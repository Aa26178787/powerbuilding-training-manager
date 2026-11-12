// 일정 변경 유스케이스: 미리보기 → 사용자 승인 → 트랜잭션 반영 → 취소
import type { ChangeReason, Db, ISODate, Patch, PlannedSet, ScheduleChange } from '../domain/types';
import { applyScheduleChange, ChangeRequest, PlanView, previewScheduleChange, SchedulePreview, undoScheduleChange } from '../engine/scheduleMerge';
import { Ctx, fail } from './ctx';

export const planView = (db: Db): PlanView => ({ plannedSets: db.plannedSets, instances: db.instances, workouts: db.workouts, exercises: db.exercises });

export const previewChange = (db: Db, req: ChangeRequest): SchedulePreview => previewScheduleChange(planView(db), req);

export const commitChange = (
  db: Db, preview: SchedulePreview,
  approval: { reason: ChangeReason; note?: string; acknowledgedWarnings: boolean }, ctx: Ctx,
): Patch => {
  const r = applyScheduleChange(planView(db), preview, { approved: true, ...approval, note: approval.note?.slice(0, 300) }, ctx.now, `c-${ctx.newId()}`);
  return { put: { changes: [r.change], plannedSets: r.plannedSets, instances: r.instances } };
};

export const undoChange = (db: Db, changeId: string, ctx: Ctx): { patch: Patch; keptCount: number } => {
  const c = db.changes[changeId] ?? fail('변경 이력을 찾을 수 없습니다');
  const r = undoScheduleChange(planView(db), c, ctx.now);
  return { patch: { put: { changes: [r.change], plannedSets: r.plannedSets, instances: r.instances } }, keptCount: r.keptCount };
};

/** 승인된 추가 세트: 원본 계획 달성률의 분모는 그대로 두고 조정 계획에만 더한다 */
export const addPlannedSets = (db: Db, instanceId: string, count: number, date: ISODate, ctx: Ctx): Patch => {
  const inst = db.instances[instanceId] ?? fail('처방을 찾을 수 없습니다');
  if (!(count >= 1 && count <= 10)) fail('추가 세트 수는 1~10 범위여야 합니다');
  const sets = Object.values(db.plannedSets).filter((s) => s.instanceId === instanceId).sort((a, b) => a.index - b.index);
  const last = sets[sets.length - 1] ?? fail('기준이 될 세트가 없습니다');
  const created: PlannedSet[] = Array.from({ length: count }, (_, i) => ({
    ...last, id: `${instanceId}:x${ctx.newId()}`, index: last.index + 1 + i, type: last.type === 'top' ? 'backoff' : last.type,
    plannedDate: date, status: 'planned', inOriginalPlan: false, statusReason: undefined, rev: 1,
  }));
  const change: ScheduleChange = {
    id: `c-${ctx.newId()}`, type: 'add_sets', reason: 'user_choice', createdAt: ctx.now, approvedAt: ctx.now, setPatches: [],
    createdSetIds: created.map((s) => s.id), orderPatches: [], warnings: [], summary: `${inst.exerciseName} ${count}세트 추가`,
  };
  return { put: { plannedSets: created, changes: [change] } };
};

/** 같은 날 안에서 운동 순서 한 칸 이동 */
export const reorderInstance = (db: Db, instanceId: string, date: ISODate, dir: -1 | 1): Patch => {
  const ids = [...new Set(Object.values(db.plannedSets).filter((s) => s.plannedDate === date && s.status !== 'removed' && s.status !== 'excused').map((s) => s.instanceId))]
    .sort((a, b) => db.instances[a].order - db.instances[b].order || db.instances[a].originalDate.localeCompare(db.instances[b].originalDate) || a.localeCompare(b));
  const i = ids.indexOf(instanceId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return {};
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return { put: { instances: ids.map((id, idx) => ({ ...db.instances[id], order: idx * 10, rev: db.instances[id].rev + 1 })).filter((n) => n.order !== db.instances[n.id].order) } };
};
