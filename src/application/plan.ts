// 주간 계획 생성·프로그램 버전 관리
import type { Db, ISODate, Patch, PlannedSet, PrescriptionInstance, PrescriptionTemplate, ProgramDayTemplate, ProgramVersion, SetGroupSpec, Workout } from '../domain/types';
import { addDays, weekStart } from '../engine/dates';
import { Ctx, fail } from './ctx';

/** 해당 주에 적용되는 프로그램 버전(effectiveFrom이 그 주 이하인 것 중 최신) */
export const versionForWeek = (db: Db, ws: ISODate): ProgramVersion | null => {
  const vs = Object.values(db.versions).filter((v) => v.effectiveFrom <= ws).sort((a, b) => b.version - a.version);
  return vs[0] ?? null;
};

export const expandGroups = (groups: SetGroupSpec[]) => {
  const out: Pick<PlannedSet, 'type' | 'reps' | 'repMin' | 'repMax' | 'seconds' | 'targetRpe' | 'targetRpeMax' | 'rpeCap'>[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.count; i += 1) {
      out.push({ type: g.type, reps: g.reps, repMin: g.repMin, repMax: g.repMax, seconds: g.seconds, targetRpe: g.targetRpe, targetRpeMax: g.targetRpeMax, rpeCap: g.rpeCap });
    }
  }
  return out;
};

/** 프로그램 항목의 실제 운동: 슬롯 배정이 있으면 그 운동, 없으면 항목의 기본 운동 */
export const resolveItemExercise = (db: Db, item: PrescriptionTemplate): string => {
  const a = item.slotId ? db.settings.slotAssignments?.[item.slotId]?.exerciseId : undefined;
  return a && db.exercises[a] && !db.exercises[a].archived ? a : item.exerciseId;
};

const buildDay = (db: Db, v: ProgramVersion, day: ProgramDayTemplate, date: ISODate) => {
  const workout: Workout = { id: `pb:${date}`, track: 'pb', label: `${day.label}요일 세션`, originalDate: date, versionId: v.id, closedAs: null, rev: 1 };
  const instances: PrescriptionInstance[] = [];
  const sets: PlannedSet[] = [];
  day.items.forEach((item: PrescriptionTemplate, idx) => {
    // 슬롯 처방이면 지금 슬롯에 배정된 운동으로 만든다(처방 세트·반복·RPE는 그대로)
    const exerciseId = resolveItemExercise(db, item);
    const ex = db.exercises[exerciseId];
    const inst: PrescriptionInstance = {
      id: `pb:${date}:${item.id}`, workoutId: workout.id, track: 'pb', exerciseId,
      exerciseName: ex?.name ?? exerciseId, ...(item.slotId ? { slotId: item.slotId } : {}), order: idx * 10, model: item.model, groups: structuredClone(item.groups),
      required: item.required, dpCriterion: item.dpCriterion, originalDate: date, rev: 1,
    };
    instances.push(inst);
    expandGroups(item.groups).forEach((s, i) => sets.push({
      id: `${inst.id}:${i}`, instanceId: inst.id, workoutId: workout.id, track: 'pb', exerciseId, index: i,
      ...s, originalDate: date, plannedDate: date, status: 'planned', inOriginalPlan: true, rev: 1,
    }));
  });
  return { workout, instances, sets };
};

/** 프로그램 시작 주 이후의 주간 계획을 스냅샷으로 생성(이미 있으면 건너뜀 — 멱등) */
export const ensureWeeks = (db: Db, weekStarts: ISODate[]): Patch => {
  const patch: Required<Pick<Patch, 'put'>> = { put: { workouts: [], instances: [], plannedSets: [] } };
  const start = db.settings.programStart;
  if (!start) return {};
  for (const ws of [...new Set(weekStarts.map(weekStart))]) {
    if (ws < weekStart(start)) continue;
    const v = versionForWeek(db, ws);
    if (!v) continue;
    for (const day of v.days) {
      const date = addDays(ws, day.weekday - 1);
      if (date < start || db.workouts[`pb:${date}`] || !day.items.length) continue;
      const b = buildDay(db, v, day, date);
      patch.put.workouts!.push(b.workout);
      patch.put.instances!.push(...b.instances);
      patch.put.plannedSets!.push(...b.sets);
    }
  }
  return patch.put.workouts!.length ? patch : {};
};

/** 손대지 않은 미래 주(다음 주 이후)의 계획을 지워 새 버전으로 다시 생성되게 한다 */
export const dropUntouchedFuture = (db: Db, fromWeek: ISODate): Patch => {
  const del = { workouts: [] as string[], instances: [] as string[], plannedSets: [] as string[] };
  for (const w of Object.values(db.workouts)) {
    if (w.track !== 'pb' || w.originalDate < fromWeek || w.closedAs) continue;
    const sets = Object.values(db.plannedSets).filter((s) => s.workoutId === w.id);
    const untouched = sets.every((s) => s.status === 'planned' && s.plannedDate === s.originalDate && s.inOriginalPlan);
    if (!untouched) continue;
    del.workouts.push(w.id);
    del.plannedSets.push(...sets.map((s) => s.id));
    del.instances.push(...Object.values(db.instances).filter((i) => i.workoutId === w.id).map((i) => i.id));
  }
  return { del };
};

/** 새 프로그램 버전의 적용 시작 주: 시작 전이면 시작 주, 시작 후면 다음 주 */
export const nextEffectiveFrom = (db: Db, today: ISODate, noStartFallback?: ISODate): ISODate => {
  const thisWeek = weekStart(today);
  const start = db.settings.programStart;
  if (!start) return noStartFallback ?? thisWeek;
  return weekStart(start) <= thisWeek ? addDays(thisWeek, 7) : weekStart(start);
};

/**
 * 프로그램 편집 저장: 새 버전을 만들고 다음 주부터 적용한다.
 * 이번 주는 기간 시작 스냅샷을 유지하며, 과거 세션의 처방·기록은 바뀌지 않는다.
 */
export const saveProgramVersion = (db: Db, days: ProgramDayTemplate[], changeNote: string, ctx: Ctx): Patch => {
  if (!days.length) fail('요일 구성이 비어 있습니다');
  for (const d of days) for (const it of d.items) {
    if (!db.exercises[it.exerciseId]) fail(`운동을 찾을 수 없습니다: ${it.exerciseId}`);
    for (const g of it.groups) {
      if (!(g.count >= 1 && g.count <= 20)) fail('세트 수는 1~20 범위여야 합니다');
      if (g.rpeCap < 5 || g.rpeCap > 10) fail('RPE 상한이 올바르지 않습니다');
    }
  }
  const latest = Object.values(db.versions).sort((a, b) => b.version - a.version)[0];
  const effectiveFrom = nextEffectiveFrom(db, ctx.today);
  const version: ProgramVersion = {
    id: `pv-${ctx.newId()}`, name: latest?.name ?? 'Program', version: (latest?.version ?? 0) + 1,
    createdAt: ctx.now, effectiveFrom, days: structuredClone(days), changeNote,
  };
  return { put: { versions: [version] }, ...dropUntouchedFuture(db, effectiveFrom) };
};
