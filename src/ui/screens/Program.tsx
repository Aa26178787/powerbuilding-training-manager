// 프로그램 조회·편집. 저장하면 새 버전이 만들어지고 과거 세션의 처방·기록은 바뀌지 않는다.
import { useState } from 'react';
import type { Exercise, PrescriptionTemplate, ProgramDayTemplate, SetGroupSpec } from '../../domain/types';
import { saveProgramVersion, versionForWeek } from '../../application/plan';
import { addDays, fmtDateKo, weekStart, WEEKDAY_KO } from '../../engine/dates';
import { run, toast, todayStr, useApp } from '../store';
import { Badge, Btn, cx, Empty, SectionTitle, Sheet } from '../components';

const num = (v: string, fallback: number) => (v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

const GroupEditor = ({ g, onChange }: { g: SetGroupSpec; onChange: (g: SetGroupSpec) => void }) => {
  const range = g.repMin !== undefined;
  const F = ({ label, value, on }: { label: string; value: number | undefined; on: (n: number) => void }) => (
    <label className="text-[11px] text-dust">{label}
      <input className="field num mt-0.5 px-1 text-center" type="number" inputMode="decimal" step="any" value={value ?? ''} onChange={(e) => on(num(e.target.value, value ?? 0))} />
    </label>
  );
  return (
    <div className="mt-1.5">
      <div className="mb-1 text-xs font-semibold">{g.type === 'top' ? 'Top Set' : g.type === 'backoff' ? 'Backoff' : g.type === 'straight' ? 'Straight Sets' : '작업 세트'}</div>
      <div className="grid grid-cols-5 gap-1.5">
        <F label="세트" value={g.count} on={(n) => onChange({ ...g, count: Math.round(n) })} />
        {range ? <><F label="최소 회" value={g.repMin} on={(n) => onChange({ ...g, repMin: Math.round(n) })} /><F label="최대 회" value={g.repMax} on={(n) => onChange({ ...g, repMax: Math.round(n) })} /></>
          : <F label="반복" value={g.reps} on={(n) => onChange({ ...g, reps: Math.round(n) })} />}
        <F label="목표 RPE" value={g.targetRpe} on={(n) => onChange({ ...g, targetRpe: n, targetRpeMin: undefined, targetRpeMax: undefined })} />
        <F label="상한" value={g.rpeCap} on={(n) => onChange({ ...g, rpeCap: n })} />
      </div>
    </div>
  );
};

const describe = (it: PrescriptionTemplate) => it.groups.map((g) => `${g.type === 'top' ? 'Top ' : g.type === 'backoff' ? 'Backoff ' : ''}${g.count}×${g.reps ?? `${g.repMin}~${g.repMax}`}`).join(' + ');

export const ProgramScreen = () => {
  const { db } = useApp();
  const today = todayStr();
  const current = db ? versionForWeek(db, weekStart(db.settings.programStart && db.settings.programStart > today ? db.settings.programStart : today)) : null;
  const latest = db ? Object.values(db.versions).sort((a, b) => b.version - a.version)[0] : null;
  const [draft, setDraft] = useState<ProgramDayTemplate[] | null>(null);
  const [wd, setWd] = useState(1);
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [newEx, setNewEx] = useState({ name: '', increment: '2.5', sets: '3', repMin: '8', repMax: '12' });
  if (!db || !latest) return null;
  const days = draft ?? latest.days;
  const day = days.find((d) => d.weekday === wd);
  const edit = (fn: (d: ProgramDayTemplate[]) => void) => { const next = structuredClone(days); fn(next); setDraft(next); };
  const dayOf = (d: ProgramDayTemplate[]) => {
    let x = d.find((q) => q.weekday === wd);
    if (!x) { x = { weekday: wd, label: WEEKDAY_KO[wd], items: [] }; d.push(x); d.sort((a, b) => a.weekday - b.weekday); }
    return x;
  };
  const started = db.settings.programStart && weekStart(db.settings.programStart) <= weekStart(today);
  const applyFrom = started ? addDays(weekStart(today), 7) : weekStart(db.settings.programStart ?? today);
  const save = async () => {
    if (!draft) return;
    const r = await run((d, ctx) => saveProgramVersion(d, draft, note, ctx));
    if (r.ok) { setDraft(null); setNote(''); toast(`새 버전을 저장했습니다. ${fmtDateKo(applyFrom)} 주부터 적용됩니다`); }
  };
  const addExisting = (ex: Exercise) => {
    edit((d) => dayOf(d).items.push({
      id: `c_${wd}_${Date.now().toString(36)}`, exerciseId: ex.id, model: 'double_progression', required: false, dpCriterion: 'all_sets',
      groups: [{ type: 'volume', count: 3, repMin: 8, repMax: 12, targetRpe: 7.5, rpeCap: 8 }],
    }));
    setAdding(false);
  };
  const createAndAdd = async () => {
    const name = newEx.name.trim();
    if (!name) return;
    const ex: Exercise = { id: `custom_${Date.now().toString(36)}`, name: name.slice(0, 60), role: 'accessory', pattern: 'other', increment: num(newEx.increment, 2.5), rounding: 'down', loadMode: 'external', barbell: false };
    if (!(ex.increment > 0)) { toast('증량 단위를 확인하세요', 'error'); return; }
    const r = await run(() => ({ put: { exercises: [ex] } }));
    if (!r.ok) return;
    edit((d) => dayOf(d).items.push({
      id: `c_${wd}_${Date.now().toString(36)}`, exerciseId: ex.id, model: 'double_progression', required: false, dpCriterion: 'all_sets',
      groups: [{ type: 'volume', count: num(newEx.sets, 3), repMin: num(newEx.repMin, 8), repMax: num(newEx.repMax, 12), targetRpe: 7.5, rpeCap: 8 }],
    }));
    setAdding(false);
  };

  return (
    <div>
      <header><h1 className="text-xl font-extrabold">프로그램</h1><p className="text-sm text-dust">{latest.name} · 버전 {latest.version}{current && current.id !== latest.id ? ` (이번 주는 버전 ${current.version} 적용 중)` : ''}</p></header>
      <div className="mt-3 flex gap-1" role="tablist" aria-label="요일">
        {[1, 2, 3, 4, 5, 6, 7].map((n) => (
          <button key={n} type="button" role="tab" aria-selected={wd === n} onClick={() => setWd(n)} className={cx('h-11 flex-1 rounded-lg border text-sm font-bold', wd === n ? 'border-p15 bg-p15/15' : 'border-rail text-dust')}>{WEEKDAY_KO[n]}</button>
        ))}
      </div>

      <div className="mt-3 space-y-2">
        {(!day || day.items.length === 0) && <Empty>이 요일은 휴식일입니다. 운동을 추가하면 훈련일이 됩니다.</Empty>}
        {day?.items.map((it, idx) => {
          const ex = db.exercises[it.exerciseId];
          return (
            <div key={it.id} className="rounded-xl bg-steel p-3">
              <div className="flex items-start justify-between gap-2">
                <div><div className="font-bold">{ex?.name ?? it.exerciseId}</div><div className="num text-xs text-dust">{describe(it)}{it.note ? ` · ${it.note}` : ''}</div></div>
                <div className="flex shrink-0 gap-1">{it.required && <Badge>필수</Badge>}<Badge tone="info">{it.model === 'top_backoff' ? 'Top+Backoff' : it.model === 'straight_linear' ? '선형 증량' : 'Double Progression'}</Badge></div>
              </div>
              <details>
                <summary className="tap flex cursor-pointer items-center text-xs text-dust">편집</summary>
                {it.groups.map((g, gi) => <GroupEditor key={gi} g={g} onChange={(ng) => edit((d) => { dayOf(d).items[idx].groups[gi] = ng; })} />)}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Btn disabled={idx === 0} onClick={() => edit((d) => { const a = dayOf(d).items; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; })}>위로</Btn>
                  <Btn disabled={idx === day.items.length - 1} onClick={() => edit((d) => { const a = dayOf(d).items; [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]]; })}>아래로</Btn>
                  <Btn onClick={() => edit((d) => { dayOf(d).items[idx].required = !it.required; })}>{it.required ? '선택 운동으로' : '필수로 지정'}</Btn>
                  <Btn kind="danger" onClick={() => edit((d) => { dayOf(d).items.splice(idx, 1); })}>이 요일에서 빼기</Btn>
                </div>
              </details>
            </div>
          );
        })}
        <Btn className="w-full" onClick={() => setAdding(true)}>{WEEKDAY_KO[wd]}요일에 운동 추가</Btn>
      </div>

      {draft && (
        <div className="sticky bottom-20 z-10 mt-4 rounded-xl border border-p15 bg-steel p-3 shadow-lg">
          <div className="text-sm font-bold">저장하지 않은 변경이 있습니다</div>
          <p className="mt-1 text-xs text-dust">{fmtDateKo(applyFrom)} 주부터 적용됩니다. {started ? '이번 주는 주 시작 시점의 계획을 유지하고, ' : ''}지난 세션의 처방과 기록은 바뀌지 않습니다. 이번 주 조정은 캘린더·오늘 화면의 이동·세트 추가·축소로 하세요.</p>
          <input className="field mt-2" placeholder="변경 메모(예: 로우 5→4세트)" maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="mt-2 flex gap-2"><Btn className="flex-1" onClick={() => setDraft(null)}>되돌리기</Btn><Btn kind="primary" className="flex-1" onClick={save}>새 버전으로 저장</Btn></div>
        </div>
      )}

      <SectionTitle>버전 이력</SectionTitle>
      <ul className="divide-y divide-rail rounded-xl bg-steel px-3">
        {Object.values(db.versions).sort((a, b) => b.version - a.version).map((v) => (
          <li key={v.id} className="num flex min-h-[44px] items-center justify-between gap-2 py-1.5 text-sm">
            <span>버전 {v.version}{v.changeNote ? ` — ${v.changeNote}` : ''}</span>
            <span className="text-xs text-dust">{v.effectiveFrom < '2001' ? '처음부터' : `${fmtDateKo(v.effectiveFrom)} 주부터`}</span>
          </li>
        ))}
      </ul>

      {adding && (
        <Sheet title={`${WEEKDAY_KO[wd]}요일에 운동 추가`} onClose={() => setAdding(false)}>
          <div className="text-xs font-bold text-dust">기존 운동에서 선택</div>
          <div className="mt-1 max-h-56 divide-y divide-rail overflow-y-auto rounded-lg border border-rail">
            {Object.values(db.exercises).filter((e) => e.role !== 'arm' && !e.archived).map((e) => (
              <button key={e.id} type="button" className="tap flex w-full items-center px-3 text-left text-sm" onClick={() => addExisting(e)}>{e.name}</button>
            ))}
          </div>
          <div className="mt-4 text-xs font-bold text-dust">새 운동 만들기</div>
          <input className="field mt-1" placeholder="운동 이름" maxLength={60} value={newEx.name} onChange={(e) => setNewEx({ ...newEx, name: e.target.value })} />
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {([['increment', '증량 kg'], ['sets', '세트'], ['repMin', '최소 회'], ['repMax', '최대 회']] as const).map(([k, l]) => (
              <label key={k} className="text-[11px] text-dust">{l}<input className="field num mt-0.5 px-1 text-center" type="number" inputMode="decimal" value={newEx[k]} onChange={(e) => setNewEx({ ...newEx, [k]: e.target.value })} /></label>
            ))}
          </div>
          <Btn kind="primary" className="mt-3 w-full" disabled={!newEx.name.trim()} onClick={createAndAdd}>만들어서 추가</Btn>
        </Sheet>
      )}
    </div>
  );
};
