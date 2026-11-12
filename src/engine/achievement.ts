// 주·월간 달성률 계산 (SRS FR-120~123, 보완 C)
// 크레딧은 항상 원래 계획일(originalDate)의 기간에 귀속한다.
import type { ISODate, PlannedSet, Track } from '../domain/types';

export const ACHIEVEMENT_VERSION = 'achievement-1.0.0';

export interface AchievementInput {
  plannedSets: PlannedSet[];
  /** 실제 수행 기록의 귀속 훈련일 목록(방문 수 계산용, 삭제 기록 제외) */
  performedDates: ISODate[];
  /** 계획에 없는 추가 자유 세트 수(달성률 분자에 넣지 않음) */
  extraSetCount: number;
  period: { start: ISODate; end: ISODate };
  today: ISODate;
  track: Track | 'all';
}
export interface Ratio { done: number; total: number; pct: number | null }
export interface AchievementResult {
  version: string;
  /** 원본 계획 달성률: 완료한 원본 계획 세트 ÷ 원본 계획 세트 */
  original: Ratio;
  /** 조정 계획 이행률: 완료 ÷ (원본 − 승인된 면제·삭제·조기 종료 + 승인된 추가) */
  adjusted: Ratio;
  /** 기한 경과분 이행률: 현재 계획일이 오늘 이전인 세트만 대상 */
  dueSoFar: Ratio;
  /** 실제 방문일 ÷ 원래 계획 방문일(병합하면 방문은 1회) */
  visits: { actual: number; planned: number };
  excusedSets: number;
  removedSets: number;
  autoregSkippedSets: number;
  skippedSets: number;
  addedSets: number;
  extraSets: number;
  movedSets: number;
}

const ratio = (done: number, total: number): Ratio => ({
  done, total,
  // 분모 0이면 100%가 아니라 '계획 없음'(null). 100% 초과 금지
  pct: total > 0 ? Math.min(100, Math.round((done / total) * 1000) / 10) : null,
});

export const calculateAchievement = (i: AchievementInput): AchievementResult => {
  const inPeriod = (d: ISODate) => d >= i.period.start && d <= i.period.end;
  const sets = i.plannedSets.filter((s) => inPeriod(s.originalDate) && (i.track === 'all' || s.track === i.track));
  const orig = sets.filter((s) => s.inOriginalPlan);
  const added = sets.filter((s) => !s.inOriginalPlan && s.status !== 'removed');
  const exempt = (s: PlannedSet) => s.status === 'excused' || s.status === 'removed' || s.status === 'skipped_by_autoregulation';
  const adjustedPool = [...orig.filter((s) => !exempt(s)), ...added.filter((s) => !exempt(s))];
  const due = adjustedPool.filter((s) => s.plannedDate <= i.today);
  const isDone = (s: PlannedSet) => s.status === 'done';
  const plannedVisitDays = new Set(orig.map((s) => s.originalDate));
  const actualVisitDays = new Set(i.performedDates.filter(inPeriod));
  return {
    version: ACHIEVEMENT_VERSION,
    original: ratio(orig.filter(isDone).length, orig.length),
    adjusted: ratio(adjustedPool.filter(isDone).length, adjustedPool.length),
    dueSoFar: ratio(due.filter(isDone).length, due.length),
    visits: { actual: actualVisitDays.size, planned: plannedVisitDays.size },
    excusedSets: sets.filter((s) => s.status === 'excused').length,
    removedSets: sets.filter((s) => s.status === 'removed' && s.inOriginalPlan).length,
    autoregSkippedSets: sets.filter((s) => s.status === 'skipped_by_autoregulation').length,
    skippedSets: sets.filter((s) => s.status === 'skipped').length,
    addedSets: added.length,
    extraSets: i.extraSetCount,
    movedSets: sets.filter((s) => s.plannedDate !== s.originalDate && s.status !== 'removed').length,
  };
};

/** ARM Day 이행률: 기간 내 배정된 ARM Day 중 활성 세트를 모두 완료한 Day 수 */
export const armDayAdherence = (plannedSets: PlannedSet[], period: { start: ISODate; end: ISODate }): Ratio => {
  const byWorkout = new Map<string, PlannedSet[]>();
  for (const s of plannedSets) {
    if (s.track !== 'arm' || s.originalDate < period.start || s.originalDate > period.end) continue;
    byWorkout.set(s.workoutId, [...(byWorkout.get(s.workoutId) ?? []), s]);
  }
  let done = 0;
  for (const sets of byWorkout.values()) {
    const active = sets.filter((s) => s.status !== 'removed' && s.status !== 'excused');
    if (active.length > 0 && active.every((s) => s.status === 'done')) done += 1;
  }
  return ratio(done, byWorkout.size);
};
