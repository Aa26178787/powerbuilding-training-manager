// 운동일 이동·교환·병합·분할·이월·면제 엔진 (SRS 4장, 보완 6)
// 날짜 단위가 아니라 세트 단위의 일정 변형 트랜잭션으로 처리한다. 순수 함수만 포함.
import type {
  ChangeReason, ChangeType, Exercise, ISODate, PlannedSet, PlannedStatus, PrescriptionInstance,
  ScheduleChange, ScheduleWarning, SetPatch, Workout,
} from '../domain/types';
import { addDays, fmtDateKo, isISODate, weekStart } from './dates';

export interface PlanView {
  plannedSets: Record<string, PlannedSet>;
  instances: Record<string, PrescriptionInstance>;
  workouts: Record<string, Workout>;
  exercises: Record<string, Exercise>;
}

export type ChangeRequest =
  | { kind: 'move'; setIds: string[]; toDate: ISODate }
  | { kind: 'swap'; dateA: ISODate; dateB: ISODate }
  | { kind: 'status'; setIds: string[]; status: Extract<PlannedStatus, 'excused' | 'skipped' | 'removed'>; statusReason?: string };

export interface DayGroup {
  instanceId: string;
  workoutId: string;
  workoutLabel: string;
  exerciseId: string;
  name: string;
  role: Exercise['role'];
  pattern: Exercise['pattern'];
  heavy: boolean;
  track: 'pb' | 'arm';
  originalDate: ISODate;
  order: number;
  total: number;
  done: number;
  open: number;
}

export interface SchedulePreview {
  ok: boolean;
  errors: string[];
  type: ChangeType;
  setPatches: SetPatch[];
  orderPatches: { instanceId: string; before: number; after: number }[];
  affected: { date: ISODate; before: DayGroup[]; after: DayGroup[] }[];
  warnings: ScheduleWarning[];
  /** 이동·삭제·축소되는 처방 요약 */
  counts: { moved: number; removed: number; excused: number; skipped: number; preserved: number };
  summary: string;
}

const isLive = (s: PlannedSet) => s.status !== 'removed';

const PATTERN_KO: Record<string, string> = {
  squat: '스쿼트', bench: '벤치', hinge: '힙힌지', dips: '딥스', pullup: '풀업', row: '로우', chest_acc: '가슴 보조', delts: '삼각근',
  quads: '대퇴사두', hams: '햄스트링', core: '복근', triceps: '삼두', arm: 'ARM', other: '기타',
};

/** 한 날짜의 수행 예정 목록(운동 단위 묶음, 수행 순서대로) */
export const buildDayPlan = (v: PlanView, date: ISODate, setsOverride?: Record<string, PlannedSet>): DayGroup[] => {
  const sets = Object.values(setsOverride ?? v.plannedSets).filter((s) => s.plannedDate === date && isLive(s) && s.status !== 'excused');
  const map = new Map<string, DayGroup>();
  for (const s of sets) {
    const inst = v.instances[s.instanceId];
    const ex = v.exercises[s.exerciseId];
    if (!inst) continue;
    let g = map.get(inst.id);
    if (!g) {
      g = {
        instanceId: inst.id, workoutId: inst.workoutId, workoutLabel: v.workouts[inst.workoutId]?.label ?? '',
        exerciseId: inst.exerciseId, name: inst.exerciseName, role: ex?.role ?? (inst.track === 'arm' ? 'arm' : 'accessory'),
        pattern: ex?.pattern ?? (inst.track === 'arm' ? 'arm' : 'other'),
        heavy: inst.model === 'top_backoff' || inst.model === 'straight_linear',
        track: inst.track, originalDate: inst.originalDate, order: inst.order, total: 0, done: 0, open: 0,
      };
      map.set(inst.id, g);
    }
    g.total += 1;
    if (s.status === 'done') g.done += 1;
    if (s.status === 'planned') g.open += 1;
  }
  return [...map.values()].sort((a, b) => a.order - b.order || a.originalDate.localeCompare(b.originalDate) || a.instanceId.localeCompare(b.instanceId));
};

/** 병합일의 권장 수행 순서: Comp SBD → Strength → Variation → Accessory → ARM */
const priorityOf = (g: DayGroup): number =>
  g.track === 'arm' ? 4 : g.role === 'comp' ? 0 : g.role === 'strength' ? 1 : g.role === 'variation' ? 2 : 3;

/** 규칙 기반 경고(P0). 숫자 기준은 안전 보증이 아니라 검토 신호다 */
export const ruleWarnings = (v: PlanView, sets: Record<string, PlannedSet>, dates: ISODate[]): ScheduleWarning[] => {
  const out: ScheduleWarning[] = [];
  const push = (w: ScheduleWarning) => { if (!out.some((x) => x.code === w.code && x.date === w.date && x.message === w.message)) out.push(w); };
  for (const date of dates) {
    const day = buildDayPlan(v, date, sets).filter((g) => g.open > 0);
    if (!day.length) continue;
    const label = fmtDateKo(date);
    // 1) 같은 운동 중복
    const byEx = new Map<string, DayGroup[]>();
    day.forEach((g) => byEx.set(g.exerciseId, [...(byEx.get(g.exerciseId) ?? []), g]));
    for (const gs of byEx.values()) {
      if (gs.length > 1) push({ code: 'duplicate_exercise', severity: 'warn', date, message: `${label}: ${gs[0].name}이(가) ${gs.length}번 들어갑니다. 중복 제거 또는 세트 축소를 검토하세요` });
    }
    // 2) 같은 날 고강도 SBD 핵심 운동 중첩
    const heavy = day.filter((g) => g.heavy && g.track === 'pb');
    const heavySbd = heavy.filter((g) => ['squat', 'bench', 'hinge'].includes(g.pattern));
    if (heavySbd.length >= 2) {
      push({ code: 'heavy_sbd_stack', severity: 'approval', date, message: `${label}: 중량 SBD 핵심 운동 ${heavySbd.length}개가 겹칩니다 (${heavySbd.map((g) => g.name).join(' + ')}). 주력 리프트 품질을 우선해 일부 이월을 검토하세요` });
    }
    // 3) 힙힌지 과밀
    const hinge = day.filter((g) => g.pattern === 'hinge');
    if (hinge.length >= 2 && new Set(hinge.map((g) => g.workoutId)).size > 1) {
      push({ code: 'hinge_stack', severity: 'approval', date, message: `${label}: 힙힌지 운동이 ${hinge.length}개 겹칩니다 (${hinge.map((g) => g.name).join(' + ')}). 요추·후면사슬 피로 주의` });
    }
    // 4) Strength 종목 중첩(딥스/풀업 포함)
    if (heavy.length >= 3 || (heavy.length >= 2 && new Set(heavy.map((g) => g.workoutId)).size > 1 && heavySbd.length < 2)) {
      push({ code: 'strength_stack', severity: 'approval', date, message: `${label}: 고강도 Strength 종목 ${heavy.length}개가 한 방문에 겹칩니다 (${heavy.map((g) => g.name).join(' + ')}). 우선순위와 팔꿈치·그립 피로를 검토하세요` });
    }
    // 5) 같은 패턴(근육군) 운동 과밀
    const byPattern = new Map<string, DayGroup[]>();
    day.filter((g) => g.track === 'pb').forEach((g) => byPattern.set(g.pattern, [...(byPattern.get(g.pattern) ?? []), g]));
    for (const [pattern, gs] of byPattern) {
      if (gs.length >= 2 && new Set(gs.map((g) => g.workoutId)).size > 1 && new Set(gs.map((g) => g.exerciseId)).size > 1 && pattern !== 'hinge' && pattern !== 'other') {
        push({ code: 'pattern_crowding', severity: 'warn', date, message: `${label}: 같은 부위(${PATTERN_KO[pattern] ?? pattern}) 운동이 서로 다른 원본 세션에서 겹칩니다 (${gs.map((g) => g.name).join(', ')})` });
      }
    }
    // 6) 벤치·딥스·ARM 중복
    const arm = day.filter((g) => g.track === 'arm');
    if (arm.length && day.some((g) => g.heavy && (g.pattern === 'dips' || g.pattern === 'pullup'))) {
      push({ code: 'arm_elbow_grip', severity: 'info', date, message: `${label}: ARM과 중량 딥스/풀업 Strength가 같은 날입니다. 팔꿈치·그립 피로를 확인하세요` });
    }
    if (new Set(arm.map((g) => g.workoutId)).size > 1) {
      push({ code: 'arm_days_same_date', severity: 'info', date, message: `${label}: ARM Day가 둘 이상입니다. 각각 독립된 PDF Day로 표시하며 처방을 합산하거나 RPE를 바꾸지 않습니다` });
    }
    // 7) 연속일 동일 패턴 고강도
    for (const off of [-1, 1]) {
      const other = buildDayPlan(v, addDays(date, off), sets).filter((g) => g.open > 0 && g.heavy && g.track === 'pb');
      for (const g of heavy) {
        const hit = other.find((o) => o.pattern === g.pattern);
        if (hit) {
          const [a, b] = off < 0 ? [addDays(date, off), date] : [date, addDays(date, off)];
          push({ code: 'consecutive_heavy', severity: 'warn', date: a, message: `${fmtDateKo(a)}·${fmtDateKo(b)}: 같은 패턴(${PATTERN_KO[g.pattern] ?? g.pattern}) 고강도 운동이 연속일에 배치됩니다 (${off < 0 ? hit.name : g.name} → ${off < 0 ? g.name : hit.name})` });
        }
      }
    }
  }
  return out;
};

const classifyMove = (v: PlanView, moving: PlannedSet[], toDate: ISODate): ChangeType => {
  const movingIds = new Set(moving.map((s) => s.id));
  const targetHasOthers = Object.values(v.plannedSets).some((s) => s.plannedDate === toDate && isLive(s) && s.status !== 'excused' && !movingIds.has(s.id));
  if (targetHasOthers) return 'merge';
  // 원본 세션의 남은 세트 일부만 옮기면 분할
  const partial = [...new Set(moving.map((s) => s.workoutId))].some((wid) =>
    Object.values(v.plannedSets).some((s) => s.workoutId === wid && s.status === 'planned' && !movingIds.has(s.id) && moving.some((m) => m.plannedDate === s.plannedDate)));
  if (partial) return 'split';
  if (moving.some((s) => weekStart(toDate) > weekStart(s.originalDate))) return 'defer';
  return 'move';
};

/** 일정 변경 미리보기. 확정 전에 충돌·경고·영향 범위를 계산한다(상태 변경 없음) */
export const previewScheduleChange = (v: PlanView, req: ChangeRequest): SchedulePreview => {
  const errors: string[] = [];
  const setPatches: SetPatch[] = [];
  let type: ChangeType = 'move';
  const next: Record<string, PlannedSet> = { ...v.plannedSets };
  const touchDates = new Set<ISODate>();
  const patch = (s: PlannedSet, after: SetPatch['after']) => {
    const before: SetPatch['before'] = {};
    (Object.keys(after) as (keyof SetPatch['after'])[]).forEach((k) => { (before as Record<string, unknown>)[k] = s[k]; });
    setPatches.push({ id: s.id, before, after });
    next[s.id] = { ...s, ...after };
  };
  const pick = (ids: string[]): PlannedSet[] => {
    const uniq = [...new Set(ids)];
    if (uniq.length !== ids.length) errors.push('같은 세트가 두 번 선택되었습니다');
    const out: PlannedSet[] = [];
    for (const id of uniq) {
      const s = v.plannedSets[id];
      if (!s) { errors.push(`세트를 찾을 수 없습니다: ${id}`); continue; }
      if (s.status === 'done') { errors.push('이미 완료한 세트는 옮기거나 상태를 바꿀 수 없습니다'); continue; }
      if (s.status !== 'planned') { errors.push('예정 상태가 아닌 세트는 변경할 수 없습니다'); continue; }
      out.push(s);
    }
    return out;
  };

  if (req.kind === 'move') {
    if (!isISODate(req.toDate)) errors.push('대상 날짜가 올바르지 않습니다');
    const moving = pick(req.setIds).filter((s) => s.plannedDate !== req.toDate);
    if (!moving.length && !errors.length) errors.push('옮길 세트가 없습니다');
    if (!errors.length) {
      type = classifyMove(v, moving, req.toDate);
      moving.forEach((s) => { touchDates.add(s.plannedDate); patch(s, { plannedDate: req.toDate }); });
      touchDates.add(req.toDate);
    }
  } else if (req.kind === 'swap') {
    type = 'swap';
    if (!isISODate(req.dateA) || !isISODate(req.dateB) || req.dateA === req.dateB) errors.push('맞교환할 두 날짜가 올바르지 않습니다');
    const open = (d: ISODate) => Object.values(v.plannedSets).filter((s) => s.plannedDate === d && s.status === 'planned');
    const a = open(req.dateA);
    const b = open(req.dateB);
    if (!a.length && !b.length) errors.push('두 날짜 모두 옮길 예정 세트가 없습니다');
    if (!errors.length) {
      a.forEach((s) => patch(s, { plannedDate: req.dateB }));
      b.forEach((s) => patch(s, { plannedDate: req.dateA }));
      touchDates.add(req.dateA); touchDates.add(req.dateB);
    }
  } else {
    type = req.status === 'excused' ? 'excuse' : req.status === 'skipped' ? 'skip' : 'reduce_sets';
    const target = pick(req.setIds);
    if (!target.length && !errors.length) errors.push('변경할 세트가 없습니다');
    if (!errors.length) {
      if (req.status === 'removed') {
        // 운동 전체를 지우면 중복 제거, 일부만 지우면 세트 수 축소
        const whole = [...new Set(target.map((s) => s.instanceId))].every((iid) =>
          Object.values(v.plannedSets).filter((s) => s.instanceId === iid && s.status === 'planned').every((s) => target.some((t) => t.id === s.id)));
        type = whole ? 'remove_duplicate' : 'reduce_sets';
      }
      target.forEach((s) => { touchDates.add(s.plannedDate); patch(s, { status: req.status, statusReason: req.statusReason }); });
    }
  }

  const dates = [...touchDates].sort();
  const warnings: ScheduleWarning[] = errors.length ? [] : ruleWarnings(v, next, dates);
  // 필수 운동이 삭제·축소되면 확인 요구
  const removedRequired = setPatches.filter((p) => p.after.status === 'removed' || p.after.status === 'skipped')
    .map((p) => v.instances[v.plannedSets[p.id].instanceId]).filter((i) => i?.required);
  if (removedRequired.length) {
    warnings.push({ code: 'required_reduced', severity: 'approval', message: `필수 운동의 세트가 줄어듭니다: ${[...new Set(removedRequired.map((i) => i.exerciseName))].join(', ')} (${removedRequired.length}세트)` });
  }
  // 병합일의 권장 수행 순서 재배치
  const orderPatches: SchedulePreview['orderPatches'] = [];
  if (!errors.length && (req.kind === 'move' || req.kind === 'swap')) {
    for (const date of dates) {
      const day = buildDayPlan(v, date, next);
      if (new Set(day.map((g) => g.workoutId)).size < 2) continue;
      [...day].sort((a, b) => priorityOf(a) - priorityOf(b) || a.originalDate.localeCompare(b.originalDate) || a.order - b.order)
        .forEach((g, idx) => {
          const after = idx * 10;
          if (v.instances[g.instanceId].order !== after) orderPatches.push({ instanceId: g.instanceId, before: v.instances[g.instanceId].order, after });
        });
    }
  }
  const withOrder: PlanView = orderPatches.length
    ? { ...v, instances: { ...v.instances, ...Object.fromEntries(orderPatches.map((o) => [o.instanceId, { ...v.instances[o.instanceId], order: o.after }])) } }
    : v;
  const affected = dates.map((date) => ({ date, before: buildDayPlan(v, date), after: buildDayPlan(withOrder, date, next) }));
  const counts = {
    moved: setPatches.filter((p) => p.after.plannedDate !== undefined).length,
    removed: setPatches.filter((p) => p.after.status === 'removed').length,
    excused: setPatches.filter((p) => p.after.status === 'excused').length,
    skipped: setPatches.filter((p) => p.after.status === 'skipped').length,
    preserved: Object.values(next).filter((s) => dates.includes(s.plannedDate) && s.status === 'planned').length,
  };
  const TYPE_KO: Record<ChangeType, string> = {
    move: '이동', swap: '맞교환', merge: '병합', split: '분할', defer: '이월', excuse: '면제', skip: '스킵',
    remove_duplicate: '중복 제거', reduce_sets: '세트 축소', add_sets: '세트 추가', arm_assign: 'ARM 배정', reorder: '순서 변경',
  };
  const n = setPatches.length;
  const summary = errors.length ? errors[0]
    : req.kind === 'move' ? `${n}세트 ${TYPE_KO[type]} → ${fmtDateKo(req.toDate)}`
    : req.kind === 'swap' ? `${fmtDateKo(req.dateA)} ↔ ${fmtDateKo(req.dateB)} 맞교환 (${n}세트)`
    : `${n}세트 ${TYPE_KO[type]}`;
  return { ok: !errors.length, errors, type, setPatches, orderPatches, affected, warnings, counts, summary };
};

export interface ApplyResult { change: ScheduleChange; plannedSets: PlannedSet[]; instances: PrescriptionInstance[] }

/** 사용자 승인 후 변경 확정. 원본 계획(originalDate, inOriginalPlan)은 건드리지 않는다 */
export const applyScheduleChange = (
  v: PlanView, preview: SchedulePreview,
  approval: { approved: boolean; reason: ChangeReason; note?: string; acknowledgedWarnings: boolean },
  now: string, changeId: string,
): ApplyResult => {
  if (!preview.ok) throw new Error(preview.errors.join(', '));
  if (!approval.approved) throw new Error('사용자 승인이 필요합니다');
  if (preview.warnings.some((w) => w.severity === 'approval') && !approval.acknowledgedWarnings) throw new Error('경고를 확인하고 승인해야 합니다');
  const plannedSets = preview.setPatches.map((p) => {
    const s = v.plannedSets[p.id];
    // 미리보기 이후 상태가 달라졌으면(다른 탭·중복 클릭) 적용하지 않는다
    if (!s || s.status !== 'planned') throw new Error('미리보기 이후 세트 상태가 바뀌었습니다. 다시 시도하세요');
    return { ...s, ...p.after, rev: s.rev + 1 };
  });
  const instances = preview.orderPatches.map((o) => ({ ...v.instances[o.instanceId], order: o.after, rev: v.instances[o.instanceId].rev + 1 }));
  const change: ScheduleChange = {
    id: changeId, type: preview.type, reason: approval.reason, note: approval.note, createdAt: now, approvedAt: now,
    setPatches: preview.setPatches, createdSetIds: [], orderPatches: preview.orderPatches, warnings: preview.warnings, summary: preview.summary,
  };
  return { change, plannedSets, instances };
};

/** 변경 취소: 이후 수행 기록은 보존하고, 아직 변경 후 상태 그대로인 세트만 되돌린다 */
export const undoScheduleChange = (v: PlanView, change: ScheduleChange, now: string) => {
  if (change.undoneAt) throw new Error('이미 취소한 변경입니다');
  const plannedSets: PlannedSet[] = [];
  let kept = 0;
  for (const p of change.setPatches) {
    const s = v.plannedSets[p.id];
    if (!s) continue;
    const unchanged = (Object.keys(p.after) as (keyof SetPatch['after'])[]).every((k) => s[k] === p.after[k]);
    if (s.status === 'done' || !unchanged) { kept += 1; continue; }
    plannedSets.push({ ...s, ...p.before, rev: s.rev + 1 });
  }
  for (const id of change.createdSetIds) {
    const s = v.plannedSets[id];
    if (!s) continue;
    if (s.status === 'done') { kept += 1; continue; }
    if (s.status !== 'removed') plannedSets.push({ ...s, status: 'removed', statusReason: '추가 취소', rev: s.rev + 1 });
  }
  const instances = change.orderPatches
    .filter((o) => v.instances[o.instanceId]?.order === o.after)
    .map((o) => ({ ...v.instances[o.instanceId], order: o.before, rev: v.instances[o.instanceId].rev + 1 }));
  return { change: { ...change, undoneAt: now }, plannedSets, instances, keptCount: kept };
};
