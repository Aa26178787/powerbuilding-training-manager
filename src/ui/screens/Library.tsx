// 운동 라이브러리: Category → Slot → Exercise 탐색, 검색, 즐겨찾기, 운동·슬롯 추가와 수정
import { useState } from 'react';
import { Search, Star } from 'lucide-react';
import type { Db, EquipmentType, Exercise } from '../../domain/types';
import { allSlots, CATEGORIES, EQUIPMENT_NAMES, MUSCLE_NAMES, muscleName } from '../../domain/slots';
import { musclesOf } from '../../domain/defaults';
import { saveExercise, searchExercises, toggleFavorite, ExerciseDraft } from '../../application/library';
import { addCustomSlot } from '../../application/slots';
import { run, toast, useApp } from '../store';
import { Badge, Btn, Chip, cx, Empty, SectionTitle, Sheet } from '../components';

const draftOf = (db: Db, e?: Exercise, slotId?: string): ExerciseDraft => {
  const w = e ? musclesOf(e) : {};
  const slot = allSlots(db).find((s) => s.id === (slotId ?? e?.slotIds?.[0]));
  return {
    id: e?.id, name: e?.name ?? '', category: e?.category ?? slot?.categoryId ?? 'chest', slotId: slot?.id ?? null,
    equipment: e?.equipment ?? 'machine', increment: e?.increment ?? 2.5, loadStep: e?.loadStep, repRange: e?.repRange,
    primaryMuscles: e?.primaryMuscles ?? Object.entries(w).filter(([, v]) => v >= 1).map(([m]) => m),
    secondaryMuscles: e?.secondaryMuscles ?? Object.entries(w).filter(([, v]) => v < 1).map(([m]) => m),
    unilateral: !!e?.unilateral, barWeight: e?.barWeight, pause: e?.pause,
  };
};

const MuscleChips = ({ value, other, onChange, label }: { value: string[]; other: string[]; onChange: (v: string[]) => void; label: string }) => (
  <fieldset className="mt-3">
    <legend className="text-[12px] text-dust">{label}</legend>
    <div className="mt-1 flex flex-wrap gap-1.5">
      {MUSCLE_NAMES.filter(([id]) => !other.includes(id)).map(([id, name]) => (
        <Chip key={id} aria-pressed={value.includes(id)} className={cx(value.includes(id) && '!bg-chalk !text-iron')} onClick={() => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])}>{name}</Chip>
      ))}
    </div>
  </fieldset>
);

const ExerciseForm = ({ db, init, onClose }: { db: Db; init: ExerciseDraft; onClose: () => void }) => {
  const [d, setD] = useState<ExerciseDraft>(init);
  const fixed = !!(init.id && db.exercises[init.id]?.fixed);
  const slots = allSlots(db).filter((s) => s.categoryId === d.category);
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const save = async () => {
    const r = await run((x, ctx) => saveExercise(x, d, ctx));
    if (r.ok) { toast(init.id ? '운동을 고쳤습니다' : '운동을 추가했습니다'); onClose(); }
  };
  return (
    <Sheet title={init.id ? init.name : '운동 추가'} onClose={onClose} footer={<Btn kind="primary" className="w-full" disabled={!d.name.trim() || !d.primaryMuscles.length} onClick={save}>{init.id ? '저장' : '추가'}</Btn>}>
      {fixed && <p className="mb-2 text-[12.5px] leading-[1.45] text-dust">V1.9 고정 운동입니다. 처방과 진행 방식은 프로그램에서 정하고, 여기서는 이름·장비·근육 정보만 고칩니다.</p>}
      <label className="block text-[12px] text-dust">운동명<input className="field mt-1" maxLength={60} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-[12px] text-dust">Category
          <select className="field mt-1 w-full" value={d.category} disabled={fixed} onChange={(e) => setD({ ...d, category: e.target.value, slotId: null })}>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-[12px] text-dust">Slot
          <select className="field mt-1 w-full" value={d.slotId ?? ''} disabled={fixed} onChange={(e) => setD({ ...d, slotId: e.target.value || null })}>
            <option value="">없음</option>
            {slots.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-[12px] text-dust">장비 유형
          <select className="field mt-1 w-full" value={d.equipment} onChange={(e) => setD({ ...d, equipment: e.target.value as EquipmentType })}>
            {Object.entries(EQUIPMENT_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="text-[12px] text-dust">증량 kg
          <input className="field num mt-1" type="number" inputMode="decimal" step="any" value={d.increment} onChange={(e) => setD({ ...d, increment: Number(e.target.value) })} />
        </label>
        <label className="text-[12px] text-dust">사용 가능한 중량 단위 kg
          <input className="field num mt-1" type="number" inputMode="decimal" step="any" placeholder="증량과 같음" value={d.loadStep ?? ''} onChange={(e) => setD({ ...d, loadStep: num(e.target.value) })} />
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          <label className="text-[12px] text-dust">권장 최소 회<input className="field num mt-1" type="number" inputMode="numeric" value={d.repRange?.[0] ?? ''} onChange={(e) => { const a = num(e.target.value); setD({ ...d, repRange: a === undefined ? undefined : [a, d.repRange?.[1] ?? a] }); }} /></label>
          <label className="text-[12px] text-dust">최대 회<input className="field num mt-1" type="number" inputMode="numeric" value={d.repRange?.[1] ?? ''} onChange={(e) => { const b = num(e.target.value); setD({ ...d, repRange: b === undefined ? undefined : [d.repRange?.[0] ?? b, b] }); }} /></label>
        </div>
      </div>
      {d.equipment === 'barbell' && (
        <label className="mt-3 block text-[12px] text-dust">바 무게 kg
          <input className="field num mt-1" type="number" inputMode="decimal" step="any" placeholder={`설정값 ${db.settings.barWeight}kg`} value={d.barWeight ?? ''} onChange={(e) => setD({ ...d, barWeight: num(e.target.value) })} />
          <span className="mt-1 block">원판 그림과 추천 중량 단위를 이 무게와 가진 원판으로 계산합니다.</span>
        </label>
      )}
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5 accent-[var(--color-p15)]" checked={d.unilateral} onChange={(e) => setD({ ...d, unilateral: e.target.checked })} />좌·우 한쪽씩 하는 운동</label>
      <MuscleChips label="주요 근육군(가중치 1.0)" value={d.primaryMuscles} other={d.secondaryMuscles} onChange={(v) => setD({ ...d, primaryMuscles: v })} />
      <MuscleChips label="보조 근육군(가중치 0.5)" value={d.secondaryMuscles} other={d.primaryMuscles} onChange={(v) => setD({ ...d, secondaryMuscles: v })} />
      {d.pause && (
        <div className="mt-3 grid grid-cols-[1fr_88px] gap-2">
          <label className="text-[12px] text-dust">정지 위치<input className="field mt-1" maxLength={80} value={d.pause.position} onChange={(e) => setD({ ...d, pause: { ...d.pause!, position: e.target.value } })} /></label>
          <label className="text-[12px] text-dust">정지 초<input className="field num mt-1" type="number" inputMode="decimal" step="0.5" value={d.pause.seconds} onChange={(e) => setD({ ...d, pause: { ...d.pause!, seconds: Number(e.target.value) } })} /></label>
        </div>
      )}
    </Sheet>
  );
};

const SlotForm = ({ onClose }: { onClose: () => void }) => {
  const [name, setName] = useState(''); const [cat, setCat] = useState('chest'); const [desc, setDesc] = useState('');
  const save = async () => {
    const r = await run((x, ctx) => addCustomSlot(x, { name, categoryId: cat, description: desc.trim().slice(0, 60) }, ctx));
    if (r.ok) { toast('슬롯을 추가했습니다'); onClose(); }
  };
  return (
    <Sheet title="슬롯 추가" onClose={onClose} footer={<Btn kind="primary" className="w-full" disabled={!name.trim()} onClick={save}>추가</Btn>}>
      <label className="block text-[12px] text-dust">Slot 이름(영어 권장)<input className="field mt-1" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="mt-3 block text-[12px] text-dust">Category<select className="field mt-1 w-full" value={cat} onChange={(e) => setCat(e.target.value)}>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="mt-3 block text-[12px] text-dust">설명<input className="field mt-1" maxLength={60} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <p className="mt-2 text-[12px] text-dust">슬롯을 만들어도 프로그램 세트는 늘지 않습니다. 프로그램 편집에서 직접 넣어야 처방이 생깁니다.</p>
    </Sheet>
  );
};

export const LibraryScreen = () => {
  const { db } = useApp();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>('chest');
  const [form, setForm] = useState<ExerciseDraft | null>(null);
  const [slotForm, setSlotForm] = useState(false);
  if (!db) return null;
  const fav = new Set(db.settings.favorites ?? []);
  const slots = allSlots(db);
  const results = q.trim() ? searchExercises(db, q) : [];
  const Row = ({ e, badge = true }: { e: Exercise; badge?: boolean }) => (
    <li className="flex min-h-[52px] items-center gap-2">
      <button type="button" className="min-w-0 flex-1 py-1.5 text-left" onClick={() => setForm(draftOf(db, e))}>
        <span className="block truncate text-[14px] font-semibold">{e.name}</span>
        <span className="block truncate text-[12px] text-dust">{EQUIPMENT_NAMES[e.equipment ?? 'other']}{e.primaryMuscles?.length || Object.keys(musclesOf(e)).length ? `, ${Object.entries(musclesOf(e)).filter(([, w]) => w >= 1).map(([m]) => muscleName(m)).join(', ')}` : ''}</span>
      </button>
      {badge && e.fixed && <Badge>Fixed</Badge>}
      <button type="button" className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-lg" aria-pressed={fav.has(e.id)} aria-label={`${e.name} 즐겨찾기`} onClick={() => void run((d) => toggleFavorite(d, e.id))}>
        <Star size={18} aria-hidden className={fav.has(e.id) ? 'fill-chalk text-chalk' : 'text-knurl'} />
      </button>
    </li>
  );
  const exercisesIn = (slotId: string) => Object.values(db.exercises).filter((e) => !e.archived && (e.slotIds ?? []).includes(slotId)).sort((a, b) => Number(fav.has(b.id)) - Number(fav.has(a.id)) || a.name.localeCompare(b.name));
  const fixed = Object.values(db.exercises).filter((e) => e.fixed && !e.archived);
  return (
    <div>
      <header><h1 className="text-lg font-extrabold">운동 라이브러리</h1><p className="text-sm text-dust">슬롯은 훈련 목적, 운동은 실제로 하는 동작입니다. 운동마다 중량·진행이 따로 기록됩니다.</p></header>
      <label className="mt-3 flex h-11 items-center gap-2 rounded-xl bg-steel px-3">
        <Search size={16} aria-hidden className="text-dust" />
        <input className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-knurl" placeholder="운동·슬롯·근육 검색" value={q} onChange={(e) => setQ(e.target.value)} aria-label="운동 검색" />
      </label>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Btn onClick={() => setForm(draftOf(db))}>운동 추가</Btn>
        <Btn onClick={() => setSlotForm(true)}>슬롯 추가</Btn>
      </div>

      {q.trim() ? (
        <>
          <SectionTitle>검색 결과 {results.length}</SectionTitle>
          {results.length ? <ul className="divide-y divide-rail rounded-xl bg-steel px-3">{results.map((e) => <Row key={e.id} e={e} />)}</ul> : <Empty>찾는 운동이 없습니다. 운동 추가로 직접 등록하세요.</Empty>}
        </>
      ) : (
        <>
          {fav.size > 0 && (<><SectionTitle>즐겨찾기</SectionTitle><ul className="divide-y divide-rail rounded-xl bg-steel px-3">{[...fav].map((id) => db.exercises[id]).filter(Boolean).map((e) => <Row key={e.id} e={e} />)}</ul></>)}
          <SectionTitle>Fixed Exercise</SectionTitle>
          <ul className="divide-y divide-rail rounded-xl bg-steel px-3">{fixed.map((e) => <Row key={e.id} e={e} badge={false} />)}</ul>
          <SectionTitle>Category</SectionTitle>
          <div className="space-y-2">
            {CATEGORIES.map((c) => (
              <div key={c.id} className="rounded-xl bg-steel px-3">
                <button type="button" className="flex min-h-12 w-full items-center justify-between text-left font-bold" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
                  {c.name}<span className="text-[12px] font-normal text-dust">{slots.filter((s) => s.categoryId === c.id).length} slots</span>
                </button>
                {open === c.id && slots.filter((s) => s.categoryId === c.id).map((s) => {
                  const list = exercisesIn(s.id);
                  return (
                    <div key={s.id} className="border-t border-rail py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[14px] font-semibold">{s.name}</span>
                        <span className="text-[12px] text-dust">{s.group ? `${s.group}, ` : ''}{s.description}</span>
                      </div>
                      {list.length ? <ul className="divide-y divide-rail/60">{list.map((e) => <Row key={e.id} e={e} />)}</ul>
                        : <button type="button" className="mt-1 min-h-11 text-[13px] text-dust" onClick={() => setForm(draftOf(db, undefined, s.id))}>등록된 운동 없음. 추가하기</button>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
      {form && <ExerciseForm db={db} init={form} onClose={() => setForm(null)} />}
      {slotForm && <SlotForm onClose={() => setSlotForm(false)} />}
    </div>
  );
};
