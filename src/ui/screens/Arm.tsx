// ARM SYSTEM: 데이터 가져오기, Day 배정(수동 승인 진행), 처방 라이브러리·교정, 영상 링크
import { useState } from 'react';
import type { ArmPrescription, Db, ISODate } from '../../domain/types';
import { isArmOverlapExercise } from '../../domain/defaults';
import { addDays, fmtDateKo, weekdayOf, WEEKDAY_KO } from '../../engine/dates';
import { STATUS_LABEL } from '../../engine/status';
import { armDayList, assignArmDay, assignArmDays, suggestArmDates, clearArmOverride, effectiveArm, saveArmOverride, saveArmVideoLink, unassignArmDay } from '../../application/arm';
import { workoutStatuses } from '../../application/selectors';
import { ArmImportResult, parseArmJson } from '../../data-import/armImport';
import { ask, ensureWeeksFor, run, toast, todayStr, useApp } from '../store';
import { Badge, Btn, cx, Empty, Row, SectionTitle, Sheet } from '../components';

const volText = (p: ArmPrescription) => (p.sets === null || (p.reps === null && p.duration_seconds === null) ? '세트·반복 누락' : `${p.duration_seconds !== null ? `${p.duration_seconds}초` : `${p.reps}회`} × ${p.sets}세트`);
const intText = (p: ArmPrescription) => [p.percent_1rm !== null ? `${p.percent_1rm}%` : '', p.rpe_range ? `RPE ${p.rpe_range[0]}~${p.rpe_range[1]}` : p.rpe !== null ? `RPE ${p.rpe}` : ''].filter(Boolean).join(' ') || 'RPE 누락';
const GUIDE_KO: Record<string, string> = {
  load_methods: '강도 표기 방식', order: '블록 순서', joint_pain_adjustment: '인대·관절 통증 시', high_workload_option: '작업량이 과할 때',
  'rest_between_sets.RPE_9_to_10': '세트 간 휴식 (RPE 9~10)', 'rest_between_sets.RPE_6_to_8': '세트 간 휴식 (RPE 6~8)', 'rest_between_sets.basic_compounds': '세트 간 휴식 (복합 운동)', warmup: '워밍업',
};
const VERIFY_KO: Record<string, string> = { verified_visual: '원본 확인', dual_ocr_match: 'OCR 2회 일치', ocr_resolved: 'OCR 교차 판독', source_missing: '원본 누락', manually_checked: '원본 확인', ocr_parsed_unverified: 'OCR 미검증', needs_review: '검토 필요' };

const Importer = ({ hasData }: { hasData: boolean }) => {
  const [res, setRes] = useState<ArmImportResult | null>(null);
  const [name, setName] = useState('');
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setName(f.name);
    if (f.size > 5 * 1024 * 1024) { setRes({ ok: false, errors: ['파일이 너무 큽니다(최대 5MB)'], warnings: [] }); return; }
    setRes(parseArmJson(await f.text(), new Date().toISOString()));
  };
  return (
    <div className="rounded-xl bg-steel p-3">
      <p className="text-sm">구매한 ARM SYSTEM의 추출 JSON 파일을 이 기기에서 직접 선택합니다. 파일은 이 브라우저 안에만 저장되고 앱 배포본에는 포함되지 않습니다.</p>
      <label className="mt-3 block">
        <span className="tap inline-flex cursor-pointer items-center press rounded-lg bg-deck px-4 text-sm font-semibold">{hasData ? '다른 JSON으로 교체' : 'ARM JSON 파일 선택'}</span>
        <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      {res && (
        <div className="mt-3 rounded-lg bg-deck p-3 text-sm">
          <div className="font-bold break-all">{name}</div>
          {!res.ok && <ul className="mt-1 list-disc pl-5 text-p25">{res.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          {res.ok && res.summary && (
            <>
              <div className="num mt-1 text-dust">{res.summary.blocks.join(' → ')}, {res.summary.days}일, 처방 {res.summary.total}개 (활성 {res.summary.active}, 중복 제외 {res.summary.excluded})</div>
              {res.warnings.map((w, i) => <div key={i} className="mt-1 text-p15">주의: {w}</div>)}
              <Btn kind="primary" className="mt-3 w-full" onClick={async () => { const r = await run(() => ({ arm: res.data })); if (r.ok) { toast('ARM 데이터를 가져왔습니다'); setRes(null); } }}>이 데이터 가져오기</Btn>
            </>
          )}
        </div>
      )}
    </div>
  );
};

const OverrideSheet = ({ db, p, onClose }: { db: Db; p: ArmPrescription; onClose: () => void }) => {
  const eff = effectiveArm(p, db.armOverrides[p.id]);
  const [v, setV] = useState({ sets: eff.sets?.toString() ?? '', reps: eff.reps?.toString() ?? '', secs: eff.duration_seconds?.toString() ?? '', rpe: eff.rpe?.toString() ?? '' });
  const n = (s: string) => (s === '' ? null : Number(s));
  return (
    <Sheet title={`${p.exercise} 교정`} onClose={onClose} footer={
      <div className="flex gap-2">
        {db.armOverrides[p.id] && <Btn kind="danger" onClick={async () => { const r = await run(() => clearArmOverride(p.id)); if (r.ok) onClose(); }}>교정 취소</Btn>}
        <Btn kind="primary" className="flex-1" onClick={async () => {
          const r = await run((_, ctx) => saveArmOverride(db, { id: p.id, sets: n(v.sets), reps: n(v.reps), duration_seconds: n(v.secs), rpe: n(v.rpe), verifiedBy: 'user', sourcePage: p.source_page }, ctx));
          if (r.ok) { toast('교정값을 저장했습니다(이후 배정하는 Day부터 적용)'); onClose(); }
        }}>교정값 저장</Btn>
      </div>}>
      <p className="text-sm">PDF {p.source_page}쪽을 직접 확인한 값만 입력하세요. 추출 원문은 그대로 보존되고 교정값은 따로 저장됩니다.</p>
      <div className="mt-2 rounded-lg bg-deck p-2.5 text-sm"><span className="text-dust">추출 원문: </span>{p.prescription_source}</div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {([['sets', '세트'], ['reps', '반복'], ['secs', '초'], ['rpe', 'RPE']] as const).map(([k, l]) => (
          <label key={k} className="text-xs text-dust">{l}<input className="field num mt-1 px-1 text-center" type="number" inputMode="decimal" step="any" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></label>
        ))}
      </div>
      <p className="mt-2 text-xs text-dust">PDF 표기는 "반복 × 세트"입니다. 예: 6x3 = 6회 × 3세트.</p>
    </Sheet>
  );
};

export const ArmScreen = ({ go }: { go: (tab: string, date?: ISODate) => void }) => {
  const { db } = useApp();
  const today = todayStr();
  const [date, setDate] = useState<ISODate | ''>('');
  const [ack, setAck] = useState(false);
  const [block, setBlock] = useState('');
  const [week, setWeek] = useState(0);
  const [showExcluded, setShowExcluded] = useState(false);
  const [ov, setOv] = useState<ArmPrescription | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  if (!db) return null;
  if (!db.arm) {
    return (
      <div>
        <header><h1 className="text-lg font-extrabold">ARM</h1></header>
        <div className="mt-3"><Importer hasData={false} /></div>
      </div>
    );
  }
  const arm = db.arm;
  const days = armDayList(arm);
  const next = days[db.settings.armCursor];
  const statuses = workoutStatuses(db, today);
  const armWorkouts = Object.values(db.workouts).filter((w) => w.track === 'arm').sort((a, b) => (b.arm?.dayIndex ?? 0) - (a.arm?.dayIndex ?? 0));
  const assignedDates = new Set(Object.values(db.plannedSets).filter((s) => s.track === 'arm' && s.status === 'planned').map((s) => s.plannedDate));
  const prefer = db.settings.armMode === 3 ? db.settings.armWeekdays3 : db.settings.armWeekdays2;
  let suggest = today;
  for (let i = 0; i < 14; i += 1) { const d = addDays(today, i); if (prefer.includes(weekdayOf(d)) && !assignedDates.has(d)) { suggest = d; break; } }
  const target = date || suggest;
  // 새 주차로 넘어갈 때 이전 Day가 정리되지 않았으면 명시적 승인 요구
  const unfinished = armWorkouts.filter((w) => ['planned', 'in_progress', 'overdue', 'rescheduled', 'merged'].includes(statuses.get(w.id) ?? ''));
  const crossesWeek = !!next && unfinished.some((w) => w.arm && (w.arm.block !== next.block || w.arm.week !== next.week));
  const selBlock = block || next?.block || arm.blockOrder[0];
  const weeks = [...new Set(arm.exercises.filter((e) => e.block === selBlock).map((e) => e.week))].sort((a, b) => a - b);
  const selWeek = week || (next?.block === selBlock ? next.week : weeks[0]);
  const lib = arm.exercises.filter((e) => e.block === selBlock && e.week === selWeek);
  const toggleWd = (n: number) => {
    const key = db.settings.armMode === 3 ? 'armWeekdays3' : 'armWeekdays2';
    const cur = db.settings[key];
    void run(() => ({ settings: { [key]: cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort() } }));
  };
  const assign = async () => {
    if (!next) return;
    ensureWeeksFor([target]);
    const r = await run((d, ctx) => assignArmDay(d, next.dayIndex, target, ctx));
    if (r.ok) { toast(`${fmtDateKo(target)}에 ${next.block} W${next.week} D${next.day} 배정`); setDate(''); setAck(false); }
  };
  const weekPlan = suggestArmDates(db, today);
  const assignWeek = async () => {
    if (crossesWeek && !(await ask(`이전 주차에 끝내지 않은 Day가 ${unfinished.length}개 있습니다. 그래도 다음 Day들을 배정할까요?`, '배정'))) return;
    ensureWeeksFor(weekPlan.map((x) => x.date));
    const r = await run((d, ctx) => assignArmDays(d, weekPlan.map((x) => ({ dayIndex: x.ref.dayIndex, date: x.date })), ctx));
    if (r.ok) toast(`${weekPlan.length}일을 한 번에 배정했습니다`);
  };
  const guide = Object.entries(arm.guidelines).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>).map(([k2, v2]) => [`${k}.${k2}`, String(v2)]) : [[k, Array.isArray(v) ? v.join(', ') : String(v)]]));

  return (
    <div>
      <header><h1 className="text-lg font-extrabold">ARM</h1><p className="num mt-0.5 text-[13px] text-dust">{arm.blockOrder.join(' → ')}</p><p className="num text-[13px] text-dust">전체 {days.length}일 중 {db.settings.armCursor}일 배정</p></header>

      <SectionTitle>다음 Day 배정</SectionTitle>
      <div className="rounded-xl bg-steel p-3">
        {next && weekPlan.length > 1 && (
          <div className="mb-4 border-b border-rail pb-4">
            <div className="text-sm font-bold">한 주 한 번에 배정</div>
            <ul className="num mt-1 space-y-0.5 text-sm">
              {weekPlan.map((x) => <li key={x.date} className="flex justify-between"><span>{x.ref.block} W{x.ref.week} D{x.ref.day}</span><span className="text-dust">{fmtDateKo(x.date)}</span></li>)}
            </ul>
            <Btn kind="primary" className="mt-2 w-full" onClick={assignWeek}>{weekPlan.length}일 한 번에 배정</Btn>
            <p className="mt-1 text-xs text-dust">기본 요일(아래 운영 방식)에 맞춰 놓습니다. 오늘 화면에서도 ARM 요일이면 버튼 한 번으로 그날 Day를 추가할 수 있습니다.</p>
          </div>
        )}
        {next ? (
          <>
            <div className="text-lg font-extrabold">{next.block} <span className="num">Week {next.week} Day {next.day}</span></div>
            <p className="mt-1 text-xs text-dust">달력이 넘어가도 주차가 자동으로 올라가지 않습니다. 직접 배정할 때만 다음 Day로 진행하며, 배정 시점의 처방이 그대로 기록됩니다.</p>
            <label className="mt-3 block text-xs text-dust">수행할 날짜
              <input className="field num mt-1" type="date" value={target} onChange={(e) => setDate(e.target.value)} />
            </label>
            {crossesWeek && (
              <label className="mt-2 flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-p15/60 px-3 text-sm">
                <input type="checkbox" className="h-5 w-5 accent-[var(--color-p15)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                이전 주차에 끝내지 않은 Day가 {unfinished.length}개 있습니다. 그래도 다음 주차로 진행합니다
              </label>
            )}
            <Btn kind="primary" className="mt-3 w-full" disabled={crossesWeek && !ack} onClick={assign}>{fmtDateKo(target)}에 배정</Btn>
            <Btn kind="quiet" className="mt-1 w-full" onClick={async () => { if (await ask(`${next.block} W${next.week} D${next.day}는 배정하지 않고 건너뜁니다.`, '건너뛰기')) void run(() => ({ settings: { armCursor: db.settings.armCursor + 1 } })); }}>이 Day 건너뛰기</Btn>
          </>
        ) : <p className="text-sm">모든 ARM Day를 배정했습니다.</p>}
        {db.settings.armCursor > 0 && !db.workouts[`arm:${db.settings.armCursor - 1}`] && (
          <Btn kind="quiet" className="w-full" onClick={() => void run(() => ({ settings: { armCursor: db.settings.armCursor - 1 } }))}>건너뛴 Day로 되돌아가기</Btn>
        )}
      </div>

      <SectionTitle>운영 방식</SectionTitle>
      <div className="rounded-xl bg-steel px-3 py-1">
        <Row label="주간 횟수">
          <div className="flex gap-1">{([3, 2] as const).map((m) => <button key={m} type="button" aria-pressed={db.settings.armMode === m} onClick={() => void run(() => ({ settings: { armMode: m } }))} className={cx('h-10 rounded-lg border px-3 font-semibold', db.settings.armMode === m ? 'border-p15 bg-p15/15' : 'border-rail text-dust')}>주 {m}일</button>)}</div>
        </Row>
        <Row label="기본 요일">
          <div className="flex gap-1">{[1, 2, 3, 4, 5, 6, 7].map((n) => <button key={n} type="button" aria-pressed={prefer.includes(n)} onClick={() => toggleWd(n)} className={cx('h-10 w-9 rounded-lg border text-sm', prefer.includes(n) ? 'border-p15 bg-p15/15 font-bold' : 'border-rail text-dust')}>{WEEKDAY_KO[n]}</button>)}</div>
        </Row>
        <Row label="팔 기록">
          <div className="flex gap-1">{(['separate', 'both'] as const).map((m) => <button key={m} type="button" aria-pressed={db.settings.armSideMode === m} onClick={() => void run(() => ({ settings: { armSideMode: m } }))} className={cx('h-10 rounded-lg border px-3 text-sm font-semibold', db.settings.armSideMode === m ? 'border-p15 bg-p15/15' : 'border-rail text-dust')}>{m === 'separate' ? '좌·우 따로' : '한 번에'}</button>)}</div>
        </Row>
        {db.settings.armMode === 2 && <p className="pb-2 text-xs text-dust">주 2일 모드에서도 운동을 지우거나 처방을 합치지 않습니다. Day를 순서대로 주 2회 배정하고, 넘길 Day가 있으면 위에서 직접 건너뛰세요.</p>}
      </div>

      <SectionTitle>배정한 Day</SectionTitle>
      {armWorkouts.length === 0 ? <Empty>아직 배정한 Day가 없습니다.</Empty> : (
        <ul className="divide-y divide-rail rounded-xl bg-steel px-3">
          {armWorkouts.slice(0, 9).map((w) => {
            const st = statuses.get(w.id) ?? 'planned';
            const d = Object.values(db.plannedSets).find((s) => s.workoutId === w.id && s.status !== 'removed')?.plannedDate ?? w.originalDate;
            return (
              <li key={w.id} className="flex min-h-[52px] items-center justify-between gap-2 py-1.5 text-sm">
                <button type="button" className="text-left" onClick={() => go('day', d)}><div>{w.label.replace('ARM · ', '')}</div><div className="num text-xs text-dust">{fmtDateKo(d)}{d !== w.originalDate ? ` (원래 ${fmtDateKo(w.originalDate)})` : ''}</div></button>
                <span className="flex items-center gap-1.5"><Badge tone={st === 'completed' ? 'ok' : st === 'overdue' ? 'bad' : 'mute'}>{STATUS_LABEL[st]}</Badge>
                  {st === 'planned' && <Btn onClick={() => void run((x) => unassignArmDay(x, w.id))}>배정 취소</Btn>}</span>
              </li>
            );
          })}
        </ul>
      )}

      <SectionTitle right={<label className="flex items-center gap-1.5 text-xs text-dust"><input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} />제외 항목 보기</label>}>처방 라이브러리</SectionTitle>
      <div className="flex gap-2">
        <select className="field flex-1" value={selBlock} onChange={(e) => { setBlock(e.target.value); setWeek(0); }} aria-label="블록">{arm.blockOrder.map((b) => <option key={b}>{b}</option>)}</select>
        <select className="field num w-28" value={selWeek} onChange={(e) => setWeek(Number(e.target.value))} aria-label="주차">{weeks.map((w) => <option key={w} value={w}>Week {w}</option>)}</select>
      </div>
      {[...new Set(lib.map((e) => e.day))].sort().map((d) => (
        <div key={d} className="mt-3 rounded-xl bg-steel p-3">
          <div className="num mb-1 text-sm font-bold">Day {d} <span className="font-normal text-dust">PDF {lib.find((e) => e.day === d)?.source_page}쪽</span></div>
          <ul className="divide-y divide-rail">
            {lib.filter((e) => e.day === d).sort((a, b) => a.order - b.order).map((raw) => {
              const excluded = isArmOverlapExercise(raw.exercise);
              if (excluded && !showExcluded) return null;
              const p = effectiveArm(raw, db.armOverrides[raw.id]);
              return (
                <li key={p.id}>
                  <button type="button" className={cx('w-full py-2 text-left', excluded && 'opacity-55')} onClick={() => setOv(raw)}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-semibold">{p.order}. {p.exercise}{p.load_note ? ` (${p.load_note})` : ''}</div>
                      <div className="num shrink-0 text-right text-sm">{volText(p)}<div className="text-xs text-dust">{intText(p)}</div></div>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {p.rom && <Badge tone="info">{p.rom}</Badge>}
                      {p.execution.map((e) => <Badge key={e} tone="info">{e}</Badge>)}
                      {excluded && <Badge>본 프로그램과 겹쳐 제외</Badge>}
                      {p.source_missing.length > 0 && !excluded && <Badge tone="bad">원본 누락, 직접 입력 필요</Badge>}
                      {db.armOverrides[p.id] && <Badge tone="warn">교정됨</Badge>}
                      {p.verification_status !== 'verified_visual' && p.verification_status !== 'dual_ocr_match' && p.verification_status !== 'manually_checked' && p.verification_status !== 'source_missing' && <Badge>{VERIFY_KO[p.verification_status] ?? p.verification_status}</Badge>}
                    </div>
                    <div className="mt-1 text-xs text-dust">원문: {p.prescription_source}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <SectionTitle>운동 영상 링크</SectionTitle>
      <div className="rounded-xl bg-steel p-3">
        <p className="text-xs text-dust">PDF에는 영상 메뉴 제목만 있고 주소가 없습니다. 가지고 있는 Video Library 주소를 직접 등록하세요(HTTPS만 허용, 이 기기에만 저장).</p>
        <ul className="mt-2 space-y-2">
          {arm.videoLibrary.map((c) => {
            const cur = links[c.id] ?? db.armLinks[c.id]?.url ?? '';
            return (
              <li key={c.id}>
                <label className="text-xs text-dust">{c.title}
                  <div className="mt-1 flex gap-1.5">
                    <input className="field min-w-0 flex-1 text-sm" type="url" inputMode="url" placeholder="https://" value={cur} onChange={(e) => setLinks({ ...links, [c.id]: e.target.value })} />
                    <Btn disabled={links[c.id] === undefined} onClick={async () => { const r = await run((_, ctx) => saveArmVideoLink(c.id, cur, ctx)); if (r.ok) { const n = { ...links }; delete n[c.id]; setLinks(n); toast(cur.trim() ? '링크를 저장했습니다' : '링크를 지웠습니다'); } }}>저장</Btn>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      {guide.length > 0 && (
        <>
          <SectionTitle>프로그램 가이드 (원본 PDF 명시사항)</SectionTitle>
          <dl className="rounded-xl bg-steel px-3 py-1 text-sm">
            {guide.map(([k, v]) => <div key={k} className="flex justify-between gap-3 py-1.5"><dt className="shrink-0 text-dust">{GUIDE_KO[k] ?? k}</dt><dd className="text-right">{v}</dd></div>)}
          </dl>
          <p className="mt-1 text-xs text-dust">ARM은 PDF의 RPE를 그대로 따릅니다(RPE 9~9.5 포함). 일반 운동의 상한 @8을 적용하지 않으며, 통증·피로가 있으면 직접 낮춰서 수행하세요.</p>
        </>
      )}

      <SectionTitle>데이터</SectionTitle>
      <Importer hasData />
      <Btn kind="danger" className="mt-2 w-full" onClick={async () => { if (await ask('이 기기에 저장된 ARM 처방 라이브러리를 지웁니다. 이미 배정한 Day와 수행 기록은 남습니다.', '라이브러리 지우기')) void run(() => ({ arm: null })); }}>ARM 처방 라이브러리 지우기</Btn>
      {ov && <OverrideSheet db={db} p={ov} onClose={() => setOv(null)} />}
    </div>
  );
};
