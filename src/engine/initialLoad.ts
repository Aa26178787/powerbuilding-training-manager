// 최초 중량 산출(Initial Load Calibration) — 순수 함수만 둔다. 화면·저장소를 모른다.
// e1RM·목표 중량 환산은 앱 전체와 같은 RTS 표(engine/e1rm)를 쓴다.
// 모든 계산은 반올림 전 값(raw)을 함께 돌려주고, 표시용 값(rounded)에만 운동별 증분을 적용한다.
import { conservativeE1RM, impliedE1RM, loadForTarget, FORMULA_VERSION } from './e1rm';
import { roundLoad, Rounding } from './rounding';
import { adviseNextSet, NextSetAdvice } from './backoff';
import { decideProgression, DoneSet, ProgressionResult } from './progression';

export const INITIAL_LOAD_VERSION = 'initial-load-1.0.0';

/** 추천 신뢰도. 확률이나 정확도 퍼센트로 바꾸지 않는다 */
export type LoadConfidence = 'record' | 'estimate' | 'none';
export const CONFIDENCE_KO: Record<LoadConfidence, string> = { record: '참고 기록 있음', estimate: '추정치', none: '기록 없음' };

export type LoadMethod = 'progression' | 'own_record' | 'comp_e1rm' | 'related_e1rm' | 'warmup' | 'arm_percent' | 'bodyweight_only' | 'manual';
export const METHOD_KO: Record<LoadMethod, string> = {
  progression: '지난 세션 진행 판정', own_record: '같은 운동 기록', comp_e1rm: '본종목 e1RM 환산', related_e1rm: '관련 운동 e1RM 환산',
  warmup: '워밍업 세트로 보정', arm_percent: 'PDF %1RM', bodyweight_only: '맨몸 반복수 진행', manual: '직접 입력',
};

/** 덤벨은 한 손 중량, 머신은 핀·스택 표시값. 다른 단위끼리 같은 숫자로 섞지 않는다 */
export type LoadUnit = 'total' | 'per_hand' | 'machine';
export const LOAD_UNIT_KO: Record<LoadUnit, string> = { total: 'kg', per_hand: '한 손 kg', machine: '스택 kg' };
/** 바깥으로 드는 총중량. 한 손 덤벨은 2배, 머신 표시값은 기구마다 달라 총중량으로 바꾸지 않는다(null) */
export const totalExternalLoad = (weight: number, unit: LoadUnit): number | null => (unit === 'per_hand' ? weight * 2 : unit === 'machine' ? null : weight);

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** 보수적 e1RM: RTS 표에서 RPE를 0.5 높게 본다(Top Set·기준 기록용) */
export const calculateConservativeE1RM = (weight: number, reps: number, rpe: number): number => conservativeE1RM(weight, reps, rpe);

/** e1RM에서 목표 반복·RPE 중량. 내림이 기본 */
export const calculateTargetLoad = (e1rm: number, reps: number, rpe: number, increment: number, rounding: Rounding = 'nearest') => {
  const raw = loadForTarget(e1rm, reps, rpe);
  return { raw, rounded: roundLoad(Math.max(0, raw), increment, rounding) };
};

/** Variation: e1RM_comp × k_base × k_individual → 목표 반복·RPE 중량 */
export const estimateVariationLoad = (i: { compE1rm: number; kBase: number; kIndividual: number; reps: number; rpe: number; increment: number; rounding?: Rounding }) => {
  const e1rm = i.compE1rm * i.kBase * i.kIndividual;
  const t = calculateTargetLoad(e1rm, i.reps, i.rpe, i.increment, i.rounding);
  return { formulaVersion: FORMULA_VERSION, e1rm, ...t };
};

/**
 * 체중 + 추가 중량 운동(딥스·풀업). 시스템 e1RM에서 목표 시스템 중량을 구하고 체중을 뺀다.
 * 음수면 음의 추가 중량을 처방하지 않고 보조(밴드·머신) 필요로 알린다.
 */
export const estimateWeightedBodyweightLoad = (i: { systemE1rm: number; bodyweight: number; reps: number; rpe: number; increment: number; rounding?: Rounding; bodyweightFactor?: number }) => {
  const systemLoad = loadForTarget(i.systemE1rm, i.reps, i.rpe);
  const raw = systemLoad - i.bodyweight * (i.bodyweightFactor ?? 1);
  if (raw < 0) return { systemLoad, raw, added: null, assistNeeded: true, assistKg: r3(-raw) };
  return { systemLoad, raw, added: roundLoad(raw, i.increment, i.rounding ?? 'nearest'), assistNeeded: false, assistKg: 0 };
};

/**
 * 워밍업 기반 보정: 기록이 없는 운동에서 가벼운 세트 하나(중량×반복@RPE)로 첫 작업 중량을 정한다.
 * 워밍업 세트는 보수적 e1RM으로 환산하고, 목표 반복·RPE 중량을 내림으로 추천한다.
 * 체중 운동은 시스템 중량(체중 + 추가)으로 계산한 뒤 체중을 뺀다.
 */
export const calibrateInitialLoad = (i: {
  warmup: { weight: number; reps: number; rpe: number };
  target: { reps: number; rpe: number };
  increment: number; rounding?: Rounding;
  bodyweight?: number;
}) => {
  const bw = i.bodyweight ?? 0;
  const e1rm = calculateConservativeE1RM(i.warmup.weight + bw, i.warmup.reps, i.warmup.rpe);
  const system = loadForTarget(e1rm, i.target.reps, i.target.rpe);
  const raw = system - bw;
  // 워밍업보다 가벼운 작업 중량은 추천하지 않는다(목표가 워밍업보다 쉬운 경우)
  const floor = i.warmup.weight;
  const adjusted = Math.max(raw, floor);
  const assistNeeded = bw > 0 && raw < 0;
  return {
    formulaVersion: FORMULA_VERSION, version: INITIAL_LOAD_VERSION, e1rm, raw, assistNeeded,
    rounded: assistNeeded ? null : roundLoad(Math.max(0, adjusted), i.increment, i.rounding ?? 'nearest'),
    confidence: 'estimate' as LoadConfidence,
  };
};

/** 첫 작업 세트 결과로 다음 세트 중량을 보정한다(목표보다 무거우면 낮추고, 가벼우면 첫 세트에 한해 올림) */
/** 감량은 reduceRounding(기본 내림), 가벼울 때 올림은 increaseRounding(기본 가까운 쪽) */
export const recommendNextSetLoad = (i: { load: number; reps: number; lastRpe: number; targetRpe: number; rpeCap: number; increment: number; reduceRounding?: Rounding; increaseRounding?: Rounding; isFirstSet: boolean; drift?: number; bodyweight?: number }): NextSetAdvice =>
  adviseNextSet({ load: i.load, reps: i.reps, lastRpe: i.lastRpe, targetRpe: i.targetRpe, rpeCap: i.rpeCap, drift: i.drift ?? 0, increment: i.increment, rounding: i.reduceRounding ?? 'floor', increaseRounding: i.increaseRounding ?? 'nearest', isFirstBackoff: i.isFirstSet, bodyweight: i.bodyweight });

/** 다음 세션 중량(Top Set·Straight). 장비 문제는 실패로 세지 않고, RPE 누락은 판정을 미룬다 */
export const recommendNextSessionLoad = (i: { model: 'top_backoff' | 'straight_linear'; sets: DoneSet[]; plannedCount: number; targetReps: number; rpeCap: number; increment: number; prevFailStreak: number; bodyweight?: number }): ProgressionResult =>
  decideProgression({ model: i.model, sets: i.sets, plannedCount: i.plannedCount, targetReps: i.targetReps, rpeCap: i.rpeCap, increment: i.increment, prevFailStreak: i.prevFailStreak, bodyweight: i.bodyweight });

/** Double Progression 판정(Variation·보조 운동) */
export const evaluateDoubleProgression = (i: { sets: DoneSet[]; plannedCount: number; repMin: number; repMax: number; rpeCap: number; increment: number; prevFailStreak: number; dpCriterion?: 'all_sets' | 'last_set'; bodyweight?: number }): ProgressionResult =>
  decideProgression({ model: 'double_progression', sets: i.sets, plannedCount: i.plannedCount, repMin: i.repMin, repMax: i.repMax, rpeCap: i.rpeCap, increment: i.increment, prevFailStreak: i.prevFailStreak, dpCriterion: i.dpCriterion, bodyweight: i.bodyweight });

/**
 * Fast-track: Top Set이 목표 RPE보다 가벼웠으면 그 기록에서 목표 RPE 중량을 RTS로 역산해 다음 세션 중량으로 쓴다.
 * - 역산 중량과 기본 선형 증량(지난 중량 + 증량 단위) 중 큰 쪽 하나만 쓴다(두 번 더하지 않음)
 * - 상한: 지난 중량 × (1 + maxPct)
 * - 같은 기록(sourceId)으로 이미 보정했으면 다시 보정하지 않는다
 */
export const fastTrackLoad = (i: {
  sourceId: string; lastLoad: number; reps: number; rpe: number; targetRpe: number; k?: number; bodyweight?: number;
  increment: number; step: number; maxPct: number; rounding?: Rounding; alreadyUsedSourceId?: string;
}) => {
  const bw = i.bodyweight ?? 0;
  const base = i.lastLoad + i.increment;
  if (i.alreadyUsedSourceId === i.sourceId || i.rpe >= i.targetRpe) return { applied: false, raw: base, rounded: base, rtsLoad: null as number | null, cap: null as number | null, base, sourceId: i.sourceId };
  const e = impliedE1RM(i.lastLoad + bw, i.reps, i.rpe) * (i.k ?? 1);
  const rtsLoad = loadForTarget(e, i.reps, i.targetRpe) - bw;
  const cap = (i.lastLoad + bw) * (1 + i.maxPct) - bw;
  const raw = Math.min(Math.max(rtsLoad, base), cap);
  const rounded = Math.max(base, Math.min(roundLoad(raw, i.step, i.rounding ?? 'nearest'), roundLoad(cap, i.step, 'floor')));
  return { applied: rounded > base, raw, rounded, rtsLoad, cap, base, sourceId: i.sourceId };
};

/**
 * ARM: PDF에 %1RM이 있고 기준 1RM이 등록된 경우에만 계산. 원본 누락·미확인 처방이면 계산하지 않는다.
 */
export const armPercentLoad = (i: { percent1rm: number | null; oneRm: number | null | undefined; increment: number; sourceMissing: string[]; verified: boolean }): number | null => {
  if (i.percent1rm === null || !i.oneRm || !i.verified) return null;
  if (i.sourceMissing.includes('intensity') || i.sourceMissing.includes('percent1rm')) return null;
  return roundLoad((i.oneRm * i.percent1rm) / 100, i.increment, 'down');
};

/** 같은 실제 기록에서 다시 계산할 때 쓰는 e1RM(RPE 보정 없음) */
export const impliedFromSet = (weight: number, reps: number, rpe: number) => impliedE1RM(weight, reps, rpe);
