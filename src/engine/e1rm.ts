// e1RM과 목표 RPE 중량 환산 — RTS(Tuchscherer) RPE 표 기반 (SRS FR-030, 2026-11-13 변경)
// RTS 표의 각 칸은 "반복수 + (10 − RPE)" 하나로 결정된다(예: 3회 @10 = 1회 @8 = 92.2%).
// 표 범위(1~12회, RPE 6~10 → 1~16) 밖은 Epley 비율로 이어 붙여 외삽한다.
export const FORMULA_VERSION = 'e1rm-rts-2.0.0';

/** RTS 표: 인덱스 i ↔ 유효 반복 e = 1 + i/2 (0.5 간격, e = 1 … 16) */
export const RTS_PCT = [
  100, 97.8, 95.5, 93.9, 92.2, 90.7, 89.2, 87.8, 86.3, 85.0, 83.7, 82.4, 81.1, 79.9, 78.6, 77.4,
  76.2, 75.1, 73.9, 72.3, 70.7, 69.4, 68.0, 66.7, 65.3, 64.0, 62.6, 61.3, 59.9, 58.6, 57.2,
] as const;
const E_MAX = 1 + (RTS_PCT.length - 1) / 2; // 16

export interface SetInputError { field: 'weight' | 'reps' | 'rpe'; message: string }

/** 계산 입력 검증. 문제가 없으면 빈 배열 */
export const validateSetInput = (weight: number, reps: number, rpe: number): SetInputError[] => {
  const errs: SetInputError[] = [];
  if (!Number.isFinite(weight) || weight <= 0) errs.push({ field: 'weight', message: '중량은 0보다 커야 합니다' });
  if (!Number.isFinite(reps) || reps < 1 || reps > 30) errs.push({ field: 'reps', message: '반복수는 1~30 범위여야 합니다' });
  if (!Number.isFinite(rpe) || rpe < 5 || rpe > 10) errs.push({ field: 'rpe', message: 'RPE는 5~10 범위여야 합니다' });
  return errs;
};
const assertValid = (w: number, r: number, p: number) => {
  const e = validateSetInput(w, r, p);
  if (e.length) throw new RangeError(e.map((x) => x.message).join(', '));
};

/**
 * 유효 반복 e에 대한 1RM 대비 비율(0~1). 표 안은 선형 보간,
 * e < 1은 첫 구간 기울기로, e > 16은 Epley 비율로 표 끝값에 이어 붙인다.
 */
export const rtsPercent = (e: number): number => {
  if (!Number.isFinite(e)) throw new RangeError('유효 반복이 올바르지 않습니다');
  if (e <= 1) return (RTS_PCT[0] + (1 - e) * 2 * (RTS_PCT[0] - RTS_PCT[1])) / 100;
  if (e >= E_MAX) return (RTS_PCT[RTS_PCT.length - 1] * (1 + (E_MAX - 1) / 30)) / (1 + (e - 1) / 30) / 100;
  const x = (e - 1) * 2;
  const i = Math.floor(x);
  const f = x - i;
  return (RTS_PCT[i] + (RTS_PCT[i + 1] - RTS_PCT[i]) * f) / 100;
};

/** rtsPercent의 역함수: 비율 q가 되는 유효 반복 e (단조 감소라 이분 탐색) */
export const rtsEffectiveReps = (q: number): number => {
  if (!(q > 0)) throw new RangeError('비율이 올바르지 않습니다');
  let lo = -20;
  let hi = 200;
  for (let n = 0; n < 80; n += 1) {
    const mid = (lo + hi) / 2;
    if (rtsPercent(mid) > q) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};

/** Top Set 기준 보수적 e1RM: RPE를 0.5 높게 본 유효 반복 r + max(0, 9.5 − p)로 RTS 표 조회 */
export const conservativeE1RM = (weight: number, reps: number, rpe: number): number => {
  assertValid(weight, reps, rpe);
  return weight / rtsPercent(reps + Math.max(0, 9.5 - rpe));
};

/** 보정 없는 역산 e1RM: 유효 반복 r + 10 − p. 관측계수·세트 간 조정에 사용 */
export const impliedE1RM = (weight: number, reps: number, rpe: number): number => {
  assertValid(weight, reps, rpe);
  return weight / rtsPercent(reps + 10 - rpe);
};

/** e1RM에서 reps회 @rpe 목표 중량(반올림 전) */
export const loadForTarget = (e1rm: number, reps: number, rpe: number): number => {
  if (!Number.isFinite(e1rm) || e1rm <= 0) throw new RangeError('e1RM이 유효하지 않습니다');
  assertValid(1, reps, rpe);
  return e1rm * rtsPercent(reps + 10 - rpe);
};
