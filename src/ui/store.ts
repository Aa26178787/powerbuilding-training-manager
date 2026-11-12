// UI 상태 저장소: 메모리 Db + IndexedDB 반영 + 다중 탭 단일 쓰기 권한
import { useSyncExternalStore } from 'react';
import type { IDBPDatabase } from 'idb';
import type { Db, ISODate, Patch } from '../domain/types';
import { DEFAULT_EXERCISES, defaultProgramVersion, emptyDb } from '../domain/defaults';
import { applyPatch, Ctx, UseCaseError } from '../application/ctx';
import { ensureWeeks } from '../application/plan';
import { commitPatch, ConflictError, loadAll, openStore, replaceAll } from '../repositories/idb';
import { dateInTz, weekStart } from '../engine/dates';

export interface Toast { id: number; text: string; kind: 'info' | 'error'; action?: { label: string; run: () => void } }
export interface AppState {
  db: Db | null;
  save: 'idle' | 'saving' | 'saved' | 'error';
  /** 다른 탭이 쓰기 권한을 가지고 있으면 읽기 전용 */
  readOnly: boolean;
  /** 브라우저 영구 저장 허용 여부(null = 미지원/미확인) */
  persisted: boolean | null;
  toast: Toast | null;
  fatal: string | null;
  /** 홈 화면 설치가 가능한 상태인지(안드로이드 Chrome) */
  canInstall: boolean;
  installed: boolean;
  /** IndexedDB를 쓸 수 없어 메모리에만 보관 중(새로고침하면 사라짐) */
  memoryOnly: boolean;
  confirm: { message: string; okLabel: string; resolve: (ok: boolean) => void } | null;
}

let state: AppState = { db: null, save: 'idle', readOnly: false, persisted: null, toast: null, fatal: null, canInstall: false, installed: false, memoryOnly: false, confirm: null };
const listeners = new Set<() => void>();
const set = (p: Partial<AppState>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
export const useApp = (): AppState => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
export const getDb = (): Db => state.db as Db;

let idb: IDBPDatabase | null = null;
let channel: BroadcastChannel | null = null;
let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const toast = (text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) => {
  clearTimeout(toastTimer);
  set({ toast: { id: (toastSeq += 1), text, kind, action } });
  toastTimer = setTimeout(() => set({ toast: null }), action ? 6000 : 3500);
};
export const dismissToast = () => set({ toast: null });

/** 화면 안 확인 대화상자. window.confirm은 일부 환경(임베드 화면 등)에서 막혀 있어 쓰지 않는다 */
export const ask = (message: string, okLabel = '계속'): Promise<boolean> =>
  new Promise((resolve) => set({ confirm: { message, okLabel, resolve: (ok) => { set({ confirm: null }); resolve(ok); } } }));

export const makeCtx = (): Ctx => {
  const now = new Date().toISOString();
  return {
    now, today: dateInTz(now, state.db?.settings.timezone ?? 'Asia/Seoul'),
    newId: () => (crypto.randomUUID ? crypto.randomUUID().slice(0, 13) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`),
  };
};
export const todayStr = (): ISODate => makeCtx().today;

const reload = async () => { if (idb) set({ db: await loadAll(idb) }); };

export const initApp = async () => {
  let db: Db;
  const seed: Patch = { put: { exercises: DEFAULT_EXERCISES, versions: [defaultProgramVersion(new Date().toISOString(), '2000-01-03')] } };
  try {
    idb = await openStore();
    db = await loadAll(idb);
    // 첫 실행: 기본 운동과 V1.9 프리셋을 넣는다
    if (!Object.keys(db.exercises).length) { await commitPatch(idb, seed); db = applyPatch(db, seed); }
  } catch {
    // 저장소를 열 수 없는 환경(사생활 보호 모드·임베드 화면): 메모리에서만 동작하고 그 사실을 화면에 알린다
    idb = null;
    set({ db: applyPatch(emptyDb() as Db, seed), memoryOnly: true });
    return;
  }
  try {
    set({ db });
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('ptm-sync');
      channel.onmessage = () => { void reload(); };
    }
    // 단일 쓰기 권한: 먼저 연 탭만 기록 가능, 나머지는 읽기 전용으로 대기
    if (navigator.locks) {
      void navigator.locks.request('ptm-writer', { ifAvailable: true }, (lock) => {
        if (lock) return new Promise<void>(() => undefined);
        set({ readOnly: true });
        void navigator.locks.request('ptm-writer', async () => {
          await reload();
          set({ readOnly: false });
          return new Promise<void>(() => undefined);
        });
        return undefined;
      });
    }
    if (navigator.storage?.persisted) set({ persisted: await navigator.storage.persisted() });
  } catch { /* 탭 간 동기화·영구 저장 확인은 부가 기능이라 실패해도 계속 진행 */ }
};

interface InstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let installEvent: InstallPromptEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e as InstallPromptEvent; set({ canInstall: true }); });
  window.addEventListener('appinstalled', () => { installEvent = null; set({ canInstall: false, installed: true }); });
}
export const isStandalone = (): boolean => window.matchMedia('(display-mode: standalone)').matches;
export const promptInstall = async (): Promise<boolean> => {
  if (!installEvent) return false;
  await installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null;
  set({ canInstall: false });
  return outcome === 'accepted';
};

/** 세트 완료 등 짧은 진동 피드백(설정에서 끌 수 있음) */
export const haptic = (ms = 35) => { if (state.db?.settings.haptics && navigator.vibrate) navigator.vibrate(ms); };

export const requestPersist = async (): Promise<boolean> => {
  if (!navigator.storage?.persist) { set({ persisted: null }); return false; }
  const ok = await navigator.storage.persist();
  set({ persisted: ok });
  return ok;
};

/**
 * 유스케이스 실행: Patch 계산 → IndexedDB 트랜잭션 → 메모리 반영 → 다른 탭에 알림.
 * 저장이 끝난 뒤에만 화면 상태를 바꾸므로 '완료' 표시는 항상 저장된 기록을 뜻한다.
 */
export async function run<T = void>(fn: (db: Db, ctx: Ctx) => Patch | { patch: Patch; result: T }): Promise<{ ok: true; result: T } | { ok: false }> {
  const db = state.db;
  if (!db) return { ok: false };
  if (state.readOnly) { toast('다른 탭에서 기록 중입니다. 이 탭은 읽기 전용입니다', 'error'); return { ok: false }; }
  let patch: Patch;
  let result: T;
  try {
    const out = fn(db, makeCtx());
    if ('patch' in out && typeof (out as { patch: Patch }).patch === 'object') { patch = (out as { patch: Patch; result: T }).patch; result = (out as { patch: Patch; result: T }).result; }
    else { patch = out as Patch; result = undefined as T; }
  } catch (e) {
    if (e instanceof UseCaseError || e instanceof RangeError || e instanceof Error) { toast(e.message, 'error'); return { ok: false }; }
    throw e;
  }
  set({ save: 'saving' });
  try {
    if (idb) await commitPatch(idb, patch);
    set({ db: applyPatch(state.db as Db, patch), save: idb ? 'saved' : 'idle' });
    channel?.postMessage('changed');
    return { ok: true, result };
  } catch (e) {
    if (e instanceof ConflictError) { await reload(); set({ save: 'idle' }); toast('다른 탭에서 먼저 수정했습니다. 최신 상태로 다시 불러왔습니다', 'error'); }
    else { set({ save: 'error' }); toast(`저장 실패: ${(e as Error).message}`, 'error'); }
    return { ok: false };
  }
}

/** 화면에 보이는 기간의 주간 계획이 없으면 생성 */
export const ensureWeeksFor = (dates: ISODate[]) => {
  const db = state.db;
  if (!db || state.readOnly || !db.settings.programStart) return;
  const patch = ensureWeeks(db, dates.map(weekStart));
  if (patch.put) void run(() => patch);
};

export const restoreBackup = async (db: Db) => {
  if (idb) await replaceAll(idb, db);
  set({ db });
  channel?.postMessage('changed');
};

export const wipeAll = async () => {
  if (idb) await replaceAll(idb, emptyDb() as Db);
  set({ db: applyPatch(emptyDb() as Db, { put: { exercises: DEFAULT_EXERCISES, versions: [defaultProgramVersion(new Date().toISOString(), '2000-01-03')] } }) });
  if (idb) await commitPatch(idb, { put: { exercises: DEFAULT_EXERCISES, versions: [defaultProgramVersion(new Date().toISOString(), '2000-01-03')] } });
};
