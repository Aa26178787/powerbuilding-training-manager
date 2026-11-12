// 오늘 루틴: 운동마다 세트 표(# · 이전 · kg · 회 · RPE · ✓)로 기록한다.
// 레퍼런스: Strong/Hevy의 세트 줄 + 체크, 지난 기록 열, 체크 후 휴식 타이머 자동 시작.
import { useEffect, useMemo, useState } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { Check, ChevronLeft, ChevronRight, Ellipsis, Flag, Minus, Play, Plus, SkipForward, Timer, Undo2 } from 'lucide-react';
import type { Db, ISODate, IssueFlag, PerformedSet, PlannedSet, Side } from '../../domain/types';
import { addDays, fmtDateKo, weekdayOf } from '../../engine/dates';
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
import { ensureWeeksFor, haptic, run, toast, todayStr, useApp } from '../store';
import { Badge, Btn, Chip, cx, Empty, fmtKg, PlateChips, RpeChips, RpePicker, Sheet, Stepper } from '../components';

const FLAG_KO: Record<IssueFlag, string> = {
  equipment_failure: '장비 문제', grip_slip: '그립 미끄러짐', j_cup_collision: 'J컵 충돌', unusual_shoes: '평소와 다른 신발',
  range_of_motion_changed: '가동범위 변화', technique_breakdown: '자세 무너짐', pain: '통증', exceptional_fatigue: '심한 피로',
  merged_session: '병합 세션', other: '기타',
};
/** 운동 역할: 카드 왼쪽 띠 색 + 글자. 띠는 주력·스트렝스·ARM만 칠하고 나머지는 중립 */
const ROLE: Record<string, { ko: string; color: string }> = {
  comp: { ko: '주력', color: 'var(--color-p15)' }, strength: { ko: '스트렝스', color: 'var(--color-p20)' }, variation: { ko: '변형', color: 'var(--color-rail)' },
  accessory: { ko: '보조', color: 'var(--color-rail)' }, arm: { ko: 'ARM', color: 'var(--color-p10)' },
};
const SIDE_KO: Record<Side, string> = { L: '왼팔', R: '오른팔', both: '양팔' };

/** 이번 화면에서 막 완료한 세트(완료 잔광은 이 세트에만 — 화면을 열 때 이미 끝난 세트는 번쩍이지 않음) */
const justDone = new Set<string>();

const repsOf = (p: { reps?: number; seconds?: number }) => (p.seconds ? `${p.seconds}초` : `${p.reps ?? '-'}`);
const short = (p: PerformedSet) => `${p.weight === null ? '' : `${fmtKg(p.weight)}×`}${repsOf(p)}${p.rpe !== undefined ? `@${p.rpe}` : ''}`;
const perfText = (p: PerformedSet): string =>
  `${p.side && p.side !== 'both' ? `${SIDE_KO[p.side]} ` : ''}${p.weight === null ? '' : `${fmtKg(p.weight)}kg × `}${p.seconds ? `${p.seconds}초` : `${p.reps ?? '-'}회`}${p.rpe !== undefined ? ` @${p.rpe}` : ''}`;
const targetReps = (s: PlannedSet) => (s.seconds ? `${s.seconds}초` : s.reps ? `${s.reps}` : s.repMin ? `${s.repMin}-${s.repMax}` : '');
const targetRpe = (s: PlannedSet) => (s.targetRpe !== undefined ? `${s.targetRpe}${s.targetRpeMax && s.targetRpeMax !== s.targetRpe ? `-${s.targetRpeMax}` : ''}` : '');

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

/** 같은 기록이 이어지면 묶어서 한 줄 요약: "150×5@8 · 142.5×5@7 ×3" */
const summarize = (perfs: PerformedSet[]): string => {
  const parts: { t: string; n: number }[] = [];
  for (const p of perfs) {
    const t = `${p.side && p.side !== 'both' ? (p.side === 'L' ? '왼 ' : '오 ') : ''}${short(p)}`;
    const last = parts[parts.length - 1];
    if (last && last.t === t) last.n += 1; else parts.push({ t, n: 1 });
  }
  return parts.map((x) => (x.n > 1 ? `${x.t} ×${x.n}` : x.t)).join(' · ');
};

interface EditTarget { perf?: PerformedSet; group: DayGroupView; date: ISODate }

const FlagPicker = ({ flags, onChange }: { flags: IssueFlag[]; onChange: (f: IssueFlag[]) => void }) => (
  <div className="flex flex-wrap gap-1.5">
    {(Object.keys(FLAG_KO) as IssueFlag[]).map((f) => (
      <button key={f} type="button" aria-pressed={flags.includes(f)} onClick={() => onChange(flags.includes(f) ? flags.filter((x) => x !== f) : [...flags, f])}
        className={cx('press h-9 rounded-md px-2.5 text-[13px]', flags.includes(f) ? 'bg-p25/25 text-chalk' : 'bg-deck text-dust')}>{FLAG_KO[f]}</button>
    ))}
  </div>
);

/** 기록 수정·삭제 또는 계획 외 세트 기록 */
const RecordSheet = ({ t, onClose }: { t: EditTarget; onClose: () => void }) => {
  const p = t.perf;
  const isStatic = p ? p.seconds !== undefined : !!t.group.sets[0]?.seconds;
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
        {p?.side && p.side !== 'both' && <div className="text-sm text-dust">{SIDE_KO[p.side]} 기록</div>}
        <Stepper label={t.group.exercise.loadMode === 'bodyweight_plus' ? '추가 중량' : '중량'} unit="kg" value={weight} onChange={setWeight} steps={[inc]} />
        <Stepper label={isStatic ? '유지 시간' : '반복수'} unit={isStatic ? '초' : '회'} value={reps} onChange={setReps} steps={[1]} decimal={false} />
        <RpePicker value={rpe} onChange={setRpe} />
        <div><div className="mb-1 text-[11px] text-dust">이상 태그. 표시한 세트는 진행 판정과 계수 학습에서 뺄 수 있습니다</div><FlagPicker flags={flags} onChange={setFlags} /></div>
        <label className="block"><span className="mb-1 block text-[11px] text-dust">메모</span><input className="field" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
        {p && <p className="text-xs text-dust">수정 전 값은 변경 이력에 남고, 당시 추천 중량 기록은 지워지지 않습니다.</p>}
      </div>
    </Sheet>
  );
};

/* ---------- 세트 표 공통 ---------- */
const CELL = 'num-d flex h-[42px] items-center justify-center text-[17px]';
const inputCls = 'field num-d h-[42px] min-h-0 px-0.5 text-center text-[17px]';

/** 체크 버튼: 완료 전에는 노랑, 완료면 초록 채움 + 짧은 등장 */
const CheckCell = ({ done, onClick, disabled, label, fresh }: { done: boolean; onClick?: () => void; disabled?: boolean; label: string; fresh?: boolean }) => (
  done ? (
    <span className={cx('flex h-[40px] items-center justify-center rounded-md bg-p10 text-[#0d1f14]', fresh && 'check-pop')} aria-label={`${label} 완료`}><Check size={20} strokeWidth={3} /></span>
  ) : (
    <button type="button" className="press flex h-[42px] items-center justify-center rounded-md bg-p15 text-[#1b1608] disabled:bg-steel disabled:text-knurl" onClick={onClick} disabled={disabled} aria-label={`${label} 완료`}>
      <Check size={20} strokeWidth={3} />
    </button>
  )
);

/** 처방·추천 안내 한 줄. 감량 권고면 왼쪽 빨강 띠 */
const Advice = ({ sug, onStop, openCount, disabled }: { sug: Suggestion; onStop: () => void; openCount: number; disabled: boolean }) => {
  const [why, setWhy] = useState(false);
  if (!sug.message) return null;
  return (
    <div className={cx('mt-2 rounded-md bg-deck px-2.5 py-1.5 text-[13px] leading-snug', sug.action === 'decrease' && 'border-l-[3px] border-p25')}>
      <div className="flex items-start justify-between gap-2">
        <span>{sug.load !== null && <b className="num-d text-[15px]">추천 {fmtKg(sug.load)}kg · </b>}{sug.message}</span>
        {sug.detail && <Chip className="!h-7 !bg-rail px-2 text-[11px]" onClick={() => setWhy(!why)} aria-expanded={why}>{why ? '접기' : '근거'}</Chip>}
      </div>
      {why && sug.detail && (
        <dl className="num mt-1.5 grid grid-cols-2 gap-x-3 border-t border-rail pt-1.5 text-[11px] text-dust">
          {Object.entries(sug.detail).filter(([, v]) => typeof v === 'number' || typeof v === 'string').map(([k, v]) => (
            <div key={k} className="contents"><dt>{k}</dt><dd className="text-right">{typeof v === 'number' ? Math.round(v * 1000) / 1000 : String(v)}</dd></div>
          ))}
        </dl>
      )}
      {sug.offerStop && openCount > 0 && <Btn className="mt-1.5 w-full" onClick={onStop} disabled={disabled}>남은 {openCount}세트 조기 종료</Btn>}
    </div>
  );
};

const UndoSkip = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" className="press flex h-[40px] flex-col items-center justify-center rounded-md bg-deck text-[10px] leading-none text-dust" aria-label={`${label} 되돌리기`} onClick={(e) => { e.stopPropagation(); onClick(); }}>
    <Undo2 size={14} aria-hidden /><span className="mt-0.5">{label}</span>
  </button>
);

const PendingCheck = () => <span className="flex h-[40px] items-center justify-center rounded-md border border-rail text-knurl" aria-label="대기"><Check size={16} /></span>;

/** 파워빌딩 세트 표 */
const PbTable = ({ db, g, date, focused, disabled, onEdit, onFocus }: {
  db: Db; g: DayGroupView; date: ISODate; focused: boolean; disabled: boolean; onEdit: (t: EditTarget) => void; onFocus: () => void;
}) => {
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 180 });
  const active = g.sets.find((s) => s.status === 'planned');
  const sug = useMemo(() => (active ? suggestForSet(db, active, date) : null), [db, active, date]);
  const prev = lastSessionSets(db, g.exercise.id, date).filter((p) => p.plannedSetId !== null);
  const prevFor = (s: PlannedSet) => prev.filter((p) => p.type === s.type)[g.sets.filter((x) => x.type === s.type).indexOf(s)];
  const doneHere = Object.values(g.performed).flat().sort((a, b) => a.performedAt.localeCompare(b.performedAt));
  const lastHere = doneHere[doneHere.length - 1];
  const inc = g.exercise.increment;
  const initW = sug?.load ?? lastHere?.weight ?? (active ? prevFor(active)?.weight : null) ?? null;
  const initR = active ? (active.seconds ?? active.reps ?? lastHere?.reps ?? active.repMax ?? '') : '';
  const [weight, setWeight] = useState(initW === null ? '' : String(initW));
  const [reps, setReps] = useState(String(initR));
  const [rpe, setRpe] = useState<number | null>(null);
  const [flags, setFlags] = useState<IssueFlag[]>([]);
  const [showFlags, setShowFlags] = useState(false);
  const [busy, setBusy] = useState(false);
  // 다음 세트로 넘어가거나 추천값이 바뀌면 새로 채운다(같은 세트 안에서 고친 값은 유지)
  useEffect(() => {
    setWeight(initW === null ? '' : String(initW)); setReps(String(initR)); setRpe(null); setFlags([]); setShowFlags(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, sug?.load]);
  const w = weight === '' ? null : Number(weight);
  const plates = g.exercise.barbell && w !== null && w > 0 ? plateBreakdown(w, db.settings.barWeight, db.settings.plates) : null;
  const warm = g.exercise.barbell && w !== null && doneHere.length === 0 ? warmupPlan(w, db.settings.barWeight, inc) : [];
  const open = g.sets.filter((s) => s.status === 'planned');
  const bump = (d: number) => setWeight(String(Math.max(0, Math.round(((Number(weight) || 0) + d) * 1000) / 1000)));

  const complete = async () => {
    if (!active || busy) return;
    setBusy(true);
    const n = Number(reps);
    const r = await run<string>((d, ctx) => {
      const patch = recordSet(d, { plannedSetId: active.id, exerciseId: g.exercise.id, date, weight: w, rpe: rpe ?? undefined, flags, ...(active.seconds ? { seconds: n } : { reps: n }) }, ctx);
      return { patch, result: patch.put!.performed![0].id };
    });
    setBusy(false);
    if (r.ok) {
      justDone.add(active.id);
      haptic();
      toast('세트를 기록했습니다', 'info', { label: '실행 취소', run: () => { void run((d, ctx) => deletePerformedSet(d, r.result, ctx)); } });
    }
  };
  const stopRest = async () => {
    const r = await run((d, ctx) => skipSets(d, open.map((s) => s.id), true, '사용자 승인 조기 종료', ctx));
    if (r.ok) toast(`남은 ${open.length}세트를 조기 종료로 기록했습니다`);
  };
  const label = (s: PlannedSet) => (s.type === 'top' ? 'T' : String(g.sets.filter((x) => x.type === s.type).indexOf(s) + 1));
  const COLS = 'grid grid-cols-[1.6rem_minmax(0,1fr)_4.4rem_2.6rem_2.6rem_2.75rem] items-center gap-1.5';

  return (
    <div>
      {focused && sug && sug.kind !== 'none' && <Advice sug={sug} onStop={stopRest} openCount={open.length} disabled={disabled} />}
      {focused && sug?.kind === 'none' && sug.message && <div className="mt-1.5 text-[12px] text-dust">{sug.message}</div>}
      {focused && active && <div className={cx(COLS, 'mt-2 text-[11px] text-dust')}><span className="text-center">세트</span><span>이전</span><span className="text-center">kg</span><span className="text-center">회</span><span className="text-center">RPE</span><span /></div>}
      <ul ref={listRef} className="mt-1 space-y-1">
        {g.sets.map((s) => {
          const perf = g.performed[s.id] ?? [];
          const pv = prevFor(s);
          if (s.id === active?.id && focused) {
            return (
              <li key={s.id} className="rounded-lg bg-deck p-1.5">
                <div className={COLS}>
                  <span className="num-d text-center text-[15px] text-p15">{label(s)}</span>
                  <span className="num-d truncate text-[14px] text-dust">{pv ? short(pv) : '—'}</span>
                  <input className={inputCls} type="number" inputMode="decimal" step="any" aria-label={`${g.instance.exerciseName} ${label(s)}세트 중량`} value={weight} disabled={disabled} onChange={(e) => setWeight(e.target.value)} onFocus={(e) => e.target.select()} />
                  <input className={inputCls} type="number" inputMode="numeric" aria-label={`${label(s)}세트 ${s.seconds ? '유지 시간' : '반복수'}`} placeholder={targetReps(s)} value={reps} disabled={disabled} onChange={(e) => setReps(e.target.value)} onFocus={(e) => e.target.select()} />
                  <span className={cx(CELL, rpe !== null && rpe > s.rpeCap ? 'text-p25' : rpe === null ? 'text-knurl' : '')}>{rpe ?? (targetRpe(s) || '—')}</span>
                  <CheckCell done={false} onClick={complete} disabled={disabled || busy || reps === '' || weight === ''} label={`${label(s)}세트`} />
                </div>
                <div className="mt-1.5"><RpeChips value={rpe} onChange={setRpe} cap={s.rpeCap} disabled={disabled} /></div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <button type="button" className="press flex h-9 w-10 items-center justify-center rounded-md bg-steel text-dust" onClick={() => bump(-inc)} disabled={disabled} aria-label={`중량 ${inc}kg 줄이기`}><Minus size={16} /></button>
                  <button type="button" className="press flex h-9 w-10 items-center justify-center rounded-md bg-steel text-dust" onClick={() => bump(inc)} disabled={disabled} aria-label={`중량 ${inc}kg 늘리기`}><Plus size={16} /></button>
                  <div className="min-w-0 flex-1">{plates && <PlateChips perSide={plates.perSide} remainder={plates.remainder} />}</div>
                  <button type="button" className={cx('press flex h-9 items-center gap-1 rounded-md px-2 text-[12px]', flags.length ? 'bg-p25/25 text-chalk' : 'bg-steel text-dust')} onClick={() => setShowFlags(!showFlags)} aria-expanded={showFlags}>
                    <Flag size={14} />{flags.length ? flags.length : '태그'}
                  </button>
                </div>
                {showFlags && <div className="mt-1.5"><FlagPicker flags={flags} onChange={setFlags} /></div>}
                {warm.length > 1 && <div className="num mt-1.5 text-[11px] text-dust">워밍업 {warm.map((x) => `${fmtKg(x.load)}×${x.reps}`).join(' → ')}</div>}
                {rpe !== null && rpe > s.rpeCap && <div className="mt-1 text-[12px] text-p25">상한 @{s.rpeCap}을 넘습니다. 기록은 그대로 저장되고 다음 세트는 감량을 제안합니다.</div>}
              </li>
            );
          }
          const tappable = s.status === 'planned' && !focused;
          return (
            <li key={s.id} className={cx(COLS, 'min-h-[40px] rounded-md', s.status === 'done' && justDone.has(s.id) && 'row-done', s.status === 'done' && 'bg-p10/[0.07]')}
              onClick={tappable ? onFocus : undefined} role={tappable ? 'button' : undefined}>
              <span className={cx('num-d text-center text-[15px]', s.type === 'top' ? 'text-p15' : 'text-dust')}>{label(s)}</span>
              <span className="num-d truncate text-[14px] text-dust">{pv ? short(pv) : '—'}</span>
              {perf.length ? (
                <button type="button" className="col-span-3 grid h-[40px] grid-cols-[4.4rem_2.6rem_2.6rem] items-center gap-1.5" onClick={() => onEdit({ perf: perf[0], group: g, date })} aria-label={`${perfText(perf[0])} 수정`}>
                  <span className="num-d text-center text-[17px]">{fmtKg(perf[0].weight)}</span>
                  <span className="num-d text-center text-[17px]">{repsOf(perf[0])}</span>
                  <span className={cx('num-d text-center text-[17px]', perf[0].rpe !== undefined && perf[0].rpe > s.rpeCap && 'text-p25')}>{perf[0].rpe ?? '—'}</span>
                </button>
              ) : (
                <>
                  <span className="num-d text-center text-[15px] text-knurl">—</span>
                  <span className="num-d text-center text-[15px] text-knurl">{targetReps(s)}</span>
                  <span className="num-d text-center text-[15px] text-knurl">{targetRpe(s)}</span>
                </>
              )}
              {s.status === 'done' ? <CheckCell done fresh={justDone.has(s.id)} label={label(s)} />
                : s.status === 'planned' ? <PendingCheck />
                : <UndoSkip label={s.status === 'skipped_by_autoregulation' ? '조기종료' : '건너뜀'} onClick={() => void run((d) => unskipSet(d, s.id))} />}
            </li>
          );
        })}
      </ul>
      {focused && active && (
        <div className="mt-1 flex justify-end">
          <Chip disabled={disabled} onClick={() => void run((d, ctx) => skipSets(d, [active.id], false, '사용자 스킵', ctx))}><SkipForward size={14} aria-hidden />이 세트 건너뛰기</Chip>
        </div>
      )}
      {g.extras.length > 0 && <div className="num mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-dust"><span>계획 외 세트</span>{g.extras.map((p) => <Chip key={p.id} onClick={() => onEdit({ perf: p, group: g, date })}>{short(p)}</Chip>)}</div>}
    </div>
  );
};

/** ARM 세트 표: 한 줄에 왼팔·오른팔 kg을 함께 넣고 체크 */
const ArmTable = ({ db, g, date, focused, disabled, onEdit, onFocus }: {
  db: Db; g: DayGroupView; date: ISODate; focused: boolean; disabled: boolean; onEdit: (t: EditTarget) => void; onFocus: () => void;
}) => {
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 180 });
  const separate = db.settings.armSideMode === 'separate';
  const history = lastSessionSets(db, g.exercise.id, date, armVariantKey(db, g.instance.id));
  const any = history.length ? history : lastSessionSets(db, g.exercise.id, date);
  const prevW = (side: Side) => any.find((p) => p.side === side || p.side === 'both')?.weight;
  const active = g.sets.find((s) => s.status === 'planned');
  const [left, setLeft] = useState(prevW('L') != null ? String(prevW('L')) : '');
  const [right, setRight] = useState(prevW('R') != null ? String(prevW('R')) : '');
  const [reps, setReps] = useState(String(active?.seconds ?? active?.reps ?? ''));
  const [rpe, setRpe] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const isStatic = !!g.sets[0]?.seconds;
  const num = (v: string): number | null => (v === '' ? null : Number(v));
  const complete = async () => {
    if (!active || busy) return;
    setBusy(true);
    const l = num(left); const r = num(right);
    const one = separate && (l === null) !== (r === null);
    const res = await run<string[]>((d, ctx) => {
      const patch = recordArmRow(d, { plannedSetId: active.id, date, left: one && l === null ? undefined : l, right: separate ? (one && r === null ? undefined : r) : undefined, rpe: rpe ?? undefined, ...(isStatic ? { seconds: Number(reps) } : { reps: Number(reps) }) }, ctx);
      return { patch, result: (patch.put?.performed ?? []).map((p) => p.id) };
    });
    setBusy(false);
    if (res.ok) {
      justDone.add(active.id);
      setRpe(null);
      haptic();
      toast('세트를 기록했습니다', 'info', { label: '실행 취소', run: () => { void (async () => { for (const id of res.result) await run((d, ctx) => deletePerformedSet(d, id, ctx)); })(); } });
    }
  };
  const open = g.sets.filter((s) => s.status === 'planned');
  const COLS = separate ? 'grid grid-cols-[1.6rem_minmax(0,1fr)_minmax(0,1fr)_2.6rem_2.6rem_2.75rem] items-center gap-1.5' : 'grid grid-cols-[1.6rem_minmax(0,1fr)_2.6rem_2.6rem_2.75rem] items-center gap-1.5';
  return (
    <div>
      {focused && active && <div className={cx(COLS, 'mt-2 text-[11px] text-dust')}><span className="text-center">세트</span><span className="text-center">{separate ? '왼팔 kg' : 'kg'}</span>{separate && <span className="text-center">오른팔 kg</span>}<span className="text-center">{isStatic ? '초' : '회'}</span><span className="text-center">RPE</span><span /></div>}
      <ul ref={listRef} className="mt-1 space-y-1">
        {g.sets.map((s, i) => {
          const perf = g.performed[s.id] ?? [];
          if (s.id === active?.id && focused) {
            return (
              <li key={s.id} className="rounded-lg bg-deck p-1.5">
                <div className={COLS}>
                  <span className="num-d text-center text-[15px] text-p10">{i + 1}</span>
                  <input className={inputCls} type="number" inputMode="decimal" step="any" aria-label={`세트 ${i + 1} ${separate ? '왼팔' : ''} 중량`} value={left} disabled={disabled} onChange={(e) => setLeft(e.target.value)} onFocus={(e) => e.target.select()} />
                  {separate && <input className={inputCls} type="number" inputMode="decimal" step="any" aria-label={`세트 ${i + 1} 오른팔 중량`} value={right} disabled={disabled} onChange={(e) => setRight(e.target.value)} onFocus={(e) => e.target.select()} />}
                  <input className={inputCls} type="number" inputMode="numeric" aria-label={`세트 ${i + 1} ${isStatic ? '유지 시간' : '반복수'}`} value={reps} disabled={disabled} onChange={(e) => setReps(e.target.value)} onFocus={(e) => e.target.select()} />
                  <span className={cx(CELL, rpe === null && 'text-knurl')}>{rpe ?? (targetRpe(s) || '—')}</span>
                  <CheckCell done={false} onClick={complete} disabled={disabled || busy || reps === ''} label={`세트 ${i + 1}`} />
                </div>
                <div className="mt-1.5"><RpeChips value={rpe} onChange={setRpe} disabled={disabled} /></div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-dust">
                  <span>{separate ? '한쪽만 넣으면 그 팔만, 둘 다 비우면 중량 없이 기록' : '값은 다음 세트로 이어집니다'}</span>
                  <Chip disabled={disabled} onClick={() => void run((d, ctx) => skipSets(d, open.map((x) => x.id), false, '사용자 스킵', ctx))}><SkipForward size={14} aria-hidden />남은 {open.length}세트 건너뛰기</Chip>
                </div>
              </li>
            );
          }
          const tappable = s.status === 'planned' && !focused;
          const L = perf.find((p) => p.side === 'L' || p.side === 'both');
          const R = perf.find((p) => p.side === 'R');
          const p0 = perf[0];
          return (
            <li key={s.id} className={cx(COLS, 'min-h-[40px] rounded-md', s.status === 'done' && justDone.has(s.id) && 'row-done', s.status === 'done' && 'bg-p10/[0.07]')}
              onClick={tappable ? onFocus : undefined} role={tappable ? 'button' : undefined}>
              <span className="num-d text-center text-[15px] text-dust">{i + 1}</span>
              {p0 ? (
                <>
                  <button type="button" className="num-d h-[40px] text-center text-[17px]" onClick={() => onEdit({ perf: L ?? p0, group: g, date })}>{L ? (L.weight === null ? '—' : fmtKg(L.weight)) : '—'}</button>
                  {separate && <button type="button" className="num-d h-[40px] text-center text-[17px]" onClick={() => R && onEdit({ perf: R, group: g, date })}>{R ? (R.weight === null ? '—' : fmtKg(R.weight)) : '—'}</button>}
                  <span className="num-d text-center text-[17px]">{repsOf(p0)}</span>
                  <span className="num-d text-center text-[17px]">{p0.rpe ?? '—'}</span>
                </>
              ) : (
                <>
                  <span className="num-d text-center text-[15px] text-knurl">—</span>
                  {separate && <span className="num-d text-center text-[15px] text-knurl">—</span>}
                  <span className="num-d text-center text-[15px] text-knurl">{targetReps(s)}</span>
                  <span className="num-d text-center text-[15px] text-knurl">{targetRpe(s)}</span>
                </>
              )}
              {s.status === 'done' ? <CheckCell done fresh={justDone.has(s.id)} label={`세트 ${i + 1}`} />
                : s.status === 'planned' ? <PendingCheck />
                : <UndoSkip label="건너뜀" onClick={() => void run((d) => unskipSet(d, s.id))} />}
            </li>
          );
        })}
      </ul>
      {separate && active && focused && (g.performed[active.id] ?? []).length === 1 && (
        <Btn kind="quiet" className="mt-1 w-full" onClick={() => void run((d, ctx) => markSetDone(d, active.id, ctx))} disabled={disabled}>한 팔만 하고 이 세트 완료 처리</Btn>
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
    <div className="mt-2 rounded-lg border border-p25/50 p-2.5">
      <div className="text-sm font-bold text-p25">원본에 값이 없습니다. 직접 입력하세요</div>
      <p className="mt-0.5 text-xs text-dust">PDF {g.instance.arm?.sourcePage}쪽에 세트·반복수가 없습니다. 자동으로 추정하지 않으니 수행할 값을 정해 주세요.</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <label className="text-[11px] text-dust">세트<input className="field num-d mt-0.5 text-center" type="number" inputMode="numeric" value={sets} onChange={(e) => setSets(e.target.value)} /></label>
        <label className="text-[11px] text-dust">반복수<input className="field num-d mt-0.5 text-center" type="number" inputMode="numeric" value={reps} onChange={(e) => setReps(e.target.value)} /></label>
        <label className="text-[11px] text-dust">또는 초<input className="field num-d mt-0.5 text-center" type="number" inputMode="numeric" value={secs} onChange={(e) => setSecs(e.target.value)} /></label>
      </div>
      {g.instance.arm?.rpe === null && g.instance.arm?.rpeRange === null && <div className="mt-2"><RpeChips value={rpe} onChange={setRpe} label="목표 RPE" /></div>}
      <Btn className="mt-2 w-full" onClick={() => void run((d) => fillArmMissing(d, g.instance.id, { sets: Number(sets), reps: reps ? Number(reps) : null, seconds: secs ? Number(secs) : null, rpe }))}>이 값으로 세트 만들기</Btn>
    </div>
  );
};

/** 운동별 메뉴: 순서·세트 수·계획 외 세트·PDF 원문·영상 */
const CardMenu = ({ db, g, date, disabled, isFirst, isLast, onEdit, onClose }: { db: Db; g: DayGroupView; date: ISODate; disabled: boolean; isFirst: boolean; isLast: boolean; onEdit: (t: EditTarget) => void; onClose: () => void }) => {
  const active = g.sets.find((s) => s.status === 'planned');
  const arm = g.instance.arm;
  const videoCat = arm && db.arm ? videoCategoryFor(db.arm, g.instance.exerciseName) : null;
  const video = videoCat ? db.armLinks[videoCat] : null;
  const reduceOne = async () => {
    const last = [...g.sets].reverse().find((s) => s.status === 'planned');
    if (!last) return;
    const r = await run((d, ctx) => commitChange(d, previewChange(d, { kind: 'status', setIds: [last.id], status: 'removed', statusReason: '세트 수 축소' }), { reason: 'user_choice', acknowledgedWarnings: true }, ctx));
    if (r.ok) { toast('1세트를 줄였습니다(원본 계획은 보존, 캘린더의 변경 이력에서 취소 가능)'); onClose(); }
  };
  return (
    <Sheet title={g.instance.exerciseName} onClose={onClose}>
      <div className="grid grid-cols-2 gap-1.5">
        <Btn disabled={disabled || isFirst} onClick={() => void run((d) => reorderInstance(d, g.instance.id, date, -1))}>순서 위로</Btn>
        <Btn disabled={disabled || isLast} onClick={() => void run((d) => reorderInstance(d, g.instance.id, date, 1))}>순서 아래로</Btn>
        {g.sets.length > 0 && <Btn disabled={disabled} onClick={async () => { const r = await run((d, ctx) => addPlannedSets(d, g.instance.id, 1, date, ctx)); if (r.ok) toast('1세트를 추가했습니다(조정 계획에만 반영)'); }}>세트 추가</Btn>}
        <Btn disabled={disabled || !active} onClick={reduceOne}>세트 줄이기</Btn>
        <Btn className="col-span-2" disabled={disabled} onClick={() => { onClose(); onEdit({ group: g, date }); }}>계획 외 세트 기록</Btn>
      </div>
      {arm && (
        <div className="mt-3 space-y-1 text-sm">
          <div className="text-xs text-dust">PDF {arm.sourcePage}쪽 원문</div>
          <div>{arm.sourceText || '—'}</div>
          {video && <a className="press mt-1 inline-flex h-10 items-center gap-1.5 rounded-lg bg-deck px-3 text-sm font-semibold" href={video.url} target="_blank" rel="noopener noreferrer"><Play size={15} aria-hidden />운동 영상</a>}
        </div>
      )}
    </Sheet>
  );
};

const GroupCard = ({ db, g, date, disabled, onEdit, isFirst, isLast, focused, onFocus }: {
  db: Db; g: DayGroupView; date: ISODate; disabled: boolean; onEdit: (t: EditTarget) => void; isFirst: boolean; isLast: boolean; focused: boolean; onFocus: () => void;
}) => {
  const [menu, setMenu] = useState(false);
  const [expand, setExpand] = useState(false);
  const arm = g.instance.arm;
  const st = db.exStates[g.exercise.id];
  const dec = st?.lastDecision;
  const doneCount = g.sets.filter((s) => s.status === 'done').length;
  const finished = g.sets.length > 0 && !g.sets.some((s) => s.status === 'planned');
  const collapsed = finished && !expand;
  const perfs = g.sets.flatMap((s) => g.performed[s.id] ?? []);
  const role = ROLE[g.exercise.role] ?? ROLE.accessory;
  // 아직 시작하지 않았고 지금 입력 중인 운동이 아니면 한 줄로 접는다(지난 기록 요약 + 기록 시작)
  const idle = !focused && !finished && doneCount === 0 && g.sets.length > 0;
  const prevSummary = idle ? summarize(lastSessionSets(db, g.exercise.id, date, arm ? armVariantKey(db, g.instance.id) : undefined).filter((p) => p.plannedSetId !== null)) : '';
  const hasTags = !!(g.movedFrom || arm?.rom || (arm?.execution.length ?? 0) > 0 || arm?.loadNote || (arm && arm.sourceMissing.includes('intensity')) || arm?.userFilled);
  return (
    <section className="rounded-xl bg-steel px-3 pt-2 pb-2.5" style={{ boxShadow: `inset 3px 0 0 ${role.color}` }} aria-label={g.instance.exerciseName}>
      <div className="flex items-start gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={finished ? () => setExpand(!expand) : onFocus} aria-expanded={finished ? expand : focused}>
          <h3 className="text-[15px] leading-snug font-bold">{g.instance.exerciseName}</h3>
          <div className="num truncate text-[12px] text-dust">{role.ko} · {prescriptionText(g)}</div>
        </button>
        <span className={cx('num-d mt-0.5 shrink-0 rounded-md px-1.5 text-[16px] leading-7', finished ? 'bg-p10/20 text-p10' : 'bg-deck')}>{doneCount}/{g.sets.length}</span>
        <button type="button" className="press -mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-dust" onClick={() => setMenu(true)} aria-label={`${g.instance.exerciseName} 메뉴`}><Ellipsis size={20} /></button>
      </div>
      {hasTags && (
        <div className="mt-1 flex flex-wrap gap-1">
          {g.movedFrom && <Badge tone="info">{fmtDateKo(g.movedFrom)}에서 옮김</Badge>}
          {arm?.rom && <Badge tone="info">{arm.rom}</Badge>}
          {arm?.execution.map((e) => <Badge key={e} tone="info">{e}</Badge>)}
          {arm?.loadNote && <Badge tone="info">{arm.loadNote}</Badge>}
          {arm && arm.sourceMissing.includes('intensity') && <Badge tone="bad">원본에 RPE 없음</Badge>}
          {arm?.userFilled && <Badge tone="warn">직접 입력값</Badge>}
        </div>
      )}
      {dec && !arm && dec.reduceOptions && st.nextLoad === dec.nextLoad && !finished && (
        <div className="mt-2 rounded-md border-l-[3px] border-p15 bg-deck p-2 text-[13px]">
          <div>{dec.reason}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Btn onClick={() => void run((d, ctx) => setNextLoad(d, g.exercise.id, dec.nextLoad, '유지 선택', ctx))}>{fmtKg(dec.nextLoad)}kg 유지</Btn>
            {dec.reduceOptions.map((o) => <Btn key={o.pct} onClick={() => void run((d, ctx) => setNextLoad(d, g.exercise.id, o.load, `${o.pct}% 감량 승인`, ctx))}>−{o.pct}% → {fmtKg(o.load)}kg</Btn>)}
          </div>
        </div>
      )}
      {arm && g.sets.length === 0 && <ArmFill g={g} />}
      {idle ? (
        <button type="button" className="press mt-1.5 flex h-10 w-full items-center gap-2 rounded-md bg-deck px-2.5 text-left" onClick={onFocus} aria-label={`${g.instance.exerciseName} 기록 시작`}>
          <span className="shrink-0 text-[11px] text-dust">이전</span>
          <span className="num-d min-w-0 flex-1 truncate text-[15px] text-dust">{prevSummary || '기록 없음'}</span>
          <span className="shrink-0 text-[13px] font-semibold">기록 시작</span>
        </button>
      ) : collapsed ? (
        <button type="button" className="mt-1 block w-full text-left" onClick={() => setExpand(true)} aria-label={`${g.instance.exerciseName} 세트 펼치기`}>
          <div className="num-d truncate text-[15px]">{summarize(perfs) || '기록 없음'}</div>
          {dec && dec.instanceId === g.instance.id && !arm && <div className="num truncate text-[12px] text-dust">다음 세션 {fmtKg(st.nextLoad)}kg · {dec.reason}</div>}
        </button>
      ) : g.sets.length > 0 && (
        arm ? <ArmTable db={db} g={g} date={date} focused={focused} disabled={disabled} onEdit={onEdit} onFocus={onFocus} />
          : <PbTable db={db} g={g} date={date} focused={focused} disabled={disabled} onEdit={onEdit} onFocus={onFocus} />
      )}
      {menu && <CardMenu db={db} g={g} date={date} disabled={disabled} isFirst={isFirst} isLast={isLast} onEdit={onEdit} onClose={() => setMenu(false)} />}
    </section>
  );
};

const ReportSheet = ({ report, onClose }: { report: SessionReport; onClose: () => void }) => (
  <Sheet title="세션 요약" onClose={onClose} footer={<Btn kind="primary" className="w-full" onClick={onClose}>확인</Btn>}>
    <div className="grid grid-cols-3 gap-2 text-center">
      <div className="rounded-lg bg-deck p-2.5"><div className="num-d text-[28px] leading-none">{report.doneSets}/{report.plannedSets}</div><div className="mt-1 text-[11px] text-dust">계획 세트</div></div>
      <div className="rounded-lg bg-deck p-2.5"><div className="num-d text-[28px] leading-none">{report.extraSets}</div><div className="mt-1 text-[11px] text-dust">계획 외 세트</div></div>
      <div className="rounded-lg bg-deck p-2.5"><div className={cx('num-d text-[28px] leading-none', report.rpeOverCap > 0 && 'text-p25')}>{report.rpeOverCap}</div><div className="mt-1 text-[11px] text-dust">RPE 상한 초과</div></div>
    </div>
    {report.plannedSets > report.doneSets && <p className="mt-3 text-sm text-dust">남은 {report.plannedSets - report.doneSets}세트는 자동으로 미수행 처리하지 않았습니다. 캘린더에서 다른 날로 옮기거나 면제·미수행으로 확정할 수 있습니다.</p>}
    {report.decisions.length > 0 && <h3 className="mt-4 mb-1 text-sm font-bold">다음 세션 추천</h3>}
    <ul className="space-y-1.5">
      {report.decisions.map((d, i) => (
        <li key={i} className="rounded-lg bg-deck p-2.5 text-sm"><div className="flex justify-between gap-2 font-semibold"><span>{d.exerciseName}</span><span className="num-d text-[17px]">{fmtKg(d.nextLoad)}kg</span></div><div className="text-xs text-dust">{d.reason}</div></li>
      ))}
    </ul>
    {report.learned.length > 0 && <h3 className="mt-4 mb-1 text-sm font-bold">계수 학습 관측</h3>}
    <ul className="space-y-1">
      {report.learned.map((l, i) => (
        <li key={i} className="num flex justify-between gap-2 text-sm"><span>{l.exerciseName}{l.used ? '' : <span className="text-dust"> 제외 후보({l.reason})</span>}</span><span className="num-d text-[16px]">k {l.k.toFixed(3)}</span></li>
      ))}
    </ul>
  </Sheet>
);

/** 휴식 타이머: 세트 체크 후 자동 시작, ±15초 조정, 권장 시간에 한 번 진동. 진행 막대는 일정 속도(linear) */
const RestTimer = ({ since, target, onClose }: { since: string; target: number; onClose: () => void }) => {
  const [now, setNow] = useState(Date.now());
  const [extra, setExtra] = useState(0);
  const elapsed = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const goal = Math.max(15, target + extra);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { document.body.dataset.timer = '1'; return () => { delete document.body.dataset.timer; }; }, []);
  useEffect(() => { if (elapsed === goal) haptic(200); }, [elapsed, goal]);
  const mmss = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  if (elapsed > 20 * 60) return null;
  const done = elapsed >= goal;
  return (
    <div className="toast-in fixed inset-x-0 z-20 mx-auto max-w-[496px] overflow-hidden rounded-xl bg-deck shadow-lg" role="timer" aria-label={`휴식 ${mmss(elapsed)}, 권장 ${mmss(goal)}`}
      style={{ marginInline: 'max(12px, calc(50% - 248px))', bottom: 'calc(64px + env(safe-area-inset-bottom))' }}>
      <div className="flex items-center gap-2 px-3 py-1">
        <Timer size={18} className={done ? 'text-p10' : 'text-dust'} aria-hidden />
        <span className="num-d text-[22px] leading-none">{mmss(elapsed)}</span>
        <span className="num text-[12px] text-dust">/ {mmss(goal)}{done ? ' · 휴식 충분' : ''}</span>
        <span className="ml-auto flex gap-1">
          <Btn className="!min-h-9 px-2 text-[13px]" onClick={() => setExtra(extra - 15)}>−15</Btn>
          <Btn className="!min-h-9 px-2 text-[13px]" onClick={() => setExtra(extra + 15)}>+15</Btn>
          <Btn kind="quiet" className="!min-h-9 px-2 text-[13px]" onClick={onClose}>닫기</Btn>
        </span>
      </div>
      <div className="h-1 bg-rail">
        <div className="rest-bar h-full origin-left" style={{ transform: `scaleX(${Math.min(1, elapsed / goal)})`, background: done ? 'var(--color-p10)' : 'var(--color-p15)' }} />
      </div>
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
  const [bwOpen, setBwOpen] = useState(false);
  const [cardsRef] = useAutoAnimate<HTMLDivElement>({ duration: 200 });
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
  // 입력은 한 번에 한 운동만: 고른 운동, 없거나 끝났으면 남은 첫 운동
  const hasOpen = (g: DayGroupView) => g.sets.some((s) => s.status === 'planned');
  const focusedId = groups.find((g) => g.instance.id === openId && hasOpen(g))?.instance.id ?? groups.find(hasOpen)?.instance.id ?? null;
  const armNext = db.arm ? armDayList(db.arm)[db.settings.armCursor] : undefined;
  const armPrefer = db.settings.armMode === 3 ? db.settings.armWeekdays3 : db.settings.armWeekdays2;
  const offerArm = !!armNext && date >= today && armPrefer.includes(weekdayOf(date)) && !groups.some((g) => g.instance.track === 'arm');
  // 휴식 권장: 고강도 복합 4분, ARM RPE 9 이상 3분 30초, 그 외 2~2분 30초
  const lastSet = here ? Object.values(db.performed).filter((p) => !p.deleted && p.sessionId === here.id).sort((a, b) => b.performedAt.localeCompare(a.performedAt))[0] : undefined;
  const restTarget = !lastSet ? 0 : lastSet.exerciseId.startsWith('arm:') ? ((lastSet.rpe ?? 0) >= 9 ? 210 : 150) : ['top', 'backoff', 'straight'].includes(lastSet.type) ? 240 : 120;
  const moreToDo = groups.some(hasOpen);

  const finish = async () => {
    if (!session) return;
    const r = await run<SessionReport>((d, ctx) => { const e = endSession(d, session.id, ctx); return { patch: e.patch, result: e.report }; });
    if (r.ok) setReport(r.result);
  };
  const saveBw = async () => {
    const n = Number(bw);
    const r = here ? await run((d) => setSessionBodyweight(d, here.id, n)) : await run((d, ctx) => startSession(d, date, n, ctx));
    if (r.ok) { setBw(''); setBwOpen(false); toast('체중을 저장했습니다'); }
  };

  return (
    <div>
      <header className="flex items-center gap-1">
        <button type="button" className="press flex h-11 w-11 items-center justify-center rounded-lg text-dust" onClick={() => onDate(addDays(date, -1))} aria-label="전날"><ChevronLeft size={22} /></button>
        <div className="min-w-0 flex-1 text-center">
          <h1 className="text-[17px] leading-tight font-extrabold">{fmtDateKo(date)}{date === today ? ' 오늘' : ''}</h1>
          <div className="num flex items-center justify-center gap-2 text-[11px] text-dust"><span>{total ? `계획 ${done}/${total}세트` : '계획 없음'}</span>{date !== today && <Chip className="!h-6 px-2 text-[11px]" onClick={() => onDate(today)}>오늘</Chip>}</div>
        </div>
        <button type="button" className="press flex h-11 w-11 items-center justify-center rounded-lg text-dust" onClick={() => onDate(addDays(date, 1))} aria-label="다음 날"><ChevronRight size={22} /></button>
      </header>

      {session && !here && (
        <div className="mt-1.5 rounded-xl border border-p15/60 p-2.5 text-[13px]">
          <b>{fmtDateKo(session.date)} 세션이 진행 중입니다.</b> 자정을 넘겨도 세션은 시작한 날짜에 귀속됩니다. 이어서 기록하거나 종료한 뒤 이 날짜를 기록하세요.
          <div className="mt-2 flex gap-2"><Btn className="flex-1" onClick={() => onDate(session.date)}>진행 중 세션으로</Btn><Btn className="flex-1" onClick={finish}>세션 종료</Btn></div>
        </div>
      )}
      {(here || needsBw) && (
        <div className="mt-1.5 rounded-xl bg-steel px-3 text-[13px]">
          <div className="flex min-h-[46px] items-center justify-between gap-2">
            <span className="num min-w-0 truncate">
              {here ? <><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-p10 align-middle" aria-hidden />세션 진행 중 <span className="text-dust">· {new Date(here.startedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: db.settings.timezone })} 시작</span></> : session ? <span className="text-dust">이 날짜의 체중</span> : <span className="text-dust">첫 세트를 기록하면 세션이 시작됩니다</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {needsBw && <button type="button" className={cx('press num h-9 rounded-md px-2', curBw ? 'bg-deck' : 'border border-p25 text-p25')} aria-expanded={bwOpen} onClick={() => setBwOpen(!bwOpen)}>체중 <span className="num-d text-[15px]">{curBw ? `${curBw}` : '입력'}</span></button>}
              {here && <Btn className="!min-h-9" onClick={finish} disabled={readOnly}>세션 종료</Btn>}
            </span>
          </div>
          {needsBw && (bwOpen || !curBw) && (
            <div className="flex items-center gap-1.5 pb-2">
              <input className="field num-d flex-1 text-[17px]" type="number" inputMode="decimal" aria-label="오늘 체중 (kg)" placeholder={curBw ? `오늘 체중 (현재 ${curBw}kg)` : '오늘 체중 kg — 딥스·풀업 계산에 필요'} value={bw} onChange={(e) => setBw(e.target.value)} />
              <Btn onClick={saveBw} disabled={!bw || blocked}>저장</Btn>
            </div>
          )}
        </div>
      )}

      {offerArm && armNext && (
        <Btn className="mt-1.5 w-full" disabled={readOnly} onClick={async () => { const r = await run((d, ctx) => assignArmDay(d, armNext.dayIndex, date, ctx)); if (r.ok) toast(`ARM ${armNext.block} W${armNext.week} D${armNext.day} 배정`); }}>
          <Plus size={16} aria-hidden />ARM {armNext.block} W{armNext.week} D{armNext.day} 추가
        </Btn>
      )}
      {groups.length === 0 && (
        <div className="mt-4"><Empty>{db.settings.programStart && date < db.settings.programStart ? `프로그램 시작일(${fmtDateKo(db.settings.programStart)}) 이전입니다.` : '이 날짜에 예정된 운동이 없습니다. 캘린더에서 다른 날의 운동을 옮겨 올 수 있습니다.'}</Empty></div>
      )}
      <div ref={cardsRef} className="mt-2 space-y-2">
        {groups.map((g, i) => (
          <GroupCard key={g.instance.id} db={db} g={g} date={date} disabled={blocked} onEdit={setEdit} isFirst={i === 0} isLast={i === groups.length - 1}
            focused={focusedId === g.instance.id} onFocus={() => setOpenId(g.instance.id)} />
        ))}
      </div>
      {db.settings.restTimer && lastSet && moreToDo && timerOff !== lastSet.id && !edit && !report && <RestTimer key={lastSet.id} since={lastSet.performedAt} target={restTarget} onClose={() => setTimerOff(lastSet.id)} />}
      {edit && <RecordSheet t={edit} onClose={() => setEdit(null)} />}
      {report && <ReportSheet report={report} onClose={() => setReport(null)} />}
    </div>
  );
};
