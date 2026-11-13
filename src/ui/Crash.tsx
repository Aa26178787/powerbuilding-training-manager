import { Component, ReactNode } from 'react';
import { openStore, loadAll } from '../repositories/idb';

/** 원본 저장소를 그대로 JSON으로 내려받는다(화면이 깨져도 기록을 꺼낼 수 있게). ARM 자료가 들어 있을 수 있다 */
const rawBackup = async () => {
  const idb = await openStore();
  const db = await loadAll(idb);
  const blob = new Blob([JSON.stringify({ kind: 'ptm-raw-dump', note: 'ARM SYSTEM 자료가 포함될 수 있습니다. 공유하지 마세요.', exportedAt: new Date().toISOString(), db })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `ptm-긴급백업-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

const refresh = async () => {
  try {
    const rs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(rs.map((r) => r.unregister()));
    if ('caches' in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } finally { location.reload(); }
};

/** 화면 그리기 중 오류가 나면 검은 화면 대신 원인과 복구 방법을 보여 준다. 기록(IndexedDB)은 지우지 않는다 */
export class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="mx-auto max-w-[480px] p-6 text-[15px] leading-normal text-chalk">
        <p className="mb-1.5 text-[17px] font-bold">화면을 그리다 문제가 생겼습니다</p>
        <p className="mb-4 text-dust">훈련 기록은 이 기기에 그대로 있습니다. 아래 오류 내용을 캡처해 두면 원인을 찾기 쉽습니다.</p>
        <button type="button" className="press h-12 w-full rounded-xl bg-chalk font-bold text-iron" onClick={() => location.reload()}>다시 열기</button>
        <button type="button" className="press mt-2 h-11 w-full rounded-xl border border-rail" onClick={() => void refresh()}>앱 파일 새로 받기</button>
        <button type="button" className="press mt-2 h-11 w-full rounded-xl border border-rail" onClick={() => void rawBackup().catch((x) => alert(String(x)))}>기록 긴급 백업(JSON, ARM 자료 포함 가능)</button>
        <pre className="mt-4 whitespace-pre-wrap break-all text-[12px] text-dust">{`${e.name}: ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 6).join('\n')}`}</pre>
      </div>
    );
  }
}
