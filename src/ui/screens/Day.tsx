// 오늘 루틴: 운동마다 세트 표(# · 이전 · kg · 회 · RPE · ✓)로 기록한다.
// 레퍼런스: Strong/Hevy의 세트 줄 + 체크, 지난 기록 열, 체크 후 휴식 타이머 자동 시작.
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { m } from 'motion/react';
import { Check, ChevronLeft, ChevronRight, Ellipsis, Flag, Minus, Play, Plus, SkipForward, Timer, Undo2, X } from 'lucide-react';
import type { Db, ISODate, IssueFlag, PerformedSet, PlannedSet, Side } from '../../domain/types';
import { addDays, fmtDateKo, weekdayOf } from '../../engine/dates';
import { plateBreakdown, roundingNote, ROUNDING_KO } from '../../engine/rounding';
import { calibrateInitialLoad, CONFIDENCE_KO, LOAD_UNIT_KO, METHOD_KO } from '../../engine/initialLoad';
import { dayView, DayGroupView } from '../../application/selectors';
import { armVariantKey, bodyweightFor, lastSessionSets, modeOf, stepOf, suggestForSet, Suggestion } from '../../application/recommend';
import {
  activeSession, deletePerformedSet, setEquipment, editPerformedSet, endSession, markSetDone, recordArmRow, recordSet, SessionReport,
  setNextLoad, setSessionBodyweight, skipSets, startSession, unskipSet,
} from '../../application/session';
import { addPlannedSets, commitChange, previewChange, reorderInstance } from '../../application/schedule';
import { assignSlot, duplicateWarnings, slotOptions, swapInstanceExercise } from '../../application/slots';
import { EQUIPMENT_NAMES, slotById } from '../../domain/slots';
import { armDayList, assignArmDay, fillArmMissing, videoCategoryFor } from '../../application/arm';
import { ensureWeeksFor, haptic, run, toast, todayStr, useApp } from '../store';
import { Badge, Btn, Chip, cx, fmtKg, PLATE_COLOR, Reveal, RpePicker, Sheet, Stepper } from '../components';

const FLAG_KO: Record<IssueFlag, string> = {
  equipment_failure: '장비 문제', grip_slip: '그립 미끄러짐', j_cup_collision: 'J컵 충돌', unusual_shoes: '평소와 다른 신발',
  range_of_motion_changed: '가동범위 변화', technique_breakdown: '자세 무너짐', pain: '통증', exceptional_fatigue: '심한 피로',
  merged_session: '병합 세션', other: '기타',
};
/** 운동 역할: 카드 왼쪽 띠 색 + 글자. 띠는 주력·스트렝스·ARM만 칠하고 나머지는 중립 */
const ROLE: Record<string, { ko: string; color: string }> = {
  comp: { ko: '주력', color: 'var(--color-p15)' }, strength: { ko: '스트렝스', color: 'var(--color-p20)' }, variation: { ko: '변형', color: 'var(--color-dust)' },
  accessory: { ko: '보조', color: 'var(--color-dust)' }, arm: { ko: 'ARM', color: 'var(--color-p10)' },
};
/** 자리 이동 애니메이션: 200ms, 강한 ease-out (Emil Kowalski 기준 UI 동작은 300ms 미만) */
const LAYOUT = { duration: 0.2, ease: [0.23, 1, 0.32, 1] } as const;
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
    const vol = first ? `${g.sets.length}×${first.seconds ? `${first.seconds}초` : first.reps}` : '세트·반복 원본 누락';
    const inten = a.rpeRange ? `@${a.rpeRange[0]}~${a.rpeRange[1]}` : a.rpe !== null ? `@${a.rpe}` : a.percent1rm !== null ? `${a.percent1rm}%` : 'RPE 원본 누락';
    return `${vol} ${inten}`;
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
  return parts.map((x) => (x.n > 1 ? `${x.t} ×${x.n}` : x.t)).join(', ');
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

/** 처방·추천 안내 한 줄. 감량 권고면 왼쪽 빨강 띠 */
const Advice = ({ sug, onStop, openCount, disabled }: { sug: Suggestion; onStop: () => void; openCount: number; disabled: boolean }) => {
  const [why, setWhy] = useState(false);
  if (!sug.message) return null;
  const b = sug.basis;
  const rows: [string, string][] = [];
  if (sug.method) rows.push(['산출 방법', METHOD_KO[sug.method]]);
  if (sug.confidence) rows.push(['추천 신뢰도', CONFIDENCE_KO[sug.confidence]]);
  if (b?.baseExercise) rows.push(['기준 운동', b.baseExercise]);
  if (b?.e1rm !== undefined) rows.push(['사용한 e1RM', `${(Math.round(b.e1rm * 10) / 10).toFixed(1)}kg`]);
  if (b?.kBase !== undefined) rows.push(['환산계수', `k_base ${b.kBase} × k ${(b.kIndividual ?? 1).toFixed(3)}`]);
  if (b) rows.push(['목표', `${b.targetReps}회 @${b.targetRpe}`]);
  if (sug.round && sug.load !== null) rows.push(['반올림', `${ROUNDING_KO[sug.round.mode]}, ${sug.round.step}kg 단위`]);
  rows.push(['개인화 보정', sug.personalized ? '적용' : '없음']);
  if (sug.kind === 'progression') rows.push(['Fast-track', sug.fastTrack ? '적용' : '아님']);
  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {sug.load !== null && (
            <div className="flex items-baseline gap-2 text-[13px] leading-none font-semibold">
              <span>추천 <span className="num-d text-[18px]">{fmtKg(sug.load)}</span>kg</span>
              {sug.confidence && <span className="text-[11px] font-normal text-dust">{CONFIDENCE_KO[sug.confidence]}</span>}
            </div>
          )}
          {sug.round && sug.load !== null && <div className="num mt-1 text-[11.5px] text-dust">{roundingNote(sug.round.raw, sug.load, sug.round.mode, sug.round.step)}</div>}
          <p className={cx('text-[12.5px] leading-[1.45]', sug.load !== null && 'mt-1', sug.action === 'decrease' ? 'text-p25' : 'text-dust')}>{sug.message}</p>
        </div>
        {(rows.length > 2 || sug.detail) && <Chip onClick={() => setWhy(!why)} aria-expanded={why}>{why ? '접기' : '근거'}</Chip>}
      </div>
      {why && (<Reveal>
        <dl className="num mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 rounded-lg bg-deck px-3 py-2 text-[12px]">
          {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-dust">{k}</dt><dd className="text-right">{v}</dd></div>)}
        </dl></Reveal>
      )}
      {sug.offerStop && openCount > 0 && <Btn className="mt-1.5 w-full" onClick={onStop} disabled={disabled}>남은 {openCount}세트 조기 종료</Btn>}
    </div>
  );
};

const Tag = ({ children }: { children: ReactNode }) => <span className="inline-flex h-6 items-center rounded-md border border-rail px-2 text-[11.5px] text-dust">{children}</span>;

/** 원판 지름(mm)·두께 비율로 그린 크기 [폭, 높이] px. 25·20kg 지름 450mm를 88px로 */
const PLATE_DIM: Record<string, [number, number]> = { 25: [11, 88], 20: [10, 88], 15: [9, 78], 10: [8, 64], 5: [6, 45], 2.5: [5, 37], 1.25: [4, 31] };

/** 바벨 옆모습: 가운데 봉, 칼라, 슬리브. 원판은 칼라에 붙여 큰 것부터 바깥으로 */
const BarDiagram = ({ perSide }: { perSide: number[] }) => {
  const plates = perSide.map((kg, i) => ({ kg, i, w: PLATE_DIM[String(kg)]?.[0] ?? 4, h: PLATE_DIM[String(kg)]?.[1] ?? 26 }));
  const side = (dir: 'L' | 'R') => (
    <div className="relative h-full min-w-[64px] flex-1" style={{ maxWidth: 112 }}>
      <div className="absolute inset-x-0 top-1/2 h-[10px] -translate-y-1/2 rounded-sm bg-[#8a8f98]" />
      <div className={cx('absolute inset-y-0 flex items-center gap-[2px]', dir === 'L' ? 'right-0 flex-row-reverse' : 'left-0')}>
        {plates.map((p) => (
          <m.span key={`${p.i}-${p.kg}`} className="block rounded-[3px]" initial={{ opacity: 0, scaleY: 0.6 }} animate={{ opacity: 1, scaleY: 1 }} transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
            style={{ width: p.w, height: p.h, background: PLATE_COLOR[String(p.kg)] ?? '#6b7280', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.14)' }} />
        ))}
      </div>
    </div>
  );
  return (
    <div aria-hidden className="flex h-[92px] items-center">
      {side('L')}
      <div className="h-5 w-2 shrink-0 rounded-sm bg-[#a3a8b0]" />
      <div className="h-1 flex-[1.3] bg-[#6b7079]" />
      <div className="h-5 w-2 shrink-0 rounded-sm bg-[#a3a8b0]" />
      {side('R')}
    </div>
  );
};

const RPES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
/** RPE 9칸. 선택은 흰색, 목표 범위는 밑줄, 상한 초과 선택은 빨강 */
const RpeCells = ({ value, onChange, lo, hi, cap, disabled }: { value: number | null; onChange: (v: number | null) => void; lo?: number; hi?: number; cap?: number; disabled?: boolean }) => (
  <div role="radiogroup" aria-label="실제 RPE" data-dense className="grid grid-cols-9 gap-1">
    {RPES.map((r) => {
      const sel = value === r;
      const inTarget = lo !== undefined && r >= lo && r <= (hi ?? lo);
      return (
        <button key={r} type="button" role="radio" aria-checked={sel} disabled={disabled} onClick={() => onChange(sel ? null : r)}
          className={cx('press num-d h-11 rounded-lg text-[17px]', sel ? (cap !== undefined && r > cap ? 'bg-p25 font-bold text-white' : 'bg-chalk font-bold text-iron') : inTarget ? 'bg-iron text-chalk shadow-[inset_0_-2px_0_var(--color-chalk)]' : 'bg-iron text-dust')}>{r}</button>
      );
    })}
  </div>
);

/** 큰 숫자 입력 + 양옆 −/+ */
const BigNumber = ({ value, onChange, onStep, step, unit, label, size = 'lg', disabled }: {
  value: string; onChange: (v: string) => void; onStep: (d: number) => void; step: number; unit: string; label: string; size?: 'lg' | 'md'; disabled?: boolean;
}) => (
  <div className="flex items-center gap-2.5">
    <button type="button" className={cx('press flex shrink-0 items-center justify-center rounded-xl', size === 'lg' ? 'h-12 w-12 border border-rail' : 'h-11 w-11 text-dust')} disabled={disabled} onClick={() => onStep(-step)} aria-label={`${label} ${step} 줄이기`}><Minus size={18} aria-hidden /></button>
    <label className="flex min-w-0 flex-1 items-baseline justify-center gap-1">
      <input className={cx('num-d w-full min-w-0 bg-transparent text-center font-bold outline-none focus-visible:rounded-lg focus-visible:bg-iron', size === 'lg' ? 'h-16 text-[60px] leading-none tracking-[-0.01em] placeholder:text-knurl' : 'h-10 text-[32px] leading-none')}
        type="number" inputMode="decimal" step="any" aria-label={label} placeholder="0" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} onFocus={(e) => e.target.select()} style={{ maxWidth: size === 'lg' ? 200 : 72 }} />
      <span className={cx('shrink-0 text-dust', size === 'lg' ? 'text-[16px]' : 'text-[14px]')}>{unit}</span>
    </label>
    <button type="button" className={cx('press flex shrink-0 items-center justify-center rounded-xl', size === 'lg' ? 'h-12 w-12 border border-rail' : 'h-11 w-11 text-dust')} disabled={disabled} onClick={() => onStep(step)} aria-label={`${label} ${step} 늘리기`}><Plus size={18} aria-hidden /></button>
  </div>
);

/** 화면 아래 고정 주 버튼. 탭 막대 바로 위에 붙는다 */
const ActionBar = ({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) => {
  useEffect(() => { document.body.dataset.action = '1'; return () => { delete document.body.dataset.action; }; }, []);
  return createPortal(
    <div className="action-pos fixed inset-x-0 z-20 border-t border-rail bg-iron/95 px-4 py-2.5 backdrop-blur">
      <button type="button" className="press mx-auto flex h-14 w-full max-w-[496px] items-center justify-center gap-2.5 rounded-[14px] bg-chalk text-[16px] font-bold text-iron" onClick={onClick} disabled={disabled}>{children}</button>
    </div>,
    document.body,
  );
};

/** 세트 줄: 세트마다 한 칸, 위쪽 2px 선(끝남 흰색, 남음 회색). 끝난 칸을 누르면 수정 */
const SetStrip = ({ g, date, activeId, onEdit, labelOf, valueOf }: {
  g: DayGroupView; date: ISODate; activeId?: string; onEdit: (t: EditTarget) => void; labelOf: (s: PlannedSet, i: number) => string; valueOf: (perf: PerformedSet[]) => string;
}) => (
  <ol className="mt-3.5 grid grid-cols-4 gap-x-1.5 gap-y-2.5">
    {g.sets.map((s, i) => {
      const perf = g.performed[s.id] ?? [];
      const done = s.status === 'done';
      const now = s.id === activeId;
      const skipped = s.status !== 'done' && s.status !== 'planned';
      return (
        <m.li layout="position" transition={LAYOUT} key={s.id} className={cx('min-w-0 border-t-2 pt-1.5', done ? 'border-chalk' : now ? 'border-chalk/40' : 'border-rail', done && justDone.has(s.id) && 'row-done')}>
          <div className={cx('text-[11px] leading-4', now ? 'font-semibold text-chalk' : 'text-dust')}>{labelOf(s, i)}{now ? ' 지금' : ''}</div>
          {done && perf.length ? (
            <button type="button" className="hit num-d block w-full truncate text-left text-[16px] leading-6" onClick={() => onEdit({ perf: perf[0], group: g, date })} aria-label={`${labelOf(s, i)} ${perfText(perf[0])} 수정`}>{valueOf(perf)}</button>
          ) : skipped ? (
            <button type="button" className="press flex h-6 items-center gap-1 text-[12px] text-dust" onClick={() => void run((d) => unskipSet(d, s.id))} aria-label={`${labelOf(s, i)} 건너뜀 되돌리기`}><Undo2 size={13} aria-hidden />{s.status === 'skipped_by_autoregulation' ? '조기 종료' : '건너뜀'}</button>
          ) : (
            <div className="num-d truncate text-[16px] leading-6 text-knurl">×{targetReps(s)}{targetRpe(s) ? ` @${targetRpe(s)}` : ''}</div>
          )}
        </m.li>
      );
    })}
  </ol>
);

/** 파워빌딩 운동 입력 구역 */
/** 기록이 없을 때: 가벼운 세트 하나로 시작 중량을 정한다 */
type Calib = { load: number | null; raw: number; e1rm: number; inputs: Record<string, unknown> };
const CalibratePanel = ({ db, g, date, sug, disabled, onUse }: { db: Db; g: DayGroupView; date: ISODate; sug: Suggestion; disabled: boolean; onUse: (c: Calib) => void }) => {
  const [w, setW] = useState(''); const [r, setR] = useState('5'); const [e, setE] = useState<number | null>(null);
  const bwPlus = g.exercise.loadMode === 'bodyweight_plus';
  const bw = bwPlus ? bodyweightFor(db, date) : 0;
  const target = { reps: sug.basis?.targetReps ?? 5, rpe: sug.basis?.targetRpe ?? 7.5 };
  const step = stepOf(db, g.exercise); const mode = modeOf(db, g.exercise, 'start');
  const ready = w !== '' && Number(r) > 0 && e !== null && (!bwPlus || !!bw);
  const res = ready ? calibrateInitialLoad({ warmup: { weight: Number(w), reps: Number(r), rpe: e! }, target, increment: step, rounding: mode, bodyweight: bw ?? 0 }) : null;
  return (
    <div className="mt-2.5 rounded-lg bg-deck px-3 py-2.5">
      <div className="text-[12.5px] font-semibold">가벼운 세트로 시작 중량 정하기</div>
      <p className="mt-0.5 text-[11.5px] leading-[1.45] text-dust">한 세트를 해 보고 중량·반복·RPE를 넣으면 {target.reps}회 @{target.rpe} 중량을 계산합니다. 이 세트는 기록에 남지 않습니다.</p>
      {bwPlus && !bw && <p className="mt-1 text-[11.5px] text-p25">맨 위에서 오늘 체중을 먼저 넣으세요.</p>}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-[11px] text-dust">{bwPlus ? '추가 중량' : '중량'} kg
          <input className="num-d mt-0.5 h-10 w-full rounded-md bg-iron text-center text-[20px] font-bold outline-none" type="number" inputMode="decimal" step="any" value={w} disabled={disabled} onChange={(x) => setW(x.target.value)} />
        </label>
        <label className="text-[11px] text-dust">반복
          <input className="num-d mt-0.5 h-10 w-full rounded-md bg-iron text-center text-[20px] font-bold outline-none" type="number" inputMode="numeric" value={r} disabled={disabled} onChange={(x) => setR(x.target.value)} />
        </label>
      </div>
      <div className="mt-2"><RpeCells value={e} onChange={setE} disabled={disabled} /></div>
      {res && (
        <div className="mt-2 flex items-center gap-3">
          <div className="num min-w-0 flex-1 text-[12px] text-dust">
            {res.assistNeeded ? <span className="text-p25">체중만으로도 무겁습니다. 보조를 쓰세요.</span>
              : <>e1RM {res.e1rm.toFixed(1)}kg, {roundingNote(Math.max(res.raw, Number(w)), res.rounded ?? 0, mode, step)}</>}
          </div>
          {!res.assistNeeded && <Btn disabled={disabled} onClick={() => onUse({ load: res.rounded, raw: res.raw, e1rm: res.e1rm, inputs: { warmup: { weight: Number(w), reps: Number(r), rpe: e }, target, bodyweight: bw, step, rounding: mode, formulaVersion: res.formulaVersion } })}>이 중량으로 시작</Btn>}
        </div>
      )}
    </div>
  );
};

const EDIT_REASONS = ['컨디션', '장비 차이', '기술 연습', '통증 주의'];

const PbTable = ({ db, g, date, focused, disabled, onEdit }: {
  db: Db; g: DayGroupView; date: ISODate; focused: boolean; disabled: boolean; onEdit: (t: EditTarget) => void;
}) => {
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
  const [calib, setCalib] = useState<Calib | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [assist, setAssist] = useState<'band' | 'machine' | null>(null);
  // 다음 세트로 넘어가거나 추천값이 바뀌면 새로 채운다(같은 세트 안에서 고친 값은 유지)
  useEffect(() => {
    setWeight(initW === null ? '' : String(initW)); setReps(String(initR)); setRpe(null); setFlags([]); setShowFlags(false); setReason(null); setCalib(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, sug?.load, g.exercise.id]);
  const w = weight === '' ? null : Number(weight);
  const plates = g.exercise.barbell && w !== null && w > 0 ? plateBreakdown(w, db.settings.barWeight, db.settings.plates, db.settings.plateStock) : null;
  const open = g.sets.filter((s) => s.status === 'planned');
  const bumpW = (d: number) => setWeight(String(Math.max(0, Math.round(((Number(weight) || 0) + d) * 1000) / 1000)));
  const recLoad = calib ? calib.load : sug?.load ?? null;
  const edited = w !== null && recLoad !== null && Math.abs(w - recLoad) > 1e-6;
  const unitLbl = g.exercise.loadUnit && g.exercise.loadUnit !== 'total' ? LOAD_UNIT_KO[g.exercise.loadUnit] : null;
  const bumpR = (d: number) => setReps(String(Math.max(0, (Number(reps) || 0) + d)));

  const complete = async () => {
    if (!active || busy) return;
    setBusy(true);
    const n = Number(reps);
    const r = await run<string>((d, ctx) => {
      const patch = recordSet(d, { plannedSetId: active.id, exerciseId: g.exercise.id, date, weight: w, rpe: rpe ?? undefined, flags, ...(assist ? { assist } : {}), ...(calib ? { calibration: { load: calib.load, raw: calib.raw, method: 'warmup', confidence: 'estimate' as const, inputs: calib.inputs } } : {}), ...(reason && edited ? { editReason: reason } : {}), ...(active.seconds ? { seconds: n } : { reps: n }) }, ctx);
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
  const labelOf = (s: PlannedSet) => (s.type === 'top' ? 'Top' : `${g.sets.filter((x) => x.type === s.type).indexOf(s) + 1}세트`);
  const unit = active?.seconds ? '초' : '회';

  return (
    <div>
      {focused && active && (
        <div className="mt-3">
          {plates && (
            <>
              <BarDiagram perSide={plates.perSide} />
              <div className="mt-1 text-center text-[12px] text-dust">
                한쪽 <span className="num-d text-[14px] text-chalk/80">{plates.perSide.join(' ') || '빈 바'}</span>
                {plates.remainder > 0 && <span className="text-p25">, 가진 원판으로 {plates.remainder}kg 모자람</span>}
              </div>
            </>
          )}
          {g.exercise.loadMode === 'bodyweight_plus' && <div className="text-center text-[12px] text-dust">{assist ? `보조(${assist === 'band' ? '밴드' : '머신'}) 사용, 중량은 0으로` : '추가 중량(벨트에 다는 무게)'}</div>}
          {unitLbl && <div className="text-center text-[12px] text-dust">{unitLbl} 기준</div>}
          <div className="mt-2.5"><BigNumber value={weight} onChange={setWeight} onStep={bumpW} step={inc} unit="kg" label={`${labelOf(active)} 중량`} disabled={disabled} /></div>
          <div className="mx-auto mt-1 max-w-[220px]"><BigNumber value={reps} onChange={setReps} onStep={bumpR} step={1} unit={unit} label={`${labelOf(active)} ${active.seconds ? '유지 시간' : '반복수'}`} size="md" disabled={disabled} /></div>
          <div className="mt-3"><RpeCells value={rpe} onChange={setRpe} lo={active.targetRpe} hi={active.targetRpeMax} cap={active.rpeCap} disabled={disabled} /></div>
          {rpe !== null && rpe > active.rpeCap
            ? <p className="mt-1.5 text-[12px] leading-[1.45] text-p25">상한 @{active.rpeCap}을 넘습니다. 기록은 그대로 남고 다음 세트는 감량을 제안합니다.</p>
            : <p className="mt-1.5 text-[11px] text-dust">밑줄은 목표 RPE {targetRpe(active)}</p>}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Chip className={cx(flags.length > 0 && '!bg-p25/25')} onClick={() => setShowFlags(!showFlags)} aria-expanded={showFlags}><Flag size={13} aria-hidden />{flags.length ? `태그 ${flags.length}` : '태그'}</Chip>
            <Chip disabled={disabled} onClick={() => void run((d, ctx) => skipSets(d, [active.id], false, '사용자 스킵', ctx))}><SkipForward size={13} aria-hidden />이 세트 건너뛰기</Chip>
          </div>
          {showFlags && <Reveal className="mt-2"><FlagPicker flags={flags} onChange={setFlags} /></Reveal>}
          {g.exercise.loadMode === 'bodyweight_plus' && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-dust">
              <span>보조</span>
              {(['band', 'machine'] as const).map((a) => <Chip key={a} className={cx(assist === a && '!bg-chalk !text-iron')} aria-pressed={assist === a} onClick={() => { setAssist(assist === a ? null : a); if (assist !== a) setWeight('0'); }}>{a === 'band' ? '밴드' : '머신'}</Chip>)}
            </div>
          )}
          {edited && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-dust">
              <span className="w-full">추천 {fmtKg(recLoad!)}kg에서 바꾼 이유(선택)</span>
              {EDIT_REASONS.map((x) => <Chip key={x} className={cx(reason === x && '!bg-chalk !text-iron')} aria-pressed={reason === x} onClick={() => setReason(reason === x ? null : x)}>{x}</Chip>)}
            </div>
          )}
        </div>
      )}
      {focused && active && sug?.needsCalibration && doneHere.length === 0 && !calib && <CalibratePanel db={db} g={g} date={date} sug={sug} disabled={disabled} onUse={(c) => { setCalib(c); if (c.load !== null) setWeight(String(c.load)); }} />}
      {focused && calib && <p className="num mt-2 text-[12px] text-dust">가벼운 세트로 정한 시작 중량 {calib.load === null ? '-' : `${fmtKg(calib.load)}kg`} (e1RM {calib.e1rm.toFixed(1)}kg, 추정치) <button className="hit ml-1 underline-offset-2 text-chalk" onClick={() => setCalib(null)}>다시</button></p>}
      <SetStrip g={g} date={date} activeId={focused ? active?.id : undefined} onEdit={onEdit} labelOf={labelOf} valueOf={(perf) => short(perf[0])} />
      {focused && sug && sug.kind !== 'none' && <Advice sug={sug} onStop={stopRest} openCount={open.length} disabled={disabled} />}
      {focused && sug?.kind === 'none' && sug.message && !(sug.needsCalibration && doneHere.length === 0) && <p className="mt-2.5 text-[12.5px] leading-[1.45] text-dust">{sug.message}</p>}
      {g.extras.length > 0 && <div className="num mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-dust"><span>계획 외 세트</span>{g.extras.map((p) => <Chip key={p.id} onClick={() => onEdit({ perf: p, group: g, date })}>{short(p)}</Chip>)}</div>}
      {focused && active && (
        <ActionBar onClick={complete} disabled={disabled || busy || reps === '' || (weight === '' && g.exercise.loadMode !== 'bodyweight_plus')}>
          {weight === '' && g.exercise.loadMode !== 'bodyweight_plus' ? '중량을 넣으세요' : <>{labelOf(active)} 기록 <span className="num-d text-[19px] font-semibold">{weight === '' ? '' : `${fmtKg(w)}kg × `}{reps || '?'}{unit === '초' ? '초' : ''}{rpe !== null ? ` @${rpe}` : ''}</span></>}
        </ActionBar>
      )}
    </div>
  );
};

/** ARM 입력 구역: 왼팔·오른팔 중량을 함께 넣는다 */
const ArmTable = ({ db, g, date, focused, disabled, onEdit }: {
  db: Db; g: DayGroupView; date: ISODate; focused: boolean; disabled: boolean; onEdit: (t: EditTarget) => void;
}) => {
  const separate = db.settings.armSideMode === 'separate';
  const history = lastSessionSets(db, g.exercise.id, date, armVariantKey(db, g.instance.id));
  const prevW = (side: Side) => history.find((p) => p.side === side || p.side === 'both')?.weight;
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
  const labelOf = (_s: PlannedSet, i: number) => `${i + 1}세트`;
  const idx = active ? g.sets.indexOf(active) : -1;
  const kgField = (label: string, value: string, set: (v: string) => void) => (
    <label className="min-w-0 flex-1 text-center">
      <span className="block text-[11px] text-dust">{label}</span>
      <span className="flex items-baseline justify-center gap-1">
        <input className="num-d h-12 w-full min-w-0 rounded-lg bg-iron text-center text-[32px] font-bold leading-none outline-none placeholder:text-knurl" placeholder="0" type="number" inputMode="decimal" step="any" aria-label={`${label} 중량`} value={value} disabled={disabled} onChange={(e) => set(e.target.value)} onFocus={(e) => e.target.select()} />
        <span className="shrink-0 text-[13px] text-dust">kg</span>
      </span>
    </label>
  );
  return (
    <div>
      {focused && active && (
        <div className="mt-3">
          <div className="flex gap-3">{kgField(separate ? '왼팔' : '중량', left, setLeft)}{separate && kgField('오른팔', right, setRight)}</div>
          <div className="mx-auto mt-2 max-w-[220px]"><BigNumber value={reps} onChange={setReps} onStep={(d) => setReps(String(Math.max(0, (Number(reps) || 0) + d)))} step={1} unit={isStatic ? '초' : '회'} label={`${idx + 1}세트 ${isStatic ? '유지 시간' : '반복수'}`} size="md" disabled={disabled} /></div>
          <div className="mt-3"><RpeCells value={rpe} onChange={setRpe} lo={active.targetRpe} hi={active.targetRpeMax} disabled={disabled} /></div>
          <p className="mt-1.5 text-[11px] leading-[1.45] text-dust">{separate ? '한쪽만 넣으면 그 팔만, 둘 다 비우면 중량 없이 기록합니다. ' : ''}ARM은 PDF의 RPE를 그대로 따릅니다.</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Chip disabled={disabled} onClick={() => void run((d, ctx) => skipSets(d, open.map((x) => x.id), false, '사용자 스킵', ctx))}><SkipForward size={13} aria-hidden />남은 {open.length}세트 건너뛰기</Chip>
            {separate && (g.performed[active.id] ?? []).length === 1 && <Chip disabled={disabled} onClick={() => void run((d, ctx) => markSetDone(d, active.id, ctx))}>한 팔만 하고 완료</Chip>}
          </div>
        </div>
      )}
      <SetStrip g={g} date={date} activeId={focused ? active?.id : undefined} onEdit={onEdit} labelOf={labelOf} valueOf={(perf) => summarize(perf)} />
      {focused && active && (
        <ActionBar onClick={complete} disabled={disabled || busy || reps === ''}>
          {idx + 1}세트 기록 <span className="num-d text-[19px] font-semibold">{left === '' && right === '' ? '중량 없이' : separate ? `왼 ${left || '-'} 오 ${right || '-'}kg` : `${left}kg`} × {reps || '?'}{isStatic ? '초' : ''}{rpe !== null ? ` @${rpe}` : ''}</span>
        </ActionBar>
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
      {g.instance.arm?.rpe === null && g.instance.arm?.rpeRange === null && <div className="mt-2"><div className="mb-1 text-[11px] text-dust">목표 RPE</div><RpeCells value={rpe} onChange={setRpe} /></div>}
      <Btn className="mt-2 w-full" onClick={() => void run((d) => fillArmMissing(d, g.instance.id, { sets: Number(sets), reps: reps ? Number(reps) : null, seconds: secs ? Number(secs) : null, rpe }))}>이 값으로 세트 만들기</Btn>
    </div>
  );
};

/** 운동별 메뉴: 순서·세트 수·계획 외 세트·PDF 원문·영상 */
const EquipmentForm = ({ db, exerciseId, disabled }: { db: Db; exerciseId: string; disabled: boolean }) => {
  const eq = db.exStates[exerciseId]?.equipment;
  const [id, setId] = useState(eq?.id ?? ''); const [pin, setPin] = useState(eq?.pinStep ? String(eq.pinStep) : ''); const [note, setNote] = useState(eq?.note ?? '');
  const save = async () => {
    const r = await run((d, ctx) => setEquipment(d, exerciseId, id || pin || note ? { id: id || undefined, unit: 'kg', pinStep: pin ? Number(pin) : undefined, note: note || undefined } : undefined, ctx));
    if (r.ok) toast('장비 정보를 저장했습니다');
  };
  return (
    <div className="mt-3 rounded-lg bg-deck p-2.5 text-sm">
      <div className="text-xs text-dust">장비 정보(헬스장·기구가 바뀌면 중량이 달라질 수 있어 함께 남깁니다)</div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <input className="field" placeholder="기구 이름·번호" value={id} onChange={(e) => setId(e.target.value)} aria-label="기구 이름·번호" />
        <input className="field num" placeholder="핀 간격 kg" type="number" inputMode="decimal" step="any" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="핀 간격" />
        <input className="field col-span-2" placeholder="메모(시트 높이 등)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="장비 메모" />
      </div>
      <Btn className="mt-1.5 w-full" disabled={disabled} onClick={save}>장비 정보 저장</Btn>
    </div>
  );
};

const ArmOneRmForm = ({ db, exerciseId, disabled }: { db: Db; exerciseId: string; disabled: boolean }) => {
  const cur = db.settings.armOneRm?.[exerciseId];
  const [v, setV] = useState(cur ? String(cur) : '');
  const save = async () => {
    const n = v === '' ? null : Number(v);
    if (n !== null && !(n > 0 && n < 500)) { toast('1RM 값을 확인하세요', 'error'); return; }
    const next = { ...db.settings.armOneRm }; if (n === null) delete next[exerciseId]; else next[exerciseId] = n;
    const r = await run(() => ({ settings: { armOneRm: next } }));
    if (r.ok) toast(n === null ? '기준 1RM을 지웠습니다' : '기준 1RM을 저장했습니다');
  };
  return (
    <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-deck p-2.5 text-sm">
      <label className="min-w-0 flex-1 text-xs text-dust">기준 1RM(PDF %1RM 처방 계산용)
        <input className="field num mt-1 w-full" type="number" inputMode="decimal" step="any" value={v} onChange={(e) => setV(e.target.value)} />
      </label>
      <Btn className="self-end" disabled={disabled} onClick={save}>저장</Btn>
    </div>
  );
};

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
      {!arm && g.exercise.role !== 'comp' && <EquipmentForm db={db} exerciseId={g.exercise.id} disabled={disabled} />}
      {arm && arm.percent1rm != null && <ArmOneRmForm db={db} exerciseId={g.exercise.id} disabled={disabled} />}
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

/** 슬롯 운동 바꾸기: 세트·반복·RPE 처방은 그대로, 운동별 중량·진행은 따로 */
const SwapSheet = ({ db, g, date, onClose }: { db: Db; g: DayGroupView; date: ISODate; onClose: () => void }) => {
  const slotId = g.instance.slotId as string;
  const slot = slotById(db, slotId);
  const [pick, setPick] = useState<string | null>(null);
  const [forward, setForward] = useState(true);
  const started = g.sets.some((s) => s.status !== 'planned');
  const opts = slotOptions(db, slotId);
  const fav = new Set(db.settings.favorites ?? []);
  const warn = pick ? duplicateWarnings(db, pick, date) : [];
  const apply = async () => {
    if (!pick) return;
    const a = await run((d, ctx) => swapInstanceExercise(d, g.instance.id, pick, ctx));
    if (!a.ok) return;
    if (forward) { const b = await run((d, ctx) => assignSlot(d, slotId, pick, ctx, { fromDate: addDays(date, 1) })); if (!b.ok) return; }
    toast(`${db.exercises[pick].name}(으)로 바꿨습니다${started ? '. 끝낸 세트는 원래 운동 기록으로 남습니다' : ''}`);
    onClose();
  };
  return (
    <Sheet title={`${slot?.name ?? '슬롯'} 운동 바꾸기`} onClose={onClose} footer={
      <div className="space-y-2">
        {warn.map((w) => <p key={w} className="text-[12.5px] leading-[1.45] text-p25">{w}</p>)}
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5 accent-[var(--color-p15)]" checked={forward} onChange={(e) => setForward(e.target.checked)} />앞으로도 이 운동으로(이후 계획에도 적용)</label>
        <Btn kind="primary" className="w-full" disabled={!pick} onClick={apply}>{pick ? `${db.exercises[pick].name}(으)로 바꾸기` : '운동을 고르세요'}</Btn>
      </div>
    }>
      <p className="text-[12.5px] leading-[1.45] text-dust">처방({prescriptionText(g)})은 그대로입니다. 중량과 진행은 운동마다 따로 기록되며, 머신끼리 중량을 환산하지 않습니다.{started ? ' 끝낸 세트는 지금 운동 기록으로 남고 남은 세트만 바뀝니다.' : ''}</p>
      <ul className="mt-2 divide-y divide-rail rounded-lg bg-deck">
        {opts.map((e) => {
          const last = summarize(lastSessionSets(db, e.id, date).filter((p) => p.plannedSetId !== null));
          const cur = e.id === g.exercise.id;
          return (
            <li key={e.id}>
              <button type="button" disabled={cur} aria-pressed={pick === e.id} onClick={() => setPick(e.id)} className={cx('flex min-h-[52px] w-full items-center gap-3 px-3 py-2 text-left', pick === e.id && 'bg-rail/60')}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">{fav.has(e.id) ? '★ ' : ''}{e.name}</span>
                  <span className="block truncate text-[12px] text-dust">{EQUIPMENT_NAMES[e.equipment ?? 'other']}{last ? <>, 지난번 <span className="num-d text-[13px] text-chalk/80">{last}</span></> : ', 기록 없음(처음엔 가벼운 세트로 시작 중량을 정합니다)'}</span>
                </span>
                {cur && <span className="text-[12px] text-dust">지금 운동</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <Btn className="mt-2 w-full" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('ptm-nav', { detail: 'library' })); }}>라이브러리에서 운동 추가</Btn>
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
  const started = g.sets.some((s) => s.status !== 'planned');
  const perfs = g.sets.flatMap((s) => g.performed[s.id] ?? []);
  const role = ROLE[g.exercise.role] ?? ROLE.accessory;
  const prevSummary = !focused && !started ? summarize(lastSessionSets(db, g.exercise.id, date, arm ? armVariantKey(db, g.instance.id) : undefined).filter((p) => p.plannedSetId !== null)) : '';
  const hasTags = !!(g.movedFrom || arm?.rom || (arm?.execution.length ?? 0) > 0 || arm?.loadNote || (arm && arm.sourceMissing.includes('intensity')) || arm?.userFilled);
  const showBody = g.sets.length > 0 && (focused || (started && !finished) || (finished && expand));
  const nextLine = finished && dec && dec.instanceId === g.instance.id && !arm ? `다음 세션 ${fmtKg(st.nextLoad)}kg. ${dec.reason}` : '';
  const slot = !arm ? slotById(db, g.instance.slotId) : undefined;
  const [swap, setSwap] = useState(false);
  const onHeader = focused ? undefined : finished ? () => setExpand(!expand) : onFocus;

  return (
    <section aria-label={g.instance.exerciseName} className={cx(focused ? '-mx-3 bg-steel px-4 pt-4 pb-5' : 'border-b border-rail/80 py-3')}>
      <div className="flex items-start gap-3">
        {!focused && (
          <span aria-hidden className="mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center">
            {finished ? <Check size={19} strokeWidth={2.6} className="text-chalk" />
              : started ? <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-chalk"><span className="h-2 w-2 rounded-full bg-chalk" /></span>
              : <span className="h-5 w-5 rounded-full border-2 border-rail" />}
          </span>
        )}
        <button type="button" className={cx('min-h-11 min-w-0 flex-1 text-left', focused && 'cursor-default')} onClick={onHeader} aria-expanded={finished ? expand : focused}>
          <h3 className={cx('truncate leading-tight', focused ? 'text-[20px] font-bold' : 'text-[15px] font-semibold')}>{slot ? slot.name : g.instance.exerciseName}</h3>
          {slot && <div className={cx('truncate text-[13px] leading-5', focused ? 'mt-0.5 text-chalk/85' : 'text-chalk/70')}>{g.exercise.name}</div>}
          {focused ? (
            <div className="mt-1 flex items-baseline gap-2 text-[13px] leading-5 text-dust"><span className="shrink-0 font-semibold text-chalk/75">{role.ko}</span><span className="num-d truncate text-[15px]">{prescriptionText(g)}</span></div>
          ) : finished ? (
            <div className="num-d truncate text-[15px] leading-5 text-dust">{summarize(perfs) || '기록 없음'}</div>
          ) : started ? (
            <div className="num-d truncate text-[14px] leading-5 text-dust">{prescriptionText(g)}</div>
          ) : (
            <div className="truncate text-[12px] leading-5 text-dust">{prevSummary ? <>지난번 <span className="num-d text-[14px] text-chalk/80">{prevSummary}</span></> : <>지난 기록 없음&nbsp;&nbsp;<span className="num-d text-[14px]">{prescriptionText(g)}</span></>}</div>
          )}
        </button>
        <span className={cx('num-d shrink-0 leading-6 tabular-nums', focused ? 'text-[22px]' : 'text-[17px] text-dust', finished && 'text-chalk')}>{doneCount}<span className="text-knurl">/{g.sets.length}</span></span>
        <button type="button" className="press -mt-2.5 -mr-2.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-dust" onClick={() => setMenu(true)} aria-label={`${g.instance.exerciseName} 메뉴`}><Ellipsis size={20} aria-hidden /></button>
      </div>
      {focused && slot && g.sets.some((s) => s.status === 'planned') && (
        <div className="mt-2"><Chip disabled={disabled} onClick={() => setSwap(true)}>운동 변경</Chip></div>
      )}
      {focused && g.exercise.pause && <div className="mt-2 text-[12.5px] text-dust">정지: {g.exercise.pause.position}, {g.exercise.pause.seconds}초</div>}
      {nextLine && !focused && <div className={cx('mt-1 truncate text-[12px] text-dust', 'pl-8')}>{nextLine}</div>}
      {focused && hasTags && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {g.movedFrom && <Tag>{fmtDateKo(g.movedFrom)}에서 옮김</Tag>}
          {arm?.rom && <Tag>{arm.rom}</Tag>}
          {arm?.execution.map((e) => <Tag key={e}>{e}</Tag>)}
          {arm?.loadNote && <Tag>{arm.loadNote}</Tag>}
          {arm && arm.sourceMissing.includes('intensity') && <Badge tone="bad">원본에 RPE 없음</Badge>}
          {arm?.userFilled && <Badge tone="warn">직접 입력값</Badge>}
        </div>
      )}
      {focused && dec && !arm && dec.reduceOptions && st.nextLoad === dec.nextLoad && (
        <div className="mt-3 border-t border-rail pt-3 text-[13px] leading-[1.45]">
          <div>{dec.reason}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Btn onClick={() => void run((d, ctx) => setNextLoad(d, g.exercise.id, dec.nextLoad, '유지 선택', ctx))}>{fmtKg(dec.nextLoad)}kg 유지</Btn>
            {dec.reduceOptions.map((o) => <Btn key={o.pct} onClick={() => void run((d, ctx) => setNextLoad(d, g.exercise.id, o.load, `${o.pct}% 감량 승인`, ctx))}>{o.pct}% 낮춰 {fmtKg(o.load)}kg</Btn>)}
          </div>
        </div>
      )}
      {arm && g.sets.length === 0 && <ArmFill g={g} />}
      {showBody && (
        <Reveal key={focused ? 'f' : 'r'} className={cx(!focused && 'pl-8')}>
          {arm ? <ArmTable db={db} g={g} date={date} focused={focused} disabled={disabled} onEdit={onEdit} />
            : <PbTable db={db} g={g} date={date} focused={focused} disabled={disabled} onEdit={onEdit} />}
        </Reveal>
      )}
      {swap && slot && <SwapSheet db={db} g={g} date={date} onClose={() => setSwap(false)} />}
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
    <div className="timer-pos fixed inset-x-0 z-20 border-t border-rail bg-steel/95 backdrop-blur" role="timer" aria-label={`휴식 ${mmss(elapsed)}, 권장 ${mmss(goal)}`}>
      <div className="mx-auto flex h-[56px] max-w-[520px] items-center gap-2 px-4">
        <Timer size={18} className={done ? 'text-p10' : 'text-dust'} aria-hidden />
        <span className="num-d text-[22px] leading-none">{mmss(elapsed)}</span>
        <span className="num text-[12px] text-dust">/ {mmss(goal)}{done ? ', 휴식 충분' : ''}</span>
        <span className="ml-auto flex gap-1">
          <Chip className="!h-9 px-3 num-d !text-[15px]" onClick={() => setExtra(extra - 15)} aria-label="권장 시간 15초 줄이기">−15</Chip>
          <Chip className="!h-9 px-3 num-d !text-[15px]" onClick={() => setExtra(extra + 15)} aria-label="권장 시간 15초 늘리기">+15</Chip>
          <button type="button" className="press flex h-11 w-11 items-center justify-center rounded-lg text-dust" onClick={onClose} aria-label="휴식 타이머 닫기"><X size={16} aria-hidden /></button>
        </span>
      </div>
      <div className="absolute inset-x-0 top-0 h-[3px] bg-rail">
        <div className="rest-bar h-full origin-left" style={{ transform: `scaleX(${Math.min(1, elapsed / goal)})`, background: done ? 'var(--color-p10)' : 'var(--color-p15)' }} />
      </div>
    </div>
  );
};

export const DayScreen = ({ date, onDate, onCalendar }: { date: ISODate; onDate: (d: ISODate) => void; onCalendar?: () => void }) => {
  const { db, readOnly } = useApp();
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [bw, setBw] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [timerOff, setTimerOff] = useState<string | null>(null);
  const [bwOpen, setBwOpen] = useState(false);
  useEffect(() => { ensureWeeksFor([date, addDays(date, 7), addDays(date, 14)]); }, [date, db?.settings.programStart]);
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
          <div className="flex justify-center"><span className="relative"><h1 className="text-[16px] leading-5 font-bold">{fmtDateKo(date)}</h1>{date !== today && <button type="button" className="press absolute top-1/2 left-full ml-2 inline-flex h-5 -translate-y-1/2 items-center whitespace-nowrap rounded-md bg-deck px-2 text-[11px] leading-none font-semibold text-chalk after:absolute after:-inset-x-2 after:-inset-y-3 after:content-['']" onClick={() => onDate(today)}>오늘</button>}</span></div>
          <div className="num flex h-5 items-center justify-center gap-2 text-[11px] text-dust"><span>{total ? `${date === today ? '오늘, ' : ''}${total}세트 중 ${done}세트` : '계획 없음'}</span></div>
        </div>
        <button type="button" className="press flex h-11 w-11 items-center justify-center rounded-lg text-dust" onClick={() => onDate(addDays(date, 1))} aria-label="다음 날"><ChevronRight size={22} /></button>
      </header>

      {session && !here && (
        <div className="-mx-3 mt-1 border-y border-rail px-4 py-3 text-[13px] leading-[1.5]">
          <b>{fmtDateKo(session.date)} 세션이 진행 중입니다.</b> 자정을 넘겨도 세션은 시작한 날짜에 귀속됩니다. 이어서 기록하거나 종료한 뒤 이 날짜를 기록하세요.
          <div className="mt-2 flex gap-2"><Btn className="flex-1" onClick={() => onDate(session.date)}>진행 중 세션으로</Btn><Btn className="flex-1" onClick={finish}>세션 종료</Btn></div>
        </div>
      )}
      {(here || needsBw) && (
        <div className="-mx-3 mt-1 border-y border-rail px-4 text-[13px]">
          <div className="flex min-h-11 items-center justify-between gap-2">
            <span className="num min-w-0 truncate">
              {here ? <><b className="font-semibold text-p10">세션 진행 중</b> <span className="text-dust">{new Date(here.startedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: db.settings.timezone })} 시작</span></> : session ? <span className="text-dust">이 날짜의 체중</span> : <span className="text-dust">첫 세트를 기록하면 세션이 시작됩니다</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {needsBw && <button type="button" className={cx('press hit num h-8 rounded-lg border px-2.5', curBw ? 'border-rail' : 'border-p25 text-p25')} aria-expanded={bwOpen} onClick={() => setBwOpen(!bwOpen)}>체중 <span className="num-d text-[15px]">{curBw ? `${curBw}` : '입력'}</span></button>}
              {here && <button type="button" className="press hit h-8 rounded-lg border border-rail px-2.5 font-semibold" onClick={finish} disabled={readOnly}>세션 종료</button>}
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
      {groups.length === 0 && (() => {
        const before = !!db.settings.programStart && date < db.settings.programStart;
        // 다음 운동이 있는 날(2주 안)을 찾아 미리 보여 준다
        let next: { d: ISODate; gs: DayGroupView[] } | null = null;
        for (let i = 1; i <= 14 && !next; i++) { const d = addDays(date, i); const gs = dayView(db, d); if (gs.length) next = { d, gs }; }
        return (
          <section className="pt-4">
            <h2 className="text-[20px] leading-tight font-bold">{before ? '프로그램 시작 전' : '휴식일'}</h2>
            <p className="mt-1 text-[13px] leading-[1.5] text-dust">{before ? `프로그램은 ${fmtDateKo(db.settings.programStart as string)}에 시작합니다.` : '이 날짜에는 계획된 운동이 없습니다.'}</p>
            {next && (
              <div className="mt-5 border-t border-rail pt-4">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[15px] font-bold">다음 운동 {fmtDateKo(next.d)}</span>
                  <Chip onClick={() => onDate(next.d)}>열기</Chip>
                </div>
                <ul className="mt-2 text-[14px] leading-[30px]">
                  {next.gs.filter((g) => g.instance.track === 'pb').map((g) => (
                    <li key={g.instance.id} className="flex items-baseline justify-between gap-3"><span className="min-w-0 truncate">{g.instance.exerciseName}</span><span className="num-d shrink-0 text-[16px] text-dust">{prescriptionText(g)}</span></li>
                  ))}
                  {next.gs.some((g) => g.instance.track === 'arm') && <li className="text-dust">ARM {next.gs.filter((g) => g.instance.track === 'arm').length}종목</li>}
                </ul>
              </div>
            )}
            {!before && onCalendar && (
              <div className="mt-5 flex items-center gap-3 border-t border-rail pt-4">
                <p className="min-w-0 flex-1 text-[13px] leading-[1.5] text-dust">다른 날 운동을 오늘로 옮기려면 캘린더에서 고릅니다.</p>
                <button type="button" className="press h-11 shrink-0 rounded-[10px] border border-rail px-3.5 text-[13px] font-semibold" onClick={onCalendar}>캘린더</button>
              </div>
            )}
          </section>
        );
      })()}
      <div className={cx(groups.length > 0 && 'mt-1')}>
        {groups.map((g, i) => (
          <m.div key={g.instance.id} layout="position" transition={LAYOUT}>
            <GroupCard db={db} g={g} date={date} disabled={blocked} onEdit={setEdit} isFirst={i === 0} isLast={i === groups.length - 1}
              focused={focusedId === g.instance.id} onFocus={() => setOpenId(g.instance.id)} />
          </m.div>
        ))}
      </div>
      {db.settings.restTimer && lastSet && moreToDo && timerOff !== lastSet.id && !edit && !report && <RestTimer key={lastSet.id} since={lastSet.performedAt} target={restTarget} onClose={() => setTimerOff(lastSet.id)} />}
      {edit && <RecordSheet t={edit} onClose={() => setEdit(null)} />}
      {report && <ReportSheet report={report} onClose={() => setReport(null)} />}
    </div>
  );
};
