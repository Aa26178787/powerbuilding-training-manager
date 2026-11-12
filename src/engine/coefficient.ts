// 개인화 계수 EMA (SRS FR-034, FR-035, 보완 A)
// k는 저장된 관측 기록을 시간순으로 다시 계산(replay)해 얻는다. 각 관측의 예측은 그 관측 이전의 k만 쓰므로 데이터 누수가 없다.
import { impliedE1RM, rtsEffectiveReps } from './e1rm';

export const COEFF_MODEL_VERSION = 'ema-clamp-rts-2.0.0';

/** 관측계수 = Backoff(또는 Variation 대표 세트)의 역산 e1RM ÷ 기준 e1RM */
export const observedK = (weight: number, reps: number, rpe: number, referenceE1rm: number): number => {
  if (!(referenceE1rm > 0)) throw new RangeError('기준 e1RM이 유효하지 않습니다');
  return impliedE1RM(weight, reps, rpe) / referenceE1rm;
};

export interface CoefficientUpdate { kPrev: number; kObserved: number; kObservedClamped: number; kNext: number; lambda: number; modelVersion: string }

/** k_next = (1−λ)·k + λ·clamp(k_obs, k·(1±clampPct%)) */
export const updateCoefficient = (kPrev: number, kObserved: number, lambda: number, clampPct: number): CoefficientUpdate => {
  if (!(kPrev > 0) || !(kObserved > 0) || lambda < 0 || lambda > 1 || clampPct < 0) throw new RangeError('계수 입력이 유효하지 않습니다');
  const lo = kPrev * (1 - clampPct / 100);
  const hi = kPrev * (1 + clampPct / 100);
  const clamped = Math.min(hi, Math.max(lo, kObserved));
  return { kPrev, kObserved, kObservedClamped: clamped, kNext: (1 - lambda) * kPrev + lambda * clamped, lambda, modelVersion: COEFF_MODEL_VERSION };
};

/** 주어진 계수 k에서, 실제로 든 중량·반복이 몇 RPE일지 예측: W = k·e1RM·RTS(r + 10 − p) 를 p에 대해 풂 */
export const predictRpe = (refE1rm: number, k: number, load: number, reps: number): number => {
  if (!(refE1rm > 0) || !(k > 0) || !(load > 0)) throw new RangeError('예측 입력이 유효하지 않습니다');
  return reps + 10 - rtsEffectiveReps(load / (refE1rm * k));
};

export interface CoeffRecordInput {
  id: string;
  kind: 'observation' | 'manual' | 'reset';
  at: string;
  sessionDate?: string;
  refE1rm?: number;
  obsLoad?: number;
  obsReps?: number;
  obsRpe?: number;
  rpeCap?: number;
  autoValid?: boolean;
  excludedReason?: string;
  override?: 'include' | 'exclude' | null;
  manualK?: number;
}
export interface CoeffRow {
  id: string;
  kind: CoeffRecordInput['kind'];
  at: string;
  sessionDate?: string;
  /** 학습에 실제로 쓰였는지 */
  used: boolean;
  excludedReason?: string;
  kPrev: number;
  kNext: number;
  kObserved?: number;
  kObservedClamped?: number;
  /** 이 관측 이전의 개인화 계수로 예측한 RPE와 기본 모델(k=1)로 예측한 RPE */
  predModel?: number;
  predBaseline?: number;
  actualRpe?: number;
  errModel?: number;
  errBaseline?: number;
}
export interface CoeffEvaluation {
  modelVersion: string;
  k: number;
  rows: CoeffRow[];
  /** 유효 관측 수와 예측 오차 요약. 표본이 적으면 해석에 주의 */
  n: number;
  maeModel: number | null;
  maeBaseline: number | null;
  biasModel: number | null;
  biasBaseline: number | null;
  /** 실제 RPE가 상한을 넘은 관측 비율 */
  overCapRate: number | null;
}

/** 관측 기록을 시간순으로 재생해 현재 k와 예측 오차를 계산한다. learn=false면 k를 갱신하지 않고 오차만 평가 */
export const evaluateCoefficients = (records: CoeffRecordInput[], lambda: number, clampPct: number, learn = true): CoeffEvaluation => {
  let k = 1;
  const rows: CoeffRow[] = [];
  const sorted = [...records].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const r of sorted) {
    const base = { id: r.id, kind: r.kind, at: r.at, sessionDate: r.sessionDate, kPrev: k };
    if (r.kind === 'reset') { k = 1; rows.push({ ...base, used: true, kNext: k }); continue; }
    if (r.kind === 'manual') {
      if (r.manualK && r.manualK > 0) k = r.manualK;
      rows.push({ ...base, used: true, kNext: k });
      continue;
    }
    const ok = r.refE1rm && r.obsLoad && r.obsReps && r.obsRpe && r.refE1rm > 0 && r.obsLoad > 0;
    if (!ok) { rows.push({ ...base, used: false, excludedReason: '관측값 불완전', kNext: k }); continue; }
    const valid = r.override ? r.override === 'include' : r.autoValid !== false;
    const kObs = observedK(r.obsLoad as number, r.obsReps as number, r.obsRpe as number, r.refE1rm as number);
    const clip = (p: number) => Math.min(10, Math.max(4, p));
    const predModel = clip(predictRpe(r.refE1rm as number, k, r.obsLoad as number, r.obsReps as number));
    const predBaseline = clip(predictRpe(r.refE1rm as number, 1, r.obsLoad as number, r.obsReps as number));
    const row: CoeffRow = {
      ...base, used: valid, excludedReason: valid ? undefined : (r.override === 'exclude' ? '사용자 제외' : r.excludedReason ?? '비정상 조건'),
      kNext: k, kObserved: kObs, predModel, predBaseline, actualRpe: r.obsRpe,
      errModel: (r.obsRpe as number) - predModel, errBaseline: (r.obsRpe as number) - predBaseline,
    };
    if (valid && learn) {
      const u = updateCoefficient(k, kObs, lambda, clampPct);
      row.kObservedClamped = u.kObservedClamped;
      k = u.kNext;
      row.kNext = k;
    }
    rows.push(row);
  }
  const used = rows.filter((r) => r.kind === 'observation' && r.used && r.errModel !== undefined);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const capOf = new Map(records.map((r) => [r.id, r.rpeCap ?? 8]));
  return {
    modelVersion: COEFF_MODEL_VERSION, k, rows, n: used.length,
    maeModel: mean(used.map((r) => Math.abs(r.errModel as number))), maeBaseline: mean(used.map((r) => Math.abs(r.errBaseline as number))),
    biasModel: mean(used.map((r) => r.errModel as number)), biasBaseline: mean(used.map((r) => r.errBaseline as number)),
    overCapRate: used.length ? used.filter((r) => (r.actualRpe as number) > (capOf.get(r.id) as number)).length / used.length : null,
  };
};
