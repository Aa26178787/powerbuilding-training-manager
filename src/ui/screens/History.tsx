// 운동 기록: 운동별 이력, 기록 수정·삭제·복원
import { useState } from 'react';
import type { PerformedSet } from '../../domain/types';
import { fmtDateKo } from '../../engine/dates';
import { conservativeE1RM, validateSetInput } from '../../engine/e1rm';
import { deletePerformedSet, editPerformedSet, restorePerformedSet, setNextLoad } from '../../application/session';
import { run, toast, useApp } from '../store';
import { Badge, Btn, Empty, fmtKg, RpePicker, SectionTitle, Sheet, Stepper } from '../components';

export const HistoryScreen = () => {
  const { db } = useApp();
  const [exId, setExId] = useState<string>('');
  const [edit, setEdit] = useState<PerformedSet | null>(null);
  const [w, setW] = useState(''); const [r, setR] = useState(''); const [rpe, setRpe] = useState<number | null>(null);
  const [next, setNext] = useState('');
  if (!db) return null;
  const all = Object.values(db.performed);
  const used = [...new Set(all.map((p) => p.exerciseId))].map((id) => db.exercises[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const sel = exId || used[0]?.id || '';
  const ex = db.exercises[sel];
  const rows = all.filter((p) => p.exerciseId === sel).sort((a, b) => b.performedAt.localeCompare(a.performedAt));
  const byDate = new Map<string, PerformedSet[]>();
  rows.forEach((p) => byDate.set(p.sessionDate, [...(byDate.get(p.sessionDate) ?? []), p]));
  const st = db.exStates[sel];
  const open = (p: PerformedSet) => { setEdit(p); setW(p.weight === null ? '' : String(p.weight)); setR(String(p.seconds ?? p.reps ?? '')); setRpe(p.rpe ?? null); };
  const e1 = (p: PerformedSet): string => {
    if (p.type !== 'top' || p.weight === null || p.reps === undefined || p.rpe === undefined) return '';
    const sys = p.weight + (ex?.loadMode === 'bodyweight_plus' ? p.bodyweight ?? 0 : 0);
    return validateSetInput(sys, p.reps, p.rpe).length ? '' : ` · e1RM ${conservativeE1RM(sys, p.reps, p.rpe).toFixed(1)}`;
  };
  return (
    <div>
      <header><h1 className="text-xl font-extrabold">운동 기록</h1></header>
      {used.length === 0 ? <div className="mt-4"><Empty>아직 기록이 없습니다. 오늘 화면에서 세트를 완료하면 여기에 쌓입니다.</Empty></div> : (
        <>
          <select className="field mt-3" value={sel} onChange={(e) => setExId(e.target.value)} aria-label="운동 선택">
            {used.map((e) => <option key={e.id} value={e.id}>{e.role === 'arm' ? 'ARM · ' : ''}{e.name}</option>)}
          </select>
          {ex && ex.role !== 'arm' && (
            <div className="mt-3 rounded-xl bg-steel p-3 text-sm">
              <div className="flex items-center justify-between gap-2"><span className="text-dust">다음 세션 추천 중량</span><b className="num">{fmtKg(st?.nextLoad)}kg</b></div>
              {st?.lastDecision && <div className="mt-1 text-xs text-dust">{st.lastDecision.reason}{st.failStreak ? ` (연속 미달 ${st.failStreak}회)` : ''}</div>}
              <div className="mt-2 flex gap-2">
                <input className="field num flex-1" type="number" inputMode="decimal" placeholder="직접 지정(kg) — 감량·디로드 포함" value={next} onChange={(e) => setNext(e.target.value)} />
                <Btn disabled={!next} onClick={async () => { const x = await run((d, ctx) => setNextLoad(d, sel, Number(next), '사용자 지정', ctx)); if (x.ok) { setNext(''); toast('다음 세션 중량을 지정했습니다'); } }}>지정</Btn>
              </div>
            </div>
          )}
          <SectionTitle>세션별 기록</SectionTitle>
          <ul className="space-y-2">
            {[...byDate.entries()].map(([date, sets]) => (
              <li key={date} className="rounded-xl bg-steel p-3">
                <div className="num mb-1 text-sm font-bold">{fmtDateKo(date)} <span className="font-normal text-dust">{date.slice(0, 4)}</span></div>
                <ul className="space-y-0.5">
                  {[...sets].reverse().map((p) => (
                    <li key={p.id} className="num flex min-h-[40px] items-center justify-between gap-2 text-sm">
                      <button type="button" className={`text-left ${p.deleted ? 'text-dust line-through' : 'underline decoration-rail underline-offset-4'}`} onClick={() => !p.deleted && open(p)}>
                        {p.side && p.side !== 'both' ? (p.side === 'L' ? '왼팔 ' : '오른팔 ') : ''}{p.weight === null ? '' : `${fmtKg(p.weight)}kg × `}{p.seconds ? `${p.seconds}초` : `${p.reps}회`}{p.rpe !== undefined ? ` @${p.rpe}` : ''}<span className="text-xs text-dust">{e1(p)}</span>
                      </button>
                      <span className="flex items-center gap-1">
                        {p.type === 'top' && <Badge tone="warn">Top</Badge>}{p.type === 'extra' && <Badge>계획 외</Badge>}
                        {p.flags.length > 0 && <Badge tone="bad">태그 {p.flags.length}</Badge>}
                        {p.deleted && <Btn onClick={() => void run((d, ctx) => restorePerformedSet(d, p.id, ctx))}>복원</Btn>}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
      {edit && (
        <Sheet title="기록 수정" onClose={() => setEdit(null)} footer={
          <div className="flex gap-2">
            <Btn kind="danger" onClick={async () => { const x = await run((d, ctx) => deletePerformedSet(d, edit.id, ctx)); if (x.ok) setEdit(null); }}>삭제</Btn>
            <Btn kind="primary" className="flex-1" onClick={async () => {
              const n = Number(r);
              const x = await run((d, ctx) => editPerformedSet(d, edit.id, { weight: w === '' ? null : Number(w), rpe: rpe ?? undefined, ...(edit.seconds !== undefined ? { seconds: n } : { reps: n }) }, ctx));
              if (x.ok) { setEdit(null); toast('기록을 수정했습니다'); }
            }}>수정 저장</Btn>
          </div>}>
          <div className="space-y-3">
            <Stepper label="중량" unit="kg" value={w} onChange={setW} steps={[ex?.increment ?? 2.5]} />
            <Stepper label={edit.seconds !== undefined ? '유지 시간' : '반복수'} value={r} onChange={setR} steps={[1]} decimal={false} />
            <RpePicker value={rpe} onChange={setRpe} />
          </div>
        </Sheet>
      )}
    </div>
  );
};
