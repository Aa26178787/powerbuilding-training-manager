// 설정·데이터: 프로필, 기준 기록, 증량 단위, 백업·복원, 저장소 상태
import { useEffect, useState } from 'react';
import type { Db, ExerciseState, ISODate, Patch } from '../../domain/types';
import { fmtDateKo, isISODate, weekStart } from '../../engine/dates';
import { DEFAULT_ROUNDING_POLICY, minBarbellStep, PlateStock, ROUND_KIND_KO, RoundKind } from '../../engine/rounding';
import { setSeed } from '../../application/session';
import { BackupCheck, buildBackup, parseBackup } from '../../data-import/backup';
import { performedCsv } from '../../application/analysis';
import { ask, isStandalone, promptInstall, requestPersist, restoreBackup, run, toast, todayStr, useApp, wipeAll } from '../store';
import { Minus, Plus, X } from 'lucide-react';
import { Badge, Btn, Chip, PLATE_COLOR, Row, SectionTitle } from '../components';

export const SEED_EXERCISES = ['comp_squat', 'comp_bench', 'comp_sumo', 'conv_dl', 'dips_strength', 'pullup_strength'];

export const SeedEditor = ({ db, exerciseId, compact }: { db: Db; exerciseId: string; compact?: boolean }) => {
  const ex = db.exercises[exerciseId];
  const seed = db.exStates[exerciseId]?.seed;
  const [v, setV] = useState({ w: seed?.weight?.toString() ?? '', r: seed?.reps?.toString() ?? '', p: seed?.rpe?.toString() ?? '' });
  if (!ex) return null;
  const dirty = v.w !== (seed?.weight?.toString() ?? '') || v.r !== (seed?.reps?.toString() ?? '') || v.p !== (seed?.rpe?.toString() ?? '');
  const save = async () => {
    const s: ExerciseState['seed'] = v.w === '' ? undefined : { weight: Number(v.w), reps: Number(v.r), rpe: Number(v.p), bodyweight: ex.loadMode === 'bodyweight_plus' ? db.settings.bodyweight ?? undefined : undefined };
    const r = await run((d, ctx) => setSeed(d, exerciseId, s, ctx));
    if (r.ok && !compact) toast('기준 기록을 저장했습니다');
  };
  return (
    <div className="py-2">
      <div className="mb-1 text-sm font-semibold">{ex.name}{ex.loadMode === 'bodyweight_plus' ? <span className="font-normal text-dust"> 추가 중량</span> : null}</div>
      <div className="flex items-end gap-1.5">
        {([['w', 'kg'], ['r', '회'], ['p', 'RPE']] as const).map(([k, l]) => (
          <label key={k} className="flex-1 text-[11px] text-dust">{l}<input className="field num mt-0.5 px-1 text-center" type="number" inputMode="decimal" step="any" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} onBlur={() => { if (compact && dirty && (v.w === '' || (v.r && v.p))) void save(); }} /></label>
        ))}
        {!compact && <Btn disabled={!dirty || (v.w !== '' && (!v.r || !v.p))} onClick={save}>저장</Btn>}
      </div>
    </div>
  );
};

/** 보유 원판: 종류별 쌍 수. 비우면 제한 없음, 0이면 쓰지 않음. 바꾸는 즉시 저장 */
const PlateStockEditor = ({ db }: { db: Db }) => {
  const s = db.settings;
  const stock: PlateStock[] = s.plateStock ?? s.plates.map((kg) => ({ kg, pairs: null }));
  const [kg, setKg] = useState('');
  const save = (next: PlateStock[]) => {
    const sorted = [...next].sort((a, b) => b.kg - a.kg);
    void run(() => ({ settings: { plateStock: sorted, plates: sorted.filter((p) => p.pairs !== 0).map((p) => p.kg) } }));
  };
  const setPairs = (i: number, pairs: number | null) => save(stock.map((p, j) => (j === i ? { ...p, pairs } : p)));
  const add = () => {
    const n = Number(kg);
    if (!(n > 0 && n <= 50)) { toast('원판 무게를 0보다 크고 50 이하로 입력하세요', 'error'); return; }
    if (stock.some((p) => p.kg === n)) { toast(`${n}kg 원판은 이미 있습니다`, 'error'); return; }
    save([...stock, { kg: n, pairs: 1 }]); setKg('');
  };
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm">보유 원판</span>
        <span className="num text-xs text-dust">바벨 최소 증량 {minBarbellStep(s.plates, s.plateStock)}kg</span>
      </div>
      <p className="mt-1 text-xs leading-[1.5] text-dust">쌍 수는 양쪽에 한 장씩 끼울 수 있는 수입니다. 비워 두면 제한 없이, 0이면 쓰지 않습니다. 계산은 가진 수량 안에서 목표에 가장 가까운 조합을 찾고, 큰 원판을 안쪽에 끼웁니다.</p>
      <ul className="mt-2 divide-y divide-rail/70">
        {stock.map((p, i) => (
          <li key={p.kg} className="flex min-h-[48px] items-center gap-3">
            <span aria-hidden className="h-6 w-2 shrink-0 rounded-sm" style={{ background: PLATE_COLOR[String(p.kg)] ?? '#6b7280', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.18)' }} />
            <span className={`num-d w-12 text-[17px] ${p.pairs === 0 ? 'text-knurl line-through' : ''}`}>{p.kg}kg</span>
            <span className="flex flex-1 items-center justify-end gap-1">
              <button type="button" className="press flex h-11 w-11 items-center justify-center rounded-lg bg-deck disabled:opacity-40" aria-label={`${p.kg}kg 한 쌍 빼기`} disabled={p.pairs === null || p.pairs === 0} onClick={() => setPairs(i, Math.max(0, (p.pairs ?? 0) - 1))}><Minus size={16} aria-hidden /></button>
              <input className="field num h-11 w-16 text-center" type="number" inputMode="numeric" min={0} max={20} aria-label={`${p.kg}kg 보유 쌍 수`} placeholder="제한 없음"
                value={p.pairs ?? ''} onChange={(e) => { const v = e.target.value; if (v === '') { setPairs(i, null); return; } const n = Math.floor(Number(v)); if (n >= 0 && n <= 20) setPairs(i, n); }} />
              <button type="button" className="press flex h-11 w-11 items-center justify-center rounded-lg bg-deck disabled:opacity-40" aria-label={`${p.kg}kg 한 쌍 더하기`} disabled={p.pairs !== null && p.pairs >= 20} onClick={() => setPairs(i, (p.pairs ?? 0) + 1)}><Plus size={16} aria-hidden /></button>
              <span className="w-4 text-xs text-dust">쌍</span>
              <button type="button" className="press flex h-11 w-11 items-center justify-center rounded-lg text-dust" aria-label={`${p.kg}kg 원판 목록에서 지우기`} onClick={() => save(stock.filter((_, j) => j !== i))}><X size={16} aria-hidden /></button>
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-1.5">
        <input className="field num flex-1" type="number" inputMode="decimal" placeholder="다른 무게 추가(kg), 예: 0.5" value={kg} onChange={(e) => setKg(e.target.value)} />
        <Chip className="!h-11 px-4" disabled={!kg} onClick={add}>추가</Chip>
      </div>
    </div>
  );
};

/** 서체 진단: 기기마다 웹 서체가 적용되는지 확인용. 결과를 화면에 그대로 보여 준다 */
const FontStatus = () => {
  const [rows, setRows] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    const probe = async () => {
      const tries = await Promise.allSettled([document.fonts.load('400 16px "PTM Sans"', '가1'), document.fonts.load('600 16px "Barlow Condensed"', '1')]);
      const faces = [...document.fonts].map((f) => `${f.family.replace(/"/g, '')} ${f.weight}: ${f.status === 'loaded' ? '불러옴' : f.status === 'error' ? '실패' : f.status === 'loading' ? '받는 중' : '아직 안 씀'}`);
      const ua = navigator.userAgent.match(/SamsungBrowser\/[\d.]+|Chrome\/[\d]+|Firefox\/[\d]+|Version\/[\d.]+ Mobile/)?.[0] ?? '알 수 없음';
      const out = [
        `브라우저 ${ua}`,
        `본문 서체 확인 ${document.fonts.check('16px "PTM Sans"', '가') ? '적용' : '미적용'}`,
        `숫자 서체 확인 ${document.fonts.check('600 16px "Barlow Condensed"', '1') ? '적용' : '미적용'}`,
        `불러오기 ${tries.map((t) => (t.status === 'fulfilled' ? `${t.value.length}개` : `오류 ${String(t.reason).slice(0, 40)}`)).join(', ')}`,
        `서비스 워커 ${navigator.serviceWorker?.controller ? '사용 중' : '없음'}`,
        ...faces,
      ];
      if (live) setRows(out);
    };
    void probe();
    return () => { live = false; };
  }, []);
  return (
    <details className="mt-3 text-[12px] text-dust">
      <summary className="press hit mx-auto flex h-9 w-fit cursor-pointer list-none items-center rounded-lg bg-deck px-3 font-semibold text-chalk/85 [&::-webkit-details-marker]:hidden">서체 상태 보기</summary>
      <ul className="num mt-2 space-y-0.5 text-center">{(rows ?? ['확인 중']).map((r) => <li key={r}>{r}</li>)}</ul>
    </details>
  );
};

const download = (name: string, text: string, type = 'application/json') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const MODES: ['nearest' | 'floor' | 'ceil', string][] = [['nearest', '가까운 쪽'], ['floor', '내림'], ['ceil', '올림']];

export const SettingsScreen = () => {
  const { db, persisted, canInstall, installed } = useApp();
  const [bw, setBw] = useState('');
  const [includeArm, setIncludeArm] = useState(false);
  const [check, setCheck] = useState<BackupCheck | null>(null);
  const [start, setStart] = useState('');
  if (!db) return null;
  const s = db.settings;
  const hasPbRecords = Object.values(db.performed).some((p) => !p.exerciseId.startsWith('arm:'));
  const exportNow = async () => {
    const now = new Date().toISOString();
    const text = JSON.stringify(buildBackup(db, includeArm, now));
    if (import.meta.env.VITE_PREVIEW) {
      try { await navigator.clipboard.writeText(text); toast('이 미리보기에서는 파일 저장이 막혀 있어 백업 내용을 클립보드에 복사했습니다'); } catch { toast('이 미리보기에서는 백업 파일을 내보낼 수 없습니다', 'error'); }
      return;
    }
    download(`ptm-backup-${todayStr()}${includeArm ? '-with-arm' : ''}.json`, text);
    await run(() => ({ settings: { lastBackupAt: now } }));
    toast(includeArm ? '백업 파일을 내보냈습니다. ARM 자료가 들어 있으니 공유·공개 업로드하지 마세요' : '백업 파일을 내보냈습니다');
  };
  const onImport = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 30 * 1024 * 1024) { setCheck({ ok: false, errors: ['파일이 너무 큽니다(최대 30MB)'] }); return; }
    setCheck(parseBackup(await f.text()));
  };
  const changeStart = async () => {
    if (!isISODate(start)) return;
    const del: Patch['del'] = {
      workouts: Object.values(db.workouts).filter((w) => w.track === 'pb').map((w) => w.id),
      instances: Object.values(db.instances).filter((i) => i.track === 'pb').map((i) => i.id),
      plannedSets: Object.values(db.plannedSets).filter((x) => x.track === 'pb').map((x) => x.id),
    };
    const versions = Object.values(db.versions).map((v) => (v.version === 1 ? { ...v, effectiveFrom: weekStart(start as ISODate) } : v));
    const r = await run(() => ({ del, put: { versions }, settings: { programStart: start as ISODate } }));
    if (r.ok) { toast(`프로그램 시작일을 ${fmtDateKo(start as ISODate)}로 바꿨습니다`); setStart(''); }
  };

  return (
    <div>
      <header><h1 className="text-lg font-extrabold">설정·데이터</h1></header>

      <SectionTitle>이 기기에서 쓰기</SectionTitle>
      <div className="rounded-xl bg-steel px-3 py-1">
        <Row label="홈 화면 설치">
          {installed || isStandalone() ? <Badge tone="ok">설치됨</Badge>
            : canInstall ? <Btn kind="primary" onClick={async () => { if (await promptInstall()) { toast('홈 화면에 설치했습니다'); void requestPersist(); } }}>설치</Btn>
            : <span className="text-xs text-dust">Chrome 메뉴(⋮)에서 홈 화면에 추가를 누르세요</span>}
        </Row>
        <Row label="세션 중 화면 켜 두기">
          <label className="-mr-2 flex h-11 w-11 items-center justify-center"><input type="checkbox" className="h-6 w-6 accent-[var(--color-p15)]" aria-label="세션 중 화면 켜 두기" checked={s.keepAwake} onChange={(e) => void run(() => ({ settings: { keepAwake: e.target.checked } }))} /></label>
        </Row>
        <Row label="휴식 타이머">
          <label className="-mr-2 flex h-11 w-11 items-center justify-center"><input type="checkbox" className="h-6 w-6 accent-[var(--color-p15)]" aria-label="휴식 타이머" checked={s.restTimer} onChange={(e) => void run(() => ({ settings: { restTimer: e.target.checked } }))} /></label>
        </Row>
        <Row label="세트 완료 진동">
          <label className="-mr-2 flex h-11 w-11 items-center justify-center"><input type="checkbox" className="h-6 w-6 accent-[var(--color-p15)]" aria-label="세트 완료 진동" checked={s.haptics} onChange={(e) => void run(() => ({ settings: { haptics: e.target.checked } }))} /></label>
        </Row>
        <p className="pb-2 text-xs text-dust">설치하면 주소창 없이 열리고, 브라우저가 기록을 지울 가능성이 줄어듭니다. 그래도 백업 파일은 주기적으로 내보내세요.</p>
      </div>

      <SectionTitle>백업·복원</SectionTitle>
      <div className="rounded-xl bg-steel p-3">
        <Row label="마지막 백업">{s.lastBackupAt ? new Date(s.lastBackupAt).toLocaleString('ko-KR', { timeZone: s.timezone }) : <Badge tone="warn">없음</Badge>}</Row>
        <Row label="브라우저 영구 저장">
          {persisted === true ? <Badge tone="ok">허용됨</Badge> : persisted === false ? <span className="flex items-center gap-2"><Badge tone="warn">허용 안 됨</Badge><Btn onClick={async () => toast((await requestPersist()) ? '영구 저장이 허용되었습니다' : '브라우저가 허용하지 않았습니다. 홈 화면에 앱을 추가하고 정기적으로 백업하세요')}>요청</Btn></span> : <Badge>이 브라우저는 지원하지 않음</Badge>}
        </Row>
        <p className="text-xs text-dust">기록은 이 기기의 브라우저에만 저장됩니다. 브라우저 데이터를 지우거나 오래 쓰지 않으면 사라질 수 있으니(특히 홈 화면에 추가하지 않은 iOS Safari) 백업 파일을 주기적으로 내보내세요.</p>
        <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-p15)]" checked={includeArm} disabled={!db.arm} onChange={(e) => setIncludeArm(e.target.checked)} />
          ARM 처방 라이브러리 포함 <span className="text-xs text-dust">(저작권 자료라 개인 보관용)</span>
        </label>
        <Btn kind="primary" className="w-full" onClick={exportNow}>백업 파일 내보내기</Btn>
        <Btn className="mt-2 w-full" onClick={async () => {
          const csv = performedCsv(db);
          if (import.meta.env.VITE_PREVIEW) { try { await navigator.clipboard.writeText(csv); toast('이 미리보기에서는 파일 저장이 막혀 있어 CSV 내용을 클립보드에 복사했습니다'); } catch { toast('이 미리보기에서는 CSV를 내보낼 수 없습니다', 'error'); } return; }
          download(`ptm-records-${todayStr()}.csv`, csv, 'text/csv;charset=utf-8'); toast('수행 기록 CSV를 내보냈습니다');
        }}>수행 기록 CSV 내보내기</Btn>
        <label className="mt-2 block">
          <span className="tap flex w-full cursor-pointer items-center justify-center press rounded-lg bg-deck px-4 text-sm font-semibold">백업 파일에서 복원</span>
          <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { void onImport(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {check && (
          <div className="mt-3 rounded-lg bg-deck p-3 text-sm">
            {!check.ok ? <ul className="list-disc pl-5 text-p25">{check.errors.map((e, i) => <li key={i}>{e}</li>)}</ul> : (
              <>
                <div className="font-bold">복원 미리보기</div>
                <div className="num mt-1 text-dust">내보낸 시각 {check.summary?.exportedAt.slice(0, 16).replace('T', ' ')}, 세션 {check.summary?.counts.sessions ?? 0} · 수행 세트 {check.summary?.counts.performed ?? 0} · 계획 세트 {check.summary?.counts.plannedSets ?? 0} · ARM {check.summary?.includesArm ? '포함' : '미포함'}</div>
                <p className="mt-2 text-p15">지금 이 기기의 모든 데이터가 이 파일 내용으로 바뀝니다.</p>
                <div className="mt-2 flex gap-2"><Btn className="flex-1" onClick={() => setCheck(null)}>취소</Btn><Btn kind="danger" className="flex-1" onClick={async () => { await restoreBackup(check.db as Db); setCheck(null); toast('백업에서 복원했습니다'); }}>이 파일로 복원</Btn></div>
              </>
            )}
          </div>
        )}
      </div>

      <SectionTitle>프로필</SectionTitle>
      <div className="rounded-xl bg-steel px-3 py-1">
        <Row label={`체중 (현재 ${s.bodyweight ?? '미입력'}kg)`}>
          <span className="flex gap-1.5"><input className="field num w-24 text-center" type="number" inputMode="decimal" value={bw} placeholder="kg" onChange={(e) => setBw(e.target.value)} /><Btn disabled={!bw} onClick={async () => { const n = Number(bw); if (!(n > 20 && n < 300)) { toast('체중 값을 확인하세요', 'error'); return; } const r = await run(() => ({ settings: { bodyweight: n } })); if (r.ok) setBw(''); }}>저장</Btn></span>
        </Row>
        <Row label="대회 날짜">
          <input className="field num w-40" type="date" aria-label="대회 날짜" value={s.meetDate === undefined ? '2026-11-29' : s.meetDate ?? ''} onChange={(e) => void run(() => ({ settings: { meetDate: e.target.value || null } }))} />
        </Row>
        <Row label="바 무게">
          <select className="field num w-24" value={s.barWeight} onChange={(e) => void run(() => ({ settings: { barWeight: Number(e.target.value) } }))}>{[20, 15, 10].map((n) => <option key={n} value={n}>{n}kg</option>)}</select>
        </Row>
        <PlateStockEditor db={db} />
        <Row label="화면 테마">
          <select className="field w-28" value={s.theme} onChange={(e) => void run(() => ({ settings: { theme: e.target.value as 'dark' | 'light' | 'system' } }))}><option value="dark">어둡게</option><option value="light">밝게</option><option value="system">기기 설정</option></select>
        </Row>
        <Row label="시간대">{s.timezone}</Row>
      </div>

      <SectionTitle>기준 기록</SectionTitle><p className="-mt-1 pb-2 text-xs text-dust">첫 중량 추천에 씁니다.</p>
      <div className="divide-y divide-rail rounded-xl bg-steel px-3">
        {SEED_EXERCISES.map((id) => <SeedEditor key={id} db={db} exerciseId={id} />)}
      </div>
      <p className="mt-1 text-xs text-dust">최근에 한 세트 하나(중량·반복·RPE)를 넣으면 보수적 e1RM으로 첫 Top Set을 제안합니다. 비워 두면 첫 세션에서 직접 입력합니다.</p>

      <SectionTitle>중량 반올림</SectionTitle><p className="-mt-1 pb-2 text-xs text-dust">계산은 끝까지 소수로 하고 마지막에 한 번만 반올림합니다.</p>
      <div className="divide-y divide-rail rounded-xl bg-steel px-3">
        {(Object.keys(DEFAULT_ROUNDING_POLICY) as RoundKind[]).map((k) => (
          <Row key={k} label={ROUND_KIND_KO[k]}>
            <select className="field w-28" value={s.roundingPolicy?.[k] ?? DEFAULT_ROUNDING_POLICY[k]} aria-label={`${ROUND_KIND_KO[k]} 반올림`} onChange={(ev) => void run(() => ({ settings: { roundingPolicy: { ...s.roundingPolicy, [k]: ev.target.value as 'nearest' | 'floor' | 'ceil' } } }))}>
              {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Row>
        ))}
        <Row label="Fast-track 최대 증가">
          <select className="field num w-28" value={s.fastTrackMaxPct ?? 0.05} aria-label="Fast-track 최대 증가율" onChange={(ev) => void run(() => ({ settings: { fastTrackMaxPct: Number(ev.target.value) } }))}>
            {[0.025, 0.05, 0.075, 0.1].map((n) => <option key={n} value={n}>{(n * 100).toFixed(1).replace('.0', '')}%</option>)}
          </select>
        </Row>
      </div>

      <SectionTitle>운동별 단위</SectionTitle><p className="-mt-1 pb-2 text-xs text-dust">증량은 다음 세션에 올리는 폭, 중량 단위는 실제로 맞출 수 있는 가장 작은 차이입니다.</p>
      <div className="divide-y divide-rail rounded-xl bg-steel px-3">
        {Object.values(db.exercises).filter((e) => e.role !== 'arm').map((e) => (
          <div key={e.id} className="py-2 text-sm">
            <div className="truncate">{e.name}</div>
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              <select className="field num" value={e.increment} aria-label={`${e.name} 증량`} onChange={(ev) => void run(() => ({ put: { exercises: [{ ...e, increment: Number(ev.target.value) }] } }))}>
                {[...new Set([0.5, 1, 1.25, 2, 2.5, 5, e.increment])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>증량 {n}</option>)}
              </select>
              <select className="field num" value={e.loadStep ?? ''} aria-label={`${e.name} 중량 단위`} onChange={(ev) => void run(() => ({ put: { exercises: [{ ...e, loadStep: ev.target.value === '' ? undefined : Number(ev.target.value) }] } }))}>
                <option value="">단위 자동</option>
                {[0.5, 1, 1.25, 2, 2.5, 5].map((n) => <option key={n} value={n}>단위 {n}</option>)}
              </select>
              <select className="field" value={e.roundingOverride ?? ''} aria-label={`${e.name} 반올림`} onChange={(ev) => void run(() => ({ put: { exercises: [{ ...e, roundingOverride: ev.target.value === '' ? undefined : ev.target.value as 'nearest' | 'floor' | 'ceil' }] } }))}>
                <option value="">정책 따름</option>
                {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
        ))}
      </div>

      <SectionTitle>프로그램 시작일</SectionTitle>
      <div className="rounded-xl bg-steel p-3 text-sm">
        <div>현재: <b className="num">{s.programStart ? `${s.programStart} ${fmtDateKo(s.programStart)}` : '미설정'}</b></div>
        {hasPbRecords ? <p className="mt-1 text-xs text-dust">기록이 있어서 시작일을 바꿀 수 없습니다.</p> : (
          <div className="mt-2 flex gap-1.5"><input className="field num flex-1" type="date" value={start} onChange={(e) => setStart(e.target.value)} /><Btn disabled={!isISODate(start)} onClick={changeStart}>변경</Btn></div>
        )}
      </div>

      <SectionTitle>계산 설정</SectionTitle>
      <div className="rounded-xl bg-steel px-3 py-1">
        <Row label="세트 간 예상 RPE 상승폭">
          <select className="field num w-24" value={s.rpeDriftPerSet} onChange={(e) => void run(() => ({ settings: { rpeDriftPerSet: Number(e.target.value) } }))}>{[0, 0.25, 0.5, 0.75, 1].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </Row>
        <Row label="백업 알림 주기">
          <select className="field num w-24" value={s.backupReminderDays} onChange={(e) => void run(() => ({ settings: { backupReminderDays: Number(e.target.value) } }))}>{[3, 7, 14, 30].map((n) => <option key={n} value={n}>{n}일</option>)}</select>
        </Row>
        <p className="pb-2 text-xs text-dust">개인 보정계수와 학습 설정은 더보기의 모델 실험실에서 봅니다.</p>
      </div>

      <SectionTitle>초기화</SectionTitle>
      <Btn kind="danger" className="w-full" onClick={async () => { if (await ask('이 기기의 모든 기록·계획·ARM 데이터를 지웁니다. 되돌릴 수 없습니다. 먼저 백업했는지 확인하세요.', '모두 지우기')) void wipeAll(); }}>모든 데이터 지우기</Btn>
      <p className="mt-6 text-center text-xs text-dust">Powerbuilding Training Manager<br />빌드 {__BUILD_ID__}. 외부 분석·추적 스크립트를 쓰지 않습니다.</p>
      <FontStatus />
    </div>
  );
};
