import { describe, expect, it } from 'vitest';
import {
  addDays, weekStart, weekdayOf, monthEnd, dateInTz, conservativeE1RM, impliedE1RM, loadForTarget, validateSetInput,
  roundLoad, plateBreakdown, minBarbellStep, recommendBackoff, adviseNextSet, variationStartLoad,
  observedK, updateCoefficient, decideProgression, calculateAchievement,
} from '../engine';
import type { PlannedSet } from '../domain/types';

describe('날짜', () => {
  it('주 시작(월요일)·요일·월말', () => {
    expect(weekStart('2026-12-03')).toBe('2026-11-30');
    expect(weekdayOf('2026-11-30')).toBe(1);
    expect(weekdayOf('2026-12-06')).toBe(7);
    expect(monthEnd('2026-12-10')).toBe('2026-12-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('자정 전후 세션: 한국 시간 23:30 시작은 그날 귀속', () => {
    expect(dateInTz('2026-11-30T14:30:00.000Z', 'Asia/Seoul')).toBe('2026-11-30');
    expect(dateInTz('2026-11-30T16:00:00.000Z', 'Asia/Seoul')).toBe('2026-12-01');
  });
});

describe('e1RM·Backoff (TC-001, TC-002, TC-005)', () => {
  it('보수적 e1RM과 Backoff가 재현 가능', () => {
    expect(conservativeE1RM(150, 5, 8)).toBeCloseTo(182.5, 6);
    const r = recommendBackoff({ topWeight: 150, topReps: 5, topRpe: 8, backoffReps: 5, backoffTargetRpe: 7, k: 1, increment: 2.5, rounding: 'down' });
    expect(r.raw).toBeCloseTo(182.5 / (1 + 8 / 30), 6);
    expect(r.rounded).toBe(142.5);
    expect(recommendBackoff(r.inputs)).toEqual(r); // 같은 입력 → 같은 출력
  });
  it('RPE 10 이상에서도 보수화 항이 음수가 되지 않음', () => {
    expect(conservativeE1RM(100, 3, 10)).toBeCloseTo(110, 6);
  });
  it('개인 보정계수 반영', () => {
    const a = recommendBackoff({ topWeight: 100, topReps: 5, topRpe: 7.5, backoffReps: 5, backoffTargetRpe: 7, k: 1, increment: 1.25, rounding: 'down' });
    const b = recommendBackoff({ ...a.inputs, k: 0.97 });
    expect(b.raw).toBeCloseTo(a.raw * 0.97, 6);
  });
  it('잘못된 입력 차단', () => {
    expect(validateSetInput(-5, 5, 8).length).toBe(1);
    expect(() => conservativeE1RM(100, 0, 8)).toThrow();
    expect(() => conservativeE1RM(100, 5, 11)).toThrow();
    expect(() => loadForTarget(NaN, 5, 8)).toThrow();
    expect(() => recommendBackoff({ topWeight: 20, topReps: 5, topRpe: 8, backoffReps: 5, backoffTargetRpe: 7, k: 1, increment: 1.25, rounding: 'down', bodyweight: 0 })).toThrow();
  });
  it('체중 66→67kg: 딥스 총 부하와 추가 중량을 분리 계산', () => {
    const base = { topWeight: 40, topReps: 5, topRpe: 8, backoffReps: 5, backoffTargetRpe: 7, k: 1, increment: 1.25, rounding: 'down' as const };
    const a = recommendBackoff({ ...base, bodyweight: 66 });
    const b = recommendBackoff({ ...base, bodyweight: 67 });
    expect(a.e1rmConservative).toBeCloseTo(106 * (1 + 6.5 / 30), 6);
    expect(b.e1rmConservative).toBeCloseTo(107 * (1 + 6.5 / 30), 6);
    expect(a.raw).toBeCloseTo(a.e1rmConservative / (1 + 8 / 30) - 66, 6);
    expect(a.rounded % 1.25).toBeCloseTo(0, 6);
    expect(a.rounded).toBeLessThanOrEqual(a.raw);
  });
  it('첫 Backoff가 상한을 넘으면 다음 세트 감량 제안', () => {
    const a = adviseNextSet({ load: 142.5, reps: 5, lastRpe: 8.5, targetRpe: 7, rpeCap: 8, drift: 0.5, increment: 2.5, rounding: 'down', isFirstBackoff: true });
    expect(a.action).toBe('decrease');
    expect(a.load).toBeLessThan(142.5);
    expect(a.offerStop).toBe(true);
  });
  it('상한 초과가 예상되면 미리 감량 추천, 여유가 크면 증량 가능', () => {
    expect(adviseNextSet({ load: 100, reps: 5, lastRpe: 8, targetRpe: 7, rpeCap: 8, drift: 0.5, increment: 2.5, rounding: 'down', isFirstBackoff: false }).action).toBe('decrease');
    expect(adviseNextSet({ load: 100, reps: 5, lastRpe: 7, targetRpe: 7, rpeCap: 8, drift: 0.5, increment: 2.5, rounding: 'down', isFirstBackoff: true }).action).toBe('keep');
    const up = adviseNextSet({ load: 100, reps: 5, lastRpe: 5.5, targetRpe: 7, rpeCap: 8, drift: 0.5, increment: 2.5, rounding: 'down', isFirstBackoff: true });
    expect(up.action).toBe('increase');
    expect(up.load).toBeGreaterThan(100);
  });
  it('Variation 시작 중량', () => {
    const r = variationStartLoad(180, 0.925, 1, 10, 7, 2.5);
    expect(r.estimated1rm).toBeCloseTo(166.5, 6);
    expect(r.rounded).toBe(115); // 166.5 / (1 + 13/30) = 116.16 → 내림
  });
});

describe('반올림·원판', () => {
  it('기본 내림, 부동소수 오차 보정', () => {
    expect(roundLoad(144.08, 2.5)).toBe(142.5);
    expect(roundLoad(142.5, 2.5)).toBe(142.5);
    expect(roundLoad(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(roundLoad(144.08, 2.5, 'nearest')).toBe(145);
    expect(roundLoad(-3, 2.5)).toBe(0);
    expect(() => roundLoad(100, 0)).toThrow();
  });
  it('원판 조합', () => {
    expect(minBarbellStep([20, 5, 1.25, 0.25])).toBe(0.5);
    const b = plateBreakdown(142.5, 20, [25, 20, 15, 10, 5, 2.5, 1.25]);
    expect(b?.perSide).toEqual([25, 25, 10, 1.25]);
    expect(b?.remainder).toBe(0);
    expect(plateBreakdown(141, 20, [20, 10, 5])?.remainder).toBe(1);
    expect(plateBreakdown(10, 20, [20])).toBeNull();
  });
});

describe('진행 판정 (TC-003, TC-004, TC-006)', () => {
  const top = (reps: number, rpe: number, flags: never[] | string[] = []) => ({ weight: 150, reps, rpe, flags: flags as never[], type: 'top' });
  const base = { model: 'top_backoff' as const, plannedCount: 5, targetReps: 5, rpeCap: 8, increment: 2.5, prevFailStreak: 0 };
  it('목표 반복 완료 + RPE ≤ 8 → 증량 후보', () => {
    const r = decideProgression({ ...base, sets: [top(5, 8)] });
    expect(r).toMatchObject({ action: 'increase', nextLoad: 152.5, failStreak: 0 });
  });
  it('미달 → 유지, 2회 연속 → 유지 또는 감량 후보(자동 감량 없음), 3회 → 검토', () => {
    const r1 = decideProgression({ ...base, sets: [top(4, 9)] });
    expect(r1).toMatchObject({ action: 'hold', nextLoad: 150, failStreak: 1 });
    const r2 = decideProgression({ ...base, prevFailStreak: 1, sets: [top(5, 8.5)] });
    expect(r2.action).toBe('hold_or_reduce');
    expect(r2.nextLoad).toBe(150);
    expect(r2.reduceOptions).toEqual([{ pct: 2.5, load: 145 }, { pct: 5, load: 142.5 }]);
    expect(decideProgression({ ...base, prevFailStreak: 2, sets: [top(4, 9)] }).action).toBe('review');
  });
  it('장비 문제 세트는 근력 실패로 세지 않음', () => {
    const r = decideProgression({ ...base, prevFailStreak: 1, sets: [top(3, 9, ['equipment_failure'])] });
    expect(r).toMatchObject({ action: 'not_counted', nextLoad: 150, failStreak: 1 });
  });
  it('Double Progression: 모든 세트 상단 달성 → 증량, 범위 내 진행 중 → 유지(실패 아님)', () => {
    const dp = { model: 'double_progression' as const, plannedCount: 3, repMin: 8, repMax: 10, rpeCap: 8, increment: 2.5, prevFailStreak: 0, dpCriterion: 'all_sets' as const };
    const s = (reps: number, rpe: number) => ({ weight: 100, reps, rpe, flags: [], type: 'volume' });
    expect(decideProgression({ ...dp, sets: [s(10, 7), s(10, 7.5), s(10, 8)] })).toMatchObject({ action: 'increase', nextLoad: 102.5 });
    expect(decideProgression({ ...dp, sets: [s(10, 7), s(9, 7.5), s(8, 8)] })).toMatchObject({ action: 'hold', failStreak: 0 });
    expect(decideProgression({ ...dp, sets: [s(10, 7), s(9, 8), s(7, 8.5)] })).toMatchObject({ action: 'hold', failStreak: 1 });
    expect(decideProgression({ ...dp, sets: [s(10, 7), s(10, 8)] }).action).toBe('hold'); // 계획 3세트 중 2세트만
  });
  it('RDL: 마지막 세트 기준', () => {
    const r = decideProgression({ model: 'double_progression', plannedCount: 2, repMin: 8, repMax: 10, rpeCap: 8, increment: 2.5, prevFailStreak: 0, dpCriterion: 'last_set',
      sets: [{ weight: 120, reps: 9, rpe: 7, flags: [], type: 'volume' }, { weight: 120, reps: 10, rpe: 7.5, flags: [], type: 'volume' }] });
    expect(r.action).toBe('increase');
  });
  it('추가 중량 운동의 감량 후보는 총 부하 기준', () => {
    const r = decideProgression({ ...base, increment: 1.25, prevFailStreak: 1, bodyweight: 66, sets: [{ weight: 40, reps: 4, rpe: 9, flags: [], type: 'top' }] });
    expect(r.reduceOptions?.[1].load).toBe(33.75); // (106 × 0.95) − 66 = 34.7 → 1.25 단위 내림
  });
});

describe('개인화 계수 EMA (TC-020)', () => {
  it('관측계수와 ±5% 제한 후 EMA', () => {
    expect(observedK(142.5, 5, 7, 182.5)).toBeCloseTo(impliedE1RM(142.5, 5, 7) / 182.5, 9);
    const u = updateCoefficient(1, 1.2, 0.15, 5);
    expect(u.kObservedClamped).toBeCloseTo(1.05, 9);
    expect(u.kNext).toBeCloseTo(0.85 + 0.15 * 1.05, 9);
    expect(updateCoefficient(1, 0.98, 0.1, 5).kNext).toBeCloseTo(0.998, 9);
    expect(() => updateCoefficient(1, 1, 2, 5)).toThrow();
  });
});

describe('달성률 (TC-010, TC-011, TC-022)', () => {
  const mk = (n: number, over: Partial<PlannedSet> = {}): PlannedSet[] => Array.from({ length: n }, (_, i) => ({
    id: `s${Math.random()}${i}`, instanceId: 'i', workoutId: 'w', track: 'pb', exerciseId: 'e', index: i, type: 'straight', rpeCap: 8,
    originalDate: '2026-11-30', plannedDate: '2026-11-30', status: 'planned', inOriginalPlan: true, rev: 1, ...over,
  }));
  const period = { start: '2026-11-30', end: '2026-12-06' };
  it('60세트 중 42 완료·12 면제 → 원본 70%, 조정 87.5%', () => {
    const sets = [...mk(42, { status: 'done' }), ...mk(12, { status: 'excused' }), ...mk(6)];
    const r = calculateAchievement({ plannedSets: sets, performedDates: [], extraSetCount: 0, period, today: '2026-12-06', track: 'all' });
    expect(r.original).toEqual({ done: 42, total: 60, pct: 70 });
    expect(r.adjusted).toEqual({ done: 42, total: 48, pct: 87.5 });
    expect(r.excusedSets).toBe(12);
  });
  it('계획 0이면 100%가 아니라 계획 없음, 자유 세트는 100%를 넘기지 않음', () => {
    const none = calculateAchievement({ plannedSets: [], performedDates: [], extraSetCount: 3, period, today: '2026-12-06', track: 'all' });
    expect(none.original.pct).toBeNull();
    const full = calculateAchievement({ plannedSets: mk(4, { status: 'done' }), performedDates: [], extraSetCount: 5, period, today: '2026-12-06', track: 'all' });
    expect(full.original.pct).toBe(100);
    expect(full.extraSets).toBe(5);
  });
  it('승인된 추가 세트는 조정 계획에만 반영', () => {
    const sets = [...mk(4, { status: 'done' }), ...mk(2, { inOriginalPlan: false, status: 'done' })];
    const r = calculateAchievement({ plannedSets: sets, performedDates: [], extraSetCount: 0, period, today: '2026-12-06', track: 'all' });
    expect(r.original).toMatchObject({ done: 4, total: 4 });
    expect(r.adjusted).toMatchObject({ done: 6, total: 6 });
  });
  it('월말 예정 세트를 다음 달에 수행해도 원래 달에 크레딧', () => {
    const sets = mk(3, { originalDate: '2026-12-31', plannedDate: '2027-01-01', status: 'done' });
    const dec = calculateAchievement({ plannedSets: sets, performedDates: ['2027-01-01'], extraSetCount: 0, period: { start: '2026-12-01', end: '2026-12-31' }, today: '2027-01-02', track: 'all' });
    const jan = calculateAchievement({ plannedSets: sets, performedDates: ['2027-01-01'], extraSetCount: 0, period: { start: '2027-01-01', end: '2027-01-31' }, today: '2027-01-02', track: 'all' });
    expect(dec.original).toMatchObject({ done: 3, total: 3, pct: 100 });
    expect(dec.visits.actual).toBe(0);
    expect(jan.original.total).toBe(0);
    expect(jan.visits.actual).toBe(1);
  });
  it('기한 경과분 이행률은 아직 오지 않은 날을 미완료로 세지 않음', () => {
    const sets = [...mk(5, { status: 'done' }), ...mk(5, { originalDate: '2026-12-04', plannedDate: '2026-12-04' })];
    const r = calculateAchievement({ plannedSets: sets, performedDates: ['2026-11-30'], extraSetCount: 0, period, today: '2026-12-01', track: 'all' });
    expect(r.original.pct).toBe(50);
    expect(r.dueSoFar).toEqual({ done: 5, total: 5, pct: 100 });
  });
});
