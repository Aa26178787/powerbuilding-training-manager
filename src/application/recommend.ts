// 세트별 추천 중량 산출(읽기 전용). 엔진 순수 함수에 입력을 모아 전달한다.
import type { Db, Exercise, ISODate, PerformedSet, PlannedSet } from '../domain/types';
import { adviseNextSet, recommendBackoff, variationStartLoad } from '../engine/backoff';
import { conservativeE1RM, loadForTarget, validateSetInput, FORMULA_VERSION } from '../engine/e1rm';
import { roundLoad } from '../engine/rounding';

export interface Suggestion {
  load: number | null;
  kind: 'top_start' | 'backoff' | 'next_set' | 'variation_start' | 'progression' | 'none';
  message: string;
  /** 계산 근거(수식·계수·반올림 전/후) */
  detail?: Record<string, unknown>;
  offerStop?: boolean;
  action?: 'keep' | 'decrease' | 'increase';
}

export const livePerformed = (db: Db, pred: (p: PerformedSet) => boolean): PerformedSet[] =>
  Object.values(db.performed).filter((p) => !p.deleted && pred(p)).sort((a, b) => a.performedAt.localeCompare(b.performedAt));

export const bodyweightFor = (db: Db, date: ISODate): number | null => {
  const s = Object.values(db.sessions).filter((x) => x.date === date && x.bodyweight).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return s?.bodyweight ?? db.settings.bodyweight ?? null;
};

/** 최근 Competition Top Set(없으면 초기 입력 기록)으로 보수적 e1RM 추정 */
export const latestE1rm = (db: Db, exerciseId: string): number | null => {
  const ex = db.exercises[exerciseId];
  if (!ex) return null;
  const tops = livePerformed(db, (p) => p.exerciseId === exerciseId && p.type === 'top' && p.weight !== null && p.reps !== undefined && p.rpe !== undefined && !p.flags.length);
  const last = tops[tops.length - 1];
  const src = last ? { weight: last.weight as number, reps: last.reps as number, rpe: last.rpe as number, bodyweight: last.bodyweight }
    : db.exStates[exerciseId]?.seed;
  if (!src) return null;
  const bw = ex.loadMode === 'bodyweight_plus' ? (src.bodyweight ?? db.settings.bodyweight ?? 0) : 0;
  if (ex.loadMode === 'bodyweight_plus' && !bw) return null;
  if (validateSetInput(src.weight + bw, src.reps, src.rpe).length) return null;
  return conservativeE1RM(src.weight + bw, src.reps, src.rpe);
};

const seedStart = (db: Db, ex: Exercise, reps: number, rpe: number, bw: number | null): Suggestion | null => {
  const e1rm = latestE1rm(db, ex.id);
  if (e1rm === null) return null;
  const off = ex.loadMode === 'bodyweight_plus' ? (bw ?? 0) : 0;
  const raw = Math.max(0, loadForTarget(e1rm * (db.exStates[ex.id]?.k ?? 1), reps, rpe) - off);
  const load = roundLoad(raw, ex.increment, ex.rounding);
  return { load, kind: 'top_start', message: `기준 기록 e1RM ${e1rm.toFixed(1)}kg에서 ${reps}회 @${rpe}로 계산`, detail: { formulaVersion: FORMULA_VERSION, e1rm, reps, rpe, raw, rounded: load, increment: ex.increment } };
};

/** 예정 세트 하나에 대한 추천 중량. 추천은 제안일 뿐 실제 기록을 덮어쓰지 않는다 */
export const suggestForSet = (db: Db, set: PlannedSet, sessionDate: ISODate): Suggestion => {
  const ex = db.exercises[set.exerciseId];
  const inst = db.instances[set.instanceId];
  if (!ex || !inst) return { load: null, kind: 'none', message: '' };
  if (inst.model === 'arm_manual') return { load: null, kind: 'none', message: 'ARM은 자동 추천이 없습니다. PDF 처방과 지난 기록을 보고 정하세요' };
  const st = db.exStates[ex.id];
  const bw = ex.loadMode === 'bodyweight_plus' ? bodyweightFor(db, sessionDate) : null;
  if (ex.loadMode === 'bodyweight_plus' && !bw) return { load: null, kind: 'none', message: '체중을 입력하면 추천 중량을 계산합니다' };
  const done = livePerformed(db, (p) => p.instanceId === inst.id && p.type !== 'warmup' && p.type !== 'extra');
  const last = done[done.length - 1];
  const drift = db.settings.rpeDriftPerSet;
  const targetReps = set.reps ?? set.repMax ?? 1;
  const targetRpe = set.targetRpe ?? 7.5;
  const bwArg = bw ?? undefined;

  if (set.type === 'top') {
    if (st?.nextLoad != null) return { load: st.nextLoad, kind: 'progression', message: st.lastDecision?.reason ?? '지난 세션 기준 추천' };
    return seedStart(db, ex, targetReps, targetRpe, bw) ?? { load: null, kind: 'none', message: '기록이 없습니다. 첫 세트에서 중량을 정하세요' };
  }
  if (set.type === 'backoff') {
    const top = done.find((p) => p.type === 'top');
    if (!top || top.weight === null || top.reps === undefined || top.rpe === undefined) return { load: null, kind: 'none', message: 'Top Set의 중량·반복·RPE를 기록하면 계산합니다' };
    const backoffs = done.filter((p) => p.type === 'backoff');
    const lastBo = backoffs[backoffs.length - 1];
    if (!lastBo || lastBo.weight === null || lastBo.rpe === undefined) {
      try {
        const r = recommendBackoff({ topWeight: top.weight, topReps: top.reps, topRpe: top.rpe, backoffReps: targetReps, backoffTargetRpe: targetRpe, k: st?.k ?? 1, increment: ex.increment, rounding: ex.rounding, bodyweight: bwArg });
        return { load: r.rounded, kind: 'backoff', message: `Top ${top.weight}kg×${top.reps} @${top.rpe} 기준, 보수적 e1RM ${r.e1rmConservative.toFixed(1)}kg로 ${targetReps}회 @${targetRpe} 계산`, detail: { ...r, inputs: { ...r.inputs } } };
      } catch (e) {
        return { load: null, kind: 'none', message: (e as Error).message };
      }
    }
    const a = adviseNextSet({ load: lastBo.weight, reps: targetReps, lastRpe: lastBo.rpe, targetRpe, rpeCap: set.rpeCap, drift, increment: ex.increment, rounding: ex.rounding, isFirstBackoff: backoffs.length === 1, bodyweight: bwArg });
    return { load: a.load, kind: 'next_set', message: a.reason, offerStop: a.offerStop, action: a.action, detail: { ...a } };
  }
  // straight / volume
  if (last && last.weight !== null) {
    if (last.rpe === undefined) return { load: last.weight, kind: 'next_set', message: '직전 세트와 같은 중량', action: 'keep' };
    const a = adviseNextSet({ load: last.weight, reps: last.reps ?? targetReps, lastRpe: last.rpe, targetRpe, rpeCap: set.rpeCap, drift: set.type === 'straight' ? drift : 0, increment: ex.increment, rounding: ex.rounding, isFirstBackoff: false, bodyweight: bwArg });
    return { load: a.load, kind: 'next_set', message: a.reason, offerStop: a.offerStop, action: a.action, detail: { ...a } };
  }
  if (st?.nextLoad != null) return { load: st.nextLoad, kind: 'progression', message: st.lastDecision?.reason ?? '지난 세션 기준 추천' };
  if (set.type === 'straight') return seedStart(db, ex, targetReps, targetRpe, bw) ?? { load: null, kind: 'none', message: '기록이 없습니다. 첫 세트에서 중량을 정하세요' };
  if (ex.variationOf) {
    const comp = latestE1rm(db, ex.variationOf.compExerciseId);
    if (comp !== null) {
      const r = variationStartLoad(comp, ex.variationOf.kBase, st?.k ?? 1, targetReps, targetRpe, ex.increment, ex.rounding);
      return { load: r.rounded, kind: 'variation_start', message: `첫 수행 시작값. 본종목 e1RM ${comp.toFixed(1)}kg × ${ex.variationOf.kBase}로 ${targetReps}회 @${targetRpe} 계산`, detail: { ...r, compE1rm: comp, kBase: ex.variationOf.kBase } };
    }
  }
  const prev = livePerformed(db, (p) => p.exerciseId === ex.id && p.weight !== null && p.type !== 'warmup');
  const lp = prev[prev.length - 1];
  if (lp) return { load: lp.weight, kind: 'progression', message: `지난 기록 ${lp.weight}kg×${lp.reps ?? '-'}` };
  return { load: null, kind: 'none', message: '기록이 없습니다. 첫 세션은 목표 RPE에 맞춰 중량을 정하세요' };
};

/** 같은 운동의 직전 세션 기록(카드의 '지난 기록' 표시용) */
export const lastSessionSets = (db: Db, exerciseId: string, beforeDate: ISODate, armKey?: string): PerformedSet[] => {
  const all = livePerformed(db, (p) => p.exerciseId === exerciseId && p.sessionDate < beforeDate && p.type !== 'warmup'
    && (!armKey || (p.instanceId ? armVariantKey(db, p.instanceId) === armKey : false)));
  if (!all.length) return [];
  const lastDate = all[all.length - 1].sessionDate;
  return all.filter((p) => p.sessionDate === lastDate);
};

/** ARM 기록 비교 키: 같은 운동이라도 ROM·수행 방식이 다르면 구분 */
export const armVariantKey = (db: Db, instanceId: string): string => {
  const a = db.instances[instanceId]?.arm;
  return a ? `${a.rom ?? ''}|${[...a.execution].sort().join(',')}|${a.loadNote ?? ''}` : '';
};
