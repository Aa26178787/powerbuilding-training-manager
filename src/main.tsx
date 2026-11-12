import { StrictMode } from 'react';
import { domMax, LazyMotion, MotionConfig } from 'motion/react';
import { createRoot } from 'react-dom/client';
// 서체는 앱과 함께 배포(외부 CDN 없음): 한글 UI Pretendard(필요한 글자 묶음만 받음), 숫자 Barlow Condensed
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import './index.css';
import { App } from './ui/App';
import { initApp } from './ui/store';

void initApp();
createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><LazyMotion features={domMax} strict><MotionConfig reducedMotion="user"><App /></MotionConfig></LazyMotion></StrictMode>);

// 앱 셸 오프라인 사용을 위한 Service Worker(배포 빌드에서만). 훈련 데이터는 IndexedDB에만 저장한다.
if (import.meta.env.PROD && !import.meta.env.VITE_PREVIEW && 'serviceWorker' in navigator) {
  // 이미 이전 버전이 화면을 관리하고 있었다면, 새 버전이 넘겨받는 순간 '업데이트 준비됨'을 알린다
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    window.dispatchEvent(new Event('ptm-update-ready'));
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // 앱을 다시 볼 때마다 새 버전이 있는지 확인(설치된 앱은 오래 켜 두는 경우가 많음)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => undefined); });
    }).catch(() => undefined);
  });
}
