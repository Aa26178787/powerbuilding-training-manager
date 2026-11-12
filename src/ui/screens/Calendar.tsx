// 캘린더: 주간·월간 보기, 운동일 이동·맞교환·병합·분할·면제, 변경 이력과 취소
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ChangeReason, Db, ISODate } from '../../domain/types';
import { addDays, addMonths, datesBetween, fmtDateKo, monthEnd, monthStart, weekDates, weekStart, weekdayOf, WEEKDAY_KO } from '../../engine/dates';
import { STATUS_LABEL, WorkoutStatus } from '../../engine/status';
import type { ChangeRequest, DayGroup, SchedulePreview } from '../../engine/scheduleMerge';
import { daySummary, dayView, workoutStatuses } from '../../application/selectors';
import { commitChange, previewChange, undoChange } from '../../application/schedule';
import { muscleDelta } from '../../application/analysis';
import { MUSCLES } from '../../domain/defaults';
import { closeWorkout } from '../../application/session';
import { ensureWeeksFor, run, toast, todayStr, useApp } from '../store';
import { Badge, Btn, cx, Empty, SectionTitle, Sheet } from '../components';

const REASONS: [ChangeReason, string][] = [['gym_closed', '체육관 휴관'], ['unavoidable_personal', '개인 사정'], ['travel', '이동·여행'], ['health_issue', '건강 문제'], ['user_choice', '내 선택'], ['other', '기타']];
const tone = (s: WorkoutStatus) => (s === 'completed' ? 'ok' : s === 'missed' || s === 'overdue' ? 'bad' : s === 'excused' || s === 'partial' ? 'warn' : s === 'merged' || s === 'rescheduled' ? 'info' : 'mute') as 'ok' | 'bad' | 'warn' | 'info' | 'mute';

const PlanList = ({ title, groups }: { title: string; groups: DayGroup[] }) => (
  <div className="min-w-0 flex-1">
    <div className="mb-1 text-xs font-bold text-dust">{title}</div>
    {groups.length === 0 ? <div className="text-xs text-dust">운동 없음</div> : (
      <ol className="space-y-0.5 text-xs">
        {groups.map((g, i) => <li key={g.instanceId} className="num"><span className="text-dust">{i + 1}.</span> {g.name} <span className="text-dust">{g.open}세트{g.done ? ` (+완료 ${g.done})` : ''}</span></li>)}
      </ol>
    )}
  </div>
);

/** 일정 변경 흐름: 대상 선택 → 작업 선택 → 미리보기(충돌·경고) → 사용자 승인 */
const ChangeFlow = ({ db, date, onClose }: { db: Db; date: ISODate; onClose: () => void }) => {
  const groups = dayView(db, date).filter((g) => g.sets.some((s) => s.status === 'planned'));
  const [picked, setPicked] = useState<string[]>(groups.map((g) => g.instance.id));
  const [action, setAction] = useState<'move' | 'swap' | 'excuse' | 'remove'>('move');
  const [toDate, setToDate] = useState<ISODate>(addDays(date, 1));
  const [reason, setReason] = useState<ChangeReason>('gym_closed');
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  const setIds = groups.filter((g) => picked.includes(g.instance.id)).flatMap((g) => g.sets.filter((s) => s.status === 'planned').map((s) => s.id));
  useEffect(() => { ensureWeeksFor([toDate]); }, [toDate]);
  const preview: SchedulePreview | null = useMemo(() => {
    const req: ChangeRequest = action === 'move' ? { kind: 'move', setIds, toDate }
      : action === 'swap' ? { kind: 'swap', dateA: date, dateB: toDate }
      : { kind: 'status', setIds, status: action === 'excuse' ? 'excused' : 'removed', statusReason: REASONS.find((r) => r[0] === reason)?.[1] };
    if (action !== 'swap' && !setIds.length) return null;
    return previewChange(db, req);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, action, toDate, setIds.join('|'), reason]);
  const needsAck = !!preview?.warnings.some((w) => w.severity === 'approval');
  const confirm = async () => {
    if (!preview) return;
    const r = await run((d, ctx) => commitChange(d, previewChange(d, action === 'move' ? { kind: 'move', setIds, toDate } : action === 'swap' ? { kind: 'swap', dateA: date, dateB: toDate } : { kind: 'status', setIds, status: action === 'excuse' ? 'excused' : 'removed', statusReason: REASONS.find((x) => x[0] === reason)?.[1] }), { reason, note, acknowledgedWarnings: ack }, ctx));
    if (r.ok) { toast(`${preview.summary} 확정`); onClose(); }
  };
  const quick = [...weekDates(weekStart(date)), ...weekDates(addDays(weekStart(date), 7))].filter((d) => d !== date);
  return (
    <Sheet
      title={`${fmtDateKo(date)} 일정 변경`} onClose={onClose}
      footer={<Btn kind="primary" className="w-full" disabled={!preview?.ok || (needsAck && !ack)} onClick={confirm}>{preview?.ok ? `${preview.summary} 확정` : '변경 내용을 선택하세요'}</Btn>}
    >
      {groups.length === 0 ? <Empty>이 날짜에 옮길 수 있는 예정 세트가 없습니다. 완료한 세트는 옮길 수 없습니다.</Empty> : (
        <div className="space-y-4">
          <fieldset>
            <legend className="mb-1 text-xs font-bold text-dust">무엇을 할까요</legend>
            <div className="grid grid-cols-2 gap-1.5">
              {([['move', '다른 날로 이동·병합'], ['swap', '두 날짜 맞교환'], ['excuse', '면제(휴관·사정)'], ['remove', '삭제·중복 제거']] as const).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={action === k} onClick={() => { setAction(k); setAck(false); }} className={cx('tap rounded-lg border px-2 text-sm font-semibold', action === k ? 'border-p15 bg-p15/15' : 'border-rail text-dust')}>{l}</button>
              ))}
            </div>
          </fieldset>
          {action !== 'swap' && (
            <fieldset>
              <legend className="mb-1 text-xs font-bold text-dust">대상 운동. 일부만 고르면 세션이 나뉩니다</legend>
              <div className="divide-y divide-rail overflow-hidden rounded-lg bg-deck">
                {groups.map((g) => (
                  <label key={g.instance.id} className="flex min-h-[44px] cursor-pointer items-center gap-3 px-3 text-sm">
                    <input type="checkbox" className="h-5 w-5 accent-[var(--color-p15)]" checked={picked.includes(g.instance.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, g.instance.id] : picked.filter((x) => x !== g.instance.id))} />
                    <span className="flex-1">{g.instance.exerciseName}</span>
                    <span className="num text-xs text-dust">{g.sets.filter((s) => s.status === 'planned').length}세트</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {(action === 'move' || action === 'swap') && (
            <fieldset>
              <legend className="mb-1 text-xs font-bold text-dust">{action === 'move' ? '옮길 날짜' : '맞교환할 날짜'}</legend>
              <div className="flex flex-wrap gap-1">
                {quick.map((d) => (
                  <button key={d} type="button" aria-pressed={toDate === d} onClick={() => { setToDate(d); setAck(false); }} className={cx('num h-11 rounded-lg border px-2 text-xs', toDate === d ? 'border-p15 bg-p15/15 font-bold' : 'border-rail text-dust')}>{fmtDateKo(d)}</button>
                ))}
              </div>
              <input className="field mt-2" type="date" value={toDate} onChange={(e) => { if (e.target.value) { setToDate(e.target.value); setAck(false); } }} aria-label="날짜 직접 선택" />
            </fieldset>
          )}
          <label className="block"><span className="mb-1 block text-xs font-bold text-dust">사유</span>
            <select className="field" value={reason} onChange={(e) => setReason(e.target.value as ChangeReason)}>{REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </label>
          <input className="field" placeholder="메모(선택)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />

          {preview && !preview.ok && <div className="rounded-lg bg-p25/15 p-3 text-sm">{preview.errors.join(' / ')}</div>}
          {preview?.ok && (
            <div className="rounded-xl bg-deck p-3">
              <div className="text-sm font-bold">미리보기: {preview.summary}</div>
              <div className="num mt-1 text-xs text-dust">이동 {preview.counts.moved} · 면제 {preview.counts.excused} · 삭제 {preview.counts.removed}세트. 원본 계획과 달성률 분모는 그대로 보존됩니다{preview.counts.excused + preview.counts.removed > 0 ? '(조정 계획 이행률의 분모만 줄어듭니다)' : ''}.</div>
              {preview.affected.map((a) => (
                <div key={a.date} className="mt-3 border-t border-rail pt-2">
                  <div className="mb-1 text-sm font-bold">{fmtDateKo(a.date)}</div>
                  <div className="flex gap-3"><PlanList title="변경 전" groups={a.before} /><PlanList title="변경 후(권장 순서)" groups={a.after} /></div>
                </div>
              ))}
              {(() => {
                const lost = muscleDelta(db, preview.setPatches.filter((p) => p.after.status === 'excused' || p.after.status === 'removed').map((p) => p.id));
                return lost.length > 0 && (
                  <div className="num mt-3 border-t border-rail pt-2 text-xs">
                    <div className="mb-1 font-bold text-dust">이번 주 근육군별 예정 세트 변화(가중)</div>
                    {lost.map((m) => `${Object.fromEntries(MUSCLES)[m.muscle] ?? m.muscle} −${m.total}`).join(' · ')}
                  </div>
                );
              })()}
              {preview.warnings.length > 0 && (
                <ul className="mt-3 space-y-1.5 border-t border-rail pt-2">
                  {preview.warnings.map((w, i) => (
                    <li key={i} className="flex gap-2 text-sm"><Badge tone={w.severity === 'approval' ? 'bad' : w.severity === 'warn' ? 'warn' : 'info'}>{w.severity === 'approval' ? '승인 필요' : w.severity === 'warn' ? '주의' : '안내'}</Badge><span>{w.message}</span></li>
                  ))}
                </ul>
              )}
              {needsAck && (
                <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-p25/60 px-3 text-sm">
                  <input type="checkbox" className="h-5 w-5 accent-[var(--color-p25)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />경고를 확인했고 이대로 진행합니다
                </label>
              )}
              <p className="mt-2 text-xs text-dust">경고는 규칙 기반 검토 신호이며 안전을 보증하지 않습니다. 통증·피로가 있으면 실제 컨디션을 우선하세요.</p>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
};

export const CalendarScreen = ({ go }: { go: (tab: string, date?: ISODate) => void }) => {
  const { db } = useApp();
  const today = todayStr();
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState<ISODate>(today);
  const [sel, setSel] = useState<ISODate | null>(null);
  const [change, setChange] = useState<ISODate | null>(null);
  const range = mode === 'week' ? { start: weekStart(anchor), end: addDays(weekStart(anchor), 6) } : { start: weekStart(monthStart(anchor)), end: addDays(weekStart(monthEnd(anchor)), 6) };
  useEffect(() => { ensureWeeksFor(datesBetween(range.start, range.end).filter((d) => weekdayOf(d) === 1)); }, [range.start, range.end, db?.settings.programStart]);
  if (!db) return null;
  const statuses = workoutStatuses(db, today);
  const dates = datesBetween(range.start, range.end);
  const shift = (n: number) => setAnchor(mode === 'week' ? addDays(anchor, 7 * n) : addMonths(anchor, n));
  const changes = Object.values(db.changes).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 15);
  const dayStatuses = (d: ISODate) => {
    const sum = daySummary(db, d);
    // 그 날짜가 원래 계획일인 세션(다른 날로 옮겨졌어도 표시)
    const own = Object.values(db.workouts).filter((w) => w.originalDate === d).map((w) => w.id);
    return { sum, ids: [...new Set([...sum.workoutIds, ...own])] };
  };
  const selInfo = sel ? dayStatuses(sel) : null;

  return (
    <div>
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-extrabold">캘린더</h1>
        <div className="flex shrink-0 rounded-lg bg-steel p-0.5 whitespace-nowrap" role="tablist" aria-label="보기">
          {(['week', 'month'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`press h-9 rounded-md px-3 text-[13px] font-semibold ${mode === m ? 'bg-deck text-chalk' : 'text-dust'}`}>{m === 'week' ? '주간' : '월간'}</button>
          ))}
        </div>
      </header>
      <div className="mt-2 flex items-center justify-between">
        <Btn kind="quiet" onClick={() => shift(-1)} aria-label="이전"><ChevronLeft size={20} /></Btn>
        <button type="button" className="num tap text-sm font-semibold" onClick={() => setAnchor(today)}>
          {mode === 'week' ? `${fmtDateKo(range.start)} ~ ${fmtDateKo(range.end)}` : `${anchor.slice(0, 4)}년 ${Number(anchor.slice(5, 7))}월`}
        </button>
        <Btn kind="quiet" onClick={() => shift(1)} aria-label="다음"><ChevronRight size={20} /></Btn>
      </div>

      {mode === 'week' ? (
        <ul className="mt-1 space-y-1">
          {dates.map((d) => {
            const { sum, ids } = dayStatuses(d);
            const names = dayView(db, d).map((g) => g.instance.exerciseName);
            return (
              <li key={d}>
                <button type="button" onClick={() => setSel(d)} className={cx('flex w-full items-center gap-2.5 rounded-xl bg-steel px-2.5 py-2 text-left', d === today && 'ring-1 ring-p15')}>
                  <div className="num w-9 shrink-0 text-center leading-tight"><div className="text-[11px] text-dust">{WEEKDAY_KO[weekdayOf(d)]}</div><div className="num-d text-[20px] leading-none">{Number(d.slice(8))}</div></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap gap-1">
                      {ids.map((id) => <Badge key={id} tone={tone(statuses.get(id) ?? 'planned')}>{db.workouts[id]?.track === 'arm' ? 'ARM ' : ''}{db.workouts[id]?.originalDate !== d ? `${fmtDateKo(db.workouts[id].originalDate)}분 ` : ''}{STATUS_LABEL[statuses.get(id) ?? 'planned']}</Badge>)}
                      {ids.length === 0 && <span className="text-xs text-dust">휴식</span>}
                      {sum.excused > 0 && <Badge tone="warn">면제 {sum.excused}세트</Badge>}
                    </div>
                    {names.length > 0 && <div className="mt-1 truncate text-xs text-dust">{names.join(', ')}</div>}
                  </div>
                  {sum.total > 0 && <div className={cx('num-d shrink-0 text-[16px]', sum.done === sum.total ? 'text-p10' : 'text-dust')}>{sum.done}/{sum.total}</div>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-2">
          <div className="grid grid-cols-7 text-center text-xs text-dust">{WEEKDAY_KO.slice(1).map((w) => <div key={w} className="py-1">{w}</div>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {dates.map((d) => {
              const { sum, ids } = dayStatuses(d);
              const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
              const st = ids.map((id) => statuses.get(id) ?? 'planned');
              const mark = !sum.total && !ids.length ? '' : sum.total && sum.done === sum.total ? '완료' : sum.done > 0 ? '일부' : st.includes('overdue') ? '경과' : st.includes('excused') ? '면제' : st.every((s) => s === 'merged' || s === 'rescheduled') && !sum.total ? '이동' : st.includes('missed') ? '미수행' : '예정';
              return (
                <button key={d} type="button" onClick={() => setSel(d)} aria-label={`${fmtDateKo(d)} ${mark || '휴식'}`}
                  className={cx('num flex aspect-square flex-col items-center justify-center rounded-lg text-sm', inMonth ? 'bg-steel' : 'opacity-40', d === today && 'ring-1 ring-p15')}>
                  <span className="font-bold">{Number(d.slice(8))}</span>
                  <span className={cx('text-[10px] leading-tight', mark === '완료' ? 'text-p10' : mark === '경과' || mark === '미수행' ? 'text-p25' : mark === '면제' || mark === '일부' ? 'text-p15' : 'text-dust')}>{mark}</span>
                  {sum.total > 0 && <span className="text-[10px] leading-tight text-dust">{sum.done}/{sum.total}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <SectionTitle>변경 이력</SectionTitle>
      {changes.length === 0 ? <Empty>아직 일정 변경이 없습니다. 날짜를 눌러 운동을 옮기거나 면제할 수 있습니다.</Empty> : (
        <ul className="divide-y divide-rail rounded-xl bg-steel px-3">
          {changes.map((c) => (
            <li key={c.id} className="flex min-h-[52px] items-center justify-between gap-2 py-1.5 text-sm">
              <div className="min-w-0"><div className={cx(c.undoneAt && 'text-dust line-through')}>{c.summary}</div><div className="num text-xs text-dust">{fmtDateKo(c.createdAt.slice(0, 10))} · {REASONS.find((r) => r[0] === c.reason)?.[1]}{c.note ? ` · ${c.note}` : ''}</div></div>
              {c.undoneAt ? <Badge>취소됨</Badge> : c.type !== 'arm_assign' && (
                <Btn onClick={async () => { const r = await run<number>((d, ctx) => { const u = undoChange(d, c.id, ctx); return { patch: u.patch, result: u.keptCount }; }); if (r.ok) toast(r.result ? `취소했습니다. 이미 기록한 ${r.result}세트는 그대로 두었습니다` : '변경을 취소했습니다'); }}>취소</Btn>
              )}
            </li>
          ))}
        </ul>
      )}

      {sel && selInfo && (
        <Sheet title={fmtDateKo(sel)} onClose={() => setSel(null)}>
          <div className="space-y-2">
            {selInfo.ids.length === 0 && <p className="text-sm text-dust">예정된 운동이 없는 날입니다.</p>}
            {selInfo.ids.map((id) => {
              const w = db.workouts[id];
              const st = statuses.get(id) ?? 'planned';
              return (
                <div key={id} className="rounded-lg bg-deck p-3 text-sm">
                  <div className="flex items-center justify-between gap-2"><b>{w.label}{w.originalDate !== sel ? ` (원래 ${fmtDateKo(w.originalDate)})` : ''}</b><Badge tone={tone(st)}>{STATUS_LABEL[st]}</Badge></div>
                  {st === 'overdue' && (
                    <div className="mt-2 flex gap-2">
                      <Btn className="flex-1" onClick={() => void run((d, ctx) => closeWorkout(d, id, 'missed', ctx))}>미수행으로 확정</Btn>
                    </div>
                  )}
                  {w.closedAs && <Btn kind="quiet" className="mt-1" onClick={() => void run((d, ctx) => closeWorkout(d, id, null, ctx))}>확정 해제</Btn>}
                </div>
              );
            })}
            <Btn kind="primary" className="w-full" onClick={() => { go('day', sel); setSel(null); }}>이 날 운동 보기·기록</Btn>
            <Btn className="w-full" onClick={() => { setChange(sel); setSel(null); }}>이동·병합·분할·면제</Btn>
          </div>
        </Sheet>
      )}
      {change && <ChangeFlow db={db} date={change} onClose={() => setChange(null)} />}
    </div>
  );
};
