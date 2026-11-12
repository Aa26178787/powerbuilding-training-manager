// 다음 세션 진행 판정 — 선형 증량·Double Progression·실패/정체 규칙
// 감량은 후보만 제시하며 자동 적용하지 않는다(사용자 승인 필요).
import type { IssueFlag, ProgressionAction, ProgressionModel } from '../domain/types';
import { roundLoad } from './rounding';

export const PROGRESSION_VERSION = 'progression-1.0.0';

/** 근력 실패로 세지 않는 장비·환경 문제 */
const EQUIPMENT_FLAGS: IssueFlag[] = ['equipment_failure', 'grip_slip', 'j_cup_collision'];

export interface DoneSet { weight: number | null; reps?: number; rpe?: number; flags: IssueFlag[]; type: string }
export interface ProgressionInput {
  model: ProgressionModel;
  /** 완료한 작업 세트(수행 순서) */
  sets: DoneSet[];
  /** 계획된 작업 세트 수(조기 종료·스킵 포함 전체) */
  plannedCount: number;
  targetReps?: number;
  repMin?: number;
  repMax?: number;
  rpeCap: number;
  increment: number;
  prevFailStreak: number;
  dpCriterion?: 'all_sets' | 'last_set';
  /** 추가 중량 운동의 체중: 감량 후보를 총 부하(체중+추가) 기준으로 계산 */
  bodyweight?: number;
}
export interface ProgressionResult {
  action: ProgressionAction;
  nextLoad: number | null;
  failStreak: number;
  reason: string;
  reduceOptions?: { pct: number; load: number }[];
}

export const decideProgression = (i: ProgressionInput): ProgressionResult => {
  const work = i.sets.filter((s) => s.weight !== null);
  const decisive = i.model === 'top_backoff' ? work.filter((s) => s.type === 'top') : work;
  if (!decisive.length) return { action: 'not_counted', nextLoad: null, failStreak: i.prevFailStreak, reason: '판정할 작업 세트 기록이 없습니다' };
  const used = decisive[0].weight as number;
  if (decisive.some((s) => s.flags.some((f) => EQUIPMENT_FLAGS.includes(f)))) {
    return { action: 'not_counted', nextLoad: used, failStreak: i.prevFailStreak, reason: '장비 문제 세트 — 근력 실패로 계산하지 않고 중량 유지' };
  }
  if (decisive.some((s) => s.rpe === undefined)) {
    return { action: 'not_counted', nextLoad: used, failStreak: i.prevFailStreak, reason: 'RPE 미입력 — 판정 보류, 중량 유지' };
  }
  const maxRpe = Math.max(...decisive.map((s) => s.rpe as number));
  const reps = decisive.map((s) => s.reps ?? 0);
  let success = false;
  let failed = false;
  let why = '';
  if (i.model === 'double_progression') {
    const top = i.repMax ?? i.targetReps ?? 0;
    const bottom = i.repMin ?? top;
    const judged = i.dpCriterion === 'last_set' ? [reps[reps.length - 1]] : reps;
    const allDone = i.dpCriterion === 'last_set' ? decisive.length >= 1 && work.length >= i.plannedCount : work.length >= i.plannedCount;
    success = allDone && judged.every((r) => r >= top) && maxRpe <= i.rpeCap;
    failed = reps.some((r) => r < bottom) || maxRpe > i.rpeCap;
    why = success ? `반복 상단 ${top}회 달성, RPE ${maxRpe} ≤ ${i.rpeCap} — 증량 후 ${bottom}회부터 재진행`
      : maxRpe > i.rpeCap ? `RPE ${maxRpe}로 상한 ${i.rpeCap} 초과`
      : reps.some((r) => r < bottom) ? `반복 하단 ${bottom}회 미달` : `반복 범위 진행 중 — 같은 중량으로 상단 ${top}회까지`;
  } else {
    const target = i.targetReps ?? 0;
    const allDone = i.model === 'top_backoff' ? true : work.length >= i.plannedCount;
    const repsOk = reps.every((r) => r >= target);
    success = allDone && repsOk && maxRpe <= i.rpeCap;
    failed = !success;
    why = success ? `목표 ${target}회 완료, RPE ${maxRpe} ≤ ${i.rpeCap}`
      : !repsOk ? `목표 ${target}회 미달` : maxRpe > i.rpeCap ? `RPE ${maxRpe}로 상한 ${i.rpeCap} 초과` : '계획 세트 미완료';
  }
  if (success) {
    return { action: 'increase', nextLoad: Math.round((used + i.increment) * 1000) / 1000, failStreak: 0, reason: `${why} — 다음 세션 +${i.increment}kg 제안` };
  }
  if (!failed) return { action: 'hold', nextLoad: used, failStreak: i.prevFailStreak, reason: why };
  const streak = i.prevFailStreak + 1;
  if (streak >= 3) {
    return { action: 'review', nextLoad: used, failStreak: streak, reason: `${why} — 같은 중량 3회 연속 미달. 반복수·세트 수·피로·기술을 검토하세요` };
  }
  if (streak === 2) {
    const bw = i.bodyweight ?? 0;
    const reduceOptions = [2.5, 5].map((pct) => ({
      pct, load: Math.max(0, roundLoad((used + bw) * (1 - pct / 100) - bw, i.increment, 'down')),
    }));
    return { action: 'hold_or_reduce', nextLoad: used, failStreak: streak, reason: `${why} — 2회 연속 미달. 유지 또는 2.5~5% 감량 중 선택`, reduceOptions };
  }
  return { action: 'hold', nextLoad: used, failStreak: streak, reason: `${why} — 다음 세션 중량 유지` };
};
