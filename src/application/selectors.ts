// 화면용 조회 모델(읽기 전용). 계산은 engine에 위임한다.
import type { Db, Exercise, ISODate, PerformedSet, PlannedSet, PrescriptionInstance, Workout } from '../domain/types';
import { armDayAdherence, calculateAchievement } from '../engine/achievement';
import { deriveWorkoutStatus, WorkoutStatus } from '../engine/status';

export interface DayGroupView {
  instance: PrescriptionInstance;
  workout: Workout;
  exercise: Exercise;
  /** 이 날짜에 배정된 세트(삭제·면제 제외), 순서대로 */
  sets: PlannedSet[];
  performed: Record<string, PerformedSet[]>;
  extras: PerformedSet[];
  movedFrom: ISODate | null;
}

export const dayView = (db: Db, date: ISODate): DayGroupView[] => {
  const perf = Object.values(db.performed).filter((p) => !p.deleted);
  const groups = new Map<string, DayGroupView>();
  for (const s of Object.values(db.plannedSets)) {
    if (s.plannedDate !== date || s.status === 'removed' || s.status === 'excused') continue;
    const instance = db.instances[s.instanceId];
    const workout = instance && db.workouts[instance.workoutId];
    const exercise = instance && db.exercises[instance.exerciseId];
    if (!instance || !workout || !exercise) continue;
    let g = groups.get(instance.id);
    if (!g) {
      g = { instance, workout, exercise, sets: [], performed: {}, extras: [], movedFrom: instance.originalDate !== date ? instance.originalDate : null };
      groups.set(instance.id, g);
    }
    g.sets.push(s);
  }
  // 원본 누락으로 세트가 없는 ARM 처방도 카드로 보여 준다
  for (const inst of Object.values(db.instances)) {
    if (!inst.arm || groups.has(inst.id) || !inst.arm.sourceMissing.includes('sets_reps')) continue;
    const sibling = Object.values(db.plannedSets).find((s) => s.workoutId === inst.workoutId && s.status !== 'removed');
    if ((sibling?.plannedDate ?? inst.originalDate) !== date) continue;
    if (Object.values(db.plannedSets).some((s) => s.instanceId === inst.id)) continue;
    groups.set(inst.id, { instance: inst, workout: db.workouts[inst.workoutId], exercise: db.exercises[inst.exerciseId], sets: [], performed: {}, extras: [], movedFrom: null });
  }
  for (const g of groups.values()) {
    g.sets.sort((a, b) => a.index - b.index);
    for (const p of perf) {
      if (p.instanceId !== g.instance.id) continue;
      if (p.plannedSetId) g.performed[p.plannedSetId] = [...(g.performed[p.plannedSetId] ?? []), p];
      else if (p.sessionDate === date) g.extras.push(p);
    }
  }
  return [...groups.values()].sort((a, b) => a.instance.order - b.instance.order || a.instance.originalDate.localeCompare(b.instance.originalDate) || a.instance.id.localeCompare(b.instance.id));
};

export const workoutStatuses = (db: Db, today: ISODate): Map<string, WorkoutStatus> => {
  const byWorkout = new Map<string, PlannedSet[]>();
  const byDate = new Map<ISODate, Set<string>>();
  for (const s of Object.values(db.plannedSets)) {
    byWorkout.set(s.workoutId, [...(byWorkout.get(s.workoutId) ?? []), s]);
    if (s.status === 'removed' || s.status === 'excused') continue;
    if (!byDate.has(s.plannedDate)) byDate.set(s.plannedDate, new Set());
    byDate.get(s.plannedDate)!.add(s.workoutId);
  }
  const out = new Map<string, WorkoutStatus>();
  for (const w of Object.values(db.workouts)) out.set(w.id, deriveWorkoutStatus(w, byWorkout.get(w.id) ?? [], today, byDate));
  return out;
};

export const periodAchievement = (db: Db, period: { start: ISODate; end: ISODate }, today: ISODate) => {
  const plannedSets = Object.values(db.plannedSets);
  const perf = Object.values(db.performed).filter((p) => !p.deleted);
  const base = { plannedSets, period, today };
  const pbDates = perf.filter((p) => !p.exerciseId.startsWith('arm:')).map((p) => p.sessionDate);
  const extra = (arm: boolean) => perf.filter((p) => p.plannedSetId === null && p.type !== 'warmup' && p.exerciseId.startsWith('arm:') === arm && p.sessionDate >= period.start && p.sessionDate <= period.end).length;
  return {
    pb: calculateAchievement({ ...base, performedDates: pbDates, extraSetCount: extra(false), track: 'pb' }),
    arm: calculateAchievement({ ...base, performedDates: perf.filter((p) => p.exerciseId.startsWith('arm:')).map((p) => p.sessionDate), extraSetCount: extra(true), track: 'arm' }),
    all: calculateAchievement({ ...base, performedDates: perf.map((p) => p.sessionDate), extraSetCount: extra(true) + extra(false), track: 'all' }),
    armDays: armDayAdherence(plannedSets, period),
  };
};

/** 날짜별 요약(캘린더 표시용) */
export const daySummary = (db: Db, date: ISODate) => {
  const sets = Object.values(db.plannedSets).filter((s) => s.plannedDate === date && s.status !== 'removed');
  const live = sets.filter((s) => s.status !== 'excused');
  return {
    total: live.length, done: live.filter((s) => s.status === 'done').length, open: live.filter((s) => s.status === 'planned').length,
    excused: sets.filter((s) => s.status === 'excused').length,
    workoutIds: [...new Set(sets.map((s) => s.workoutId))],
    hasArm: live.some((s) => s.track === 'arm'), hasPb: live.some((s) => s.track === 'pb'),
    visited: Object.values(db.performed).some((p) => !p.deleted && p.sessionDate === date),
  };
};
