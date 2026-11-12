// 앱 셸: 하단 탭, 저장 상태 표시, 알림
import { useEffect, useRef, useState } from 'react';
import type { ISODate } from '../domain/types';
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
const NAV: [Tab, string][] = [['home', '홈'], ['day', '오늘'], ['calendar', '캘린더'], ['arm', 'ARM'], ['more', '더보기']];

export const App = () => {
  const { db, save, readOnly, toast, fatal, memoryOnly, confirm } = useApp();
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
    if (d) setDate(d); else if (t === 'day') setDate(todayStr());
    if (t !== tab) { trail.current = [...trail.current.filter((x) => x !== t), tab].slice(-6); if (t === 'home') trail.current = []; }
    setTab(t as Tab);
  };
  const active: Tab = ['program', 'history', 'settings', 'analysis', 'lab'].includes(tab) ? 'more' : tab;

  return (
    <div className="mx-auto flex min-h-full max-w-[520px] flex-col">
      <div className="num flex items-center justify-between px-4 pt-2 text-[11px] text-dust" style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }} aria-live="polite">
        <span>{!online ? '오프라인 — 기록은 이 기기에 저장됩니다' : ''}</span>
        <span className={cx(save === 'error' && 'font-bold text-p25')}>{save === 'saving' ? '저장 중…' : save === 'saved' ? '이 기기에 저장됨' : save === 'error' ? '저장 실패 — 다시 시도하세요' : ''}</span>
      </div>
      {import.meta.env.VITE_PREVIEW && <div className="mx-4 mt-1 rounded-lg border border-p20/60 px-3 py-2 text-xs">미리보기 화면입니다. 기록은 이 브라우저에만 임시로 남고, 설치·오프라인·백업 파일 저장은 실제 배포본에서 동작합니다.</div>}
      {memoryOnly && <div className="mx-4 mt-1 rounded-lg border border-p25/60 px-3 py-2 text-sm">이 환경에서는 저장소를 쓸 수 없어 기록이 저장되지 않습니다. 새로고침하면 사라집니다.</div>}
      {readOnly && <div className="mx-4 mt-1 rounded-lg border border-p15/60 px-3 py-2 text-sm">다른 탭에서 이 앱을 쓰는 중이라 이 탭은 읽기 전용입니다. 그 탭을 닫으면 여기서 기록할 수 있습니다.</div>}
      <main className="flex-1 px-4 pt-2 pb-28">
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
            <header><h1 className="text-xl font-extrabold">더보기</h1></header>
            <div className="mt-3 divide-y divide-rail rounded-xl bg-steel">
              {([['program', '프로그램 조회·편집', '요일별 운동, 세트·반복·RPE'], ['history', '운동 기록', '운동별 이력, 수정·삭제·복원'], ['analysis', '분석', '근육군별 세트, 추세 그래프, 피로 신호'], ['lab', '모델 실험실', '개인화 계수와 예측 오차'], ['settings', '설정·데이터', '백업·복원, 체중, 원판, 증량 단위']] as const).map(([t, l, s]) => (
                <button key={t} type="button" className="flex min-h-[60px] w-full items-center justify-between px-4 text-left" onClick={() => go(t)}>
                  <span><span className="block font-semibold">{l}</span><span className="block text-xs text-dust">{s}</span></span><span className="text-dust" aria-hidden>›</span>
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
      {toast && (
        <div className="fixed inset-x-0 bottom-20 z-50 mx-auto flex max-w-[488px] items-center justify-between gap-3 rounded-xl px-4 py-2 text-sm shadow-lg" role="status"
          style={{ background: toast.kind === 'error' ? 'var(--color-p25)' : 'var(--color-chalk)', color: toast.kind === 'error' ? '#fff' : 'var(--color-iron)', marginInline: 'max(16px, calc(50% - 244px))' }}>
          <span>{toast.text}</span>
          {toast.action ? <Btn kind="quiet" className="shrink-0 !text-inherit underline" onClick={() => { toast.action?.run(); dismissToast(); }}>{toast.action.label}</Btn>
            : <button type="button" className="tap shrink-0 text-xs underline" onClick={dismissToast}>닫기</button>}
        </div>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-rail bg-iron/95 backdrop-blur" aria-label="주요 메뉴" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto grid max-w-[520px] grid-cols-5">
          {NAV.map(([t, l]) => (
            <button key={t} type="button" aria-current={active === t ? 'page' : undefined} onClick={() => go(t)} className={cx('relative h-16 text-sm font-bold', active === t ? 'text-chalk' : 'text-dust')}>
              {active === t && <span className="absolute inset-x-5 top-0 h-[3px] rounded-b bg-p15" aria-hidden />}
              {l}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
};
