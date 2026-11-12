import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './ui/App';
import { initApp } from './ui/store';

void initApp();
createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>);

// 앱 셸 오프라인 사용을 위한 Service Worker(배포 빌드에서만). 훈련 데이터는 IndexedDB에만 저장한다.
if (import.meta.env.PROD && !import.meta.env.VITE_PREVIEW && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => undefined); });
}
