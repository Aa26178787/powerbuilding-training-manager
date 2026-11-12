// 분석용 조회: 근육군 세트, 추세, 피로 신호, CSV 내보내기
import type { Db, ISODate, PerformedSet } from '../domain/types';
import { musclesOf } from '../domain/defaults';
import { calculateWeightedMuscleSets, MuscleVolumeRow } from '../engine/muscleVolume';
import { fatigueSignals, FatigueSignal, SessionSummary } from '../engine/fatigue';
import { conservativeE1RM, impliedE1RM, validateSetInput } from '../engine/e1rm';
import { addDays, weekStart } from '../engine/dates';
import { periodAchievement } from './selectors';

const live = (db: Db) => Object.values(db.performed).filter((p) => !p.deleted && p.type !== 'warmup');

/** 기간 내 실제 완료한 세트로 근육군별 가중 세트 계산(ARM 제외) */
export const muscleVolume = (db: Db, period: { start: ISODate; end: ISODate }): MuscleVolumeRow[] => {
  const counts = new Map<string, number>();
  for (const p of live(db)) {
    if (p.sessionDate < period.start || p.sessionDate > period.end) continue;
    if (db.exercises[p.exerciseId]?.role === 'arm' || !db.exercises[p.exerciseId]) continue;
    counts.set(p.exerciseId, (counts.get(p.exerciseId) ?? 0) + 1);
  }
  const weights = Object.fromEntries([...counts.keys()].map((id) => [id, musclesOf(db.exercises[id])]));
  return calculateWeightedMuscleSets([...counts.entries()].map(([exerciseId, sets]) => ({ exerciseId, sets })), weights);
};

/** 계획 세트 기준 근육군 변화량(일정 변경 미리보기용): 면제·삭제되는 세트만큼 줄어든다 */
export const muscleDelta = (db: Db, removedSetIds: string[]): MuscleVolumeRow[] => {
  const counts = new Map<string, number>();
  for (const id of removedSetIds) {
    const s = db.plannedSets[id];
    if (!s || s.track === 'arm') continue;
    counts.set(s.exerciseId, (counts.get(s.exerciseId) ?? 0) + 1);
  }
  const weights = Object.fromEntries([...counts.keys()].filter((id) => db.exercises[id]).map((id) => [id, musclesOf(db.exercises[id])]));
  return calculateWeightedMuscleSets([...counts.entries()].map(([exerciseId, sets]) => ({ exerciseId, sets })), weights);
};

export interface TrendPoint { date: ISODate; value: number; label: string; flagged: boolean }

/** 운동별 추세: 세션마다 대표 세트(Top Set, 없으면 추정 e1RM이 가장 높은 세트)의 e1RM과 중량 */
export const exerciseTrend = (db: Db, exerciseId: string): { e1rm: TrendPoint[]; load: TrendPoint[]; hasE1rm: boolean } => {
  const ex = db.exercises[exerciseId];
  const byDate = new Map<ISODate, PerformedSet[]>();
  for (const p of live(db)) if (p.exerciseId === exerciseId && p.weight !== null) byDate.set(p.sessionDate, [...(byDate.get(p.sessionDate) ?? []), p]);
  const e1rm: TrendPoint[] = [];
  const load: TrendPoint[] = [];
  const sys = (p: PerformedSet) => (p.weight as number) + (ex?.loadMode === 'bodyweight_plus' ? p.bodyweight ?? 0 : 0);
  for (const date of [...byDate.keys()].sort()) {
    const sets = byDate.get(date) as PerformedSet[];
    const est = (p: PerformedSet): number | null => {
      if (p.reps === undefined || p.rpe === undefined || validateSetInput(sys(p), p.reps, p.rpe).length) return null;
      return p.type === 'top' ? conservativeE1RM(sys(p), p.reps, p.rpe) : impliedE1RM(sys(p), p.reps, p.rpe);
    };
    const top = sets.find((p) => p.type === 'top') ?? [...sets].sort((a, b) => (est(b) ?? 0) - (est(a) ?? 0) || (b.weight as number) - (a.weight as number))[0];
    const text = `${top.weight}kg × ${top.reps ?? `${top.seconds}초`}${top.rpe !== undefined ? ` @${top.rpe}` : ''}`;
    const flagged = top.flags.length > 0;
    load.push({ date, value: top.weight as number, label: text, flagged });
    const e = est(top);
    if (e !== null) e1rm.push({ date, value: Math.round(e * 10) / 10, label: text, flagged });
  }
  return { e1rm, load, hasE1rm: e1rm.length > 0 };
};

/** 최근 n주 달성률 추이(원본·조정) */
export const weeklyAchievementTrend = (db: Db, today: ISODate, weeks = 8) => {
  const out: { week: ISODate; original: number | null; adjusted: number | null; done: number; total: number }[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const start = addDays(weekStart(today), -7 * i);
    const a = periodAchievement(db, { start, end: addDays(start, 6) }, today).pb;
    if (a.original.total > 0) out.push({ week: start, original: a.original.pct, adjusted: a.adjusted.pct, done: a.original.done, total: a.original.total });
  }
  return out;
};

/** 종목별 최근 세션 요약 → 피로 신호 */
export const fatigueReport = (db: Db): FatigueSignal[] => {
  const out: FatigueSignal[] = [];
  for (const ex of Object.values(db.exercises)) {
    if (ex.role !== 'comp' && ex.role !== 'strength') continue;
    const byDate = new Map<ISODate, PerformedSet[]>();
    for (const p of live(db)) if (p.exerciseId === ex.id && p.plannedSetId && p.weight !== null && p.rpe !== undefined) byDate.set(p.sessionDate, [...(byDate.get(p.sessionDate) ?? []), p]);
    const sessions: SessionSummary[] = [...byDate.keys()].sort().map((date) => {
      const sets = byDate.get(date) as PerformedSet[];
      const cap = Math.min(...sets.map((p) => db.plannedSets[p.plannedSetId as string]?.rpeCap ?? 8));
      return {
        date, topLoad: Math.max(...sets.map((p) => p.weight as number)), maxRpe: Math.max(...sets.map((p) => p.rpe as number)), rpeCap: cap,
        avgRpe: sets.reduce((n, p) => n + (p.rpe as number), 0) / sets.length, flagged: sets.some((p) => p.flags.length > 0),
      };
    });
    out.push(...fatigueSignals(sessions, ex.name));
  }
  return out;
};

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  // 스프레드시트에서 수식으로 해석되지 않게 하고, 쉼표·따옴표·줄바꿈을 이스케이프
  const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** 수행 기록 CSV(삭제 기록 제외). ARM 처방 원문은 넣지 않는다 */
export const performedCsv = (db: Db): string => {
  const head = ['date', 'performed_at', 'exercise', 'track', 'set_type', 'side', 'weight_kg', 'bodyweight_kg', 'reps', 'seconds', 'rpe', 'planned', 'original_date', 'flags', 'note'];
  const rows = Object.values(db.performed).filter((p) => !p.deleted).sort((a, b) => a.performedAt.localeCompare(b.performedAt)).map((p) => {
    const ex = db.exercises[p.exerciseId];
    const planned = p.plannedSetId ? db.plannedSets[p.plannedSetId] : null;
    return [p.sessionDate, p.performedAt, ex?.name ?? p.exerciseId, ex?.role === 'arm' ? 'arm' : 'pb', p.type, p.side ?? '', p.weight, p.bodyweight ?? '', p.reps ?? '', p.seconds ?? '', p.rpe ?? '',
      planned ? 'yes' : 'no', planned?.originalDate ?? '', p.flags.join('|'), p.note ?? ''].map(csvCell).join(',');
  });
  return `﻿${[head.join(','), ...rows].join('\n')}\n`;
};
