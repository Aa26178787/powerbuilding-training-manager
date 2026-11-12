// 개인화 계수 학습 유스케이스: 세션 기록에서 관측을 만들고, 관측 기록을 재생해 k를 갱신한다.
import type { CoefficientRecord, Db, ExerciseState, Patch } from '../domain/types';
import { evaluateCoefficients, CoeffEvaluation } from '../engine/coefficient';
import { conservativeE1RM, validateSetInput, FORMULA_VERSION } from '../engine/e1rm';
import { Ctx, fail } from './ctx';
import { latestE1rm, livePerformed } from './recommend';

export const lambdaFor = (db: Db, exerciseId: string): number =>
  (db.exercises[exerciseId]?.variationOf ? db.settings.ema.lambdaVariation : db.settings.ema.lambdaStrength);

export const coefficientEvaluation = (db: Db, exerciseId: string, extra: CoefficientRecord[] = [], drop: string[] = []): CoeffEvaluation => {
  const recs = [...Object.values(db.coeffs).filter((r) => r.exerciseId === exerciseId && !drop.includes(r.id) && !extra.some((e) => e.id === r.id)), ...extra];
  return evaluateCoefficients(recs, lambdaFor(db, exerciseId), db.settings.ema.clampPct, true);
};

/** 한 처방(세션 내 한 운동)의 기록에서 관측을 만든다. 조건이 안 되면 null */
export const buildObservation = (db: Db, instanceId: string, ctx: Ctx): CoefficientRecord | null => {
  const inst = db.instances[instanceId];
  const ex = inst && db.exercises[inst.exerciseId];
  if (!inst || !ex || inst.model === 'arm_manual') return null;
  const perf = livePerformed(db, (p) => p.instanceId === instanceId && p.plannedSetId !== null && p.type !== 'warmup');
  const sys = (w: number, bw?: number) => w + (ex.loadMode === 'bodyweight_plus' ? (bw ?? db.settings.bodyweight ?? 0) : 0);
  const complete = (p?: (typeof perf)[number]) => !!p && p.weight !== null && p.reps !== undefined && p.rpe !== undefined;
  let refE1rm: number | null = null;
  let obs: (typeof perf)[number] | undefined;
  let involved: typeof perf = [];
  if (inst.model === 'top_backoff') {
    const top = perf.find((p) => p.type === 'top');
    obs = perf.find((p) => p.type === 'backoff');
    if (!complete(top) || !complete(obs)) return null;
    const w = sys(top!.weight as number, top!.bodyweight);
    if (validateSetInput(w, top!.reps as number, top!.rpe as number).length) return null;
    refE1rm = conservativeE1RM(w, top!.reps as number, top!.rpe as number);
    involved = [top!, obs!];
  } else if (ex.variationOf) {
    obs = perf[0];
    if (!complete(obs)) return null;
    const comp = latestE1rm(db, ex.variationOf.compExerciseId);
    if (comp === null) return null;
    refE1rm = comp * ex.variationOf.kBase;
    involved = [obs!];
  } else return null;
  const load = sys(obs!.weight as number, obs!.bodyweight);
  if (!(load > 0) || validateSetInput(load, obs!.reps as number, obs!.rpe as number).length) return null;
  // 비정상 조건은 학습 제외 후보로 표시(사용자가 포함으로 바꿀 수 있음)
  const flags = [...new Set(involved.flatMap((p) => p.flags))];
  const moved = Object.values(db.plannedSets).some((s) => s.instanceId === instanceId && s.plannedDate !== s.originalDate);
  const reason = flags.length ? `이상 태그: ${flags.join(', ')}` : moved ? '이동·병합된 세션' : undefined;
  const prev = db.coeffs[`k:${instanceId}`];
  return {
    id: `k:${instanceId}`, exerciseId: ex.id, kind: 'observation', at: prev?.at ?? obs!.performedAt ?? ctx.now, sessionDate: obs!.sessionDate, instanceId,
    refE1rm, obsLoad: load, obsReps: obs!.reps, obsRpe: obs!.rpe, rpeCap: inst.groups[inst.groups.length - 1]?.rpeCap ?? 8,
    autoValid: !reason, excludedReason: reason, override: prev?.override ?? null,
  };
};

/** 관측을 저장하고 k를 다시 계산한다. 자동 학습이 꺼져 있으면 관측만 남기고 k는 그대로 둔다 */
export const learnFromInstance = (db: Db, instanceId: string, ctx: Ctx): { patch: Patch; k: number | null } => {
  const inst = db.instances[instanceId];
  if (!inst) return { patch: {}, k: null };
  const rec = buildObservation(db, instanceId, ctx);
  const id = `k:${instanceId}`;
  if (!rec) return db.coeffs[id] ? { patch: { del: { coeffs: [id] } }, k: db.settings.emaEnabled ? coefficientEvaluation(db, inst.exerciseId, [], [id]).k : null } : { patch: {}, k: null };
  return { patch: { put: { coeffs: [rec] } }, k: db.settings.emaEnabled ? coefficientEvaluation(db, inst.exerciseId, [rec]).k : null };
};

const withK = (db: Db, exerciseId: string, k: number, ctx: Ctx): ExerciseState => {
  const prev = db.exStates[exerciseId];
  return { exerciseId, nextLoad: prev?.nextLoad ?? null, failStreak: prev?.failStreak ?? 0, seed: prev?.seed, lastDecision: prev?.lastDecision, k, updatedAt: ctx.now };
};

/** 관측 하나를 학습에 포함/제외(또는 자동 판정으로 되돌림) */
export const setObservationOverride = (db: Db, id: string, override: 'include' | 'exclude' | null, ctx: Ctx): Patch => {
  const r = db.coeffs[id] ?? fail('관측 기록을 찾을 수 없습니다');
  const next = { ...r, override };
  return { put: { coeffs: [next], ...(db.settings.emaEnabled ? { exStates: [withK(db, r.exerciseId, coefficientEvaluation(db, r.exerciseId, [next]).k, ctx)] } : {}) } };
};

/** 계수 수동 지정 또는 1.000으로 초기화. 이력은 지우지 않고 기록으로 남긴다 */
export const setCoefficientManually = (db: Db, exerciseId: string, k: number | 'reset', ctx: Ctx): Patch => {
  if (!db.exercises[exerciseId]) fail('운동을 찾을 수 없습니다');
  if (k !== 'reset' && !(k >= 0.7 && k <= 1.3)) fail('계수는 0.70~1.30 범위로 입력하세요');
  const rec: CoefficientRecord = k === 'reset'
    ? { id: `k:m:${ctx.newId()}`, exerciseId, kind: 'reset', at: ctx.now }
    : { id: `k:m:${ctx.newId()}`, exerciseId, kind: 'manual', at: ctx.now, manualK: k };
  return { put: { coeffs: [rec], exStates: [withK(db, exerciseId, k === 'reset' ? 1 : k, ctx)] } };
};

/** 학습 설정(λ, 제한폭, 켜기/끄기) 변경 후 모든 종목의 k를 다시 계산 */
export const updateLearningSettings = (db: Db, s: Partial<Db['settings']['ema']> & { emaEnabled?: boolean }, ctx: Ctx): Patch => {
  const ema = { ...db.settings.ema, ...(s.lambdaStrength !== undefined ? { lambdaStrength: s.lambdaStrength } : {}), ...(s.lambdaVariation !== undefined ? { lambdaVariation: s.lambdaVariation } : {}), ...(s.clampPct !== undefined ? { clampPct: s.clampPct } : {}) };
  if (ema.lambdaStrength < 0 || ema.lambdaStrength > 1 || ema.lambdaVariation < 0 || ema.lambdaVariation > 1 || ema.clampPct < 0 || ema.clampPct > 20) fail('학습 설정 값을 확인하세요');
  const enabled = s.emaEnabled ?? db.settings.emaEnabled;
  const next: Db = { ...db, settings: { ...db.settings, ema, emaEnabled: enabled } };
  const ids = [...new Set(Object.values(db.coeffs).map((r) => r.exerciseId))];
  return { settings: { ema, emaEnabled: enabled }, ...(enabled ? { put: { exStates: ids.map((id) => withK(db, id, coefficientEvaluation(next, id).k, ctx)) } } : {}) };
};

/**
 * e1RM 공식이 바뀐 뒤 처음 열 때: 수행 기록에서 관측을 다시 만들고 모든 종목의 k를 다시 계산한다.
 * 수행 기록·사용자 포함/제외 지정·수동 지정/초기화 기록은 그대로 둔다.
 */
export const migrateFormula = (db: Db, ctx: Ctx): Patch | null => {
  if (db.settings.formulaVersion === FORMULA_VERSION) return null;
  const rebuilt: CoefficientRecord[] = [];
  const dropped: string[] = [];
  for (const r of Object.values(db.coeffs)) {
    if (r.kind !== 'observation' || !r.instanceId) continue;
    const n = buildObservation(db, r.instanceId, ctx);
    if (n) rebuilt.push({ ...n, at: r.at, override: r.override ?? null }); else dropped.push(r.id);
  }
  const next: Db = { ...db, coeffs: { ...Object.fromEntries(Object.entries(db.coeffs).filter(([id]) => !dropped.includes(id))), ...Object.fromEntries(rebuilt.map((r) => [r.id, r])) } };
  const ids = [...new Set(Object.values(next.coeffs).map((r) => r.exerciseId))];
  return {
    put: { coeffs: rebuilt, ...(db.settings.emaEnabled && ids.length ? { exStates: ids.map((id) => withK(db, id, coefficientEvaluation(next, id).k, ctx)) } : {}) },
    ...(dropped.length ? { del: { coeffs: dropped } } : {}),
    settings: { formulaVersion: FORMULA_VERSION },
  };
};
