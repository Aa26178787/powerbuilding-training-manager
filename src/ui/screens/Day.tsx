// 오늘 루틴(날짜별 수행 화면): 세트 기록, 다음 세트 제안, 세션 시작·종료
import { useEffect, useMemo, useState } from 'react';
import type { Db, ISODate, IssueFlag, PerformedSet, PlannedSet, Side } from '../../domain/types';
import { addDays, fmtDateKo } from '../../engine/dates';
import { plateBreakdown } from '../../engine/rounding';
import { warmupPlan } from '../../engine/warmup';
import { dayView, DayGroupView } from '../../application/selectors';
import { armVariantKey, lastSessionSets, suggestForSet, Suggestion } from '../../application/recommend';
import {
  activeSession, deletePerformedSet, editPerformedSet, endSession, markSetDone, recordArmRow, recordSet, SessionReport,
  setNextLoad, setSessionBodyweight, skipSets, startSession, unskipSet,
} from '../../application/session';
import { addPlannedSets, commitChange, previewChange, reorderInstance } from '../../application/schedule';
import { armDayList, assignArmDay, fillArmMissing, videoCategoryFor } from '../../application/arm';
import { weekdayOf } from '../../engine/dates';
import { ensureWeeksFor, haptic, run, toast, todayStr, useApp } from '../store';
import { Badge, Btn, cx, Empty, fmtKg, PlateChips, RpePicker, Sheet, Stepper } from '../components';

const FLAG_KO: Record<IssueFlag, string> = {
  equipment_failure: '장비 문제', grip_slip: '그립 미끄러짐', j_cup_collision: 'J컵 충돌', unusual_shoes: '평소와 다른 신발',
  range_of_motion_changed: '가동범위 변화', technique_breakdown: '자세 무너짐', pain: '통증', exceptional_fatigue: '심한 피로',
  merged_session: '병합 세션', other: '기타',
};
const TYPE_KO: Record<string, string> = { top: 'Top', backoff: 'Backoff', straight: '세트', volume: '세트', arm: '세트', arm_static: '버티기', extra: '추가', warmup: '워밍업' };
const SIDE_KO: Record<Side, string> = { L: '왼팔', R: '오른팔', both: '양팔' };

const targetText = (s: PlannedSet): string => {
  const reps = s.seconds ? `${s.seconds}초` : s.reps ? `${s.reps}회` : s.repMin ? `${s.repMin}~${s.repMax}회` : '';
  const rpe = s.targetRpe !== undefined ? ` @${s.targetRpe}${s.targetRpeMax ? `~${s.targetRpeMax}` : ''}` : '';
  return `${reps}${rpe}`;
};
const perfText = (p: PerformedSet): string =>
  `${p.side && p.side !== 'both' ? `${SIDE_KO[p.side]} ` : ''}${p.weight === null ? '' : `${fmtKg(p.weight)}kg × `}${p.seconds ? `${p.seconds}초` : `${p.reps ?? '-'}회`}${p.rpe !== undefined ? ` @${p.rpe}` : ''}`;

const prescriptionText = (g: DayGroupView): string => {
  if (g.instance.arm) {
    const a = g.instance.arm;
    const first = g.sets[0];
    const vol = first ? `${first.seconds ? `${first.seconds}초` : `${first.reps}회`} × ${g.sets.length}세트` : '세트·반복 원본 누락';
    const inten = a.rpeRange ? `RPE ${a.rpeRange[0]}~${a.rpeRange[1]}` : a.rpe !== null ? `RPE ${a.rpe}` : a.percent1rm !== null ? `${a.percent1rm}%` : 'RPE 원본 누락';
    return `${vol} · ${inten}`;
  }
  return g.instance.groups.map((x) => {
    const reps = x.reps ? `${x.reps}` : `${x.repMin}~${x.repMax}`;
    const rpe = x.targetRpeMin !== undefined && x.targetRpeMin !== x.targetRpeMax ? `@${x.targetRpeMin}~${x.targetRpeMax}` : x.targetRpe !== undefined ? `@${x.targetRpe}` : '';
    const name = x.type === 'top' ? 'Top ' : x.type === 'backoff' ? 'Backoff ' : '';
    return `${name}${x.count}×${reps} ${rpe}`.trim();
  }).join(' + ');
};

interface EditTarget { perf?: PerformedSet; group: DayGroupView; date: ISODate }

/** 기록 수정·삭제 또는 계획 외 세트 기록 */
const RecordSheet = ({ t, onClose }: { t: EditTarget; onClose: () => void }) => {
  const p = t.perf;
  const isStatic = p ? p.seconds !== undefined : false;
  const [weight, setWeight] = useState(p?.weight === null || p === undefined ? '' : String(p.weight));
  const [reps, setReps] = useState(String(p?.reps ?? p?.seconds ?? ''));
  const [rpe, setRpe] = useState<number | null>(p?.rpe ?? null);
  const [flags, setFlags] = useState<IssueFlag[]>(p?.flags ?? []);
  const [note, setNote] = useState(p?.note ?? '');
  const inc = t.group.exercise.increment;
  const save = async () => {
    const w = weight === '' ? null : Number(weight);
    const n = Number(reps);
    const body = { weight: w, rpe: rpe ?? undefined, flags, note: note || undefined, ...(isStatic ? { seconds: n } : { reps: n }) };
    const r = p
      ? await run((db, ctx) => editPerformedSet(db, p.id, body, ctx))
      : await run((db, ctx) => recordSet(db, { plannedSetId: null, instanceId: t.group.instance.id, exerciseId: t.group.exercise.id, date: t.date, type: 'extra', ...body }, ctx));
    if (r.ok) { toast(p ? '기록을 수정했습니다' : '계획 외 세트를 기록했습니다'); onClose(); }
  };
  const remove = async () => {
    if (!p) return;
    const r = await run((db, ctx) => deletePerformedSet(db, p.id, ctx));
    if (r.ok) { toast('기록을 삭제했습니다(기록 화면에서 복원 가능)'); onClose(); }
  };
  return (
    <Sheet
      title={p ? `${t.group.instance.exerciseName} 기록 수정` : `${t.group.instance.exerciseName} 계획 외 세트`}
      onClose={onClose}
      footer={<div className="flex gap-2">{p && <Btn kind="danger" onClick={remove}>기록 삭제</Btn>}<Btn kind="primary" className="flex-1" onClick={save}>{p ? '수정 저장' : '세트 기록'}</Btn></div>}
    >
      <div className="space-y-3">
        <Stepper label={t.group.exercise.loadMode === 'bodyweight_plus' ? '추가 중량' : '중량'} unit="kg" value={weight} onChange={setWeight} steps={[inc]} />
        <Stepper label={isStatic ? '유지 시간' : '반복수'} unit={isStatic ? '초' : '회'} value={reps} onChange={setReps} steps={[1]} decimal={false} />
        <RpePicker value={rpe} onChange={setRpe} />
        <FlagPicker flags={flags} onChange={setFlags} />
        <label className="block"><span className="mb-1 block text-xs text-dust">메모</span><input className="field" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
        {p && <p className="text-xs text-dust">수정 전 값은 변경 이력에 남고, 당시 추천 중량 기록은 지워지지 않습니다.</p>}
      </div>
    </Sheet>
  );
};

const FlagPicker = ({ flags, onChange }: { flags: IssueFlag[]; onChange: (f: IssueFlag[]) => void }) => (
  <details className="rounded-lg border border-rail px-3 py-1">
    <summary className="tap flex cursor-pointer items-center text-sm text-dust">이상 태그{flags.length ? ` (${flags.map((f) => FLAG_KO[f]).join(', ')})` : ' — 장비 문제·통증 등'}</summary>
    <div className="flex flex-wrap gap-1.5 pb-2">
      {(Object.keys(FLAG_KO) as IssueFlag[]).map((f) => (
        <button key={f} type="button" aria-pressed={flags.includes(f)} onClick={() => onChange(flags.includes(f) ? flags.filter((x) => x !== f) : [...flags, f])}
          className={cx('tap rounded-lg border px-2.5 text-sm', flags.includes(f) ? 'border-p25 bg-p25/20 text-chalk' : 'border-rail text-dust')}>{FLAG_KO[f]}</button>
      ))}
    </div>
  </details>
);

/** 지금 할 세트 입력 패널 */
const SetEntry = ({ db, g, set, date, sug, disabled }: { db: Db; g: DayGroupView; set: PlannedSet; date: ISODate; sug: Suggestion; disabled: boolean }) => {
  const isArm = g.instance.track === 'arm';
  const separate = isArm && db.settings.armSideMode === 'separate';
  const logged = g.performed[set.id] ?? [];
  const nextSide: Side | null = !isArm ? null : separate ? (logged.some((p) => p.side === 'L') ? 'R' : 'L') : 'both';
  const lastHere = Object.values(g.performed).flat().sort((a, b) => a.performedAt.localeCompare(b.performedAt));
  const prevSame = [...lastHere].reverse().find((p) => (nextSide ? p.side === nextSide : true)) ?? lastHere[lastHere.length - 1];
  const history = lastSessionSets(db, g.exercise.id, date, isArm ? armVariantKey(db, g.instance.id) : undefined);
  const histSame = history.find((p) => (nextSide && nextSide !== 'both' ? p.side === nextSide : true));
  const initWeight = sug.load ?? prevSame?.weight ?? histSame?.weight ?? null;
  const initReps = set.seconds ?? set.reps ?? prevSame?.reps ?? set.repMax ?? '';
  const [weight, setWeight] = useState(initWeight === null ? '' : String(initWeight));
  const [reps, setReps] = useState(String(initReps));
  const [rpe, setRpe] = useState<number | null>(null);
  const [side, setSide] = useState<Side | null>(nextSide);
  const [flags, setFlags] = useState<IssueFlag[]>([]);
  const [why, setWhy] = useState(false);
  const [busy, setBusy] = useState(false);
  // 세트가 바뀌거나 추천값이 갱신되면 입력값을 새로 채운다(사용자가 고친 값은 같은 세트 안에서 유지)
  useEffect(() => {
    setWeight(initWeight === null ? '' : String(initWeight)); setReps(String(initReps)); setRpe(null); setSide(nextSide); setFlags([]); setWhy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.id, nextSide, sug.load]);

  const inc = g.exercise.increment;
  const w = weight === '' ? null : Number(weight);
  const plates = g.exercise.barbell && w !== null ? plateBreakdown(w, db.settings.barWeight, db.settings.plates) : null;
  const open = g.sets.filter((s) => s.status === 'planned');

  const complete = async () => {
    if (busy) return; // 중복 탭 방지
    setBusy(true);
    const n = Number(reps);
    const r = await run<string>((d, ctx) => {
      const patch = recordSet(d, { plannedSetId: set.id, exerciseId: g.exercise.id, date, weight: w, rpe: rpe ?? undefined, side, flags, ...(set.seconds ? { seconds: n } : { reps: n }) }, ctx);
      return { patch, result: patch.put!.performed![0].id };
    });
    setBusy(false);
    if (r.ok) haptic();
    if (r.ok) toast('세트를 기록했습니다', 'info', { label: '실행 취소', run: () => { void run((d, ctx) => deletePerformedSet(d, r.result, ctx)); } });
  };
  const stopRest = async () => {
    const r = await run((d, ctx) => skipSets(d, open.map((s) => s.id), true, '사용자 승인 조기 종료', ctx));
    if (r.ok) toast(`남은 ${open.length}세트를 조기 종료로 기록했습니다`);
  };

  return (
    <div className="mt-2 rounded-xl border border-p15/60 bg-iron p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-bold">{TYPE_KO[set.type]} {set.type === 'top' ? '' : `${g.sets.filter((s) => s.type === set.type).indexOf(set) + 1}`} <span className="font-normal text-dust">목표 {targetText(set)}</span></div>
        {set.track !== 'arm' && <span className="text-xs text-dust">상한 @{set.rpeCap}</span>}
      </div>
      {sug.message && (
        <div className={cx('mb-2 rounded-lg px-2.5 py-2 text-sm', sug.action === 'decrease' ? 'bg-p25/15' : 'bg-steel')}>
          <div className="flex items-start justify-between gap-2">
            <span>{sug.load !== null && <b className="num">추천 {fmtKg(sug.load)}kg · </b>}{sug.message}</span>
            {sug.detail && <button type="button" className="shrink-0 text-xs text-dust underline" onClick={() => setWhy(!why)} aria-expanded={why}>근거</button>}
          </div>
          {why && sug.detail && (
            <dl className="num mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-rail pt-2 text-xs text-dust">
              {Object.entries(sug.detail).filter(([, v]) => typeof v === 'number' || typeof v === 'string').map(([k, v]) => (
                <div key={k} className="contents"><dt>{k}</dt><dd className="text-right">{typeof v === 'number' ? Math.round(v * 1000) / 1000 : String(v)}</dd></div>
              ))}
            </dl>
          )}
          {sug.offerStop && open.length > 0 && <Btn className="mt-2 w-full" onClick={stopRest} disabled={disabled}>남은 {open.length}세트 조기 종료</Btn>}
        </div>
      )}
      {isArm && (
        <div className="mb-2 flex gap-1.5" role="radiogroup" aria-label="수행한 팔">
          {(['L', 'R', 'both'] as Side[]).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={side === s} onClick={() => setSide(s)}
              className={cx('tap flex-1 rounded-lg border text-sm font-semibold', side === s ? 'border-p20 bg-p20/25' : 'border-rail text-dust')}>{SIDE_KO[s]}{logged.some((p) => p.side === s) ? ' ✓' : ''}</button>
          ))}
        </div>
      )}
      <div className="space-y-2.5">
        <Stepper label={g.exercise.loadMode === 'bodyweight_plus' ? '추가 중량' : '중량'} unit="kg" value={weight} onChange={setWeight} steps={inc === 2.5 ? [1.25, 2.5] : inc === 1.25 ? [1.25, 2.5] : [inc]} disabled={disabled} />
        {plates && <PlateChips perSide={plates.perSide} remainder={plates.remainder} />}
        {g.exercise.barbell && w !== null && lastHere.length === 0 && warmupPlan(w, db.settings.barWeight, inc).length > 1 && (
          <div className="num text-xs text-dust">워밍업 제안: {warmupPlan(w, db.settings.barWeight, inc).map((x) => `${fmtKg(x.load)}×${x.reps}`).join(' → ')} → 작업 {fmtKg(w)}</div>
        )}
        <Stepper label={set.seconds ? '유지 시간' : '반복수'} unit={set.seconds ? '초' : '회'} value={reps} onChange={setReps} steps={[1]} decimal={false} disabled={disabled} />
        <RpePicker value={rpe} onChange={setRpe} cap={set.track === 'arm' ? undefined : set.rpeCap} disabled={disabled} />
        <FlagPicker flags={flags} onChange={setFlags} />
      </div>
      <div className="mt-3 flex gap-2">
        <Btn kind="primary" className="h-14 flex-1 text-base" onClick={complete} disabled={disabled || busy || reps === '' || (!isArm && weight === '')}>{isArm && side && side !== 'both' ? `${SIDE_KO[side]} 기록` : '세트 완료'}</Btn>
        <Btn kind="quiet" onClick={() => void run((d, ctx) => skipSets(d, [set.id], false, '사용자 스킵', ctx))} disabled={disabled}>건너뛰기</Btn>
      </div>
      {!isArm && weight === '' && <p className="mt-1 text-xs text-dust">중량을 입력하면 완료할 수 있습니다{g.exercise.loadMode === 'bodyweight_plus' ? '(맨몸이면 0)' : ''}.</p>}
      {separate && logged.length === 1 && (
        <Btn kind="quiet" className="mt-1 w-full" onClick={() => void run((d, ctx) => markSetDone(d, set.id, ctx))} disabled={disabled}>한 팔만 하고 이 세트 완료 처리</Btn>
      )}
    </div>
  );
};

/**
 * ARM 빠른 입력 표: 한 줄 = 한 세트. 왼팔·오른팔 중량을 나란히 넣고 한 번 눌러 완료한다.
 * 값은 다음 줄로 이어지므로 같은 중량이면 세트마다 한 번만 누르면 된다(실제로 누른 세트만 기록).
 */
const ArmTable = ({ db, g, date, disabled, onEdit }: { db: Db; g: DayGroupView; date: ISODate; disabled: boolean; onEdit: (t: EditTarget) => void }) => {
  const separate = db.settings.armSideMode === 'separate';
  const history = lastSessionSets(db, g.exercise.id, date, armVariantKey(db, g.instance.id));
  const any = history.length ? history : lastSessionSets(db, g.exercise.id, date);
  const prev = (side: Side) => any.find((p) => p.side === side || p.side === 'both')?.weight;
  const active = g.sets.find((s) => s.status === 'planned');
  const [left, setLeft] = useState(prev('L') != null ? String(prev('L')) : '');
  const [right, setRight] = useState(prev('R') != null ? String(prev('R')) : '');
  const [reps, setReps] = useState(String(active?.seconds ?? active?.reps ?? ''));
  const [rpe, setRpe] = useState('');
  const [busy, setBusy] = useState(false);
  const isStatic = !!g.sets[0]?.seconds;
  const num = (v: string): number | null => (v === '' ? null : Number(v));
  const complete = async () => {
    if (!active || busy) return;
    setBusy(true);
    const l = num(left); const r = num(right);
    // 한쪽만 입력하면 그 팔만 수행한 것으로 기록, 둘 다 비우면 중량 없는 수행
    const one = separate && (l === null) !== (r === null);
    const res = await run<string[]>((d, ctx) => {
      const patch = recordArmRow(d, { plannedSetId: active.id, date, left: one && l === null ? undefined : l, right: separate ? (one && r === null ? undefined : r) : undefined, rpe: rpe === '' ? undefined : Number(rpe), ...(isStatic ? { seconds: Number(reps) } : { reps: Number(reps) }) }, ctx);
      return { patch, result: (patch.put?.performed ?? []).map((p) => p.id) };
    });
    setBusy(false);
    if (res.ok) { haptic(); toast('세트를 기록했습니다', 'info', { label: '실행 취소', run: () => { void (async () => { for (const id of res.result) await run((d, ctx) => deletePerformedSet(d, id, ctx)); })(); } }); }
  };
  const open = g.sets.filter((s) => s.status === 'planned');
  const cols = separate ? 'grid-cols-[1.6rem_1fr_1fr_3rem_3.6rem_3rem]' : 'grid-cols-[1.6rem_1fr_3rem_3.6rem_3rem]';
  const inp = 'field num px-1 text-center';
  return (
    <div className="mt-2">
      <div className={cx('grid items-center gap-1.5 text-[11px] text-dust', cols, !active && 'hidden')}>
        <span /><span className="text-center">{separate ? '왼팔 kg' : '중량 kg'}</span>{separate && <span className="text-center">오른팔 kg</span>}<span className="text-center">{isStatic ? '초' : '회'}</span><span className="text-center">RPE</span><span />
      </div>
      <ul className="mt-1 space-y-1.5">
        {g.sets.map((s, i) => {
          const perf = g.performed[s.id] ?? [];
          if (s.id === active?.id) {
            return (
              <li key={s.id} className={cx('grid items-center gap-1.5', cols)}>
                <span className="num text-sm font-bold">{i + 1}</span>
                <input className={inp} type="number" inputMode="decimal" step="any" aria-label={`세트 ${i + 1} ${separate ? '왼팔' : ''} 중량`} value={left} disabled={disabled} onChange={(e) => setLeft(e.target.value)} onFocus={(e) => e.target.select()} />
                {separate && <input className={inp} type="number" inputMode="decimal" step="any" aria-label={`세트 ${i + 1} 오른팔 중량`} value={right} disabled={disabled} onChange={(e) => setRight(e.target.value)} onFocus={(e) => e.target.select()} />}
                <input className={inp} type="number" inputMode="numeric" aria-label={`세트 ${i + 1} ${isStatic ? '유지 시간' : '반복수'}`} value={reps} disabled={disabled} onChange={(e) => setReps(e.target.value)} onFocus={(e) => e.target.select()} />
                <select className="field num px-0.5 text-center" aria-label={`세트 ${i + 1} 실제 RPE`} value={rpe} disabled={disabled} onChange={(e) => setRpe(e.target.value)}>
                  <option value="">—</option>{[6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button type="button" className="tap rounded-[10px] bg-p15 text-lg font-extrabold text-[#1b1608]" disabled={disabled || busy || reps === ''} onClick={complete} aria-label={`세트 ${i + 1} 완료`}>✓</button>
              </li>
            );
          }
          return (
            <li key={s.id} className="flex min-h-[44px] items-center gap-2 rounded-lg bg-steel px-2 text-sm [&>span:last-child]:self-center">
              <span className="num w-5 text-dust">{i + 1}</span>
              <span className="num flex-1">
                {perf.length ? (
                  <span className="flex flex-wrap items-center gap-x-2">
                    {perf.map((p) => (
                      <button key={p.id} type="button" className="inline-flex h-11 items-center underline decoration-rail underline-offset-4" onClick={() => onEdit({ perf: p, group: g, date })} aria-label={`${perfText(p)} 수정`}>
                        {p.side === 'L' ? '왼 ' : p.side === 'R' ? '오 ' : ''}{p.weight === null ? '중량 없음' : `${fmtKg(p.weight)}kg`}
                      </button>
                    ))}
                    <span className="text-dust">× {perf[0].seconds ? `${perf[0].seconds}초` : `${perf[0].reps}회`}{perf[0].rpe !== undefined ? ` @${perf[0].rpe}` : ''}</span>
                  </span>
                ) : <span className="text-dust">{targetText(s)}</span>}
              </span>
              {s.status === 'done' && <Badge tone="ok">완료</Badge>}
              {s.status === 'planned' && <Badge>대기</Badge>}
              {(s.status === 'skipped' || s.status === 'skipped_by_autoregulation') && <button type="button" className="tap text-xs text-dust underline" onClick={() => void run((d) => unskipSet(d, s.id))}>건너뜀 · 되돌리기</button>}
            </li>
          );
        })}
      </ul>
      {active && (
        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-dust">
          <span>{separate ? '값은 다음 세트로 이어집니다. 한쪽만 넣으면 그 팔만 기록됩니다.' : '값은 다음 세트로 이어집니다.'}</span>
          <button type="button" className="tap shrink-0 underline" disabled={disabled} onClick={() => void run((d, ctx) => skipSets(d, open.map((x) => x.id), false, '사용자 스킵', ctx))}>남은 {open.length}세트 건너뛰기</button>
        </div>
      )}
    </div>
  );
};

const ArmFill = ({ g }: { g: DayGroupView }) => {
  const [sets, setSets] = useState('3');
  const [reps, setReps] = useState('');
  const [secs, setSecs] = useState('');
  const [rpe, setRpe] = useState<number | null>(g.instance.arm?.rpe ?? null);
  return (
    <div className="mt-2 rounded-xl border border-p25/50 p-3">
      <div className="text-sm font-bold text-p25">원본 누락 — 직접 입력 필요</div>
      <p className="mt-1 text-xs text-dust">PDF {g.instance.arm?.sourcePage}쪽에 세트·반복수가 없습니다. 자동으로 추정하지 않으니 수행할 값을 정해 주세요.</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <label className="text-xs text-dust">세트<input className="field num mt-1" type="number" inputMode="numeric" value={sets} onChange={(e) => setSets(e.target.value)} /></label>
        <label className="text-xs text-dust">반복수<input className="field num mt-1" type="number" inputMode="numeric" value={reps} onChange={(e) => setReps(e.target.value)} /></label>
        <label className="text-xs text-dust">또는 초<input className="field num mt-1" type="number" inputMode="numeric" value={secs} onChange={(e) => setSecs(e.target.value)} /></label>
      </div>
      {g.instance.arm?.rpe === null && g.instance.arm?.rpeRange === null && <div className="mt-2"><RpePicker value={rpe} onChange={setRpe} /></div>}
      <Btn className="mt-2 w-full" onClick={() => void run((d) => fillArmMissing(d, g.instance.id, { sets: Number(sets), reps: reps ? Number(reps) : null, seconds: secs ? Number(secs) : null, rpe }))}>이 값으로 세트 만들기</Btn>
    </div>
  );
};

const GroupCard = ({ db, g, date, disabled, onEdit, isFirst, isLast, expanded, onExpand }: { db: Db; g: DayGroupView; date: ISODate; disabled: boolean; onEdit: (t: EditTarget) => void; isFirst: boolean; isLast: boolean; expanded: boolean; onExpand: () => void }) => {
  const active = g.sets.find((s) => s.status === 'planned');
  const sug = useMemo(() => (active ? suggestForSet(db, active, date) : null), [db, active, date]);
  const arm = g.instance.arm;
  const history = lastSessionSets(db, g.exercise.id, date, arm ? armVariantKey(db, g.instance.id) : undefined);
  const st = db.exStates[g.exercise.id];
  const dec = st?.lastDecision;
  const doneCount = g.sets.filter((s) => s.status === 'done').length;
  const videoCat = arm && db.arm ? videoCategoryFor(db.arm, g.instance.exerciseName) : null;
  const video = videoCat ? db.armLinks[videoCat] : null;
  const reduceOne = async () => {
    const last = [...g.sets].reverse().find((s) => s.status === 'planned');
    if (!last) return;
    const r = await run((d, ctx) => commitChange(d, previewChange(d, { kind: 'status', setIds: [last.id], status: 'removed', statusReason: '세트 수 축소' }), { reason: 'user_choice', acknowledgedWarnings: true }, ctx));
    if (r.ok) toast('1세트를 줄였습니다(원본 계획은 보존, 캘린더의 변경 이력에서 취소 가능)');
  };
  return (
    <section className="py-4" aria-label={g.instance.exerciseName}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[17px] leading-snug font-bold">{g.instance.exerciseName}</h3>
          <div className="num mt-0.5 text-sm text-dust">{prescriptionText(g)}</div>
        </div>
        <div className="num shrink-0 text-right text-sm font-bold">{doneCount}/{g.sets.length}<div className="text-xs font-normal text-dust">세트</div></div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {g.movedFrom && <Badge tone="info">{fmtDateKo(g.movedFrom)}에서 옮김</Badge>}
        {arm && <Badge>{g.workout.label.replace('ARM · ', '')}</Badge>}
        {arm?.rom && <Badge tone="info">{arm.rom}</Badge>}
        {arm?.execution.map((e) => <Badge key={e} tone="info">{e}</Badge>)}
        {arm?.loadNote && <Badge tone="info">{arm.loadNote}</Badge>}
        {arm && arm.sourceMissing.includes('intensity') && <Badge tone="bad">RPE 원본 누락 — 직접 결정</Badge>}
        {arm?.userFilled && <Badge tone="warn">직접 입력값</Badge>}
        {g.instance.required && !arm && <Badge>필수</Badge>}
      </div>
      {arm?.sourceText && <div className="mt-1 text-xs text-dust">PDF {arm.sourcePage}쪽 원문: {arm.sourceText}</div>}
      {video && <a className="mt-1 inline-block text-sm text-p20 underline" href={video.url} target="_blank" rel="noopener noreferrer">운동 영상 열기</a>}
      {history.length > 0 && (
        <div className="num mt-1.5 text-xs text-dust">지난 기록 {fmtDateKo(history[0].sessionDate)}: {history.slice(0, 8).map(perfText).join(', ')}</div>
      )}
      {dec && !arm && dec.reduceOptions && st.nextLoad === dec.nextLoad && (
        <div className="mt-2 rounded-lg border border-p15/50 p-2.5 text-sm">
          <div>{dec.reason}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Btn onClick={() => void run((d, ctx) => setNextLoad(d, g.exercise.id, dec.nextLoad, '유지 선택', ctx))}>{fmtKg(dec.nextLoad)}kg 유지</Btn>
            {dec.reduceOptions.map((o) => <Btn key={o.pct} onClick={() => void run((d, ctx) => setNextLoad(d, g.exercise.id, o.load, `${o.pct}% 감량 승인`, ctx))}>−{o.pct}% → {fmtKg(o.load)}kg</Btn>)}
          </div>
        </div>
      )}
      {arm && g.sets.length === 0 && <ArmFill g={g} />}
      {arm && g.sets.length > 0 ? <ArmTable db={db} g={g} date={date} disabled={disabled} onEdit={onEdit} /> : (
      <ul className="mt-2 space-y-1">
        {g.sets.map((s, i) => {
          const perf = g.performed[s.id] ?? [];
          if (s.id === active?.id && expanded && sug) return <li key={s.id}><SetEntry db={db} g={g} set={s} date={date} sug={sug} disabled={disabled} /></li>;
          return (
            <li key={s.id} className="flex min-h-[44px] items-center justify-between gap-2 rounded-lg bg-steel px-3">
              <span className="num w-20 shrink-0 text-xs text-dust">{TYPE_KO[s.type]} {s.type === 'top' ? '' : i + 1 - (g.sets[0].type === 'top' ? 1 : 0)}</span>
              <span className="num flex-1 text-sm">
                {perf.length ? perf.map((p) => (
                  <button key={p.id} type="button" className="tap mr-2 inline-flex items-center underline decoration-rail underline-offset-4" onClick={() => onEdit({ perf: p, group: g, date })}>{perfText(p)}</button>
                )) : <span className="text-dust">{targetText(s)}</span>}
              </span>
              {s.status === 'done' && <Badge tone="ok">완료</Badge>}
              {s.status === 'planned' && <Badge>대기</Badge>}
              {s.status === 'skipped' && <button type="button" className="tap text-xs text-dust underline" onClick={() => void run((d) => unskipSet(d, s.id))}>건너뜀 · 되돌리기</button>}
              {s.status === 'skipped_by_autoregulation' && <button type="button" className="tap text-xs text-dust underline" onClick={() => void run((d) => unskipSet(d, s.id))}>조기 종료 · 되돌리기</button>}
            </li>
          );
        })}
      </ul>
      )}
      {g.extras.length > 0 && <div className="num mt-1 text-xs text-dust">계획 외: {g.extras.map((p) => <button key={p.id} type="button" className="mr-2 underline" onClick={() => onEdit({ perf: p, group: g, date })}>{perfText(p)}</button>)}</div>}
      {active && !expanded && !arm && <Btn className="mt-2 w-full" onClick={onExpand}>이 운동 기록하기{sug?.load != null ? ` · 추천 ${fmtKg(sug.load)}kg` : ''}</Btn>}
      {!active && dec && dec.instanceId === g.instance.id && !arm && (
        <div className="num mt-2 text-sm"><Badge tone={dec.action === 'increase' ? 'ok' : dec.action === 'hold' || dec.action === 'not_counted' ? 'mute' : 'warn'}>다음 세션 {fmtKg(st.nextLoad)}kg</Badge> <span className="text-dust">{dec.reason}</span></div>
      )}
      <details className="mt-1">
        <summary className="tap flex cursor-pointer items-center text-xs text-dust">운동 설정</summary>
        <div className="flex flex-wrap gap-1.5 pb-1">
          <Btn disabled={disabled || isFirst} onClick={() => void run((d) => reorderInstance(d, g.instance.id, date, -1))}>위로</Btn>
          <Btn disabled={disabled || isLast} onClick={() => void run((d) => reorderInstance(d, g.instance.id, date, 1))}>아래로</Btn>
          {g.sets.length > 0 && <Btn disabled={disabled} onClick={() => void run((d, ctx) => addPlannedSets(d, g.instance.id, 1, date, ctx))}>세트 추가</Btn>}
          <Btn disabled={disabled || !active} onClick={reduceOne}>세트 줄이기</Btn>
          <Btn disabled={disabled} onClick={() => onEdit({ group: g, date })}>계획 외 세트 기록</Btn>
        </div>
      </details>
    </section>
  );
};

const ReportSheet = ({ report, onClose }: { report: SessionReport; onClose: () => void }) => (
  <Sheet title="세션 요약" onClose={onClose} footer={<Btn kind="primary" className="w-full" onClick={onClose}>확인</Btn>}>
    <div className="num grid grid-cols-3 gap-2 text-center">
      <div className="rounded-lg bg-iron p-3"><div className="text-2xl font-extrabold">{report.doneSets}/{report.plannedSets}</div><div className="text-xs text-dust">계획 세트</div></div>
      <div className="rounded-lg bg-iron p-3"><div className="text-2xl font-extrabold">{report.extraSets}</div><div className="text-xs text-dust">계획 외 세트</div></div>
      <div className="rounded-lg bg-iron p-3"><div className={cx('text-2xl font-extrabold', report.rpeOverCap > 0 && 'text-p25')}>{report.rpeOverCap}</div><div className="text-xs text-dust">RPE 상한 초과</div></div>
    </div>
    {report.plannedSets > report.doneSets && <p className="mt-3 text-sm text-dust">남은 {report.plannedSets - report.doneSets}세트는 자동으로 미수행 처리하지 않았습니다. 캘린더에서 다른 날로 옮기거나 면제·미수행으로 확정할 수 있습니다.</p>}
    {report.decisions.length > 0 && <h3 className="mt-4 mb-1 text-sm font-bold">다음 세션 추천</h3>}
    <ul className="space-y-2">
      {report.decisions.map((d, i) => (
        <li key={i} className="rounded-lg bg-iron p-2.5 text-sm"><div className="flex justify-between gap-2 font-semibold"><span>{d.exerciseName}</span><span className="num">{fmtKg(d.nextLoad)}kg</span></div><div className="text-xs text-dust">{d.reason}</div></li>
      ))}
    </ul>
    {report.learned.length > 0 && <h3 className="mt-4 mb-1 text-sm font-bold">계수 학습 관측</h3>}
    <ul className="space-y-1">
      {report.learned.map((l, i) => (
        <li key={i} className="num flex justify-between gap-2 text-sm"><span>{l.exerciseName}{l.used ? '' : <span className="text-dust"> — 제외 후보({l.reason})</span>}</span><span>k {l.k.toFixed(3)}</span></li>
      ))}
    </ul>
  </Sheet>
);

/** 휴식 타이머: 마지막 세트 완료 후 경과 시간과 권장 휴식. 권장 시간에 한 번 진동 */
const RestTimer = ({ since, target, onClose }: { since: string; target: number; onClose: () => void }) => {
  const [now, setNow] = useState(Date.now());
  const [extra, setExtra] = useState(0);
  const elapsed = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const goal = target + extra;
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (elapsed === goal) haptic(200); }, [elapsed, goal]);
  const mmss = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  if (elapsed > 20 * 60) return null;
  const done = elapsed >= goal;
  return (
    <div className="fixed inset-x-0 bottom-[72px] z-20 mx-auto flex max-w-[488px] items-center justify-between gap-2 rounded-xl border px-3 py-1.5 text-sm shadow-lg" role="timer"
      style={{ marginInline: 'max(16px, calc(50% - 244px))', background: 'var(--color-steel)', borderColor: done ? 'var(--color-p10)' : 'var(--color-rail)' }}>
      <span className="num"><b className="text-lg">{mmss(elapsed)}</b> <span className="text-dust">/ 권장 {mmss(goal)}{done ? ' · 휴식 충분' : ''}</span></span>
      <span className="flex gap-1"><Btn onClick={() => setExtra(extra + 30)}>+30초</Btn><Btn kind="quiet" onClick={onClose}>닫기</Btn></span>
    </div>
  );
};

export const DayScreen = ({ date, onDate }: { date: ISODate; onDate: (d: ISODate) => void }) => {
  const { db, readOnly } = useApp();
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [bw, setBw] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [timerOff, setTimerOff] = useState<string | null>(null);
  useEffect(() => { ensureWeeksFor([date]); }, [date, db?.settings.programStart]);
  if (!db) return null;
  const today = todayStr();
  const groups = dayView(db, date);
  const session = activeSession(db);
  const here = session?.date === date ? session : null;
  const needsBw = groups.some((g) => g.exercise.loadMode === 'bodyweight_plus');
  const curBw = here?.bodyweight ?? db.settings.bodyweight;
  const total = groups.reduce((n, g) => n + g.sets.length, 0);
  const done = groups.reduce((n, g) => n + g.sets.filter((s) => s.status === 'done').length, 0);
  const blocked = readOnly || (!!session && !here);
  // 입력 패널은 한 번에 한 운동만 펼친다: 고른 운동, 없거나 끝났으면 남은 첫 운동
  const hasOpen = (g: DayGroupView) => g.sets.some((s) => s.status === 'planned');
  const expandedId = groups.find((g) => g.instance.id === openId && hasOpen(g))?.instance.id ?? groups.find(hasOpen)?.instance.id ?? null;

  // 마지막으로 기록한 세트 기준 휴식 권장: 고강도 복합 4분, ARM RPE 9 이상 3분 30초, 그 외 2~2분 30초
  const lastSet = here ? Object.values(db.performed).filter((p) => !p.deleted && p.sessionId === here.id).sort((a, b) => b.performedAt.localeCompare(a.performedAt))[0] : undefined;
  const restTarget = !lastSet ? 0 : lastSet.exerciseId.startsWith('arm:') ? ((lastSet.rpe ?? 0) >= 9 ? 210 : 150) : ['top', 'backoff', 'straight'].includes(lastSet.type) ? 240 : 120;
  const moreToDo = groups.some(hasOpen);

  // ARM 기본 요일인데 아직 배정이 없으면 한 번 눌러 다음 Day를 배정
  const armNext = db.arm ? armDayList(db.arm)[db.settings.armCursor] : undefined;
  const armPrefer = db.settings.armMode === 3 ? db.settings.armWeekdays3 : db.settings.armWeekdays2;
  const offerArm = !!armNext && date >= today && armPrefer.includes(weekdayOf(date)) && !groups.some((g) => g.instance.track === 'arm');

  const finish = async () => {
    if (!session) return;
    const r = await run<SessionReport>((d, ctx) => { const e = endSession(d, session.id, ctx); return { patch: e.patch, result: e.report }; });
    if (r.ok) setReport(r.result);
  };
  const saveBw = async () => {
    const n = Number(bw);
    const r = here ? await run((d) => setSessionBodyweight(d, here.id, n)) : await run((d, ctx) => startSession(d, date, n, ctx));
    if (r.ok) { setBw(''); toast('체중을 저장했습니다'); }
  };

  return (
    <div>
      <header className="flex items-center justify-between gap-2">
        <Btn kind="quiet" onClick={() => onDate(addDays(date, -1))} aria-label="전날">‹</Btn>
        <div className="text-center">
          <h1 className="text-xl font-extrabold">{fmtDateKo(date)}{date === today ? ' 오늘' : ''}</h1>
          <div className="num text-xs text-dust">{total ? `계획 ${done}/${total}세트` : '계획 없음'}</div>
        </div>
        <Btn kind="quiet" onClick={() => onDate(addDays(date, 1))} aria-label="다음 날">›</Btn>
      </header>
      {date !== today && <div className="mt-1 text-center"><button type="button" className="tap text-sm text-p20 underline" onClick={() => onDate(today)}>오늘로 이동</button></div>}

      {session && !here && (
        <div className="mt-3 rounded-xl border border-p15/60 p-3 text-sm">
          <b>{fmtDateKo(session.date)} 세션이 진행 중입니다.</b> 자정을 넘겨도 세션은 시작한 날짜에 귀속됩니다. 이어서 기록하거나 종료한 뒤 이 날짜를 기록하세요.
          <div className="mt-2 flex gap-2"><Btn className="flex-1" onClick={() => onDate(session.date)}>진행 중 세션으로</Btn><Btn className="flex-1" onClick={finish}>세션 종료</Btn></div>
        </div>
      )}
      {here && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-steel px-3 py-2 text-sm">
          <span>세션 진행 중 <span className="num text-dust">· {new Date(here.startedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: db.settings.timezone })} 시작</span></span>
          <Btn onClick={finish} disabled={readOnly}>세션 종료</Btn>
        </div>
      )}
      {needsBw && (
        <div className="mt-3 flex items-end gap-2 rounded-xl bg-steel px-3 py-2">
          <label className="flex-1 text-xs text-dust">오늘 체중 (kg){curBw ? <span className="num"> · 현재 {curBw}</span> : <span className="text-p25"> · 딥스·풀업 계산에 필요</span>}
            <input className="field num mt-1" type="number" inputMode="decimal" placeholder={curBw ? String(curBw) : '예: 66.0'} value={bw} onChange={(e) => setBw(e.target.value)} />
          </label>
          <Btn onClick={saveBw} disabled={!bw || blocked}>저장</Btn>
        </div>
      )}

      {offerArm && armNext && (
        <Btn className="mt-3 w-full" disabled={readOnly} onClick={async () => { const r = await run((d, ctx) => assignArmDay(d, armNext.dayIndex, date, ctx)); if (r.ok) toast(`ARM ${armNext.block} W${armNext.week} D${armNext.day}를 배정했습니다`); }}>
          ARM 추가 — {armNext.block} W{armNext.week} D{armNext.day}
        </Btn>
      )}
      {groups.length === 0 && (
        <div className="mt-6"><Empty>{db.settings.programStart && date < db.settings.programStart ? `프로그램 시작일(${fmtDateKo(db.settings.programStart)}) 이전입니다.` : '이 날짜에 예정된 운동이 없습니다. 캘린더에서 다른 날의 운동을 옮겨 올 수 있습니다.'}</Empty></div>
      )}
      <div className="mt-2">
        {groups.map((g, i) => (
          <div key={g.instance.id}>
            {i > 0 && <div className="knurl" />}
            <GroupCard db={db} g={g} date={date} disabled={blocked} onEdit={setEdit} isFirst={i === 0} isLast={i === groups.length - 1} expanded={expandedId === g.instance.id} onExpand={() => setOpenId(g.instance.id)} />
          </div>
        ))}
      </div>
      {db.settings.restTimer && lastSet && moreToDo && timerOff !== lastSet.id && !edit && !report && <RestTimer key={lastSet.id} since={lastSet.performedAt} target={restTarget} onClose={() => setTimerOff(lastSet.id)} />}
      {edit && <RecordSheet t={edit} onClose={() => setEdit(null)} />}
      {report && <ReportSheet report={report} onClose={() => setReport(null)} />}
    </div>
  );
};
