// V1.9 B안: Conventional 구조, 보조 운동 슬롯, 운동별 독립 진행, 패턴·근육군 집계 분리, 마이그레이션
import { describe, expect, it } from 'vitest';
import type { Db, PlannedSet, ProgramDayTemplate, ProgramVersion } from '../domain/types';
import { activeSession, endSession, recordSet, setSeed } from '../application/session';
import { suggestForSet } from '../application/recommend';
import { assignSlot, duplicateWarnings, movementVolume, slotAchievement, slotHistory, swapInstanceExercise } from '../application/slots';
import { migrateNames, migrateV19B, transformDaysV19B, MIGRATION_V19B } from '../application/migrate';
import { ensureWeeks } from '../application/plan';
import { muscleVolume } from '../application/analysis';
import { periodAchievement } from '../application/selectors';
import { conservativeE1RM, loadForTarget } from '../engine/e1rm';
import { roundLoad } from '../engine/rounding';
import { DEFAULT_DAYS, DEFAULT_EXERCISES, emptyDb } from '../domain/defaults';
import { muscleName, plateSetup } from '../domain/slots';
import { stepOf } from '../application/recommend';
import { saveExercise } from '../application/library';
import { plateBreakdown } from '../engine/rounding';
import { applyPatch } from '../application/ctx';
import { makeCtx, makeDb, run, START } from './helpers';

const MON = START; const TUE = '2026-12-01'; const WED = '2026-12-02'; const FRI = '2026-12-04';
const NEXT = (d: string, w = 1) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 7 * w); return t.toISOString().slice(0, 10); };
const setsOf = (db: Db, inst: string): PlannedSet[] => Object.values(db.plannedSets).filter((s) => s.instanceId === inst).sort((a, b) => a.index - b.index);
const seed = (db: Db, id: string, w: number, r: number, p: number) => run(db, setSeed(db, id, { weight: w, reps: r, rpe: p }, makeCtx()));
let N = 0;
const ctxAt = (date: string) => ({ ...makeCtx(date), newId: () => `v${(N += 1)}` });
const doSets = (db: Db, inst: string, date: string, weight: number | null, reps: number, rpe: number, n?: number) => {
  const ctx = ctxAt(date);
  const sets = setsOf(db, inst).filter((s) => s.status === 'planned').slice(0, n);
  for (const s of sets) db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: s.exerciseId, date, weight, reps, rpe }, ctx));
  return db;
};
const end = (db: Db, date: string) => run(db, endSession(db, activeSession(db)!.id, ctxAt(date)).patch);

describe('데드리프트 B안', () => {
  it('1. 화요일 Conventional Main: Top 1×4 @7~8, Backoff 4×4 첫 세트 @7, RTS e1RM 계산', () => {
    let db = seed(makeDb(), 'conv_dl', 170, 4, 8);
    const sets = setsOf(db, `pb:${TUE}:tue_conv`);
    expect(sets.map((s) => s.type)).toEqual(['top', 'backoff', 'backoff', 'backoff', 'backoff']);
    expect(sets[0]).toMatchObject({ reps: 4, targetRpe: 7.5, targetRpeMax: 8, rpeCap: 8 });
    expect(sets[1]).toMatchObject({ reps: 4, targetRpe: 7, rpeCap: 8 });
    expect(db.exercises.conv_dl.increment).toBe(2.5);
    const top = suggestForSet(db, sets[0], TUE);
    expect(top.load).toBe(roundLoad(loadForTarget(conservativeE1RM(170, 4, 8), 4, 7.5), 2.5, 'nearest'));
    db = run(db, recordSet(db, { plannedSetId: sets[0].id, exerciseId: 'conv_dl', date: TUE, weight: top.load, reps: 4, rpe: 7.5 }, makeCtx(TUE)));
    const bo = suggestForSet(db, sets[1], TUE);
    expect(bo.kind).toBe('backoff');
    expect(bo.load).toBe(roundLoad(loadForTarget(conservativeE1RM(top.load as number, 4, 7.5), 4, 7), 2.5, 'floor'));
    expect(bo.load!).toBeLessThan(top.load!);
  });

  it('2. 금요일 Paused Conventional: 3×3~5 @6.5~7.5 상한 8, Conventional과 독립 Double Progression', () => {
    let db = seed(makeDb(), 'conv_dl', 170, 4, 8);
    const fri = Object.values(db.instances).filter((i) => i.originalDate === FRI).sort((a, b) => a.order - b.order);
    expect(fri.map((i) => i.exerciseId).slice(0, 2)).toEqual(['paused_conv', 'rdl']);
    const ps = setsOf(db, `pb:${FRI}:fri_pconv`);
    expect(ps).toHaveLength(3);
    expect(ps[0]).toMatchObject({ repMin: 3, repMax: 5, targetRpe: 7, targetRpeMax: 7.5, rpeCap: 8 });
    // Conventional 기록이 있어도 Paused는 자기 기록이 없으면 가벼운 세트로 정한다
    expect(suggestForSet(db, ps[0], FRI).needsCalibration).toBe(true);
    expect(db.exercises.paused_conv.pause).toMatchObject({ seconds: 1 });
    const convBefore = JSON.stringify(db.exStates.conv_dl);
    db = doSets(db, `pb:${FRI}:fri_pconv`, FRI, 140, 5, 7);
    db = end(db, FRI);
    expect(db.exStates.paused_conv.lastDecision?.action).toBe('increase');
    expect(db.exStates.paused_conv.nextLoad).toBe(142.5);
    expect(JSON.stringify(db.exStates.conv_dl)).toBe(convBefore);
  });

  it('3. Sumo는 기본 루틴에서 빠지고 운동·기록·계수는 남는다', () => {
    const db = makeDb();
    expect(Object.values(db.instances).some((i) => i.exerciseId === 'comp_sumo')).toBe(false);
    expect(db.exercises.comp_sumo).toBeTruthy();
    expect(db.exercises.comp_sumo.archived).toBeFalsy();
    expect(DEFAULT_DAYS.flatMap((d) => d.items).some((i) => i.exerciseId === 'comp_sumo')).toBe(false);
  });
});

describe('보조 운동 슬롯', () => {
  it('4. Upper Chest: Incline DB → Incline Chest Press Machine. 처방 유지, 새 머신은 따로 Calibration', () => {
    let db = run(makeDb([MON, NEXT(MON)]), {});
    db = run(db, assignSlot(db, 'upper_chest', 'incline_db', makeCtx(MON)));
    expect(db.instances[`pb:${WED}:wed_incline`].exerciseId).toBe('incline_db');
    db = doSets(db, `pb:${WED}:wed_incline`, WED, 30, 12, 7.5);
    db = end(db, WED);
    const dbState = JSON.stringify(db.exStates.incline_db);
    db = run(db, assignSlot(db, 'upper_chest', 'incline_machine', makeCtx(WED)));
    const next = setsOf(db, `pb:${NEXT(WED)}:wed_incline`);
    expect(db.instances[`pb:${NEXT(WED)}:wed_incline`]).toMatchObject({ exerciseId: 'incline_machine', slotId: 'upper_chest' });
    expect(next.map((s) => [s.repMin, s.repMax, s.targetRpe])).toEqual([[8, 12, 7.5], [8, 12, 7.5]]);
    expect(suggestForSet(db, next[0], NEXT(WED)).needsCalibration).toBe(true);
    expect(JSON.stringify(db.exStates.incline_db)).toBe(dbState);
    // 지난주 기록은 원래 운동으로 남는다
    expect(Object.values(db.performed).every((p) => p.sessionDate !== WED || p.exerciseId === 'incline_db')).toBe(true);
  });

  it('5·6. Horizontal Pull: Chest-supported Row → Linear Row. 환산 없이 독립 기록·진행', () => {
    let db = makeDb([MON, NEXT(MON)]);
    db = run(db, assignSlot(db, 'horizontal_pull', 'cs_row', makeCtx(MON)));
    db = doSets(db, `pb:${MON}:mon_row`, MON, 60, 12, 7.5);
    db = end(db, MON);
    expect(db.exStates.cs_row.nextLoad).toBe(62.5);
    db = run(db, assignSlot(db, 'horizontal_pull', 'linear_row', makeCtx(MON)));
    // 이번 주 화요일(아직 안 한 계획)부터 Linear Row로 바뀐다. 세트 수 4 그대로
    const tue = setsOf(db, `pb:${TUE}:tue_row`);
    expect(tue.map((s) => s.exerciseId)).toEqual(['linear_row', 'linear_row', 'linear_row', 'linear_row']);
    const s = suggestForSet(db, tue[0], TUE);
    expect(s.needsCalibration).toBe(true);
    expect(s.load).toBeNull();
    db = doSets(db, `pb:${TUE}:tue_row`, TUE, 40, 12, 7.5);
    db = end(db, TUE);
    expect(db.exStates.linear_row.nextLoad).toBe(42.5);
    expect(db.exStates.cs_row.nextLoad).toBe(62.5);
    expect(slotHistory(db, 'horizontal_pull').map((h) => h.exerciseId)).toEqual(['linear_row', 'cs_row']);
  });

  it('7. 예전 운동을 다시 고르면 그 운동의 마지막 진행 상태를 쓴다', () => {
    let db = makeDb([MON, NEXT(MON)]);
    db = run(db, assignSlot(db, 'horizontal_pull', 'cs_row', makeCtx(MON)));
    db = doSets(db, `pb:${MON}:mon_row`, MON, 60, 12, 7.5);
    db = end(db, MON);
    db = run(db, assignSlot(db, 'horizontal_pull', 'linear_row', makeCtx(MON)));
    db = run(db, assignSlot(db, 'horizontal_pull', 'cs_row', makeCtx(MON)));
    const s = suggestForSet(db, setsOf(db, `pb:${NEXT(MON)}:mon_row`)[0], NEXT(MON));
    expect(s.load).toBe(62.5);
    expect(s.kind).toBe('progression');
  });

  it('8. 운동 중간 교체: 완료 세트는 원래 운동에 남고 남은 세트만 바뀜. 슬롯 주간 달성률 유지', () => {
    let db = makeDb();
    const inst = `pb:${MON}:mon_row`;
    db = doSets(db, inst, MON, 60, 12, 7.5, 2);
    db = run(db, swapInstanceExercise(db, inst, 'seated_cable_row', makeCtx(MON)));
    expect(setsOf(db, inst).map((s) => s.status)).toEqual(['done', 'done']);
    const moved = Object.values(db.plannedSets).filter((s) => s.instanceId === `${inst}~1`);
    expect(moved.map((s) => s.exerciseId)).toEqual(['seated_cable_row', 'seated_cable_row', 'seated_cable_row']);
    expect(db.instances[`${inst}~1`].slotId).toBe('horizontal_pull');
    db = doSets(db, `${inst}~1`, MON, 50, 12, 7.5);
    db = end(db, MON);
    db = doSets(db, `pb:${TUE}:tue_row`, TUE, 60, 12, 7.5);
    const row = slotAchievement(db, { start: MON, end: '2026-12-06' }).find((r) => r.slotId === 'horizontal_pull')!;
    expect(row).toMatchObject({ planned: 9, done: 9 });
    expect(row.exercises.sort()).toEqual(['linear_row', 'seated_cable_row']);
    expect(periodAchievement(db, { start: MON, end: '2026-12-06' }, MON).pb.original.total).toBe(80);
  });

  it('9. 고정 운동과 겹치는 선택은 경고만 하고 자동으로 바꾸지 않는다', () => {
    const db = makeDb();
    expect(duplicateWarnings(db, 'rdl', MON).join()).toMatch(/이미 고정 운동/);
    expect(duplicateWarnings(db, 'pullup_bw', MON).join()).toMatch(/Weighted Pull-up \(Strength\)/);
    expect(duplicateWarnings(db, 'dips_volume', MON)).toEqual([]);
    expect(duplicateWarnings(db, 'linear_row', MON)).toEqual([]);
    const after = run(db, assignSlot(db, 'hip_hinge', 'rdl', makeCtx(MON)));
    expect(Object.values(after.instances).filter((i) => i.exerciseId === 'rdl')).toHaveLength(1);
  });
});

describe('패턴·근육군 집계', () => {
  const withSets = () => {
    let db = makeDb();
    db = doSets(db, `pb:${MON}:mon_row`, MON, 60, 12, 7.5); // Horizontal Pull 5
    db = doSets(db, `pb:${MON}:mon_lat`, MON, 10, 15, 7.5); // Lateral Delt 3
    db = end(db, MON);
    db = doSets(db, `pb:${TUE}:tue_pull`, TUE, 10, 5, 7.5); // Vertical Pull(Strength) 3
    db = doSets(db, `pb:${TUE}:tue_row`, TUE, 60, 12, 7.5); // Horizontal Pull 4
    db = end(db, TUE);
    db = doSets(db, `pb:${WED}:wed_rpd`, WED, 30, 15, 7.5); // Posterior Delt 3
    db = end(db, WED);
    return db;
  };
  const week = { start: MON, end: '2026-12-06' };

  it('10. Delts는 Anterior / Lateral / Posterior를 따로 표시', () => {
    const db = withSets();
    const m = Object.fromEntries(muscleVolume(db, week).map((r) => [r.muscle, r.total]));
    expect(m.side_delt).toBe(3);
    expect(m.rear_delt).toBe(3 + 5 * 0.5 + 4 * 0.5);
    expect(['front_delt', 'side_delt', 'rear_delt'].map(muscleName)).toEqual(['Anterior Delt', 'Lateral Delt', 'Posterior Delt']);
  });
  it('11. Horizontal Pull과 Vertical Pull을 따로 집계', () => {
    const mv = Object.fromEntries(movementVolume(withSets(), week).map((r) => [r.movement, r.sets]));
    expect(mv.horizontal_pull).toBe(9);
    expect(mv.vertical_pull).toBe(3);
  });
  it('12. 운동 패턴 세트와 근육군 가중 유효 세트는 다른 지표', () => {
    const db = withSets();
    const mv = movementVolume(db, week);
    const mu = muscleVolume(db, week);
    expect(mv.some((r) => r.movement === 'horizontal_pull')).toBe(true);
    expect(mu.some((r) => (r.muscle as string) === 'horizontal_pull')).toBe(false);
    // 같은 로우 9세트가 근육군에서는 Upper Back 9 + Lats 9 + 보조근 가중치로 나뉜다
    const m = Object.fromEntries(mu.map((r) => [r.muscle, r.total]));
    expect(m.upper_back).toBe(9 + 3 * 0.5 + 3 * 0.5);
    expect(m.lats).toBe(9 + 3);
  });
});

describe('마이그레이션', () => {
  // 예전(A안) 구성: 화 Sumo Top+Backoff, 금 Conventional Straight, 보조는 운동 이름 고정
  const OLD_DAYS: ProgramDayTemplate[] = [
    { weekday: 1, label: '월', items: [
      { id: 'mon_row', exerciseId: 'cs_row', model: 'double_progression', required: false, groups: [{ type: 'volume', count: 5, repMin: 8, repMax: 12, targetRpe: 7.5, rpeCap: 8 }] },
    ] },
    { weekday: 2, label: '화', items: [
      { id: 'tue_sumo', exerciseId: 'comp_sumo', model: 'top_backoff', required: true, groups: [{ type: 'top', count: 1, reps: 4, targetRpe: 7.5, rpeCap: 8 }, { type: 'backoff', count: 4, reps: 4, targetRpe: 7, rpeCap: 8 }] },
    ] },
    { weekday: 3, label: '수', items: [
      { id: 'wed_incline', exerciseId: 'incline_db', model: 'double_progression', required: true, groups: [{ type: 'volume', count: 2, repMin: 8, repMax: 12, targetRpe: 7.5, rpeCap: 8 }] },
    ] },
    { weekday: 5, label: '금', items: [
      { id: 'fri_rdl', exerciseId: 'rdl', model: 'double_progression', required: true, groups: [{ type: 'volume', count: 2, repMin: 8, repMax: 10, targetRpe: 7, rpeCap: 8 }] },
      { id: 'fri_conv', exerciseId: 'conv_dl', model: 'straight_linear', required: true, groups: [{ type: 'straight', count: 4, reps: 4, targetRpe: 7.5, rpeCap: 8 }] },
    ] },
  ];
  const oldDb = (): Db => {
    let db = emptyDb() as Db;
    const oldEx = DEFAULT_EXERCISES.filter((e) => ['comp_sumo', 'conv_dl', 'cs_row', 'incline_db', 'rdl', 'comp_squat', 'comp_bench'].includes(e.id))
      .map((e) => (e.id === 'conv_dl' ? { ...e, name: 'Conventional Deadlift', role: 'strength' as const, fixed: undefined } : e));
    db.exercises = Object.fromEntries(oldEx.map((e) => [e.id, e]));
    const v: ProgramVersion = { id: 'pv-1', name: 'V1.9', version: 1, createdAt: '2026-11-01T00:00:00Z', effectiveFrom: '2000-01-03', days: OLD_DAYS };
    db.versions = { 'pv-1': v };
    db.settings = { ...db.settings, programStart: MON, onboardingDone: true, bodyweight: 66 };
    db = applyPatch(db, ensureWeeks(db, [MON]));
    db = doSets(db, `pb:${TUE}:tue_sumo`, TUE, 200, 4, 7.5);
    db = end(db, TUE);
    db.arm = { schemaVersion: 'x' } as unknown as Db['arm'];
    db.coeffs = { c1: { id: 'c1', exerciseId: 'comp_sumo', kind: 'manual', at: '2026-12-01T00:00:00Z', manualK: 0.98 } };
    return db;
  };

  it('13. 기록·계수·ARM은 그대로, 다음 주부터 B안. 한 번만 실행', () => {
    const before = oldDb();
    const ctx = makeCtx(WED);
    const patch = migrateV19B(before, ctx)!;
    const db = applyPatch(before, patch);
    expect(db.performed).toEqual(before.performed);
    expect(db.coeffs).toEqual(before.coeffs);
    expect(db.arm).toEqual(before.arm);
    expect(db.exStates.comp_sumo).toEqual(before.exStates.comp_sumo);
    expect(db.exercises.comp_sumo).toBeTruthy();
    expect(db.exercises.conv_dl).toMatchObject({ name: 'Comp Conventional Deadlift', role: 'comp' });
    expect(db.exercises.linear_row && db.exercises.paused_conv && db.exercises.incline_machine).toBeTruthy();
    // 이번 주(이미 시작한 주)의 계획은 그대로
    expect(db.instances[`pb:${TUE}:tue_sumo`]).toBeTruthy();
    const v2 = Object.values(db.versions).find((v) => v.version === 2)!;
    expect(v2.effectiveFrom).toBe(NEXT(MON));
    const next = applyPatch(db, ensureWeeks(db, [NEXT(MON)]));
    expect(next.instances[`pb:${NEXT(TUE)}:tue_conv`].exerciseId).toBe('conv_dl');
    expect(next.instances[`pb:${NEXT(FRI)}:fri_pconv`].exerciseId).toBe('paused_conv');
    expect(next.instances[`pb:${NEXT(MON)}:mon_row`]).toMatchObject({ exerciseId: 'linear_row', slotId: 'horizontal_pull' });
    expect(next.instances[`pb:${NEXT(WED)}:wed_incline`]).toMatchObject({ exerciseId: 'incline_machine', slotId: 'upper_chest' });
    // 금요일 순서: Paused Conventional → RDL
    expect(v2.days.find((d) => d.weekday === 5)!.items.map((i) => i.exerciseId)).toEqual(['paused_conv', 'rdl']);
    // 세트 수 유지(금요일 데드리프트만 3세트로 시작)
    const count = (days: ProgramDayTemplate[], wd: number) => days.find((d) => d.weekday === wd)!.items.reduce((n, i) => n + i.groups.reduce((m, g) => m + g.count, 0), 0);
    expect([1, 2, 3].map((wd) => count(v2.days, wd))).toEqual([1, 2, 3].map((wd) => count(OLD_DAYS, wd)));
    expect(db.settings.migrations).toContain(MIGRATION_V19B);
    expect(migrateV19B(db, ctx)).toBeNull();
  });

  it('13-1. 표시 이름: Competition → Comp, Stop-and-go Bench는 Comp 없이. 기록·id는 그대로, 직접 바꾼 이름은 유지', () => {
    let db = makeDb();
    db.exercises = { ...db.exercises, comp_squat: { ...db.exercises.comp_squat, name: 'Competition Low-bar Squat' }, sng_bench: { ...db.exercises.sng_bench, name: 'Competition Stop-and-go Bench' }, larsen_bench: { ...db.exercises.larsen_bench, name: '내 라센' } };
    const inst = `pb:${MON}:mon_sq`;
    db.instances = { ...db.instances, [inst]: { ...db.instances[inst], exerciseName: 'Competition Low-bar Squat' } };
    db = applyPatch(db, migrateNames(db)!);
    expect(db.exercises.comp_squat.name).toBe('Comp Low-bar Squat');
    expect(db.exercises.sng_bench.name).toBe('Stop-and-go Bench');
    expect(db.exercises.larsen_bench.name).toBe('내 라센');
    expect(db.instances[inst].exerciseName).toBe('Comp Low-bar Squat');
    expect(migrateNames(db)).toBeNull();
    expect(DEFAULT_EXERCISES.some((e) => e.name.includes('Competition'))).toBe(false);
  });

  it('13-2. 새 기본 프리셋은 변환해도 그대로(새로 설치한 경우)', () => {
    expect(transformDaysV19B(DEFAULT_DAYS)).toEqual(DEFAULT_DAYS);
  });

  it('14. 기본 프리셋 주간 세트: 보조 슬롯 세트 수는 예전과 같다', () => {
    const sets = (slot: string) => DEFAULT_DAYS.flatMap((d) => d.items).filter((i) => i.slotId === slot).reduce((n, i) => n + i.groups[0].count, 0);
    expect(['upper_chest', 'horizontal_pull', 'lateral_delt', 'posterior_delt', 'triceps', 'knee_extension', 'knee_flexion', 'abs'].map(sets)).toEqual([2, 9, 7, 3, 2, 3, 5, 6]);
    expect(sets('hip_hinge')).toBe(0); // RDL은 고정 운동(패턴 분류만 Hip Hinge)
  });
});

describe('원판 계산 적용 범위', () => {
  it('바벨 운동만 원판 계산(설정의 바 무게), 스미스·플레이트 머신·케이블은 제외', () => {
    const db = makeDb();
    const bars = DEFAULT_EXERCISES.filter((e) => e.equipment === 'barbell');
    expect(bars.map((e) => e.id).sort()).toEqual(['comp_bench', 'comp_squat', 'comp_sumo', 'conv_dl', 'decline_press', 'highbar_squat', 'larsen_bench', 'paused_conv', 'rdl', 'sng_bench']);
    for (const e of bars) expect(plateSetup(e, db.settings)).toEqual({ base: 20 });
    expect(plateSetup(db.exercises.incline_smith, db.settings)).toBeNull();
    expect(plateSetup(db.exercises.linear_row, db.settings)).toBeNull();
    expect(plateSetup(db.exercises.cable_lateral, db.settings)).toBeNull();
    expect(plateBreakdown(60, 0, db.settings.plates)?.perSide).toEqual([25, 5]);
  });
  it('원판 보유량에 따른 단위 제한은 바벨에만', () => {
    let db = makeDb();
    db = { ...db, settings: { ...db.settings, plateStock: [{ kg: 20, pairs: null }, { kg: 5, pairs: null }] } };
    expect(stepOf(db, db.exercises.rdl)).toBe(10);
    expect(stepOf(db, db.exercises.linear_row)).toBe(2.5);
  });
  it('라이브러리에서 장비를 바벨로 바꾸면 원판 계산 대상이 되고, 바 무게를 따로 정할 수 있다', () => {
    let db = makeDb();
    const base = { name: 'Close-grip Bench', category: 'arms', slotId: 'triceps', equipment: 'barbell' as const, increment: 2.5, primaryMuscles: ['triceps'], secondaryMuscles: ['chest'], unilateral: false };
    db = run(db, saveExercise(db, { ...base, barWeight: 15 }, makeCtx()));
    const ex = Object.values(db.exercises).find((e) => e.name === 'Close-grip Bench')!;
    expect(ex.barbell).toBe(true);
    expect(plateSetup(ex, db.settings)).toEqual({ base: 15 });
    db = run(db, saveExercise(db, { ...base, id: ex.id, equipment: 'cable', barWeight: undefined }, makeCtx()));
    expect(plateSetup(db.exercises[ex.id], db.settings)).toBeNull();
  });
});
