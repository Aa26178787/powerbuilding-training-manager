// 빌드 산출물(dist)의 앱 셸 파일만 사전 캐시하는 Service Worker를 생성한다.
// 허용 확장자만 넣으므로 JSON/CSV/PDF(ARM 자료)는 캐시 목록에 들어갈 수 없다.
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const dist = new URL('../dist/', import.meta.url).pathname;
const ALLOW = /\.(html|js|css|svg|png|webmanifest|woff2)$/;
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (ALLOW.test(name) && name !== 'sw.js') files.push(relative(dist, p).replaceAll('\\', '/'));
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
// 같은 출처의 GET만 처리: 캐시 우선, 없으면 네트워크. 훈련 데이터는 여기 저장하지 않는다(IndexedDB 전용).
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true, ignoreVary: true }).then((hit) => hit || fetch(e.request).catch(() => (e.request.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
`;
writeFileSync(join(dist, 'sw.js'), sw);
console.log(`sw.js 생성: ${files.length}개 파일 사전 캐시 (버전 ${version})`);
