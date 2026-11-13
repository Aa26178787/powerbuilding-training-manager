// 빌드 산출물(dist)의 앱 셸 파일만 사전 캐시하는 Service Worker를 생성한다.
// 허용 확장자만 넣으므로 JSON/CSV/PDF(ARM 자료)는 캐시 목록에 들어갈 수 없다.
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const dist = new URL('../dist/', import.meta.url).pathname;
const ALLOW = /\.(html|js|css|svg|png|webmanifest|woff2)$/;
// 서체는 모두 미리 받아 둔다(본문 서체는 한 파일). 예전 Pretendard 글자 묶음 이름이 섞여 들어오면 제외
const RUNTIME_ONLY = /PretendardVariable\.subset/i;
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (ALLOW.test(name) && name !== 'sw.js' && !RUNTIME_ONLY.test(name)) files.push(relative(dist, p).replaceAll('\\', '/'));
  }
};
walk(dist);
const hash = createHash('sha256');
for (const f of files.sort()) hash.update(f).update(readFileSync(join(dist, f)));
const version = hash.digest('hex').slice(0, 12);

const sw = `// 자동 생성 파일 — scripts/build-sw.mjs
const CACHE = 'ptm-shell-${version}';
const ASSETS = ${JSON.stringify(['./', ...files.map((f) => `./${f}`)])};
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ptm-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const FONTS = 'ptm-fonts';
// 화면(HTML)은 네트워크 우선: 배포 직후 옛 HTML이 지워진 옛 JS를 가리켜 빈 화면이 되는 일을 막는다.
// 3초 안에 응답이 없거나 오프라인이면 캐시한 화면을 쓴다.
const fromNetwork = (req) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), 3000);
  fetch(req).then((res) => { clearTimeout(t); res.ok ? resolve(res) : reject(new Error(String(res.status))); }, (err) => { clearTimeout(t); reject(err); });
});
// 같은 출처의 GET만 처리. 훈련 데이터는 여기 저장하지 않는다(IndexedDB 전용).
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fromNetwork(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put('./', copy)).catch(() => undefined);
      return res;
    }).catch(() => caches.match('./', { cacheName: CACHE }).then((hit) => hit || caches.match('./')).then((hit) => hit || fetch(e.request))));
    return;
  }
  if (url.pathname.endsWith('.woff2')) {
    // 서체 파일은 이름에 해시가 있어 바뀌지 않으므로, 한 번 받으면 보관해 두고 오프라인에서도 쓴다
    e.respondWith(caches.match(e.request, { ignoreVary: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(FONTS).then((c) => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  // 나머지(이름에 해시가 있는 JS·CSS·아이콘)는 캐시 우선, 없으면 네트워크
  e.respondWith(caches.match(e.request, { ignoreSearch: true, ignoreVary: true }).then((hit) => hit || fetch(e.request)));
});
`;
writeFileSync(join(dist, 'sw.js'), sw);
console.log(`sw.js 생성: ${files.length}개 파일 사전 캐시 (버전 ${version})`);
