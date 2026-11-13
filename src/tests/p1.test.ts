import { describe, expect, it } from 'vitest';
import type { Db, PlannedSet } from '../domain/types';
import { DEFAULT_MUSCLES } from '../domain/defaults';
import { calculateWeightedMuscleSets, evaluateCoefficients, fatigueSignals, predictRpe, conservativeE1RM, impliedE1RM, loadForTarget } from '../engine';
import { recordSet, editPerformedSet, recordArmRow } from '../application/session';
import { assignArmDays, suggestArmDates } from '../application/arm';
import { parseArmJson } from '../data-import/armImport';
import { setCoefficientManually, setObservationOverride, updateLearningSettings, coefficientEvaluation } from '../application/learning';
import { exerciseTrend, muscleDelta, muscleVolume, performedCsv } from '../application/analysis';
import { suggestForSet } from '../application/recommend';
import { commitChange, previewChange } from '../application/schedule';
import { applyPatch } from '../application/ctx';
import { ensureWeeks } from '../application/plan';
import { fakeArmJson, makeCtx, makeDb, run, START } from './helpers';

const setsOf = (db: Db, iid: string): PlannedSet[] => Object.values(db.plannedSets).filter((s) => s.instanceId === iid).sort((a, b) => a.index - b.index);
/** 스쿼트 한 세션: Top 5회 @topRpe, 첫 Backoff는 추천 중량으로 @boRpe */
const squatSession = (db0: Db, date: string, topW: number, topRpe: number, boRpe: number, flags: never[] | string[] = []) => {
  let db = applyPatch(db0, ensureWeeks(db0, [date]));
  const ctx = makeCtx(date, `${date}T10:00:00.000Z`);
  const ctx2 = { ...ctx, newId: () => `${date}-${Math.random().toString(36).slice(2, 8)}` };
  const sets = setsOf(db, `pb:${date}:mon_sq`);
  db = run(db, recordSet(db, { plannedSetId: sets[0].id, exerciseId: 'comp_squat', date, weight: topW, reps: 5, rpe: topRpe }, ctx2));
  const bo = suggestForSet(db, sets[1], date).load as number;
  db = run(db, recordSet(db, { plannedSetId: sets[1].id, exerciseId: 'comp_squat', date, weight: bo, reps: 5, rpe: boRpe, flags: flags as never[] }, ctx2));
  for (const s of sets.slice(2)) db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: 'comp_squat', date, weight: bo, reps: 5, rpe: Math.min(8, boRpe + 0.5) }, ctx2));
  // 세션 종료 대신 진행 중 세션을 닫아 다음 날짜 기록이 가능하게 한다
  const sess = Object.values(db.sessions).find((s) => s.status === 'in_progress')!;
  db = { ...db, sessions: { ...db.sessions, [sess.id]: { ...sess, status: 'ended' } } };
  return { db, bo };
};

describe('개인화 계수 학습 (FR-034, FR-035, TC-020)', () => {
  it('예측 RPE는 추천식의 역함수', () => {
    const e = conservativeE1RM(150, 5, 8);
    expect(predictRpe(e, 1, loadForTarget(e, 5, 7), 5)).toBeCloseTo(7, 6);
    expect(predictRpe(e, 1, loadForTarget(e, 3, 8.5), 3)).toBeCloseTo(8.5, 6);
  });
  it('재생 평가: 관측 이전 계수로만 예측(누수 없음), ±5% 제한, 제외 관측은 학습 안 함', () => {
    const ref = 180;
    const obs = (id: string, at: string, rpe: number, extra = {}) => ({ id, kind: 'observation' as const, at, refE1rm: ref, obsLoad: 142.5, obsReps: 5, obsRpe: rpe, rpeCap: 8, autoValid: true, ...extra });
    const ev = evaluateCoefficients([obs('a', '1', 8), obs('b', '2', 8), obs('c', '3', 9.5, { autoValid: false, excludedReason: '통증' })], 0.15, 5);
    const kObs = impliedE1RM(142.5, 5, 8) / ref;
    expect(ev.rows[0].kPrev).toBe(1);
    expect(ev.rows[0].predModel).toBeCloseTo(ev.rows[0].predBaseline!, 9); // 첫 관측은 두 모델이 같음
    expect(ev.rows[0].kNext).toBeCloseTo(0.85 + 0.15 * Math.max(0.95, kObs), 9);
    expect(ev.rows[1].kPrev).toBeCloseTo(ev.rows[0].kNext, 12); // 두 번째 예측은 첫 관측만 반영한 k 사용
    expect(Math.abs(ev.rows[1].errModel!)).toBeLessThan(Math.abs(ev.rows[1].errBaseline!));
    expect(ev.rows[2].used).toBe(false);
    expect(ev.k).toBeCloseTo(ev.rows[1].kNext, 12);
    expect(ev.n).toBe(2);
    expect(ev.maeModel!).toBeLessThan(ev.maeBaseline!);
    // 수동 지정·초기화 기록
    const ev2 = evaluateCoefficients([obs('a', '1', 8), { id: 'm', kind: 'manual', at: '2', manualK: 0.97 }, { id: 'r', kind: 'reset', at: '3' }], 0.15, 5);
    expect(ev2.rows[1].kNext).toBe(0.97);
    expect(ev2.k).toBe(1);
  });
  it('세션 기록 → 관측 생성 → k 갱신 → 다음 Backoff 추천에 반영', () => {
    let { db, bo } = squatSession(makeDb(), START, 150, 8, 8); // 추천 Backoff가 @7 목표인데 실제 @8
    expect(bo).toBe(142.5);
    const rec = db.coeffs[`k:pb:${START}:mon_sq`];
    expect(rec).toMatchObject({ kind: 'observation', obsLoad: 142.5, obsRpe: 8, autoValid: true });
    const k1 = db.exStates.comp_squat.k;
    expect(k1).toBeLessThan(1);
    expect(k1).toBeCloseTo(coefficientEvaluation(db, 'comp_squat').k, 12);
    // 다음 주: 같은 Top Set이면 더 가벼운 Backoff를 추천
    const second = squatSession(db, '2026-12-07', 150, 8, 7.5);
    db = second.db;
    // 반올림 전 추천값이 계수만큼 내려간다(반올림 후에는 같은 단위에 머물 수 있음)
    const raws = Object.values(db.recs).filter((r) => r.kind === 'backoff').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => r.rawLoad as number);
    expect(raws[1]).toBeCloseTo(raws[0] * k1, 6);
    expect(second.bo).toBeLessThanOrEqual(142.5);
    expect(Object.values(db.coeffs).length).toBe(2);
    const ev = coefficientEvaluation(db, 'comp_squat');
    expect(ev.n).toBe(2);
    expect(ev.rows[1].kPrev).toBeCloseTo(k1, 12);
    // 관측을 제외하면 k가 다시 계산됨
    db = run(db, setObservationOverride(db, `k:pb:${START}:mon_sq`, 'exclude', makeCtx()));
    expect(coefficientEvaluation(db, 'comp_squat').n).toBe(1);
    expect(db.exStates.comp_squat.k).not.toBeCloseTo(ev.k, 6);
    // 수동 초기화
    db = run(db, setCoefficientManually(db, 'comp_squat', 'reset', makeCtx('2026-12-08', '2026-12-08T00:00:00.000Z')));
    expect(db.exStates.comp_squat.k).toBe(1);
    expect(() => setCoefficientManually(db, 'comp_squat', 2, makeCtx())).toThrow();
  });
  it('이상 태그·이동 세션은 학습 제외 후보, 기록 수정 시 관측도 다시 계산', () => {
    let { db } = squatSession(makeDb(), START, 150, 8, 8.5, ['pain']);
    const id = `k:pb:${START}:mon_sq`;
    expect(db.coeffs[id].autoValid).toBe(false);
    expect(db.exStates.comp_squat.k).toBe(1);
    const bo = Object.values(db.performed).find((p) => p.type === 'backoff' && p.flags.length)!;
    db = run(db, editPerformedSet(db, bo.id, { flags: [], rpe: 7 }, makeCtx()));
    expect(db.coeffs[id]).toMatchObject({ autoValid: true, obsRpe: 7 });
    expect(Object.values(db.coeffs).length).toBe(1); // 같은 처방은 관측 1건으로 유지(이중 학습 없음)
  });
  it('자동 학습을 끄면 관측만 남고 k는 그대로, 설정 변경 시 재계산', () => {
    let db = makeDb();
    db = run(db, updateLearningSettings(db, { emaEnabled: false }, makeCtx()));
    db = squatSession(db, START, 150, 8, 8).db;
    expect(Object.values(db.coeffs).length).toBe(1);
    expect(db.exStates.comp_squat.k).toBe(1);
    db = run(db, updateLearningSettings(db, { emaEnabled: true, lambdaStrength: 0.3 }, makeCtx()));
    expect(db.exStates.comp_squat.k).toBeLessThan(1);
    expect(() => updateLearningSettings(db, { lambdaStrength: 2 }, makeCtx())).toThrow();
  });
});

describe('근육군 가중 세트 (FR-080)', () => {
  it('주동근 1.0·보조근 0.5, ARM 제외, 실제 완료 세트만', () => {
    const rows = calculateWeightedMuscleSets([{ exerciseId: 'comp_bench', sets: 5 }, { exerciseId: 'dips_strength', sets: 3 }, { exerciseId: 'cs_row', sets: 4 }], DEFAULT_MUSCLES);
    const m = Object.fromEntries(rows.map((r) => [r.muscle, r]));
    expect(m.chest).toMatchObject({ direct: 8, indirect: 0, total: 8 });
    expect(m.triceps).toMatchObject({ direct: 3, indirect: 2.5, total: 5.5 });
    expect(m.rear_delt).toMatchObject({ direct: 0, indirect: 2, total: 2 });
    const { db } = squatSession(makeDb(), START, 150, 8, 7);
    const vol = Object.fromEntries(muscleVolume(db, { start: START, end: '2026-12-06' }).map((r) => [r.muscle, r.total]));
    expect(vol.quads).toBe(5);
    expect(vol.adductors).toBe(2.5);
    expect(muscleVolume(db, { start: '2026-12-07', end: '2026-12-13' })).toEqual([]);
  });
  it('일정 변경 미리보기용 변화량: 면제·삭제 세트만큼 감소', () => {
    const db = makeDb();
    const tue = Object.values(db.plannedSets).filter((s) => s.plannedDate === '2026-12-01');
    const pv = previewChange(db, { kind: 'status', setIds: tue.map((s) => s.id), status: 'excused' });
    const d = Object.fromEntries(muscleDelta(db, pv.setPatches.map((p) => p.id)).map((r) => [r.muscle, r.total]));
    expect(d.lats).toBe(3 + 4);
    expect(d.hams).toBe(5 + 2); // Conventional Top+Backoff 5세트 + Knee Flexion 2세트
    expect(commitChange(db, pv, { reason: 'gym_closed', acknowledgedWarnings: true }, makeCtx()).put!.plannedSets!.length).toBe(17);
  });
});

describe('추세·피로·CSV', () => {
  it('운동별 e1RM 추세', () => {
    let { db } = squatSession(makeDb(), START, 150, 8, 7);
    db = squatSession(db, '2026-12-07', 152.5, 8, 7).db;
    const t = exerciseTrend(db, 'comp_squat');
    expect(t.e1rm.map((p) => p.date)).toEqual([START, '2026-12-07']);
    expect(t.e1rm[0].value).toBe(182); // 150 / 82.4% = 182.04
    expect(t.load[1].value).toBe(152.5);
  });
  it('피로 신호: 반복되는 상한 초과, 중량 정체 속 RPE 상승', () => {
    const s = (date: string, topLoad: number, maxRpe: number, avgRpe: number) => ({ date, topLoad, maxRpe, avgRpe, rpeCap: 8, flagged: false });
    expect(fatigueSignals([s('1', 150, 8, 7.5), s('2', 150, 8.5, 7.8), s('3', 150, 9, 8.3)], 'SQ').map((x) => x.code)).toEqual(['over_cap_repeat', 'rpe_creep']);
    expect(fatigueSignals([s('1', 150, 8, 7.5), s('2', 152.5, 8, 7.5), s('3', 155, 8, 7.5)], 'SQ')).toEqual([]);
    expect(fatigueSignals([s('1', 150, 9, 8)], 'SQ')).toEqual([]);
  });
  it('CSV: 수식 주입 방지·이스케이프', () => {
    let db = makeDb();
    const s = setsOf(db, `pb:${START}:mon_row`)[0];
    db = run(db, recordSet(db, { plannedSetId: s.id, exerciseId: 'linear_row', date: START, weight: 60, reps: 10, rpe: 7, note: '=SUM(A1), "메모"' }, makeCtx()));
    const csv = performedCsv(db);
    expect(csv.split('\n').length).toBe(3);
    expect(csv).toContain(`"'=SUM(A1), ""메모"""`);
    expect(csv).toContain('Linear Row,pb,volume');
  });
});

describe('ARM 빠른 입력·일괄 배정', () => {
  const withArm = (): Db => ({ ...makeDb(), arm: parseArmJson(fakeArmJson(), 'now').data! });
  it('기본 요일에 맞춰 한 주를 한 번에 배정', () => {
    let db = withArm();
    const plan = suggestArmDates(db, START);
    expect(plan.map((p) => p.date)).toEqual(['2026-11-30', '2026-12-02']); // 합성 데이터는 Day가 2개뿐
    db = run(db, assignArmDays(db, plan.map((p) => ({ dayIndex: p.ref.dayIndex, date: p.date })), makeCtx(START)));
    expect(db.settings.armCursor).toBe(2);
    expect(Object.values(db.workouts).filter((w) => w.track === 'arm').length).toBe(2);
    expect(suggestArmDates(db, START)).toEqual([]);
    // 수요일에 시작하면 그 주의 남은 요일만
    expect(suggestArmDates(withArm(), '2026-12-02').map((p) => p.date)).toEqual(['2026-12-02', '2026-12-04']);
  });
  it('한 줄로 왼팔·오른팔을 함께 기록하면 세트 완료, 한 팔만 넣어도 완료 처리', () => {
    let db = withArm();
    const ctx = makeCtx(START);
    db = run(db, assignArmDays(db, [{ dayIndex: 0, date: START }], ctx));
    const sets = setsOf(db, 'arm:0:a-w01-d1-e01');
    db = run(db, recordArmRow(db, { plannedSetId: sets[0].id, date: START, left: 20, right: 22.5, reps: 6, rpe: 9 }, ctx));
    const perf = Object.values(db.performed).filter((p) => p.plannedSetId === sets[0].id);
    expect(perf.map((p) => [p.side, p.weight]).sort()).toEqual([['L', 20], ['R', 22.5]]);
    expect(db.plannedSets[sets[0].id].status).toBe('done');
    expect(() => recordArmRow(db, { plannedSetId: sets[0].id, date: START, left: 20, right: 22.5, reps: 6 }, ctx)).toThrow(/중복|처리된/);
    db = run(db, recordArmRow(db, { plannedSetId: sets[1].id, date: START, left: 20, right: undefined, reps: 6 }, ctx));
    expect(db.plannedSets[sets[1].id].status).toBe('done');
    expect(Object.values(db.performed).filter((p) => p.plannedSetId === sets[1].id).map((p) => p.side)).toEqual(['L']);
    // 중량 없이(밴드·맨손) 기록
    db = run(db, recordArmRow(db, { plannedSetId: sets[2].id, date: START, left: null, right: null, reps: 6 }, ctx));
    expect(Object.values(db.performed).find((p) => p.plannedSetId === sets[2].id)).toMatchObject({ side: 'both', weight: null });
  });
});

describe('공식 변경 마이그레이션', () => {
  it('공식 버전이 다르면 관측을 새 공식으로 다시 만들고 k 재계산, 같으면 아무것도 안 함', async () => {
    const { migrateFormula } = await import('../application/learning');
    const { FORMULA_VERSION } = await import('../engine/e1rm');
    let { db } = squatSession(makeDb(), START, 150, 8, 8);
    const id = `k:pb:${START}:mon_sq`;
    // 옛 공식으로 계산된 것처럼 기준 e1RM을 바꿔 둔다
    db = { ...db, settings: { ...db.settings, formulaVersion: 'e1rm-rir30-1.0.0' }, coeffs: { ...db.coeffs, [id]: { ...db.coeffs[id], refE1rm: 182.5, override: 'include' } } };
    const p = migrateFormula(db, makeCtx())!;
    db = run(db, p);
    expect(db.coeffs[id].refE1rm).toBeCloseTo(150 / 0.824, 6);
    expect(db.coeffs[id].override).toBe('include');
    expect(db.settings.formulaVersion).toBe(FORMULA_VERSION);
    expect(migrateFormula(db, makeCtx())).toBeNull();
  });
});
