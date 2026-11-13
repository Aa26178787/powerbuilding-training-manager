// 최초 중량 산출(명세 6장)과 반올림 정책(반올림 명세 6장) 테스트
import { describe, expect, it } from 'vitest';
import type { Db, PlannedSet } from '../domain/types';
import { recordSet, endSession, setSeed, activeSession } from '../application/session';
import { suggestForSet, stepOf } from '../application/recommend';
import {
  armPercentLoad, calibrateInitialLoad, estimateVariationLoad, estimateWeightedBodyweightLoad, fastTrackLoad, recommendNextSetLoad,
  totalExternalLoad, calculateConservativeE1RM,
} from '../engine/initialLoad';
import { loadForTarget } from '../engine/e1rm';
import { roundLoad, roundingFor } from '../engine/rounding';
import { DEFAULT_EXERCISES } from '../domain/defaults';
import { makeCtx, makeDb, run, START } from './helpers';

const MON = START; const TUE = '2026-12-01'; const WED = '2026-12-02'; const THU = '2026-12-03'; const FRI = '2026-12-04';
const setsOf = (db: Db, inst: string): PlannedSet[] => Object.values(db.plannedSets).filter((s) => s.instanceId === inst).sort((a, b) => a.index - b.index);
const seed = (db: Db, id: string, w: number, r: number, p: number, bw?: number) => run(db, setSeed(db, id, { weight: w, reps: r, rpe: p, bodyweight: bw }, makeCtx()));

describe('반올림 정책', () => {
  it('129.84kg, 2.5kg 단위: NEAREST 130, FLOOR 127.5, CEIL 130', () => {
    expect(roundLoad(129.84, 2.5, 'nearest')).toBe(130);
    expect(roundLoad(129.84, 2.5, 'floor')).toBe(127.5);
    expect(roundLoad(129.84, 2.5, 'ceil')).toBe(130);
  });
  it('131.25kg NEAREST는 동률이면 올림 → 132.5', () => {
    expect(roundLoad(131.25, 2.5, 'nearest')).toBe(132.5);
  });
  it('사용 불가능한 중량을 추천하지 않음(모든 모드, 여러 단위)', () => {
    for (const step of [1.25, 2.5, 5]) for (const mode of ['nearest', 'floor', 'ceil'] as const) {
      for (let raw = 20.07; raw < 260; raw += 3.37) {
        const v = roundLoad(raw, step, mode);
        expect(Math.abs(v / step - Math.round(v / step))).toBeLessThan(1e-9);
      }
    }
  });
  it('세트 종류별 기본 정책과 운동별 지정', () => {
    expect(roundingFor('top')).toBe('nearest');
    expect(roundingFor('backoff')).toBe('floor');
    expect(roundingFor('reduce')).toBe('floor');
    expect(roundingFor('start')).toBe('nearest');
    expect(roundingFor('top', { top: 'floor' })).toBe('floor');
    expect(roundingFor('top', { top: 'floor' }, 'ceil')).toBe('ceil');
  });
  it('바벨은 가진 원판이 만들 수 있는 간격보다 작은 단위로 추천하지 않음', () => {
    let db = makeDb();
    db = { ...db, settings: { ...db.settings, plateStock: [{ kg: 25, pairs: null }, { kg: 2.5, pairs: null }] } };
    expect(stepOf(db, db.exercises.comp_bench)).toBe(5);
    db = seed(db, 'comp_bench', 100, 5, 8);
    const s = suggestForSet(db, setsOf(db, `pb:${WED}:wed_bp`)[0], WED);
    expect((s.load as number) % 5).toBe(0);
  });
  it('Fast-track: 역산 중량과 선형 증량 중 하나만, 상한 준수, 같은 기록으로 두 번 보정하지 않음', () => {
    const base = { sourceId: 'p1', lastLoad: 150, reps: 5, targetRpe: 7.5, increment: 2.5, step: 2.5, maxPct: 0.05 };
    const big = fastTrackLoad({ ...base, rpe: 5.5 });
    expect(big.applied).toBe(true);
    expect(big.rounded).toBeLessThanOrEqual(157.5);
    expect(big.rounded).toBeGreaterThan(152.5);
    const small = fastTrackLoad({ ...base, rpe: 7.5 });
    expect(small.applied).toBe(false);
    expect(small.rounded).toBe(152.5);
    expect(fastTrackLoad({ ...base, rpe: 5.5, alreadyUsedSourceId: 'p1' }).applied).toBe(false);
  });
  it('중간 반올림 없음: 최종값은 반올림 전 계산값에서 한 번만 맞춘다', () => {
    const r = estimateVariationLoad({ compE1rm: 152.3, kBase: 0.925, kIndividual: 1.013, reps: 8, rpe: 7, increment: 1.25, rounding: 'nearest' });
    expect(r.raw).toBeCloseTo(loadForTarget(152.3 * 0.925 * 1.013, 8, 7), 10);
    expect(r.rounded).toBe(roundLoad(r.raw, 1.25, 'nearest'));
  });
});

describe('최초 중량 산출', () => {
  it('Competition 기록이 있으면 Variation 첫 중량을 8회 @7로 추정', () => {
    let db = makeDb([MON, START]);
    db = seed(db, 'comp_bench', 100, 5, 8);
    const s = suggestForSet(db, setsOf(db, `pb:${THU}:thu_larsen`)[0], THU);
    expect(s.method).toBe('comp_e1rm');
    expect(s.confidence).toBe('estimate');
    expect(s.basis).toMatchObject({ kBase: 0.925, targetReps: 8, targetRpe: 7 });
    const e = calculateConservativeE1RM(100, 5, 8);
    expect(s.load).toBe(roundLoad(loadForTarget(e * 0.925, 8, 7), 1.25, 'nearest'));
  });
  it('Competition 기록이 없으면 워밍업 보정이 필요하고, 워밍업 세트로 시작 중량을 계산', () => {
    const db = makeDb();
    const s = suggestForSet(db, setsOf(db, `pb:${THU}:thu_larsen`)[0], THU);
    expect(s.needsCalibration).toBe(true);
    expect(s.load).toBeNull();
    const c = calibrateInitialLoad({ warmup: { weight: 60, reps: 8, rpe: 5 }, target: { reps: 8, rpe: 7 }, increment: 1.25 });
    expect(c.rounded!).toBeGreaterThan(60);
    expect(c.rounded!).toBeLessThan(calculateConservativeE1RM(60, 8, 5));
  });
  it('SnG 1.000, Larsen 0.925, High-bar 0.925(스쿼트 기준) 서로 다른 초기계수', () => {
    let db = makeDb();
    db = seed(db, 'comp_bench', 100, 5, 8);
    db = seed(db, 'comp_squat', 150, 5, 8);
    const sng = suggestForSet(db, setsOf(db, `pb:${MON}:mon_sng`)[0], MON);
    const larsen = suggestForSet(db, setsOf(db, `pb:${THU}:thu_larsen`)[0], THU);
    const hb = suggestForSet(db, setsOf(db, `pb:${WED}:wed_hsq`)[0], WED);
    expect(sng.basis?.kBase).toBe(1);
    expect(larsen.basis?.kBase).toBe(0.925);
    expect(hb.basis).toMatchObject({ kBase: 0.925, baseExercise: 'Competition Low-bar Squat' });
    expect(sng.load!).toBeGreaterThan(larsen.load!);
  });
  it('Sumo 기록으로 Conventional 중량을 계산하지 않음', () => {
    let db = makeDb();
    db = seed(db, 'comp_sumo', 200, 4, 8);
    const s = suggestForSet(db, setsOf(db, `pb:${TUE}:tue_conv`)[0], TUE);
    expect(s.needsCalibration).toBe(true);
    expect(s.load).toBeNull();
    db = seed(db, 'conv_dl', 170, 4, 8);
    const s2 = suggestForSet(db, setsOf(db, `pb:${TUE}:tue_conv`)[0], TUE);
    expect(s2.method).toBe('own_record');
    expect(s2.basis?.targetRpe).toBe(7.5);
  });
  it('체중이 바뀌면 딥스·풀업 추가 중량을 다시 계산하고, 음수면 보조 안내', () => {
    const sys = calculateConservativeE1RM(66 + 30, 5, 8);
    const a = estimateWeightedBodyweightLoad({ systemE1rm: sys, bodyweight: 66, reps: 5, rpe: 7.5, increment: 1.25 });
    const b = estimateWeightedBodyweightLoad({ systemE1rm: sys, bodyweight: 70, reps: 5, rpe: 7.5, increment: 1.25 });
    expect(a.systemLoad).toBeCloseTo(b.systemLoad, 10);
    expect(Math.abs(a.raw - b.raw - 4)).toBeLessThan(1e-9);
    const weak = estimateWeightedBodyweightLoad({ systemE1rm: 70, bodyweight: 70, reps: 5, rpe: 7.5, increment: 1.25 });
    expect(weak.assistNeeded).toBe(true);
    expect(weak.added).toBeNull();
  });
  it('Strength와 Volume 진행 상태는 따로: Volume은 Strength 기록으로 임시 추정만', () => {
    let db = makeDb();
    const ctx = makeCtx(TUE);
    for (const s of setsOf(db, `pb:${TUE}:tue_pull`)) db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: 'pullup_strength', date: TUE, weight: 20, reps: 5, rpe: 7.5 }, ctx));
    db = run(db, endSession(db, activeSession(db)!.id, ctx).patch);
    expect(db.exStates.pullup_strength.nextLoad).not.toBeNull();
    expect(db.exStates.pullup_volume?.nextLoad ?? null).toBeNull();
    const v = suggestForSet(db, setsOf(db, `pb:${FRI}:fri_pullv`)[0], FRI);
    expect(v.method).toBe('related_e1rm');
    expect(v.confidence).toBe('estimate');
    expect(v.basis?.targetReps).toBe(8);
  });
  it('덤벨 한 손 중량과 머신 표시값을 총중량과 섞지 않음', () => {
    const byId = Object.fromEntries(DEFAULT_EXERCISES.map((e) => [e.id, e]));
    expect(byId.incline_db.loadUnit).toBe('per_hand');
    expect(byId.leg_ext.loadUnit).toBe('machine');
    expect(totalExternalLoad(20, 'per_hand')).toBe(40);
    expect(totalExternalLoad(45, 'machine')).toBeNull();
    expect(totalExternalLoad(100, 'total')).toBe(100);
  });
  it('첫 세트 RPE가 예상보다 높으면 내리고(내림), 낮으면 올림(가까운 쪽)', () => {
    const hi = recommendNextSetLoad({ load: 100, reps: 8, lastRpe: 9, targetRpe: 7, rpeCap: 8, increment: 1.25, isFirstSet: true });
    expect(hi.action).toBe('decrease');
    expect(hi.load).toBeLessThan(100);
    const lo = recommendNextSetLoad({ load: 100, reps: 8, lastRpe: 5.5, targetRpe: 7, rpeCap: 8, increment: 1.25, isFirstSet: true });
    expect(lo.action).toBe('increase');
    expect(lo.load).toBeGreaterThan(100);
  });
  it('첫 세션 종료 후 다음 세션 진행 상태와 첫 세션 요약 생성', () => {
    let db = makeDb();
    db = seed(db, 'conv_dl', 170, 4, 8);
    const ctx = makeCtx(TUE);
    const sets = setsOf(db, `pb:${TUE}:tue_conv`);
    const first = suggestForSet(db, sets[0], TUE);
    for (const s of sets) {
      const load = suggestForSet(db, s, TUE).load;
      db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: 'conv_dl', date: TUE, weight: load, reps: 4, rpe: s.type === 'top' ? 7.5 : 7 }, ctx));
    }
    db = run(db, endSession(db, activeSession(db)!.id, ctx).patch);
    const st = db.exStates.conv_dl;
    expect(st.firstSession).toMatchObject({ recommendedLoad: first.load, actualLoad: first.load, modified: false, method: 'own_record' });
    expect(st.firstSession?.sets.length).toBe(5);
    expect(st.lastDecision?.action).toBe('increase');
    expect(st.nextLoad).toBe((first.load as number) + 2.5);
  });
  it('ARM: %1RM은 기준 1RM 등록·원본 확인된 처방에서만 계산', () => {
    expect(armPercentLoad({ percent1rm: 70, oneRm: 100, increment: 0.5, sourceMissing: [], verified: true })).toBe(70);
    expect(armPercentLoad({ percent1rm: 70, oneRm: undefined, increment: 0.5, sourceMissing: [], verified: true })).toBeNull();
    expect(armPercentLoad({ percent1rm: 70, oneRm: 100, increment: 0.5, sourceMissing: ['intensity'], verified: true })).toBeNull();
    expect(armPercentLoad({ percent1rm: 70, oneRm: 100, increment: 0.5, sourceMissing: [], verified: false })).toBeNull();
    expect(armPercentLoad({ percent1rm: null, oneRm: 100, increment: 0.5, sourceMissing: [], verified: true })).toBeNull();
  });
  it('Hanging Leg Raise는 외부 중량 0kg, 반복수 진행', () => {
    const db = makeDb();
    const s = suggestForSet(db, setsOf(db, `pb:${TUE}:tue_hlr`)[0], TUE);
    expect(s.load).toBe(0);
    expect(s.method).toBe('bodyweight_only');
  });
});
