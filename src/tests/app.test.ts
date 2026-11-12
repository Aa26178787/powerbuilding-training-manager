import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Db, PlannedSet } from '../domain/types';
import { applyPatch } from '../application/ctx';
import { ensureWeeks, saveProgramVersion } from '../application/plan';
import { closeWorkout, deletePerformedSet, editPerformedSet, endSession, recordSet, setSeed, skipSets, activeSession } from '../application/session';
import { suggestForSet } from '../application/recommend';
import { addPlannedSets, commitChange, previewChange, undoChange } from '../application/schedule';
import { armDayList, assignArmDay, fillArmMissing, isSafeHttpsUrl, saveArmVideoLink } from '../application/arm';
import { parseArmJson } from '../data-import/armImport';
import { buildBackup, parseBackup } from '../data-import/backup';
import { calculateAchievement, armDayAdherence } from '../engine/achievement';
import { deriveWorkoutStatus } from '../engine/status';
import { commitPatch, ConflictError, loadAll, openStore, replaceAll } from '../repositories/idb';
import { fakeArmJson, makeCtx, makeDb, run, START } from './helpers';

const setsOf = (db: Db, pred: (s: PlannedSet) => boolean) => Object.values(db.plannedSets).filter(pred).sort((a, b) => a.id.localeCompare(b.id));
const MON = START; const TUE = '2026-12-01'; const WED = '2026-12-02'; const THU = '2026-12-03'; const FRI = '2026-12-04';
const week = { start: MON, end: '2026-12-06' };
const ach = (db: Db, today = '2026-12-06', period = week) => calculateAchievement({
  plannedSets: Object.values(db.plannedSets), performedDates: Object.values(db.performed).filter((p) => !p.deleted).map((p) => p.sessionDate),
  extraSetCount: 0, period, today, track: 'pb',
});

describe('주간 계획 생성', () => {
  it('V1.9 프리셋 5일·81세트, 다시 호출해도 중복 생성 없음', () => {
    const db = makeDb();
    expect(Object.keys(db.workouts).length).toBe(5);
    expect(Object.keys(db.plannedSets).length).toBe(81);
    expect(setsOf(db, (s) => s.plannedDate === MON).length).toBe(22);
    expect(ensureWeeks(db, [MON])).toEqual({});
  });
});

describe('세트 기록·추천 (TC-001~003, TC-013)', () => {
  it('Top Set 기록 → Backoff 추천 → 중복 기록 차단 → 증량 판정', () => {
    let db = makeDb();
    const ctx = makeCtx(MON);
    const sq = setsOf(db, (s) => s.instanceId === `pb:${MON}:mon_sq`);
    expect(suggestForSet(db, sq[0], MON).load).toBeNull(); // 기록 없음 → 직접 입력
    db = run(db, recordSet(db, { plannedSetId: sq[0].id, exerciseId: 'comp_squat', date: MON, weight: 150, reps: 5, rpe: 8 }, ctx));
    expect(db.plannedSets[sq[0].id].status).toBe('done');
    expect(() => recordSet(db, { plannedSetId: sq[0].id, exerciseId: 'comp_squat', date: MON, weight: 150, reps: 5, rpe: 8 }, ctx)).toThrow(/중복/);
    const bo = suggestForSet(db, sq[1], MON);
    expect(bo.kind).toBe('backoff');
    expect(bo.load).toBe(142.5);
    // 첫 Backoff가 무겁게 나오면 다음 세트 감량 제안(실제 기록은 그대로 보존)
    db = run(db, recordSet(db, { plannedSetId: sq[1].id, exerciseId: 'comp_squat', date: MON, weight: 142.5, reps: 5, rpe: 8.5 }, ctx));
    const next = suggestForSet(db, sq[2], MON);
    expect(next.action).toBe('decrease');
    expect(next.load!).toBeLessThan(142.5);
    for (const s of sq.slice(2)) db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: 'comp_squat', date: MON, weight: next.load, reps: 5, rpe: 7.5 }, ctx));
    expect(db.exStates.comp_squat.lastDecision?.action).toBe('increase');
    expect(db.exStates.comp_squat.nextLoad).toBe(152.5);
    // 추천 스냅샷(원시값·반올림값·사용자 수용값) 보존
    const rec = Object.values(db.recs).find((r) => r.kind === 'backoff')!;
    expect(rec.roundedLoad).toBe(142.5);
    expect(rec.acceptedLoad).toBe(142.5);
    expect(rec.rawLoad!).toBeGreaterThan(142.5);
  });
  it('초기 입력 기록으로 첫 Top Set 시작값 제안, 없어도 세션 시작 가능', () => {
    let db = makeDb();
    db = run(db, setSeed(db, 'comp_bench', { weight: 100, reps: 3, rpe: 8 }, makeCtx()));
    const top = setsOf(db, (s) => s.instanceId === `pb:${WED}:wed_bp`)[0];
    const sug = suggestForSet(db, top, WED);
    expect(sug.kind).toBe('top_start');
    expect(sug.load! % 1.25).toBe(0);
    expect(sug.load!).toBeLessThan(100);
    // Larsen 첫 수행은 Comp e1RM × 0.925 기준
    const larsen = setsOf(db, (s) => s.instanceId === `pb:${THU}:thu_larsen`)[0];
    expect(suggestForSet(db, larsen, THU).kind).toBe('variation_start');
  });
  it('딥스: 체중 포함 부하로 계산하고 추가 중량만 저장', () => {
    let db = makeDb();
    const ctx = makeCtx(THU);
    const dips = setsOf(db, (s) => s.instanceId === `pb:${THU}:thu_dips`);
    db = run(db, recordSet(db, { plannedSetId: dips[0].id, exerciseId: 'dips_strength', date: THU, weight: 40, reps: 5, rpe: 8 }, ctx));
    const p = Object.values(db.performed)[0];
    expect(p.weight).toBe(40);
    expect(p.bodyweight).toBe(66);
    const bo = suggestForSet(db, dips[1], THU);
    expect(bo.load).toBe(35); // (106×(1+6.5/30))/(1+8/30) − 66 = 35.8 → 1.25 단위 내림
  });
  it('기록 수정은 이력을 남기고, 삭제하면 세트가 다시 예정 상태', () => {
    let db = makeDb();
    const ctx = makeCtx(MON);
    const s = setsOf(db, (x) => x.instanceId === `pb:${MON}:mon_row`)[0];
    db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: 'cs_row', date: MON, weight: 60, reps: 10, rpe: 7 }, ctx));
    const id = Object.keys(db.performed)[0];
    db = run(db, editPerformedSet(db, id, { reps: 12 }, ctx));
    expect(db.performed[id].reps).toBe(12);
    expect(Object.values(db.audit)[0]).toMatchObject({ op: 'update', entityId: id });
    db = run(db, deletePerformedSet(db, id, ctx));
    expect(db.performed[id].deleted).toBe(true);
    expect(db.plannedSets[s.id].status).toBe('planned');
    expect(() => recordSet(db, { plannedSetId: s.id, exerciseId: 'cs_row', date: MON, weight: -1, reps: 10 }, ctx)).toThrow();
    expect(() => recordSet(db, { plannedSetId: s.id, exerciseId: 'cs_row', date: MON, weight: 60, reps: 10, rpe: 7.3 }, ctx)).toThrow();
  });
  it('조기 종료는 skipped_by_autoregulation: 원본에는 미완료, 조정 계획 분모에서는 제외', () => {
    let db = makeDb();
    const ctx = makeCtx(MON);
    const sq = setsOf(db, (s) => s.instanceId === `pb:${MON}:mon_sq`);
    for (const s of sq.slice(0, 3)) db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: 'comp_squat', date: MON, weight: 140, reps: 5, rpe: 8 }, ctx));
    db = run(db, skipSets(db, sq.slice(3).map((s) => s.id), true, '상한 초과 예상', ctx));
    const r = ach(db);
    expect(r.original).toMatchObject({ done: 3, total: 81 });
    expect(r.adjusted).toMatchObject({ done: 3, total: 79 });
    expect(r.autoregSkippedSets).toBe(2);
    expect(db.exStates.comp_squat.lastDecision).toBeTruthy();
  });
  it('세션 종료 요약, 남은 세트는 자동으로 미수행 처리하지 않음', () => {
    let db = makeDb();
    const ctx = makeCtx(MON);
    const s = setsOf(db, (x) => x.plannedDate === MON)[0];
    db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: s.exerciseId, date: MON, weight: 50, reps: 10, rpe: 9 }, ctx));
    const { patch, report } = endSession(db, activeSession(db)!.id, ctx);
    db = run(db, patch);
    expect(report).toMatchObject({ plannedSets: 22, doneSets: 1, rpeOverCap: 1 });
    expect(activeSession(db)).toBeNull();
    expect(setsOf(db, (x) => x.plannedDate === MON && x.status === 'planned').length).toBe(21);
  });
});

describe('일정 이동·병합 (TC-008, 009, 011, 012, 014)', () => {
  it('세션 이동: 원래 날짜 출처 유지, 실제 예정일 별도', () => {
    let db = makeDb();
    const thu = setsOf(db, (s) => s.plannedDate === THU);
    const pv = previewChange(db, { kind: 'move', setIds: thu.map((s) => s.id), toDate: '2026-12-05' });
    expect(pv.ok).toBe(true);
    expect(pv.type).toBe('move');
    db = run(db, commitChange(db, pv, { reason: 'gym_closed', acknowledgedWarnings: false }, makeCtx(WED)));
    expect(setsOf(db, (s) => s.plannedDate === '2026-12-05').length).toBe(13);
    expect(setsOf(db, (s) => s.originalDate === THU).length).toBe(13);
    const byDate = new Map([['2026-12-05', new Set([`pb:${THU}`])]]);
    expect(deriveWorkoutStatus(db.workouts[`pb:${THU}`], thu.map((s) => db.plannedSets[s.id]), '2026-12-04', byDate)).toBe('rescheduled');
    expect(ach(db).original.total).toBe(81); // 이동만으로 분모·크레딧 변화 없음
    expect(ach(db).original.done).toBe(0);
  });
  it('Sumo를 금요일(Conventional+RDL)로 병합: 경고·승인 요구, 조용한 합침 금지', () => {
    const db = makeDb();
    const sumo = setsOf(db, (s) => s.instanceId === `pb:${TUE}:tue_sumo`);
    const pv = previewChange(db, { kind: 'move', setIds: sumo.map((s) => s.id), toDate: FRI });
    expect(pv.type).toBe('merge');
    expect(pv.warnings.some((w) => w.code === 'heavy_sbd_stack' && w.severity === 'approval')).toBe(true);
    expect(pv.warnings.some((w) => w.code === 'hinge_stack')).toBe(true);
    expect(() => commitChange(db, pv, { reason: 'gym_closed', acknowledgedWarnings: false }, makeCtx())).toThrow(/경고/);
    const after = run(db, commitChange(db, pv, { reason: 'gym_closed', acknowledgedWarnings: true }, makeCtx()));
    // 병합일 순서: Competition 우선
    const fri = pv.affected.find((a) => a.date === FRI)!.after;
    expect(fri[0].exerciseId).toBe('comp_sumo');
    expect(Object.values(after.changes)[0].type).toBe('merge');
  });
  it('화요일 전체를 수요일로: 중량 리프트 중첩과 연속일 경고', () => {
    const db = makeDb();
    const tue = setsOf(db, (s) => s.plannedDate === TUE);
    const pv = previewChange(db, { kind: 'move', setIds: tue.map((s) => s.id), toDate: WED });
    expect(pv.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['heavy_sbd_stack', 'duplicate_exercise']));
    expect(pv.counts.moved).toBe(17);
  });
  it('병합 후 A 3/3, B 1/3만 완료 → 세트 단위 부분 반영, 두 세션 자동 완료 아님', () => {
    let db = makeDb();
    const ctx = makeCtx(FRI);
    const a = setsOf(db, (s) => s.instanceId === `pb:${FRI}:fri_pullv`);
    const b = setsOf(db, (s) => s.instanceId === `pb:${TUE}:tue_hlr`);
    const pv = previewChange(db, { kind: 'move', setIds: b.map((s) => s.id), toDate: FRI });
    db = run(db, commitChange(db, pv, { reason: 'user_choice', acknowledgedWarnings: true }, ctx));
    for (const s of a) db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: 'pullup_volume', date: FRI, weight: 10, reps: 10, rpe: 7 }, ctx));
    db = run(db, recordSet(db, { plannedSetId: b[0].id, exerciseId: 'hlr', date: FRI, weight: 0, reps: 12, rpe: 7 }, ctx));
    expect(a.every((s) => db.plannedSets[s.id].status === 'done')).toBe(true);
    expect(b.filter((s) => db.plannedSets[s.id].status === 'done').length).toBe(1);
    expect(ach(db).original.done).toBe(4);
    const tueSets = setsOf(db, (s) => s.workoutId === `pb:${TUE}`);
    expect(deriveWorkoutStatus(db.workouts[`pb:${TUE}`], tueSets, '2026-12-05', new Map())).not.toBe('completed');
    // 완료한 세트는 다시 옮길 수 없음
    expect(previewChange(db, { kind: 'move', setIds: [b[0].id], toDate: '2026-12-05' }).ok).toBe(false);
  });
  it('휴관 면제: 원본 달성률은 그대로 미완료, 조정 분모만 줄고 면제 수 노출', () => {
    let db = makeDb();
    const tue = setsOf(db, (s) => s.plannedDate === TUE);
    const pv = previewChange(db, { kind: 'status', setIds: tue.map((s) => s.id), status: 'excused', statusReason: '휴관' });
    db = run(db, commitChange(db, pv, { reason: 'gym_closed', acknowledgedWarnings: true }, makeCtx()));
    const r = ach(db);
    expect(r.original).toMatchObject({ done: 0, total: 81 });
    expect(r.adjusted.total).toBe(64);
    expect(r.excusedSets).toBe(17);
    expect(deriveWorkoutStatus(db.workouts[`pb:${TUE}`], tue.map((s) => db.plannedSets[s.id]), TUE, new Map())).toBe('excused');
  });
  it('다음 주로 이월해 수행: 크레딧은 원래 주, 실제 방문은 수행한 주', () => {
    let db = makeDb([MON, '2026-12-07']);
    const fri = setsOf(db, (s) => s.instanceId === `pb:${FRI}:fri_hlr`);
    const pv = previewChange(db, { kind: 'move', setIds: fri.map((s) => s.id), toDate: '2026-12-07' });
    db = run(db, commitChange(db, pv, { reason: 'unavoidable_personal', acknowledgedWarnings: true }, makeCtx(FRI)));
    const ctx = makeCtx('2026-12-07');
    for (const s of fri) db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: 'hlr', date: '2026-12-07', weight: 0, reps: 12, rpe: 7 }, ctx));
    expect(ach(db).original.done).toBe(3);
    expect(ach(db).visits.actual).toBe(0);
    const next = ach(db, '2026-12-13', { start: '2026-12-07', end: '2026-12-13' });
    expect(next.original.done).toBe(0);
    expect(next.visits.actual).toBe(1);
  });
  it('변경 취소: 일정은 복원하고 이미 기록한 세트는 보존', () => {
    let db = makeDb();
    const ctx = makeCtx(WED);
    const hlr = setsOf(db, (s) => s.instanceId === `pb:${TUE}:tue_hlr`);
    db = run(db, commitChange(db, previewChange(db, { kind: 'move', setIds: hlr.map((s) => s.id), toDate: WED }), { reason: 'user_choice', acknowledgedWarnings: true }, ctx));
    db = run(db, recordSet(db, { plannedSetId: hlr[0].id, exerciseId: 'hlr', date: WED, weight: 0, reps: 10, rpe: 7 }, ctx));
    const { patch, keptCount } = undoChange(db, Object.keys(db.changes)[0], ctx);
    db = run(db, patch);
    expect(keptCount).toBe(1);
    expect(db.plannedSets[hlr[0].id]).toMatchObject({ status: 'done', plannedDate: WED });
    expect(db.plannedSets[hlr[1].id].plannedDate).toBe(TUE);
    expect(Object.values(db.performed).length).toBe(1);
    expect(() => undoChange(db, Object.keys(db.changes)[0], ctx)).toThrow();
  });
  it('세트 수 축소·추가 세트·맞교환', () => {
    let db = makeDb();
    const row = setsOf(db, (s) => s.instanceId === `pb:${MON}:mon_row`);
    const red = previewChange(db, { kind: 'status', setIds: row.slice(3).map((s) => s.id), status: 'removed' });
    expect(red.type).toBe('reduce_sets');
    db = run(db, commitChange(db, red, { reason: 'user_choice', acknowledgedWarnings: true }, makeCtx()));
    db = run(db, addPlannedSets(db, `pb:${MON}:mon_lat`, 1, MON, makeCtx()));
    const r = ach(db);
    expect(r.original.total).toBe(81);
    expect(r.adjusted.total).toBe(81 - 2 + 1);
    const sw = previewChange(db, { kind: 'swap', dateA: TUE, dateB: THU });
    expect(sw.ok).toBe(true);
    db = run(db, commitChange(db, sw, { reason: 'user_choice', acknowledgedWarnings: true }, makeCtx()));
    expect(setsOf(db, (s) => s.plannedDate === TUE && s.status === 'planned').every((s) => s.originalDate === THU)).toBe(true);
  });
  it('날짜가 지나도 자동으로 missed 확정하지 않음', () => {
    let db = makeDb();
    const mon = setsOf(db, (s) => s.plannedDate === MON);
    expect(deriveWorkoutStatus(db.workouts[`pb:${MON}`], mon, WED, new Map())).toBe('overdue');
    db = run(db, closeWorkout(db, `pb:${MON}`, 'missed', makeCtx(WED)));
    expect(deriveWorkoutStatus(db.workouts[`pb:${MON}`], setsOf(db, (s) => s.workoutId === `pb:${MON}`), WED, new Map())).toBe('missed');
    expect(ach(db).original).toMatchObject({ done: 0, total: 81 });
  });
});

describe('프로그램 버전 (TC-019)', () => {
  it('편집은 다음 주부터 적용, 이번 주 스냅샷과 과거 기록은 불변', () => {
    let db = makeDb([MON, '2026-12-07']);
    const ctx = makeCtx(WED);
    const before = JSON.stringify(db.instances[`pb:${MON}:mon_row`]);
    const days = structuredClone(db.versions['pv-1'].days);
    days[0].items.find((i) => i.id === 'mon_row')!.groups[0].count = 3;
    db = run(db, saveProgramVersion(db, days, '로우 5→3세트', ctx));
    expect(JSON.stringify(db.instances[`pb:${MON}:mon_row`])).toBe(before);
    expect(db.workouts['pb:2026-12-07']).toBeUndefined(); // 손대지 않은 다음 주는 다시 생성 대상
    db = applyPatch(db, ensureWeeks(db, ['2026-12-07']));
    expect(setsOf(db, (s) => s.instanceId === 'pb:2026-12-07:mon_row').length).toBe(3);
    expect(setsOf(db, (s) => s.instanceId === `pb:${MON}:mon_row`).length).toBe(5);
    expect(Object.keys(db.versions).length).toBe(2);
  });
});

describe('ARM (TC-015~018)', () => {
  const withArm = (): Db => {
    const r = parseArmJson(fakeArmJson(), '2026-11-13T00:00:00Z');
    expect(r.ok).toBe(true);
    return { ...makeDb(), arm: r.data! };
  };
  it('가져오기 검증: 중복 제외·누락 판정·잘못된 파일 거부', () => {
    const r = parseArmJson(fakeArmJson(), 'now');
    expect(r.summary).toMatchObject({ total: 6, excluded: 2, active: 4, sourceMissing: 1 });
    expect(parseArmJson('{"schema_version":"2.0.0","exercises":[]}', 'now').ok).toBe(false);
    expect(parseArmJson('not json', 'now').ok).toBe(false);
    expect(parseArmJson('{"schema_version":"1.1.0","exercises":[{"id":"x"}]}', 'now').ok).toBe(false);
  });
  it('6x3은 6회×3세트, RPE 9.5 보존(상한 8로 덮어쓰지 않음), 겹치는 운동은 활성 뷰에서 제외', () => {
    let db = withArm();
    db = run(db, assignArmDay(db, 0, MON, makeCtx(MON)));
    const curl = setsOf(db, (s) => s.instanceId === 'arm:0:a-w01-d1-e01');
    expect(curl.length).toBe(3);
    expect(curl[0]).toMatchObject({ reps: 6, targetRpe: 9.5, rpeCap: 10, track: 'arm' });
    const names = Object.values(db.instances).filter((i) => i.track === 'arm').map((i) => i.exerciseName);
    expect(names).not.toContain('Bench Press');
    expect(names).not.toContain('Weighted Puill-ups');
    expect(setsOf(db, (s) => s.instanceId === 'arm:0:a-w01-d1-e04')[0]).toMatchObject({ seconds: 12, type: 'arm_static' });
    expect(db.arm!.exercises.length).toBe(6); // 원본은 그대로 보존
    expect(db.settings.armCursor).toBe(1);
    expect(() => assignArmDay(db, 0, TUE, makeCtx())).toThrow();
    // ARM은 파워빌딩 달성률 분모에 들어가지 않음
    expect(ach(db).original.total).toBe(81);
  });
  it('원본 누락 항목은 자동 추정 없이 세트 0개 → 사용자가 직접 입력하면 생성', () => {
    let db = withArm();
    db = run(db, assignArmDay(db, 0, MON, makeCtx(MON)));
    const inst = db.instances['arm:0:a-w01-d1-e05'];
    expect(inst.arm!.sourceMissing).toContain('sets_reps');
    expect(setsOf(db, (s) => s.instanceId === inst.id).length).toBe(0);
    db = run(db, fillArmMissing(db, inst.id, { sets: 2, reps: 10, seconds: null, rpe: null }));
    expect(setsOf(db, (s) => s.instanceId === inst.id).length).toBe(2);
    expect(db.instances[inst.id].arm!.userFilled).toBe(true);
    expect(setsOf(db, (s) => s.instanceId === inst.id)[0].targetRpe).toBe(9);
  });
  it('좌·우 별도 기록: 양팔을 모두 기록해야 완료, 같은 팔 중복 차단', () => {
    let db = withArm();
    const ctx = makeCtx(MON);
    db = run(db, assignArmDay(db, 0, MON, ctx));
    const s = setsOf(db, (x) => x.instanceId === 'arm:0:a-w01-d1-e01')[0];
    db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: s.exerciseId, date: MON, weight: 20, reps: 6, rpe: 9.5, side: 'L' }, ctx));
    expect(db.plannedSets[s.id].status).toBe('planned');
    expect(() => recordSet(db, { plannedSetId: s.id, exerciseId: s.exerciseId, date: MON, weight: 20, reps: 6, rpe: 9.5, side: 'L' }, ctx)).toThrow(/왼팔/);
    db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: s.exerciseId, date: MON, weight: 22, reps: 6, rpe: 9, side: 'R' }, ctx));
    expect(db.plannedSets[s.id].status).toBe('done');
    expect(suggestForSet(db, s, MON).load).toBeNull(); // ARM은 자동 e1RM 추천 없음
  });
  it('ARM Day 2개를 같은 날에 두어도 각각 독립 Day, Day 이행률 계산', () => {
    let db = withArm();
    const ctx = makeCtx(MON);
    db = run(db, assignArmDay(db, 0, MON, ctx));
    db = run(db, assignArmDay(db, 1, WED, ctx));
    const d2 = setsOf(db, (s) => s.workoutId === 'arm:1');
    const pv = previewChange(db, { kind: 'move', setIds: d2.map((s) => s.id), toDate: MON });
    expect(pv.warnings.some((w) => w.code === 'arm_days_same_date')).toBe(true);
    db = run(db, commitChange(db, pv, { reason: 'user_choice', acknowledgedWarnings: true }, ctx));
    expect(new Set(setsOf(db, (s) => s.track === 'arm' && s.plannedDate === MON).map((s) => s.workoutId)).size).toBe(2);
    expect(d2.every((s) => db.plannedSets[s.id].reps === 8 && db.plannedSets[s.id].targetRpe === 6)).toBe(true);
    db = { ...db, settings: { ...db.settings, armSideMode: 'both' } };
    for (const s of d2) db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: s.exerciseId, date: MON, weight: 10, reps: 8, rpe: 6, side: 'both' }, ctx));
    expect(armDayAdherence(Object.values(db.plannedSets), week)).toMatchObject({ done: 1, total: 2 });
    expect(armDayList(db.arm!).length).toBe(2);
  });
  it('영상 링크는 HTTPS만 허용', () => {
    expect(isSafeHttpsUrl('https://example.com/v/1')).toBe(true);
    expect(isSafeHttpsUrl('http://example.com')).toBe(false);
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(() => saveArmVideoLink('test_curl', 'http://example.com', makeCtx())).toThrow();
  });
});

describe('백업·복원·저장소 (TC-007, TC-021)', () => {
  it('백업 왕복, ARM 제외 옵션, 잘못된 파일 거부', () => {
    const r = parseArmJson(fakeArmJson(), 'now');
    let db: Db = { ...makeDb(), arm: r.data! };
    db = run(db, assignArmDay(db, 0, MON, makeCtx(MON)));
    const full = parseBackup(JSON.stringify(buildBackup(db, true, 'now')));
    expect(full.ok).toBe(true);
    expect(full.db).toEqual(db);
    const noArm = buildBackup(db, false, 'now');
    const text = JSON.stringify(noArm);
    expect(noArm.includesArm).toBe(false);
    expect(text).not.toContain('Test Curl - 6x3');
    expect(parseBackup(text).db!.arm).toBeNull();
    expect(parseBackup('{"app":"other"}').ok).toBe(false);
    const broken = JSON.parse(JSON.stringify(buildBackup(db, true, 'now')));
    broken.data.plannedSets[Object.keys(broken.data.plannedSets)[0]].status = 'hacked';
    expect(parseBackup(JSON.stringify(broken)).ok).toBe(false);
  });
  it('IndexedDB: 세트 기록 후 다시 열어도 복구, rev 충돌은 전체 취소', async () => {
    const idb = await openStore('ptm-test-1');
    let db = makeDb();
    await replaceAll(idb, db);
    const ctx = makeCtx(MON);
    const s = setsOf(db, (x) => x.plannedDate === MON)[0];
    const patch = recordSet(db, { plannedSetId: s.id, exerciseId: s.exerciseId, date: MON, weight: 150, reps: 5, rpe: 8 }, ctx);
    await commitPatch(idb, patch);
    db = run(db, patch);
    idb.close();
    const again = await openStore('ptm-test-1');
    const loaded = await loadAll(again);
    expect(loaded).toEqual(db);
    expect(loaded.plannedSets[s.id].status).toBe('done');
    // 다른 탭이 오래된 상태에서 같은 세트를 다시 완료하려는 경우
    const stale = makeDb();
    const dup = recordSet(stale, { plannedSetId: s.id, exerciseId: s.exerciseId, date: MON, weight: 150, reps: 5, rpe: 8 }, makeCtx(MON));
    await expect(commitPatch(again, dup)).rejects.toBeInstanceOf(ConflictError);
    const after = await loadAll(again);
    expect(Object.keys(after.performed).length).toBe(1); // 이중 집계 없음
    again.close();
  });
});
