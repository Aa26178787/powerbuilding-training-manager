// 보수적 e1RM 및 목표 RPE 중량 환산 (SRS FR-030)
export const FORMULA_VERSION = 'e1rm-rir30-1.0.0';

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

/** Top Set 기준 보수적 e1RM: W × (1 + (r + max(0, 9.5 − p)) / 30). RPE를 0.5 높게 본 경험적 보수화 */
export const conservativeE1RM = (weight: number, reps: number, rpe: number): number => {
  assertValid(weight, reps, rpe);
  return weight * (1 + (reps + Math.max(0, 9.5 - rpe)) / 30);
};

/** 보정 없는 역산 e1RM: W × (1 + (r + 10 − p) / 30). 관측계수 계산에 사용 */
export const impliedE1RM = (weight: number, reps: number, rpe: number): number => {
  assertValid(weight, reps, rpe);
  return weight * (1 + (reps + 10 - rpe) / 30);
};

/** e1RM에서 reps회 @rpe 목표 중량(반올림 전) */
export const loadForTarget = (e1rm: number, reps: number, rpe: number): number => {
  if (!Number.isFinite(e1rm) || e1rm <= 0) throw new RangeError('e1RM이 유효하지 않습니다');
  assertValid(1, reps, rpe);
  return e1rm / (1 + (reps + 10 - rpe) / 30);
};
