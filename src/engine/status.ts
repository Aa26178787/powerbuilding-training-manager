// 세션(원본 계획 단위) 상태 도출 (보완 B)
import type { ISODate, PlannedSet, Workout } from '../domain/types';

export type WorkoutStatus =
  | 'planned' | 'in_progress' | 'completed' | 'partial' | 'missed' | 'rescheduled'
  | 'merged' | 'excused' | 'cancelled' | 'overdue';

export const STATUS_LABEL: Record<WorkoutStatus, string> = {
  planned: '예정', in_progress: '진행 중', completed: '완료', partial: '일부 수행', missed: '미수행',
  rescheduled: '이동됨', merged: '병합됨', excused: '면제', cancelled: '취소', overdue: '기한 경과·미확정',
};

/**
 * 날짜가 지났다는 이유만으로 missed로 확정하지 않는다.
 * 사용자가 확정(closedAs)하기 전에는 overdue(기한 경과·미확정)로 표시해 이동·병합 여지를 남긴다.
 */
export const deriveWorkoutStatus = (
  w: Workout, sets: PlannedSet[], today: ISODate,
  /** 날짜별로 그 날에 세트가 있는 workoutId 집합(병합 여부 판단) */
  workoutsByDate: Map<ISODate, Set<string>>,
): WorkoutStatus => {
  if (w.closedAs) return w.closedAs;
  const active = sets.filter((s) => s.status !== 'removed');
  if (!active.length) return 'cancelled';
  if (active.every((s) => s.status === 'excused')) return 'excused';
  const done = active.filter((s) => s.status === 'done').length;
  const open = active.filter((s) => s.status === 'planned');
  if (done > 0 && open.length === 0) {
    return active.every((s) => s.status === 'done' || s.status === 'excused') ? 'completed' : 'partial';
  }
  if (done > 0) return 'in_progress';
  if (open.length === 0) return 'partial';
  const moved = open.filter((s) => s.plannedDate !== s.originalDate);
  if (moved.length === open.length) {
    const shared = moved.some((s) => (workoutsByDate.get(s.plannedDate)?.size ?? 0) > 1);
    return shared ? 'merged' : 'rescheduled';
  }
  const latest = open.reduce((m, s) => (s.plannedDate > m ? s.plannedDate : m), open[0].plannedDate);
  return latest < today ? 'overdue' : 'planned';
};
