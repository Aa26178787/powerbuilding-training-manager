// 운동 슬롯: 슬롯 운동 선택·교체, 중복 경고, 슬롯·운동 패턴 집계
import type { Db, Exercise, ISODate, Patch, PerformedSet, PlannedSet, PrescriptionInstance, TrainingSlot } from '../domain/types';
import { allSlots, movementOf, slotById } from '../domain/slots';
import { versionForWeek, resolveItemExercise } from './plan';
import { weekStart } from '../engine/dates';
import { Ctx, fail } from './ctx';

const liveDone = (db: Db) => Object.values(db.performed).filter((p) => !p.deleted && p.type !== 'warmup');

/** 슬롯에서 고를 수 있는 운동(즐겨찾기 먼저) */
export const slotOptions = (db: Db, slotId: string): Exercise[] => {
  const fav = new Set(db.settings.favorites ?? []);
  return Object.values(db.exercises)
    .filter((e) => !e.archived && e.role !== 'arm' && (e.slotIds ?? []).includes(slotId))
    .sort((a, b) => Number(fav.has(b.id)) - Number(fav.has(a.id)) || a.name.localeCompare(b.name));
};

/** 이 슬롯의 지금 운동(배정이 없으면 프로그램 항목의 기본 운동) */
export const currentSlotExercise = (db: Db, slotId: string, today: ISODate): string | null => {
  const a = db.settings.slotAssignments?.[slotId]?.exerciseId;
  if (a && db.exercises[a]) return a;
  const v = versionForWeek(db, weekStart(today));
  for (const d of v?.days ?? []) for (const it of d.items) if (it.slotId === slotId) return resolveItemExercise(db, it);
  return null;
};

/** 프로그램에서 고정 운동으로 이미 하는 동작인지 확인. 자동으로 빼거나 바꾸지 않고 경고만 한다 */
export const duplicateWarnings = (db: Db, exerciseId: string, today: ISODate): string[] => {
  const ex = db.exercises[exerciseId];
  if (!ex) return [];
  const v = versionForWeek(db, weekStart(today));
  const fixedIds = new Set<string>();
  for (const d of v?.days ?? []) for (const it of d.items) if (!it.slotId && db.exercises[it.exerciseId]?.fixed) fixedIds.add(it.exerciseId);
  const out: string[] = [];
  if (fixedIds.has(ex.id)) {
    out.push(`${ex.name}은(는) 이미 고정 운동으로 하고 있습니다. 같은 운동을 보조 슬롯에서 또 하면 주간 부담이 겹칩니다.`);
    return out;
  }
  for (const id of fixedIds) {
    const f = db.exercises[id];
    // 같은 동작의 Volume 처방처럼 일부러 짝지은 운동(relatedOf)은 경고하지 않는다
    if (ex.relatedOf?.exerciseId === f.id) continue;
    if (f.pattern === ex.pattern && ex.pattern !== 'other') out.push(`${f.name}와(과) 같은 동작 계열입니다. 중복 수행이 될 수 있습니다.`);
  }
  return out;
};

const instanceUntouched = (db: Db, inst: PrescriptionInstance) => {
  const sets = Object.values(db.plannedSets).filter((s) => s.instanceId === inst.id);
  return sets.length > 0 && sets.every((s) => s.status === 'planned') && !Object.values(db.performed).some((p) => p.instanceId === inst.id && !p.deleted);
};

const retarget = (db: Db, inst: PrescriptionInstance, exerciseId: string, sets: PlannedSet[]) => ({
  inst: { ...inst, exerciseId, exerciseName: db.exercises[exerciseId].name, rev: inst.rev + 1 },
  sets: sets.map((s) => ({ ...s, exerciseId, rev: s.rev + 1 })),
});

/**
 * 슬롯 운동 바꾸기: 슬롯 배정을 바꾸고, 오늘 이후 아직 손대지 않은 같은 슬롯 계획도 새 운동으로 바꾼다.
 * 지난 기록·다른 운동의 진행 상태는 그대로다. 예전 운동으로 돌아오면 그 운동의 마지막 진행 상태를 그대로 쓴다.
 */
export const assignSlot = (db: Db, slotId: string, exerciseId: string, ctx: Ctx, opts: { fromDate?: ISODate } = {}): Patch => {
  if (!slotById(db, slotId)) fail('슬롯을 찾을 수 없습니다');
  const ex = db.exercises[exerciseId];
  if (!ex || ex.archived) fail('운동을 찾을 수 없습니다');
  const from = opts.fromDate ?? ctx.today;
  const instances: PrescriptionInstance[] = [];
  const plannedSets: PlannedSet[] = [];
  for (const inst of Object.values(db.instances)) {
    if (inst.track !== 'pb' || inst.slotId !== slotId || inst.originalDate < from || inst.exerciseId === exerciseId || !instanceUntouched(db, inst)) continue;
    const r = retarget(db, inst, exerciseId, Object.values(db.plannedSets).filter((s) => s.instanceId === inst.id));
    instances.push(r.inst); plannedSets.push(...r.sets);
  }
  return {
    settings: { slotAssignments: { ...db.settings.slotAssignments, [slotId]: { slotId, exerciseId, since: ctx.now } } },
    put: { instances, plannedSets },
  };
};

/**
 * 오늘 처방 하나의 운동만 바꾸기. 완료한 세트가 있으면 그 기록은 원래 운동에 두고,
 * 남은 세트만 새 운동으로 옮긴다(세트 수·반복·RPE 처방과 달성률 계산은 그대로).
 */
export const swapInstanceExercise = (db: Db, instanceId: string, exerciseId: string, ctx: Ctx): Patch => {
  const inst = db.instances[instanceId];
  if (!inst) fail('처방을 찾을 수 없습니다');
  const ex = db.exercises[exerciseId];
  if (!ex || ex.archived) fail('운동을 찾을 수 없습니다');
  if (inst.exerciseId === exerciseId) return {};
  const sets = Object.values(db.plannedSets).filter((s) => s.instanceId === instanceId);
  const open = sets.filter((s) => s.status === 'planned');
  if (!open.length) fail('남은 세트가 없어 운동을 바꿀 수 없습니다');
  if (open.length === sets.length && !Object.values(db.performed).some((p) => p.instanceId === instanceId && !p.deleted)) {
    const r = retarget(db, inst, exerciseId, sets);
    return { put: { instances: [r.inst], plannedSets: r.sets } };
  }
  // 나눠서: 남은 세트를 새 처방(같은 슬롯·같은 처방)으로 옮긴다
  const n = Object.keys(db.instances).filter((id) => id.startsWith(`${instanceId}~`)).length + 1;
  const next: PrescriptionInstance = { ...inst, id: `${instanceId}~${n}`, exerciseId, exerciseName: ex.name, order: inst.order + 1, rev: 1 };
  void ctx;
  return {
    put: {
      instances: [next],
      plannedSets: open.map((s) => ({ ...s, instanceId: next.id, exerciseId, rev: s.rev + 1 })),
    },
  };
};

/** 슬롯 한 개를 이번 처방 슬롯 목록에서 쓸 수 있게 사용자 슬롯 추가 */
export const addCustomSlot = (db: Db, slot: Omit<TrainingSlot, 'id' | 'custom'>, ctx: Ctx): Patch => {
  const name = slot.name.trim().slice(0, 40);
  if (!name) fail('슬롯 이름을 넣으세요');
  if (allSlots(db).some((s) => s.name.toLowerCase() === name.toLowerCase())) fail('같은 이름의 슬롯이 있습니다');
  const s: TrainingSlot = { ...slot, name, id: `slot_${ctx.newId()}`, custom: true };
  return { settings: { customSlots: [...(db.settings.customSlots ?? []), s] } };
};

export interface SlotWeekRow { slotId: string; planned: number; done: number; exercises: string[] }

/** 기간의 슬롯별 계획·완료 세트. 운동을 바꿔도 슬롯 처방 기준으로 이어서 센다 */
export const slotAchievement = (db: Db, period: { start: ISODate; end: ISODate }): SlotWeekRow[] => {
  const acc = new Map<string, SlotWeekRow>();
  for (const s of Object.values(db.plannedSets)) {
    if (s.track !== 'pb' || s.originalDate < period.start || s.originalDate > period.end || s.status === 'removed' || s.status === 'excused') continue;
    const inst = db.instances[s.instanceId];
    if (!inst?.slotId) continue;
    const r = acc.get(inst.slotId) ?? { slotId: inst.slotId, planned: 0, done: 0, exercises: [] };
    r.planned += 1;
    if (s.status === 'done') r.done += 1;
    if (!r.exercises.includes(s.exerciseId)) r.exercises.push(s.exerciseId);
    acc.set(inst.slotId, r);
  }
  return [...acc.values()];
};

/** 운동 패턴(Horizontal Pull, Vertical Pull …)별 실제 완료 작업 세트. 근육군 가중 세트와 다른 지표다 */
export const movementVolume = (db: Db, period: { start: ISODate; end: ISODate }): { movement: string; sets: number }[] => {
  const acc = new Map<string, number>();
  for (const p of liveDone(db)) {
    if (p.sessionDate < period.start || p.sessionDate > period.end) continue;
    const ex = db.exercises[p.exerciseId];
    if (!ex || ex.role === 'arm') continue;
    const inst = p.instanceId ? db.instances[p.instanceId] : undefined;
    const key = movementOf(ex, inst?.slotId);
    acc.set(key, (acc.get(key) ?? 0) + 1);
  }
  return [...acc.entries()].map(([movement, sets]) => ({ movement, sets })).sort((a, b) => b.sets - a.sets || a.movement.localeCompare(b.movement));
};

/** 슬롯 이력: 날짜별로 그 슬롯에서 실제로 한 운동과 세트 */
export const slotHistory = (db: Db, slotId: string): { date: ISODate; exerciseId: string; sets: PerformedSet[] }[] => {
  const acc = new Map<string, { date: ISODate; exerciseId: string; sets: PerformedSet[] }>();
  for (const p of liveDone(db)) {
    const inst = p.instanceId ? db.instances[p.instanceId] : undefined;
    if (inst?.slotId !== slotId) continue;
    const k = `${p.sessionDate}|${p.exerciseId}`;
    const r = acc.get(k) ?? { date: p.sessionDate, exerciseId: p.exerciseId, sets: [] };
    r.sets.push(p);
    acc.set(k, r);
  }
  return [...acc.values()].sort((a, b) => b.date.localeCompare(a.date));
};
