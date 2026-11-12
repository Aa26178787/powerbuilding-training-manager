import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 배포 빌드에만 CSP를 넣는다(개발 서버는 HMR용 인라인 스크립트를 쓰므로 제외).
// 외부 스크립트·외부 연결을 모두 막아 분석·추적 코드가 들어올 수 없게 한다.
const csp = (): Plugin => ({
  name: 'ptm-csp',
  // 미리보기 빌드(VITE_PREVIEW)는 호스팅 쪽 정책을 따르므로 넣지 않는다
  apply: (_, env) => env.command === 'build' && !process.env.VITE_PREVIEW,
  transformIndexHtml: (html) => html.replace(
    '<meta name="referrer"',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'" />\n    <meta name="referrer"`,
  ),
});

// 서체를 HTML에서 먼저 받기 시작하게 한다(CSS를 읽은 뒤에야 받는 지연을 없앰)
const preloadFonts = (): Plugin => ({
  name: 'ptm-preload-fonts',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler: (html, ctx) => {
      if (!ctx.bundle) return html;
      const files = Object.keys(ctx.bundle).filter((f) => /ptm-sans.*\.woff2$|barlow-condensed-latin-(600|700).*\.woff2$/.test(f));
      const links = files.map((f) => `<link rel="preload" href="./${f}" as="font" type="font/woff2" crossorigin />`).join('\n    ');
      return html.replace('</head>', `    ${links}\n  </head>`);
    },
  },
});

// 상대 경로 배포(정적 호스팅 하위 폴더)도 가능하도록 base를 './'로 둔다.
// 설정 화면에 표시할 빌드 식별자(날짜·시각) — 폰에서 새 버전이 적용됐는지 확인용
const BUILD_ID = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react(), tailwindcss(), csp(), preloadFonts()],
  test: { environment: 'node', include: ['src/tests/**/*.test.ts'] },
});
