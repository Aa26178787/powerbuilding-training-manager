import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// 서체는 앱과 함께 배포(외부 CDN 없음): 한글 UI Pretendard(필요한 글자 묶음만 받음), 숫자 Barlow Condensed
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import './index.css';
import { App } from './ui/App';
import { initApp } from './ui/store';

void initApp();
createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>);

// 앱 셸 오프라인 사용을 위한 Service Worker(배포 빌드에서만). 훈련 데이터는 IndexedDB에만 저장한다.
if (import.meta.env.PROD && !import.meta.env.VITE_PREVIEW && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => undefined); });
}
