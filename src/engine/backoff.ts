// Top Set → Backoff 중량 추천, 세트 간 자동 조절 제안 (SRS FR-022, FR-030, FR-031)
import { conservativeE1RM, impliedE1RM, loadForTarget, FORMULA_VERSION } from './e1rm';
import { roundLoad } from './rounding';

export interface BackoffInput {
  /** external: 바벨 중량 / bodyweight_plus: 추가 중량 */
  topWeight: number;
  topReps: number;
  topRpe: number;
  backoffReps: number;
  backoffTargetRpe: number;
  /** 개인 보정계수(기본 1.000) */
  k: number;
  increment: number;
  rounding: 'down' | 'nearest';
  /** 딥스·풀업: 체중(kg). 지정 시 system_load = 체중 + 추가 중량으로 계산 */
  bodyweight?: number;
}
export interface LoadRecommendation {
  formulaVersion: string;
  e1rmConservative: number;
  e1rmAdjusted: number;
  /** 반올림 전 추천값(추가 중량 운동은 추가 중량 기준) */
  raw: number;
  rounded: number;
  inputs: BackoffInput;
}

export const recommendBackoff = (inp: BackoffInput): LoadRecommendation => {
  const bw = inp.bodyweight ?? 0;
  if (inp.bodyweight !== undefined && !(inp.bodyweight > 0)) throw new RangeError('체중이 필요합니다');
  if (!(inp.k > 0)) throw new RangeError('보정계수가 유효하지 않습니다');
  if (inp.topWeight < 0) throw new RangeError('중량은 음수일 수 없습니다');
  const system = inp.topWeight + bw; // alpha = 1.0 고정
  const e1rm = conservativeE1RM(system, inp.topReps, inp.topRpe);
  const adjusted = e1rm * inp.k;
  const rawSystem = loadForTarget(adjusted, inp.backoffReps, inp.backoffTargetRpe);
  const raw = Math.max(0, rawSystem - bw);
  return {
    formulaVersion: FORMULA_VERSION, e1rmConservative: e1rm, e1rmAdjusted: adjusted,
    raw, rounded: roundLoad(raw, inp.increment, inp.rounding), inputs: inp,
  };
};

export interface NextSetInput {
  load: number;
  reps: number;
  lastRpe: number;
  targetRpe: number;
  rpeCap: number;
  /** 세트가 진행되며 예상되는 RPE 상승폭 */
  drift: number;
  increment: number;
  rounding: 'down' | 'nearest';
  isFirstBackoff: boolean;
  bodyweight?: number;
}
export interface NextSetAdvice {
  action: 'keep' | 'decrease' | 'increase';
  load: number;
  predictedRpe: number;
  /** 상한을 이미 넘겼으면 조기 종료도 선택지로 제시 */
  offerStop: boolean;
  reason: string;
}

/** 직전 세트의 실제 RPE로 다음 세트 중량 유지/증감 제안. 결정권은 사용자에게 있다 */
export const adviseNextSet = (i: NextSetInput): NextSetAdvice => {
  const bw = i.bodyweight ?? 0;
  const predicted = Math.min(10, i.lastRpe + i.drift);
  const retarget = (rpe: number) => {
    const e = impliedE1RM(i.load + bw, i.reps, i.lastRpe);
    return roundLoad(Math.max(0, loadForTarget(e, i.reps, rpe) - bw), i.increment, i.rounding);
  };
  if (i.lastRpe > i.rpeCap || predicted > i.rpeCap) {
    let load = retarget(Math.max(5, i.rpeCap - 0.5));
    if (load >= i.load) load = Math.max(0, roundLoad(i.load - i.increment, i.increment, 'nearest'));
    const over = i.lastRpe > i.rpeCap;
    return {
      action: 'decrease', load, predictedRpe: predicted, offerStop: over,
      reason: over ? `직전 세트가 @${i.lastRpe}로 상한 @${i.rpeCap}을 넘었습니다. 감량하거나 종료하세요`
        : `같은 중량이면 다음 세트는 약 @${predicted}입니다(상한 @${i.rpeCap}). 감량을 권합니다`,
    };
  }
  if (i.isFirstBackoff && i.lastRpe <= i.targetRpe - 1) {
    const load = retarget(i.targetRpe);
    if (load > i.load) {
      return { action: 'increase', load, predictedRpe: predicted, offerStop: false, reason: `첫 Backoff가 @${i.lastRpe}로 목표 @${i.targetRpe}보다 가볍습니다. 올려도 됩니다` };
    }
  }
  return { action: 'keep', load: i.load, predictedRpe: predicted, offerStop: false, reason: `직전 세트 @${i.lastRpe}. 같은 중량으로 갑니다` };
};

/** Variation 첫 수행 시작 중량: Comp e1RM × k_base × k_personal에서 목표 반복·RPE로 환산 (SRS FR-032) */
export const variationStartLoad = (
  compE1rm: number, kBase: number, kPersonal: number, targetReps: number, targetRpe: number,
  increment: number, rounding: 'down' | 'nearest' = 'down',
) => {
  const est = compE1rm * kBase * kPersonal;
  const raw = loadForTarget(est, targetReps, targetRpe);
  return { formulaVersion: FORMULA_VERSION, estimated1rm: est, raw, rounded: roundLoad(raw, increment, rounding) };
};
