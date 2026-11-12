// 세션·세트 기록 유스케이스. 실제 수행 기록은 원본 그대로 보존하고 수정·삭제는 이력을 남긴다.
import type { AuditEvent, Db, ExerciseState, FirstSessionSummary, ProgressionDecisionFastTrack, ISODate, IssueFlag, Patch, PerformedSet, PerformedType, PlannedSet, Recommendation, Session, Side, WorkoutClose } from '../domain/types';
import { decideProgression, PROGRESSION_VERSION } from '../engine/progression';
import { fastTrackLoad, INITIAL_LOAD_VERSION } from '../engine/initialLoad';
import { Ctx, applyPatch, fail, mergePatches } from './ctx';
import { bodyweightFor, livePerformed, modeOf, stepOf, suggestForSet } from './recommend';
import { learnFromInstance } from './learning';

export const activeSession = (db: Db): Session | null =>
  Object.values(db.sessions).filter((s) => s.status === 'in_progress').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;

/** 세션 시작. date는 귀속 훈련일(기본: 시작 시각의 날짜, 이동·병합 시 사용자가 고른 계획일) */
export const startSession = (db: Db, date: ISODate, bodyweight: number | null, ctx: Ctx): Patch => {
  const cur = activeSession(db);
  if (cur && cur.date === date) return {};
  if (cur) fail(`진행 중인 세션(${cur.date})을 먼저 종료하세요`);
  if (bodyweight !== null && !(bodyweight > 20 && bodyweight < 300)) fail('체중 값을 확인하세요');
  const s: Session = { id: `s-${ctx.newId()}`, date, startedAt: ctx.now, bodyweight: bodyweight ?? db.settings.bodyweight ?? undefined, status: 'in_progress', rev: 1 };
  return { put: { sessions: [s] }, ...(bodyweight ? { settings: { bodyweight } } : {}) };
};

export const setSessionBodyweight = (db: Db, sessionId: string, bodyweight: number): Patch => {
  const s = db.sessions[sessionId] ?? fail('세션을 찾을 수 없습니다');
  if (!(bodyweight > 20 && bodyweight < 300)) fail('체중 값을 확인하세요');
  return { put: { sessions: [{ ...s, bodyweight, rev: s.rev + 1 }] }, settings: { bodyweight } };
};

export interface RecordInput {
  plannedSetId: string | null;
  instanceId?: string | null;
  exerciseId: string;
  date: ISODate;
  type?: PerformedType;
  weight: number | null;
  reps?: number;
  seconds?: number;
  rpe?: number;
  side?: Side | null;
  flags?: IssueFlag[];
  note?: string;
  /** 밴드·어시스트 머신 보조 */
  assist?: 'band' | 'machine';
  /** 워밍업 보정으로 정한 시작 중량(엔진이 낸 원래 추천값을 기록에 남긴다) */
  calibration?: { load: number | null; raw: number | null; method: string; confidence: 'record' | 'estimate' | 'none'; inputs: Record<string, unknown> };
  /** 추천과 다른 중량을 쓴 사유(선택) */
  editReason?: string;
}

const validateRecord = (db: Db, i: RecordInput) => {
  if (i.weight !== null && (!Number.isFinite(i.weight) || i.weight < 0 || i.weight > 1000)) fail('중량 값을 확인하세요(0~1000kg)');
  if (i.reps !== undefined && (!Number.isInteger(i.reps) || i.reps < 0 || i.reps > 200)) fail('반복수 값을 확인하세요');
  if (i.seconds !== undefined && (!Number.isFinite(i.seconds) || i.seconds <= 0 || i.seconds > 3600)) fail('유지 시간 값을 확인하세요');
  if (i.rpe !== undefined && (i.rpe < 5 || i.rpe > 10 || Math.round(i.rpe * 2) !== i.rpe * 2)) fail('RPE는 5~10, 0.5 단위로 입력하세요');
  if (i.reps === undefined && i.seconds === undefined) fail('반복수 또는 유지 시간을 입력하세요');
  if (!db.exercises[i.exerciseId]) fail('운동을 찾을 수 없습니다');
};

/**
 * 세트 완료 기록. 한 계획 세트는 한 번만 완료 처리한다(중복 탭·재시도·다중 탭 방어).
 * ARM 좌·우 별도 모드에서는 (세트, 팔) 조합당 한 번만 기록하고 양팔이 모두 기록되면 완료 처리한다.
 */
export const recordSet = (db: Db, i: RecordInput, ctx: Ctx): Patch => {
  validateRecord(db, i);
  const planned = i.plannedSetId ? db.plannedSets[i.plannedSetId] ?? fail('계획 세트를 찾을 수 없습니다') : null;
  const ex = db.exercises[i.exerciseId];
  const side: Side | null = i.side ?? null;
  let nextPlanned: PlannedSet | null = null;
  if (planned) {
    if (planned.status !== 'planned') fail('이미 처리된 세트입니다(중복 기록 차단)');
    const prior = livePerformed(db, (p) => p.plannedSetId === planned.id);
    if (planned.track === 'arm' && db.settings.armSideMode === 'separate' && side && side !== 'both') {
      if (prior.some((p) => p.side === side)) fail(`이 세트의 ${side === 'L' ? '왼팔' : '오른팔'} 기록이 이미 있습니다`);
      const both = new Set([...prior.map((p) => p.side), side]);
      if (both.has('L') && both.has('R')) nextPlanned = { ...planned, status: 'done', rev: planned.rev + 1 };
    } else {
      if (prior.length) fail('이미 기록된 세트입니다(중복 기록 차단)');
      nextPlanned = { ...planned, status: 'done', rev: planned.rev + 1 };
    }
  }
  // 세션 확보: 진행 중 세션이 있으면 그 세션, 없으면 새로 시작
  let session = activeSession(db);
  const patches: Patch[] = [];
  if (!session || session.date !== i.date) {
    if (session) fail(`진행 중인 세션(${session.date})을 먼저 종료하세요`);
    const p = startSession(db, i.date, null, ctx);
    patches.push(p);
    session = p.put!.sessions![0];
  }
  const bw = ex.loadMode === 'bodyweight_plus' ? (session.bodyweight ?? bodyweightFor(db, i.date) ?? undefined) : undefined;
  // 추천 스냅샷: 기록 시점의 계산 입력·원시값·반올림값·사용자 수용값을 함께 보존
  let rec: Recommendation | null = null;
  if (planned) {
    const sug = suggestForSet(db, planned, i.date);
    if (i.calibration) {
      rec = {
        id: `r-${ctx.newId()}`, kind: 'calibration', exerciseId: i.exerciseId, instanceId: planned.instanceId, plannedSetId: planned.id,
        algorithmVersion: INITIAL_LOAD_VERSION, inputs: i.calibration.inputs, rawLoad: i.calibration.raw, roundedLoad: i.calibration.load,
        acceptedLoad: i.weight, message: '워밍업 세트로 시작 중량 보정', createdAt: ctx.now, method: i.calibration.method, confidence: i.calibration.confidence,
        editReason: i.editReason,
      };
    } else if (sug.kind !== 'none') {
      const d = (sug.detail ?? {}) as { raw?: number; formulaVersion?: string };
      rec = {
        id: `r-${ctx.newId()}`, kind: sug.kind as Recommendation['kind'], exerciseId: i.exerciseId, instanceId: planned.instanceId, plannedSetId: planned.id,
        algorithmVersion: d.formulaVersion ?? PROGRESSION_VERSION, inputs: { ...(sug.detail ?? {}), basis: sug.basis }, rawLoad: sug.basis?.raw ?? d.raw ?? sug.load, roundedLoad: sug.load,
        acceptedLoad: i.weight, message: sug.message, createdAt: ctx.now, method: sug.method, confidence: sug.confidence, editReason: i.editReason,
      };
    }
  }
  const perf: PerformedSet = {
    id: `p-${ctx.newId()}`, plannedSetId: planned?.id ?? null, instanceId: planned?.instanceId ?? i.instanceId ?? null, sessionId: session.id,
    exerciseId: i.exerciseId, type: i.type ?? planned?.type ?? 'extra', weight: i.weight, bodyweight: bw, reps: i.reps, seconds: i.seconds, rpe: i.rpe,
    side, flags: i.flags ?? [], note: i.note?.slice(0, 500), performedAt: ctx.now, sessionDate: session.date, recommendationId: rec?.id, ...(i.assist ? { assist: i.assist } : {}), rev: 1,
  };
  patches.push({ put: { performed: [perf], ...(nextPlanned ? { plannedSets: [nextPlanned] } : {}), ...(rec ? { recs: [rec] } : {}) } });
  let patch = mergePatches(...patches);
  if (planned) patch = mergePatches(patch, evaluateIfResolved(applyPatch(db, patch), planned.instanceId, ctx));
  return patch;
};

export interface ArmRowInput { plannedSetId: string; date: ISODate; left: number | null | undefined; right: number | null | undefined; reps?: number; seconds?: number; rpe?: number }

/**
 * ARM 세트 한 줄 기록: 왼팔·오른팔 중량을 한 번에 받아 팔별 기록을 만들고 세트를 완료 처리한다.
 * 한쪽만 입력하면 그 팔만 기록하고, 둘 다 비우면 중량 없는 양팔 수행(밴드·맨손)으로 기록한다. undefined = 그 팔은 수행 안 함.
 */
export const recordArmRow = (db: Db, i: ArmRowInput, ctx: Ctx): Patch => {
  const planned = db.plannedSets[i.plannedSetId] ?? fail('계획 세트를 찾을 수 없습니다');
  if (planned.track !== 'arm') fail('ARM 세트가 아닙니다');
  if (planned.status !== 'planned') fail('이미 처리된 세트입니다(중복 기록 차단)');
  const base = { plannedSetId: planned.id, exerciseId: planned.exerciseId, date: i.date, reps: i.reps, seconds: i.seconds, rpe: i.rpe };
  const done = livePerformed(db, (p) => p.plannedSetId === planned.id).map((p) => p.side);
  const sides: { side: Side; weight: number | null }[] = [];
  if (db.settings.armSideMode === 'both') sides.push({ side: 'both', weight: i.left ?? i.right ?? null });
  else if (i.left === undefined && i.right === undefined) fail('기록할 팔이 없습니다');
  else if (i.left === null && i.right === null && !done.length) sides.push({ side: 'both', weight: null });
  else {
    if (i.left !== undefined && !done.includes('L')) sides.push({ side: 'L', weight: i.left });
    if (i.right !== undefined && !done.includes('R')) sides.push({ side: 'R', weight: i.right });
  }
  if (!sides.length) fail('이미 기록한 팔입니다');
  let cur = db;
  let patch: Patch = {};
  for (const x of sides) {
    const one = recordSet(cur, { ...base, side: x.side, weight: x.weight }, ctx);
    patch = mergePatches(patch, one);
    cur = applyPatch(cur, one);
  }
  // 한 팔만 수행한 경우에도 이 줄은 완료로 닫는다
  if (cur.plannedSets[planned.id].status === 'planned') patch = mergePatches(patch, markSetDone(cur, planned.id, ctx));
  return patch;
};

/** ARM 한팔 수행 등: 기록이 하나 이상 있는 세트를 수동으로 완료 처리 */
export const markSetDone = (db: Db, plannedSetId: string, ctx: Ctx): Patch => {
  const s = db.plannedSets[plannedSetId] ?? fail('계획 세트를 찾을 수 없습니다');
  if (s.status !== 'planned') fail('이미 처리된 세트입니다');
  if (!livePerformed(db, (p) => p.plannedSetId === s.id).length) fail('수행 기록이 없는 세트는 완료 처리할 수 없습니다');
  const patch: Patch = { put: { plannedSets: [{ ...s, status: 'done', rev: s.rev + 1 }] } };
  return mergePatches(patch, evaluateIfResolved(applyPatch(db, patch), s.instanceId, ctx));
};

/** 세트 스킵. autoregulation=true면 사용자가 승인한 조기 종료로 기록 */
export const skipSets = (db: Db, setIds: string[], autoregulation: boolean, reason: string, ctx: Ctx): Patch => {
  const sets = setIds.map((id) => db.plannedSets[id] ?? fail('계획 세트를 찾을 수 없습니다'));
  if (sets.some((s) => s.status !== 'planned')) fail('예정 상태가 아닌 세트가 포함되어 있습니다');
  let patch: Patch = { put: { plannedSets: sets.map((s) => ({ ...s, status: autoregulation ? 'skipped_by_autoregulation' as const : 'skipped' as const, statusReason: reason, rev: s.rev + 1 })) } };
  for (const iid of new Set(sets.map((s) => s.instanceId))) patch = mergePatches(patch, evaluateIfResolved(applyPatch(db, patch), iid, ctx));
  return patch;
};

export const unskipSet = (db: Db, setId: string): Patch => {
  const s = db.plannedSets[setId] ?? fail('계획 세트를 찾을 수 없습니다');
  if (s.status !== 'skipped' && s.status !== 'skipped_by_autoregulation') fail('스킵한 세트가 아닙니다');
  return { put: { plannedSets: [{ ...s, status: 'planned', statusReason: undefined, rev: s.rev + 1 }] } };
};

const audit = (ctx: Ctx, entity: string, entityId: string, op: AuditEvent['op'], prev: unknown, next: unknown): AuditEvent =>
  ({ id: `a-${ctx.newId()}`, at: ctx.now, entity, entityId, op, prev, next });

/** 기록 수정. 이전 값은 감사 이력에 남고, 당시 추천 스냅샷은 지우지 않는다 */
export const editPerformedSet = (db: Db, id: string, changes: Partial<Pick<PerformedSet, 'weight' | 'reps' | 'seconds' | 'rpe' | 'flags' | 'note' | 'side'>>, ctx: Ctx): Patch => {
  const p = db.performed[id] ?? fail('기록을 찾을 수 없습니다');
  if (p.deleted) fail('삭제된 기록입니다');
  const next: PerformedSet = { ...p, ...changes, rev: p.rev + 1 };
  validateRecord(db, { plannedSetId: null, exerciseId: next.exerciseId, date: next.sessionDate, weight: next.weight, reps: next.reps, seconds: next.seconds, rpe: next.rpe });
  let patch: Patch = { put: { performed: [next], audit: [audit(ctx, 'performed', id, 'update', p, next)] } };
  if (p.instanceId) patch = mergePatches(patch, evaluateIfResolved(applyPatch(db, patch), p.instanceId, ctx));
  return patch;
};

/** 기록 삭제(소프트 삭제). 연결된 계획 세트는 다시 예정 상태로 돌린다 */
export const deletePerformedSet = (db: Db, id: string, ctx: Ctx): Patch => {
  const p = db.performed[id] ?? fail('기록을 찾을 수 없습니다');
  if (p.deleted) return {};
  const put: NonNullable<Patch['put']> = { performed: [{ ...p, deleted: true, rev: p.rev + 1 }], audit: [audit(ctx, 'performed', id, 'delete', p, null)] };
  const planned = p.plannedSetId ? db.plannedSets[p.plannedSetId] : null;
  if (planned && planned.status === 'done') put.plannedSets = [{ ...planned, status: 'planned', rev: planned.rev + 1 }];
  return { put };
};

export const restorePerformedSet = (db: Db, id: string, ctx: Ctx): Patch => {
  const p = db.performed[id] ?? fail('기록을 찾을 수 없습니다');
  if (!p.deleted) return {};
  const planned = p.plannedSetId ? db.plannedSets[p.plannedSetId] : null;
  if (planned && planned.status !== 'planned') fail('연결된 세트가 이미 다른 기록으로 처리되어 복원할 수 없습니다');
  const put: NonNullable<Patch['put']> = { performed: [{ ...p, deleted: false, rev: p.rev + 1 }], audit: [audit(ctx, 'performed', id, 'restore', null, p)] };
  if (planned) put.plannedSets = [{ ...planned, status: 'done', rev: planned.rev + 1 }];
  return { put };
};

/** 한 운동의 계획 세트가 모두 정리되면 다음 세션 진행을 판정해 상태에 저장(추천값이며 자동 적용 아님) */
export const evaluateIfResolved = (db: Db, instanceId: string, ctx: Ctx): Patch => {
  const inst = db.instances[instanceId];
  if (!inst || inst.model === 'arm_manual') return {};
  const sets = Object.values(db.plannedSets).filter((s) => s.instanceId === instanceId && s.status !== 'removed' && s.status !== 'excused');
  if (!sets.length || sets.some((s) => s.status === 'planned')) return {};
  return evaluateProgression(db, instanceId, ctx);
};

export const evaluateProgression = (db: Db, instanceId: string, ctx: Ctx): Patch => {
  const inst = db.instances[instanceId] ?? fail('처방을 찾을 수 없습니다');
  const ex = db.exercises[inst.exerciseId];
  if (!ex || inst.model === 'arm_manual') return {};
  const sets = Object.values(db.plannedSets).filter((s) => s.instanceId === instanceId && s.status !== 'removed' && s.status !== 'excused').sort((a, b) => a.index - b.index);
  const done = livePerformed(db, (p) => p.instanceId === instanceId && p.plannedSetId !== null && p.type !== 'warmup' && !p.assist);
  if (!done.length) return {};
  const prev = db.exStates[ex.id];
  const g = inst.groups[0];
  // 같은 처방을 다시 판정할 때(기록 수정 등)는 직전 판정 이전의 연속 실패 수에서 다시 계산한다
  const baseStreak = prev?.lastDecision?.instanceId === instanceId ? (prev.lastDecision.prevFailStreak ?? 0) : (prev?.failStreak ?? 0);
  const r = decideProgression({
    model: inst.model, sets: done.map((p) => ({ weight: p.weight, reps: p.reps, rpe: p.rpe, flags: p.flags, type: p.type })),
    plannedCount: sets.length, targetReps: g.reps, repMin: g.repMin, repMax: g.repMax, rpeCap: g.rpeCap, increment: ex.increment,
    prevFailStreak: baseStreak, dpCriterion: inst.dpCriterion,
    bodyweight: ex.loadMode === 'bodyweight_plus' ? (done[0].bodyweight ?? db.settings.bodyweight ?? undefined) : undefined,
  });
  // Fast-track: Top Set이 목표 RPE보다 가볍게 끝났고 증량 판정이면, 그 기록에서 목표 RPE 중량을 역산(선형 증량과 중복하지 않음, 상한 적용)
  let fastTrack: ProgressionDecisionFastTrack | undefined;
  let nextLoad = r.nextLoad;
  let reason = r.reason;
  const top = done.find((p) => p.type === 'top');
  const topSpec = inst.groups.find((x) => x.type === 'top');
  if (inst.model === 'top_backoff' && r.action === 'increase' && top && top.weight !== null && top.reps !== undefined && top.rpe !== undefined && topSpec?.targetRpe !== undefined) {
    const bw = ex.loadMode === 'bodyweight_plus' ? (top.bodyweight ?? db.settings.bodyweight ?? 0) : 0;
    const ft = fastTrackLoad({ sourceId: top.id, lastLoad: top.weight, reps: top.reps, rpe: top.rpe, targetRpe: topSpec.targetRpe, k: prev?.k ?? 1, bodyweight: bw,
      increment: ex.increment, step: stepOf(db, ex), maxPct: db.settings.fastTrackMaxPct ?? 0.05, rounding: modeOf(db, ex, 'fast_track') });
    fastTrack = { applied: ft.applied, sourceId: ft.sourceId, base: ft.base, rtsLoad: ft.rtsLoad, cap: ft.cap, raw: ft.raw, rounded: ft.rounded, rounding: modeOf(db, ex, 'fast_track'), step: stepOf(db, ex) };
    if (ft.applied) { nextLoad = ft.rounded; reason = `${r.reason.replace(/\. 다음 세션 \+[\d.]+kg 제안$/, '')}. Top Set이 @${top.rpe}로 목표 @${topSpec.targetRpe}보다 가벼워 Fast-track ${ft.rounded}kg 제안(기본 증량 ${ft.base}kg, 상한 ${Math.round((ft.cap ?? 0) * 100) / 100}kg)`; }
  }
  // 유효 관측이 있으면 개인화 계수 갱신(관측 이전 계수로 예측을 평가한 뒤 학습 — 누수 없음)
  const learned = learnFromInstance(db, instanceId, ctx);
  // 첫 세션 요약: 이 운동의 첫 판정이거나 같은 첫 처방을 다시 판정할 때만 쓴다
  const firstRec = done[0].recommendationId ? db.recs[done[0].recommendationId] : undefined;
  const isFirst = !prev?.firstSession || prev.firstSession.date === done[0].sessionDate;
  const firstSession: FirstSessionSummary | undefined = isFirst ? {
    date: done[0].sessionDate, recommendedLoad: firstRec?.roundedLoad ?? null, method: firstRec?.method ?? (firstRec ? firstRec.kind : 'manual'),
    confidence: firstRec?.confidence ?? 'none', baseExerciseId: ex.variationOf?.compExerciseId ?? ex.relatedOf?.exerciseId,
    kBase: ex.variationOf?.kBase ?? ex.relatedOf?.kBase, kIndividual: prev?.k ?? 1, actualLoad: done[0].weight,
    modified: !!firstRec && firstRec.roundedLoad !== null && done[0].weight !== firstRec.roundedLoad,
    sets: done.map((p) => ({ weight: p.weight, reps: p.reps, seconds: p.seconds, rpe: p.rpe })), nextLoad: nextLoad ?? null, action: r.action,
  } : prev?.firstSession;
  const state: ExerciseState = {
    exerciseId: ex.id, k: learned.k ?? prev?.k ?? 1, seed: prev?.seed, equipment: prev?.equipment, firstSession,
    nextLoad: nextLoad ?? prev?.nextLoad ?? null, failStreak: r.failStreak,
    lastDecision: { action: r.action, nextLoad, failStreak: r.failStreak, reason, reduceOptions: r.reduceOptions, decidedAt: ctx.now, instanceId, prevFailStreak: baseStreak, fastTrack },
    updatedAt: ctx.now,
  };
  return mergePatches(learned.patch, { put: { exStates: [state] } });
};

/** 다음 세션 작업 중량을 사용자가 직접 지정(감량 승인·디로드 포함). 이전 값은 이력에 남는다 */
export const setNextLoad = (db: Db, exerciseId: string, load: number | null, note: string, ctx: Ctx): Patch => {
  if (!db.exercises[exerciseId]) fail('운동을 찾을 수 없습니다');
  if (load !== null && (!Number.isFinite(load) || load < 0 || load > 1000)) fail('중량 값을 확인하세요');
  const prev = db.exStates[exerciseId];
  const next: ExerciseState = { ...prev, exerciseId, k: prev?.k ?? 1, failStreak: 0, nextLoad: load, updatedAt: ctx.now };
  return { put: { exStates: [next], audit: [audit(ctx, 'exState', exerciseId, 'update', prev ?? null, { ...next, note })] } };
};

export const setSeed = (db: Db, exerciseId: string, seed: ExerciseState['seed'] | undefined, ctx: Ctx): Patch => {
  if (!db.exercises[exerciseId]) fail('운동을 찾을 수 없습니다');
  if (seed && (!(seed.weight >= 0) || !(seed.reps >= 1 && seed.reps <= 30) || !(seed.rpe >= 5 && seed.rpe <= 10))) fail('기준 기록 값을 확인하세요');
  const prev = db.exStates[exerciseId];
  return { put: { exStates: [{ ...prev, exerciseId, k: prev?.k ?? 1, nextLoad: prev?.nextLoad ?? null, failStreak: prev?.failStreak ?? 0, seed, updatedAt: ctx.now }] } };
};

/** 장비 정보(기구 번호·단위·핀 간격·메모). 중량 계산에는 쓰지 않고 기록 해석용으로 남긴다 */
export const setEquipment = (db: Db, exerciseId: string, equipment: ExerciseState['equipment'] | undefined, ctx: Ctx): Patch => {
  if (!db.exercises[exerciseId]) fail('운동을 찾을 수 없습니다');
  if (equipment?.pinStep !== undefined && !(equipment.pinStep > 0 && equipment.pinStep <= 50)) fail('핀 간격을 확인하세요');
  const prev = db.exStates[exerciseId];
  const clean = equipment ? { ...equipment, id: equipment.id?.slice(0, 40), note: equipment.note?.slice(0, 200) } : undefined;
  return { put: { exStates: [{ ...prev, exerciseId, k: prev?.k ?? 1, nextLoad: prev?.nextLoad ?? null, failStreak: prev?.failStreak ?? 0, equipment: clean, updatedAt: ctx.now }] } };
};

export interface SessionReport {
  plannedSets: number; doneSets: number; extraSets: number; rpeOverCap: number;
  decisions: { exerciseName: string; action: string; nextLoad: number | null; reason: string }[];
  /** 이번 세션에서 얻은 계수 학습 관측 */
  learned: { exerciseName: string; k: number; used: boolean; reason?: string }[];
}

/** 세션 종료. 남은 운동의 진행 판정을 마무리하고 요약을 만든다. 남은 세트는 자동으로 미수행 처리하지 않는다 */
export const endSession = (db: Db, sessionId: string, ctx: Ctx): { patch: Patch; report: SessionReport } => {
  const s = db.sessions[sessionId] ?? fail('세션을 찾을 수 없습니다');
  if (s.status === 'ended') fail('이미 종료한 세션입니다');
  let patch: Patch = { put: { sessions: [{ ...s, status: 'ended', endedAt: ctx.now, rev: s.rev + 1 }] } };
  const perf = livePerformed(db, (p) => p.sessionId === sessionId);
  const instIds = [...new Set(perf.map((p) => p.instanceId).filter((x): x is string => !!x))];
  for (const iid of instIds) patch = mergePatches(patch, evaluateProgression(applyPatch(db, patch), iid, ctx));
  const after = applyPatch(db, patch);
  const daySets = Object.values(db.plannedSets).filter((x) => x.plannedDate === s.date && x.status !== 'removed' && x.status !== 'excused');
  const report: SessionReport = {
    plannedSets: daySets.length, doneSets: daySets.filter((x) => x.status === 'done').length,
    extraSets: perf.filter((p) => p.plannedSetId === null && p.type !== 'warmup').length,
    rpeOverCap: perf.filter((p) => p.plannedSetId && p.rpe !== undefined && p.rpe > (db.plannedSets[p.plannedSetId]?.rpeCap ?? 10)).length,
    decisions: instIds.map((iid) => db.instances[iid]).filter((x) => x && x.model !== 'arm_manual').map((inst) => {
      const d = after.exStates[inst.exerciseId]?.lastDecision;
      return { exerciseName: inst.exerciseName, action: d?.action ?? '-', nextLoad: d?.nextLoad ?? null, reason: d?.reason ?? '' };
    }),
    learned: instIds.map((iid) => after.coeffs[`k:${iid}`]).filter(Boolean).map((r) => ({
      exerciseName: after.exercises[r.exerciseId]?.name ?? r.exerciseId, k: after.exStates[r.exerciseId]?.k ?? 1,
      used: r.override ? r.override === 'include' : r.autoValid !== false, reason: r.excludedReason,
    })),
  };
  return { patch, report };
};

/** 원본 세션 확정(미수행·취소 등). 날짜가 지났다고 자동 확정하지 않으며 사용자가 직접 확정한다 */
export const closeWorkout = (db: Db, workoutId: string, closedAs: WorkoutClose | null, ctx: Ctx): Patch => {
  const w = db.workouts[workoutId] ?? fail('세션을 찾을 수 없습니다');
  const put: NonNullable<Patch['put']> = { workouts: [{ ...w, closedAs, closedAt: closedAs ? ctx.now : undefined, rev: w.rev + 1 }] };
  if (closedAs === 'missed' || closedAs === 'cancelled') {
    put.plannedSets = Object.values(db.plannedSets).filter((s) => s.workoutId === workoutId && s.status === 'planned')
      .map((s) => ({ ...s, status: closedAs === 'cancelled' ? 'removed' as const : 'skipped' as const, statusReason: closedAs === 'cancelled' ? '계획 취소' : '미수행 확정', rev: s.rev + 1 }));
  }
  if (closedAs === null) {
    // 확정 해제: 확정하면서 바꿨던 세트만 다시 예정 상태로
    put.plannedSets = Object.values(db.plannedSets).filter((s) => s.workoutId === workoutId && (s.statusReason === '미수행 확정' || s.statusReason === '계획 취소') && (s.status === 'skipped' || s.status === 'removed'))
      .map((s) => ({ ...s, status: 'planned' as const, statusReason: undefined, rev: s.rev + 1 }));
  }
  return { put };
};
