// 앱 셸: 하단 탭, 저장 상태 표시, 알림
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { BicepsFlexed, CalendarDays, ChartLine, ChevronRight, Dumbbell, Ellipsis, FlaskConical, History, House, ListChecks, Settings as SettingsIcon, X, type LucideIcon } from 'lucide-react';
import type { ISODate } from '../domain/types';
import { AnimatePresence, m } from 'motion/react';
import { dismissToast, toast as showToast, todayStr, useApp } from './store';
import { Btn, closeTopSheet, cx, Sheet } from './components';
import { activeSession } from '../application/session';
import { HomeScreen } from './screens/Home';
import { DayScreen } from './screens/Day';
import { CalendarScreen } from './screens/Calendar';
import { ArmScreen } from './screens/Arm';
import { ProgramScreen } from './screens/Program';
import { HistoryScreen } from './screens/History';
import { SettingsScreen } from './screens/Settings';
import { AnalysisScreen } from './screens/Analysis';
import { ModelLabScreen } from './screens/ModelLab';
import { Onboarding } from './screens/Onboarding';

type Tab = 'home' | 'day' | 'calendar' | 'arm' | 'more' | 'program' | 'history' | 'settings' | 'analysis' | 'lab';
const NAV: [Tab, string, LucideIcon][] = [['home', '홈', House], ['day', '오늘', Dumbbell], ['calendar', '캘린더', CalendarDays], ['arm', 'ARM', BicepsFlexed], ['more', '더보기', Ellipsis]];
const MORE: [Tab, string, string, LucideIcon][] = [
  ['program', '프로그램 조회·편집', '요일별 운동, 세트·반복·RPE', ListChecks],
  ['history', '운동 기록', '운동별 이력, 수정·삭제·복원', History],
  ['analysis', '분석', '근육군별 세트, 추세 그래프, 피로 신호', ChartLine],
  ['lab', '모델 실험실', '개인화 계수, 예측 오차, RTS RPE 표', FlaskConical],
  ['settings', '설정·데이터', '백업·복원, 체중, 원판, 증량 단위', SettingsIcon],
];

/** 탭 전환을 View Transition으로 감싼다(지원 브라우저 + 동작 줄이기 꺼짐일 때만, 아니면 즉시 전환) */
const withTransition = (update: () => void) => {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { update(); return; }
  doc.startViewTransition(() => flushSync(update));
};

export const App = () => {
  const { db, save, readOnly, toast, fatal, memoryOnly, confirm, updateReady } = useApp();
  const [tab, setTab] = useState<Tab>('home');
  const [date, setDate] = useState<ISODate>(todayStr());
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  const theme = db?.settings.theme ?? 'dark';
  useEffect(() => {
    const resolved = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
    document.documentElement.dataset.theme = resolved;
  }, [theme]);
  useEffect(() => { window.scrollTo(0, 0); }, [tab]);

  // 안드로이드 뒤로가기: 시트 닫기 → 이전 탭 → 홈 → (한 번 더 누르면) 종료
  const trail = useRef<Tab[]>([]);
  const tabRef = useRef<Tab>(tab);
  tabRef.current = tab;
  useEffect(() => {
    try { window.history.pushState({ ptm: 1 }, ''); } catch { return undefined; }
    const onPop = () => {
      if (closeTopSheet()) { window.history.pushState({ ptm: 1 }, ''); return; }
      if (tabRef.current !== 'home') {
        setTab(trail.current.pop() ?? 'home');
        window.history.pushState({ ptm: 1 }, '');
        return;
      }
      showToast('뒤로가기를 한 번 더 누르면 앱을 닫습니다');
      setTimeout(() => { if (window.history.state?.ptm !== 1) window.history.pushState({ ptm: 1 }, ''); }, 2500);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 세션 진행 중 화면 꺼짐 방지(Wake Lock). 화면이 다시 보이면 재요청한다
  const sessionOn = !!db && !!activeSession(db);
  const keepAwake = db?.settings.keepAwake ?? true;
  useEffect(() => {
    if (!sessionOn || !keepAwake || !('wakeLock' in navigator)) return undefined;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then((l) => { if (cancelled) void l.release(); else lock = l; }).catch(() => undefined);
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', acquire); void lock?.release(); };
  }, [sessionOn, keepAwake]);

  if (fatal) return <div className="mx-auto max-w-[520px] p-6"><h1 className="text-xl font-extrabold">앱을 시작할 수 없습니다</h1><p className="mt-2 text-sm">{fatal}</p></div>;
  if (!db) return <div className="p-6 text-sm text-dust">불러오는 중…</div>;
  if (!db.settings.onboardingDone) return <Onboarding />;

  const go = (t: string, d?: ISODate) => {
    if (t !== tab) { trail.current = [...trail.current.filter((x) => x !== t), tab].slice(-6); if (t === 'home') trail.current = []; }
    if (t !== tab) dismissToast();
    withTransition(() => {
      if (d) setDate(d); else if (t === 'day') setDate(todayStr());
      setTab(t as Tab);
    });
  };
  const active: Tab = ['program', 'history', 'settings', 'analysis', 'lab'].includes(tab) ? 'more' : tab;

  return (
    <div className="mx-auto flex min-h-full max-w-[520px] flex-col">
      <div className="num flex items-center justify-between px-3 text-[10px] text-dust" style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }} aria-live="polite">
        <span>{!online ? '오프라인. 기록은 이 기기에 저장됩니다' : ''}</span>
        <span className={cx(save === 'error' && 'font-bold text-p25')}>{save === 'saving' ? '저장 중…' : save === 'saved' ? '이 기기에 저장됨' : save === 'error' ? '저장 실패 — 다시 시도하세요' : ''}</span>
      </div>
      {import.meta.env.VITE_PREVIEW && <div className="mx-4 mt-1 rounded-lg border border-p20/60 px-3 py-2 text-xs">미리보기 화면입니다. 기록은 이 브라우저에만 임시로 남고, 설치·오프라인·백업 파일 저장은 실제 배포본에서 동작합니다.</div>}
      {memoryOnly && <div className="mx-4 mt-1 rounded-lg border border-p25/60 px-3 py-2 text-sm">이 환경에서는 저장소를 쓸 수 없어 기록이 저장되지 않습니다. 새로고침하면 사라집니다.</div>}
      {updateReady && (
        <div className="mx-3 mt-1 flex items-center justify-between gap-2 rounded-lg bg-deck px-3 py-1 text-[13px]">
          <span>새 버전이 준비됐습니다. 지금까지 기록한 세트는 저장되어 있습니다.</span>
          <Btn kind="primary" className="shrink-0 !min-h-9" onClick={() => window.location.reload()}>지금 적용</Btn>
        </div>
      )}
      {readOnly && <div className="mx-4 mt-1 rounded-lg border border-p15/60 px-3 py-2 text-sm">다른 탭에서 이 앱을 쓰는 중이라 이 탭은 읽기 전용입니다. 그 탭을 닫으면 여기서 기록할 수 있습니다.</div>}
      <main className="flex-1 px-3 pt-1 pb-24">
        {tab === 'home' && <HomeScreen go={go} />}
        {tab === 'day' && <DayScreen date={date} onDate={setDate} />}
        {tab === 'calendar' && <CalendarScreen go={go} />}
        {tab === 'arm' && <ArmScreen go={go} />}
        {tab === 'program' && <ProgramScreen />}
        {tab === 'history' && <HistoryScreen />}
        {tab === 'settings' && <SettingsScreen />}
        {tab === 'analysis' && <AnalysisScreen />}
        {tab === 'lab' && <ModelLabScreen />}
        {tab === 'more' && (
          <div>
            <header><h1 className="text-lg font-extrabold">더보기</h1></header>
            <div className="mt-2 divide-y divide-rail overflow-hidden rounded-xl bg-steel">
              {MORE.map(([t, l, sub, Icon]) => (
                <button key={t} type="button" className="press flex min-h-[56px] w-full items-center gap-3 px-3 text-left" onClick={() => go(t)}>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-deck text-dust"><Icon size={18} /></span>
                  <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold">{l}</span><span className="block truncate text-xs text-dust">{sub}</span></span>
                  <ChevronRight size={18} className="text-knurl" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
      {confirm && (
        <Sheet title="확인" onClose={() => confirm.resolve(false)} footer={<div className="flex gap-2"><Btn className="flex-1" onClick={() => confirm.resolve(false)}>취소</Btn><Btn kind="danger" className="flex-1" onClick={() => confirm.resolve(true)}>{confirm.okLabel}</Btn></div>}>
          <p className="text-sm">{confirm.message}</p>
        </Sheet>
      )}
      <AnimatePresence>
        {toast && (
          <m.div key={toast.id} role="status" aria-live="polite"
            className="toast-pos fixed inset-x-0 z-50 mx-auto flex min-h-12 max-w-[496px] touch-pan-y items-center justify-between gap-3 rounded-xl py-1 pr-1.5 pl-4 text-[14px] shadow-[0_8px_24px_rgba(0,0,0,.35)]"
            style={{ background: toast.kind === 'error' ? 'var(--color-p25)' : 'var(--color-chalk)', color: toast.kind === 'error' ? '#fff' : 'var(--color-iron)', marginInline: 'max(12px, calc(50% - 248px))' }}
            initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 16, opacity: 0, transition: { duration: 0.15 } }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            drag="x" dragSnapToOrigin dragElastic={0.6}
            onDragEnd={(_, i) => { if (Math.abs(i.offset.x) > 80 || Math.abs(i.velocity.x) > 500) dismissToast(); }}>
            <span className="min-w-0">{toast.text}</span>
            {toast.action ? <button type="button" className="press h-10 shrink-0 rounded-lg px-3 text-[14px] font-bold" style={{ background: 'color-mix(in srgb, currentColor 10%, transparent)' }} onClick={() => { toast.action?.run(); dismissToast(); }}>{toast.action.label}</button>
              : <button type="button" className="press flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" aria-label="알림 닫기" onClick={dismissToast}><X size={16} aria-hidden /></button>}
          </m.div>
        )}
      </AnimatePresence>
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-rail bg-iron/95 backdrop-blur" aria-label="주요 메뉴" style={{ paddingBottom: 'env(safe-area-inset-bottom)', viewTransitionName: 'nav' }}>
        <div className="mx-auto grid max-w-[520px] grid-cols-5">
          {NAV.map(([t, l, Icon]) => (
            <button key={t} type="button" aria-current={active === t ? 'page' : undefined} onClick={() => go(t)} className={cx('press relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-bold', active === t ? 'text-chalk' : 'text-dust')}>
              <Icon size={21} strokeWidth={active === t ? 2.4 : 1.9} className={active === t ? 'text-p15' : ''} aria-hidden />
              {l}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
};
