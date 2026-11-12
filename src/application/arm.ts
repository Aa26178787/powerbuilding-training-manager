// ARM SYSTEM 유스케이스: 처방 조회, Day 배정(수동 승인 진행), 원본 누락값 직접 입력, 교정·영상 링크
// 원본 처방은 임의로 보완·합산하지 않는다. ARM RPE 9~9.5는 일반 SBD 상한 8로 덮어쓰지 않는다.
import type { ArmData, ArmOverride, ArmPrescription, Db, Exercise, ISODate, Patch, PlannedSet, PrescriptionInstance, ScheduleChange, Workout } from '../domain/types';
import { isArmOverlapExercise } from '../domain/defaults';
import { Ctx, applyPatch, fail, mergePatches } from './ctx';
import { addDays, fmtDateKo, weekdayOf } from '../engine/dates';

export interface ArmDayRef { dayIndex: number; block: string; week: number; day: number }

/** 블록 순서 × 12주 × 3일 = 108일의 진행 순서 */
export const armDayList = (arm: ArmData): ArmDayRef[] => {
  const out: ArmDayRef[] = [];
  for (const block of arm.blockOrder) {
    const weeks = [...new Set(arm.exercises.filter((e) => e.block === block).map((e) => e.week))].sort((a, b) => a - b);
    for (const week of weeks) {
      const days = [...new Set(arm.exercises.filter((e) => e.block === block && e.week === week).map((e) => e.day))].sort((a, b) => a - b);
      for (const day of days) out.push({ dayIndex: out.length, block, week, day });
    }
  }
  return out;
};

/** 사용자 교정값을 반영한 처방(원문은 그대로 두고 별도 필드로 덮어씀) */
export const effectiveArm = (p: ArmPrescription, o?: ArmOverride): ArmPrescription => {
  if (!o) return p;
  const n = { ...p, sets: o.sets !== undefined ? o.sets : p.sets, reps: o.reps !== undefined ? o.reps : p.reps, duration_seconds: o.duration_seconds !== undefined ? o.duration_seconds : p.duration_seconds, rpe: o.rpe !== undefined ? o.rpe : p.rpe };
  const missing: string[] = [];
  if (n.sets === null || (n.reps === null && n.duration_seconds === null)) missing.push('sets_reps');
  if (n.rpe === null && n.rpe_range === null && n.percent_1rm === null) missing.push('intensity');
  return { ...n, source_missing: missing };
};

export const armDayPrescriptions = (db: Db, ref: ArmDayRef, activeOnly = true): ArmPrescription[] =>
  (db.arm?.exercises ?? []).filter((e) => e.block === ref.block && e.week === ref.week && e.day === ref.day)
    .filter((e) => !activeOnly || !isArmOverlapExercise(e.exercise))
    .sort((a, b) => a.order - b.order).map((e) => effectiveArm(e, db.armOverrides[e.id]));

const armExerciseId = (key: string) => `arm:${key}`;

const armPlannedSets = (inst: PrescriptionInstance, workoutId: string, date: ISODate, p: { sets: number; reps: number | null; seconds: number | null; rpe: number | null; rpeRange: [number, number] | null; isStatic: boolean }): PlannedSet[] =>
  Array.from({ length: p.sets }, (_, i) => ({
    id: `${inst.id}:${i}`, instanceId: inst.id, workoutId, track: 'arm', exerciseId: inst.exerciseId, index: i,
    type: p.isStatic ? 'arm_static' : 'arm', reps: p.reps ?? undefined, seconds: p.seconds ?? undefined,
    targetRpe: p.rpe ?? p.rpeRange?.[0] ?? undefined, targetRpeMax: p.rpeRange?.[1] ?? undefined,
    rpeCap: 10, // ARM은 PDF 처방 RPE가 우선(일반 상한 8 미적용)
    originalDate: date, plannedDate: date, status: 'planned', inOriginalPlan: true, rev: 1,
  }));

/**
 * 다음 ARM Day를 달력 날짜에 배정한다(= 사용자 승인으로 Week/Day 진행).
 * 배정 시점의 처방을 스냅샷으로 생성하며, 미래 ARM 세트를 미리 분모에 넣지 않는다.
 */
export const assignArmDay = (db: Db, dayIndex: number, date: ISODate, ctx: Ctx): Patch => {
  const arm = db.arm ?? fail('ARM 데이터를 먼저 가져오세요');
  const ref = armDayList(arm)[dayIndex] ?? fail('배정할 ARM Day가 없습니다(프로그램 종료)');
  const workoutId = `arm:${dayIndex}`;
  if (db.workouts[workoutId]) fail('이미 배정한 ARM Day입니다');
  const list = armDayPrescriptions(db, ref, true);
  if (!list.length) fail('이 Day에 활성 ARM 처방이 없습니다');
  const workout: Workout = { id: workoutId, track: 'arm', label: `ARM · ${ref.block} W${ref.week} D${ref.day}`, originalDate: date, arm: ref, closedAs: null, rev: 1 };
  const exercises: Exercise[] = [];
  const instances: PrescriptionInstance[] = [];
  const sets: PlannedSet[] = [];
  list.forEach((p, idx) => {
    const exId = armExerciseId(p.exercise_key);
    if (!db.exercises[exId] && !exercises.some((e) => e.id === exId)) {
      exercises.push({ id: exId, name: p.exercise, role: 'arm', pattern: 'arm', increment: 0.5, rounding: 'nearest', loadMode: 'external', barbell: false });
    }
    const inst: PrescriptionInstance = {
      id: `${workoutId}:${p.id}`, workoutId, track: 'arm', exerciseId: exId, exerciseName: p.exercise, order: 1000 + idx * 10, model: 'arm_manual',
      groups: [], required: false, originalDate: date, rev: 1,
      arm: { prescriptionId: p.id, sourcePage: p.source_page, sourceText: p.prescription_source, rom: p.rom, execution: p.execution, notes: p.notes, loadNote: p.load_note, percent1rm: p.percent_1rm, rpe: p.rpe, rpeRange: p.rpe_range, sourceMissing: p.source_missing },
    };
    instances.push(inst);
    // 세트·반복 정보가 원본에 없으면 세트를 만들지 않고 '직접 입력 필요'로 둔다
    if (p.sets !== null && (p.reps !== null || p.duration_seconds !== null)) {
      sets.push(...armPlannedSets(inst, workoutId, date, { sets: p.sets, reps: p.reps, seconds: p.duration_seconds, rpe: p.rpe, rpeRange: p.rpe_range, isStatic: p.is_static }));
    }
  });
  const change: ScheduleChange = {
    id: `c-${ctx.newId()}`, type: 'arm_assign', reason: 'user_choice', createdAt: ctx.now, approvedAt: ctx.now, setPatches: [],
    createdSetIds: sets.map((s) => s.id), orderPatches: [], warnings: [], summary: `${fmtDateKo(date)}에 ${workout.label} 배정`,
  };
  return {
    put: { workouts: [workout], instances, plannedSets: sets, exercises, changes: [change] },
    settings: { armCursor: Math.max(db.settings.armCursor, dayIndex + 1) },
  };
};

/** 기본 요일 기준으로 다음 ARM Day들을 놓을 날짜 제안: 오늘 이후, 아직 ARM이 없는 날, 이번 주에 자리가 없으면 다음 주 */
export const suggestArmDates = (db: Db, today: ISODate): { ref: ArmDayRef; date: ISODate }[] => {
  if (!db.arm) return [];
  const days = armDayList(db.arm);
  const prefer = db.settings.armMode === 3 ? db.settings.armWeekdays3 : db.settings.armWeekdays2;
  const taken = new Set(Object.values(db.plannedSets).filter((s) => s.track === 'arm' && s.status !== 'removed').map((s) => s.plannedDate));
  const monday = addDays(today, 1 - weekdayOf(today));
  const pick = (start: ISODate) => [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(start, n)).filter((d) => d >= today && prefer.includes(weekdayOf(d)) && !taken.has(d));
  let dates = pick(monday);
  if (!dates.length) dates = pick(addDays(monday, 7));
  return dates.map((date, i) => ({ ref: days[db.settings.armCursor + i], date })).filter((x) => x.ref);
};

/** 여러 Day를 한 번에 배정(각 Day는 독립된 스냅샷으로 생성, 처방을 합치지 않음) */
export const assignArmDays = (db: Db, plan: { dayIndex: number; date: ISODate }[], ctx: Ctx): Patch => {
  if (!plan.length) fail('배정할 Day가 없습니다');
  let cur = db;
  let patch: Patch = {};
  for (const p of plan) {
    const one = assignArmDay(cur, p.dayIndex, p.date, ctx);
    patch = mergePatches(patch, one);
    cur = applyPatch(cur, one);
  }
  return patch;
};

/** 아직 아무것도 기록하지 않은 ARM Day 배정 취소(커서를 되돌려 다시 배정 가능) */
export const unassignArmDay = (db: Db, workoutId: string): Patch => {
  const w = db.workouts[workoutId] ?? fail('ARM Day를 찾을 수 없습니다');
  if (w.track !== 'arm' || !w.arm) fail('ARM Day가 아닙니다');
  const sets = Object.values(db.plannedSets).filter((s) => s.workoutId === workoutId);
  if (sets.some((s) => s.status === 'done') || Object.values(db.performed).some((p) => !p.deleted && p.instanceId?.startsWith(`${workoutId}:`))) fail('기록이 있는 ARM Day는 배정을 취소할 수 없습니다');
  const later = Object.values(db.workouts).some((x) => x.track === 'arm' && x.arm && x.arm.dayIndex > w.arm!.dayIndex);
  return {
    del: { workouts: [workoutId], plannedSets: sets.map((s) => s.id), instances: Object.values(db.instances).filter((i) => i.workoutId === workoutId).map((i) => i.id) },
    ...(later ? {} : { settings: { armCursor: w.arm!.dayIndex } }),
  };
};

/** 원본 누락 항목에 사용자가 세트·반복·RPE를 직접 입력 → 그 값으로 세트 생성 */
export const fillArmMissing = (db: Db, instanceId: string, v: { sets: number; reps: number | null; seconds: number | null; rpe: number | null }): Patch => {
  const inst = db.instances[instanceId] ?? fail('처방을 찾을 수 없습니다');
  if (!inst.arm) fail('ARM 처방이 아닙니다');
  if (!(v.sets >= 1 && v.sets <= 20)) fail('세트 수는 1~20 범위여야 합니다');
  if (v.reps === null && v.seconds === null) fail('반복수 또는 유지 시간을 입력하세요');
  if (v.rpe !== null && (v.rpe < 5 || v.rpe > 10)) fail('RPE는 5~10 범위여야 합니다');
  const existing = Object.values(db.plannedSets).filter((s) => s.instanceId === instanceId);
  const arm = { ...inst.arm!, userFilled: true, rpe: inst.arm!.rpe ?? v.rpe, sourceMissing: [] };
  if (existing.length) {
    // 강도만 누락된 경우: 기존 세트의 목표 RPE만 채운다
    return { put: { instances: [{ ...inst, arm, rev: inst.rev + 1 }], plannedSets: existing.filter((s) => s.status === 'planned').map((s) => ({ ...s, targetRpe: s.targetRpe ?? v.rpe ?? undefined, rev: s.rev + 1 })) } };
  }
  const date = inst.originalDate;
  const sets = armPlannedSets(inst, inst.workoutId, date, { sets: v.sets, reps: v.reps, seconds: v.seconds, rpe: v.rpe ?? inst.arm!.rpe, rpeRange: inst.arm!.rpeRange, isStatic: v.seconds !== null });
  // 같은 Day의 다른 세트가 이미 옮겨졌다면 그 날짜를 따른다
  const sibling = Object.values(db.plannedSets).find((s) => s.workoutId === inst.workoutId && s.status === 'planned');
  return { put: { instances: [{ ...inst, arm, rev: inst.rev + 1 }], plannedSets: sets.map((s) => ({ ...s, plannedDate: sibling?.plannedDate ?? date })) } };
};

export const saveArmOverride = (db: Db, o: Omit<ArmOverride, 'verifiedAt'>, ctx: Ctx): Patch => {
  if (!db.arm?.exercises.some((e) => e.id === o.id)) fail('ARM 처방을 찾을 수 없습니다');
  for (const k of ['sets', 'reps', 'duration_seconds', 'rpe'] as const) {
    const val = o[k];
    if (val !== undefined && val !== null && (!Number.isFinite(val) || val < 0 || val > 600)) fail('교정값을 확인하세요');
  }
  return { put: { armOverrides: [{ ...o, verifiedAt: ctx.now }] } };
};
export const clearArmOverride = (id: string): Patch => ({ del: { armOverrides: [id] } });

/** 영상 링크는 HTTPS만 허용 */
export const isSafeHttpsUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch { return false; }
};
export const saveArmVideoLink = (categoryId: string, url: string, ctx: Ctx): Patch => {
  const trimmed = url.trim();
  if (!trimmed) return { del: { armLinks: [categoryId] } };
  if (!isSafeHttpsUrl(trimmed) || trimmed.length > 500) fail('HTTPS 주소만 등록할 수 있습니다');
  return { put: { armLinks: [{ id: categoryId, url: trimmed, updatedAt: ctx.now }] } };
};

/** 운동명 → 영상 카테고리 매칭(정확히 대응되는 것만) */
export const videoCategoryFor = (arm: ArmData, exerciseName: string): string | null => {
  const norm = (s: string) => s.toLowerCase().replace(/s\b/g, '').replace(/[^a-z]/g, '');
  const n = norm(exerciseName.replace(/^static\s+/i, '').replace(/^weighted\s+/i, ''));
  const hit = arm.videoLibrary.find((c) => norm(c.title) === n) ?? arm.videoLibrary.find((c) => n.startsWith(norm(c.title)) || norm(c.title).startsWith(n));
  return hit?.id ?? null;
};
