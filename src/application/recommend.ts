// 세트별 추천 중량 산출(읽기 전용). 엔진 순수 함수에 입력을 모아 전달한다.
import { plateSetup } from '../domain/slots';
import type { Db, Exercise, ISODate, PerformedSet, PlannedSet } from '../domain/types';
import { recommendBackoff } from '../engine/backoff';
import { validateSetInput, FORMULA_VERSION } from '../engine/e1rm';
import {
  armPercentLoad, calculateConservativeE1RM, calculateTargetLoad, estimateVariationLoad, estimateWeightedBodyweightLoad, recommendNextSetLoad,
  LoadConfidence, LoadMethod,
} from '../engine/initialLoad';
import { minBarbellStep, roundingFor, RoundKind } from '../engine/rounding';

export interface Suggestion {
  load: number | null;
  kind: 'top_start' | 'backoff' | 'next_set' | 'variation_start' | 'related_start' | 'progression' | 'arm_percent' | 'bodyweight_only' | 'none';
  message: string;
  /** 계산 근거(수식·계수·반올림 전/후) */
  detail?: Record<string, unknown>;
  offerStop?: boolean;
  action?: 'keep' | 'decrease' | 'increase';
  /** 최초 중량: 산출 방법, 신뢰도, 화면에 보여 줄 근거 */
  method?: LoadMethod;
  confidence?: LoadConfidence;
  basis?: { baseExercise?: string; e1rm?: number; kBase?: number; kIndividual?: number; targetReps: number; targetRpe: number; raw?: number | null };
  /** 기록도 추정 근거도 없어 워밍업 보정이나 직접 입력이 필요함 */
  needsCalibration?: boolean;
  /** 체중만으로도 목표보다 무거움: 보조(밴드·머신) 필요 */
  assistNeeded?: boolean;
  /** 반올림 표시: 반올림 전 계산값, 방식, 사용 가능 단위 */
  round?: { raw: number; mode: 'nearest' | 'floor' | 'ceil'; step: number };
  /** 개인화 보정계수(k)를 적용했는지 */
  personalized?: boolean;
  /** 지난 세션 판정에 Fast-track이 적용됐는지 */
  fastTrack?: boolean;
}

export const livePerformed = (db: Db, pred: (p: PerformedSet) => boolean): PerformedSet[] =>
  Object.values(db.performed).filter((p) => !p.deleted && pred(p)).sort((a, b) => a.performedAt.localeCompare(b.performedAt));

export const bodyweightFor = (db: Db, date: ISODate): number | null => {
  const s = Object.values(db.sessions).filter((x) => x.date === date && x.bodyweight).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return s?.bodyweight ?? db.settings.bodyweight ?? null;
};

/** 계산에 쓸 수 있는 실제 작업 세트: 중량·반복·RPE가 있고, 이상 태그·보조(밴드·머신)가 없음 */
const usable = (p: PerformedSet) => p.weight !== null && p.reps !== undefined && p.rpe !== undefined && !p.flags.length && !p.assist && p.type !== 'warmup' && p.type !== 'extra';

/**
 * 같은 운동의 보수적 e1RM. Top Set 기록 → (Top이 없는 운동은) 가장 최근 세션의 첫 작업 세트 → 초기 입력 기록 순.
 * 다른 운동 기록은 절대 섞지 않는다(Sumo로 Conventional을 계산하지 않음).
 */
export const latestE1rm = (db: Db, exerciseId: string): number | null => {
  const ex = db.exercises[exerciseId];
  if (!ex) return null;
  const own = livePerformed(db, (p) => p.exerciseId === exerciseId && usable(p));
  const tops = own.filter((p) => p.type === 'top');
  let last = tops[tops.length - 1];
  if (!last && own.length) { const d = own[own.length - 1].sessionDate; last = own.find((p) => p.sessionDate === d) as PerformedSet; }
  const src = last ? { weight: last.weight as number, reps: last.reps as number, rpe: last.rpe as number, bodyweight: last.bodyweight }
    : db.exStates[exerciseId]?.seed;
  if (!src) return null;
  const bw = ex.loadMode === 'bodyweight_plus' ? (src.bodyweight ?? db.settings.bodyweight ?? 0) : 0;
  if (ex.loadMode === 'bodyweight_plus' && !bw) return null;
  if (validateSetInput(src.weight + bw, src.reps, src.rpe).length) return null;
  return calculateConservativeE1RM(src.weight + bw, src.reps, src.rpe);
};

/** 사용 가능한 중량 단위: 운동 설정(loadStep, 없으면 증량 단위). 바벨은 가진 원판으로 만들 수 있는 최소 간격보다 작을 수 없다 */
export const stepOf = (db: Db, ex: Exercise): number =>
  Math.max(ex.loadStep ?? ex.increment, plateSetup(ex, db.settings) ? minBarbellStep(db.settings.plates, db.settings.plateStock) : 0);
/** 반올림 방식: 운동별 지정 > 설정의 종류별 정책 > 기본표 */
export const modeOf = (db: Db, ex: Exercise, kind: RoundKind) => roundingFor(kind, db.settings.roundingPolicy, ex.roundingOverride);

const hasOwnHistory = (db: Db, exerciseId: string) => !!db.exStates[exerciseId]?.seed || livePerformed(db, (p) => p.exerciseId === exerciseId && usable(p)).length > 0;

/** 같은 운동의 e1RM(기록·초기 입력)에서 목표 반복·RPE 시작 중량 */
const ownStart = (db: Db, ex: Exercise, reps: number, rpe: number, bw: number | null, kind: RoundKind): Suggestion | null => {
  const e1rm = latestE1rm(db, ex.id);
  if (e1rm === null) return null;
  const k = db.exStates[ex.id]?.k ?? 1;
  const basis = { baseExercise: ex.name, e1rm, kBase: 1, kIndividual: k, targetReps: reps, targetRpe: rpe };
  if (ex.loadMode === 'bodyweight_plus') {
    const r = estimateWeightedBodyweightLoad({ systemE1rm: e1rm * k, bodyweight: bw ?? 0, reps, rpe, increment: stepOf(db, ex), rounding: modeOf(db, ex, kind) });
    if (r.assistNeeded) return { load: null, kind: 'top_start', method: 'own_record', confidence: 'record', assistNeeded: true, basis: { ...basis, raw: r.raw }, message: `체중만으로도 ${reps}회 @${rpe}보다 무겁습니다(약 ${r.assistKg.toFixed(1)}kg 보조 필요). 밴드나 어시스트 머신을 쓰고 '보조'로 표시하세요`, detail: { formulaVersion: FORMULA_VERSION, ...r } };
    return { load: r.added, kind: 'top_start', method: 'own_record', confidence: 'record', basis: { ...basis, raw: r.raw }, round: { raw: r.raw, mode: modeOf(db, ex, kind), step: stepOf(db, ex) }, personalized: k !== 1, message: `같은 운동 기록의 e1RM ${e1rm.toFixed(1)}kg(체중 포함)에서 ${reps}회 @${rpe} 계산`, detail: { formulaVersion: FORMULA_VERSION, e1rm, raw: r.raw, rounded: r.added, bodyweight: bw } };
  }
  const t = calculateTargetLoad(e1rm * k, reps, rpe, stepOf(db, ex), modeOf(db, ex, kind));
  return { load: t.rounded, kind: 'top_start', method: 'own_record', confidence: 'record', basis: { ...basis, raw: t.raw }, round: { raw: t.raw, mode: modeOf(db, ex, kind), step: stepOf(db, ex) }, personalized: k !== 1, message: `같은 운동 기록의 e1RM ${e1rm.toFixed(1)}kg에서 ${reps}회 @${rpe} 계산`, detail: { formulaVersion: FORMULA_VERSION, e1rm, reps, rpe, raw: t.raw, rounded: t.rounded, increment: ex.increment } };
};

const calibrate = (reps: number, rpe: number, ex: Exercise): Suggestion => ({
  load: null, kind: 'none', method: 'warmup', confidence: 'none', needsCalibration: true, basis: { targetReps: reps, targetRpe: rpe },
  message: ex.loadMode === 'bodyweight_plus' ? '기록이 없습니다. 맨몸이나 가벼운 추가 중량으로 한 세트 해 보고 시작 중량을 정하세요' : '기록이 없습니다. 가벼운 세트 하나로 시작 중량을 정하거나 직접 입력하세요',
});

/** 예정 세트 하나에 대한 추천 중량. 추천은 제안일 뿐 실제 기록을 덮어쓰지 않는다 */
export const suggestForSet = (db: Db, set: PlannedSet, sessionDate: ISODate): Suggestion => {
  const ex = db.exercises[set.exerciseId];
  const inst = db.instances[set.instanceId];
  if (!ex || !inst) return { load: null, kind: 'none', message: '' };
  if (inst.model === 'arm_manual') {
    const a = inst.arm;
    const load = a ? armPercentLoad({ percent1rm: a.percent1rm, oneRm: db.settings.armOneRm?.[ex.id], increment: stepOf(db, ex), sourceMissing: a.sourceMissing, verified: !a.userFilled }) : null;
    if (load !== null && a) return { load, kind: 'arm_percent', method: 'arm_percent', confidence: 'estimate', basis: { targetReps: set.reps ?? 0, targetRpe: set.targetRpe ?? 0 }, message: `PDF ${a.percent1rm}% × 기준 1RM ${db.settings.armOneRm?.[ex.id]}kg` };
    return { load: null, kind: 'none', message: 'ARM은 PDF 처방과 같은 조건의 지난 기록을 보고 정합니다. %1RM 처방은 기준 1RM을 등록하면 계산합니다' };
  }
  const st = db.exStates[ex.id];
  const bw = ex.loadMode === 'bodyweight_plus' ? bodyweightFor(db, sessionDate) : null;
  if (ex.loadMode === 'bodyweight_plus' && !bw) return { load: null, kind: 'none', message: '체중을 입력하면 추천 중량을 계산합니다' };
  const done = livePerformed(db, (p) => p.instanceId === inst.id && p.type !== 'warmup' && p.type !== 'extra');
  const last = done[done.length - 1];
  const drift = db.settings.rpeDriftPerSet;
  const bwArg = bw ?? undefined;
  // 첫 작업 세트 기준: Top Set은 목표 반복 @7.5, 그 외는 반복 하한 @7(High-bar 등 목표가 더 낮으면 그 값)
  const isTop = set.type === 'top';
  const startReps = isTop ? (set.reps ?? 1) : (set.repMin ?? set.reps ?? 1);
  const startRpe = isTop ? (set.targetRpe ?? 7.5) : Math.min(7, set.targetRpeMax ?? set.targetRpe ?? 7);
  const targetReps = set.reps ?? set.repMax ?? 1;
  const targetRpe = set.targetRpe ?? 7.5;

  if (ex.bodyweightOnly) {
    if (last && last.reps !== undefined) return { load: 0, kind: 'next_set', method: 'bodyweight_only', confidence: 'record', message: `직전 세트 ${last.reps}회. 외부 중량 없이 반복수로 진행합니다` };
    return { load: 0, kind: 'bodyweight_only', method: 'bodyweight_only', confidence: hasOwnHistory(db, ex.id) ? 'record' : 'none', basis: { targetReps, targetRpe }, message: '외부 중량 0kg으로 시작해 반복수로 진행합니다' };
  }

  if (set.type === 'top') {
    if (st?.nextLoad != null) return { load: st.nextLoad, kind: 'progression', method: 'progression', confidence: 'record', fastTrack: !!st.lastDecision?.fastTrack?.applied, ...(st.lastDecision?.fastTrack?.applied ? { round: { raw: st.lastDecision.fastTrack.raw, mode: st.lastDecision.fastTrack.rounding as 'nearest', step: st.lastDecision.fastTrack.step } } : {}), message: st.lastDecision?.reason ?? '지난 세션 기준 추천' };
    return ownStart(db, ex, startReps, startRpe, bw, 'top') ?? calibrate(startReps, startRpe, ex);
  }
  if (set.type === 'backoff') {
    const top = done.find((p) => p.type === 'top');
    if (!top || top.weight === null || top.reps === undefined || top.rpe === undefined) return { load: null, kind: 'none', message: 'Top Set의 중량·반복·RPE를 기록하면 계산합니다' };
    const backoffs = done.filter((p) => p.type === 'backoff');
    const lastBo = backoffs[backoffs.length - 1];
    if (!lastBo || lastBo.weight === null || lastBo.rpe === undefined) {
      try {
        const r = recommendBackoff({ topWeight: top.weight, topReps: top.reps, topRpe: top.rpe, backoffReps: targetReps, backoffTargetRpe: targetRpe, k: st?.k ?? 1, increment: stepOf(db, ex), rounding: modeOf(db, ex, 'backoff'), bodyweight: bwArg });
        return { load: r.rounded, kind: 'backoff', round: { raw: r.raw, mode: modeOf(db, ex, 'backoff'), step: stepOf(db, ex) }, personalized: (st?.k ?? 1) !== 1, message: `Top ${top.weight}kg×${top.reps} @${top.rpe} 기준, 보수적 e1RM ${r.e1rmConservative.toFixed(1)}kg로 ${targetReps}회 @${targetRpe} 계산`, detail: { ...r, inputs: { ...r.inputs } } };
      } catch (e) {
        return { load: null, kind: 'none', message: (e as Error).message };
      }
    }
    const a = recommendNextSetLoad({ load: lastBo.weight, reps: targetReps, lastRpe: lastBo.rpe, targetRpe, rpeCap: set.rpeCap, drift, increment: stepOf(db, ex), reduceRounding: modeOf(db, ex, 'reduce'), increaseRounding: modeOf(db, ex, 'next_set'), isFirstSet: backoffs.length === 1, bodyweight: bwArg });
    return { load: a.load, kind: 'next_set', message: a.reason, offerStop: a.offerStop, action: a.action, detail: { ...a } };
  }
  // straight / volume: 세션 안에서는 직전 세트 RPE로 보정. 첫 작업 세트 뒤에는 가벼우면 올리는 것도 제안
  if (last && last.weight !== null) {
    if (last.rpe === undefined) return { load: last.weight, kind: 'next_set', message: '직전 세트와 같은 중량', action: 'keep' };
    const a = recommendNextSetLoad({ load: last.weight, reps: last.reps ?? targetReps, lastRpe: last.rpe, targetRpe, rpeCap: set.rpeCap, drift: set.type === 'straight' ? drift : 0, increment: stepOf(db, ex), reduceRounding: modeOf(db, ex, 'reduce'), increaseRounding: modeOf(db, ex, 'next_set'), isFirstSet: done.length === 1, bodyweight: bwArg });
    return { load: a.load, kind: 'next_set', message: a.reason, offerStop: a.offerStop, action: a.action, detail: { ...a } };
  }
  if (st?.nextLoad != null) return { load: st.nextLoad, kind: 'progression', method: 'progression', confidence: 'record', fastTrack: !!st.lastDecision?.fastTrack?.applied, message: st.lastDecision?.reason ?? '지난 세션 기준 추천' };
  // 1) 같은 운동 기록(초기 입력 포함)
  if (hasOwnHistory(db, ex.id)) {
    const own = ownStart(db, ex, startReps, startRpe, bw, 'start');
    if (own) return own;
    const prev = livePerformed(db, (p) => p.exerciseId === ex.id && p.weight !== null && !p.assist && p.type !== 'warmup');
    const lp = prev[prev.length - 1];
    if (lp) return { load: lp.weight, kind: 'progression', method: 'own_record', confidence: 'record', message: `지난 기록 ${lp.weight}kg×${lp.reps ?? '-'}` };
  }
  // 2) 본종목 e1RM × k_base × k_individual (Variation)
  if (ex.variationOf) {
    const base = db.exercises[ex.variationOf.compExerciseId];
    const comp = latestE1rm(db, ex.variationOf.compExerciseId);
    if (comp !== null) {
      const k = st?.k ?? 1;
      const r = estimateVariationLoad({ compE1rm: comp, kBase: ex.variationOf.kBase, kIndividual: k, reps: startReps, rpe: startRpe, increment: stepOf(db, ex), rounding: modeOf(db, ex, 'start') });
      return { load: r.rounded, kind: 'variation_start', method: 'comp_e1rm', confidence: 'estimate', round: { raw: r.raw, mode: modeOf(db, ex, 'start'), step: stepOf(db, ex) }, personalized: k !== 1, basis: { baseExercise: base?.name, e1rm: comp, kBase: ex.variationOf.kBase, kIndividual: k, targetReps: startReps, targetRpe: startRpe, raw: r.raw },
        message: `첫 수행 시작값(추정). ${base?.name ?? '본종목'} e1RM ${comp.toFixed(1)}kg × ${ex.variationOf.kBase} × ${k.toFixed(3)}로 ${startReps}회 @${startRpe} 계산`, detail: { ...r, compE1rm: comp, kBase: ex.variationOf.kBase, kIndividual: k } };
    }
  }
  // 3) 같은 동작의 다른 처방(Strength → Volume): 시스템 중량 기준 임시 추정
  if (ex.relatedOf && bw) {
    const base = db.exercises[ex.relatedOf.exerciseId];
    const rel = latestE1rm(db, ex.relatedOf.exerciseId);
    if (rel !== null) {
      const r = estimateWeightedBodyweightLoad({ systemE1rm: rel * ex.relatedOf.kBase, bodyweight: bw, reps: startReps, rpe: startRpe, increment: stepOf(db, ex), rounding: modeOf(db, ex, 'start') });
      const basis = { baseExercise: base?.name, e1rm: rel, kBase: ex.relatedOf.kBase, kIndividual: 1, targetReps: startReps, targetRpe: startRpe, raw: r.raw };
      if (r.assistNeeded) return { load: null, kind: 'related_start', method: 'related_e1rm', confidence: 'estimate', assistNeeded: true, basis, message: `${base?.name ?? '관련 운동'} 기준으로는 체중만으로도 ${startReps}회 @${startRpe}보다 무겁습니다. 보조를 쓰고 '보조'로 표시하세요` };
      return { load: r.added, kind: 'related_start', method: 'related_e1rm', confidence: 'estimate', basis, round: { raw: r.raw, mode: modeOf(db, ex, 'start'), step: stepOf(db, ex) }, message: `임시 추정. ${base?.name ?? '관련 운동'} e1RM ${rel.toFixed(1)}kg(체중 포함)에서 ${startReps}회 @${startRpe} 계산`, detail: { formulaVersion: FORMULA_VERSION, ...r } };
    }
  }
  // 4) 근거가 없으면 워밍업 보정 또는 직접 입력(일반 보조 운동에 본종목 환산계수를 만들지 않는다)
  return calibrate(startReps, startRpe, ex);
};

/** 같은 운동의 직전 세션 기록(카드의 '지난 기록' 표시용) */
export const lastSessionSets = (db: Db, exerciseId: string, beforeDate: ISODate, armKey?: string): PerformedSet[] => {
  const all = livePerformed(db, (p) => p.exerciseId === exerciseId && p.sessionDate < beforeDate && p.type !== 'warmup'
    && (!armKey || (p.instanceId ? armVariantKey(db, p.instanceId) === armKey : false)));
  if (!all.length) return [];
  const lastDate = all[all.length - 1].sessionDate;
  return all.filter((p) => p.sessionDate === lastDate);
};

/** ARM 기록 비교 키: 같은 운동이라도 ROM·수행 방식이 다르면 구분 */
export const armVariantKey = (db: Db, instanceId: string): string => {
  const a = db.instances[instanceId]?.arm;
  return a ? `${a.rom ?? ''}|${[...a.execution].sort().join(',')}|${a.loadNote ?? ''}` : '';
};
