// 공개 배포 산출물에 ARM 원본 자료가 섞이지 않았는지 검사한다 (SRS FR-074, TC-023).
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
// 원본 처방에만 나오는 고유 문자열·형식. 일반 운동명(Bench Press 등)은 중복 제외 필터에 필요하므로 검사 대상이 아니다.
const MARKERS = [
  /Steel Hook/i, /Invincible Top Roll/i, /Bone Lock/i, /Riser Blood Flow/i, /Static (Back|Side) Pressure/i, /Table Practice/i,
  /ARM_SYSTEM_web_data/i, /\d+\s*x\s*\d+\s*RPE\s*\d/i, /\d+\s*sec\s*x\s*\d+/i,
];
const FORBIDDEN_EXT = /\.(pdf|csv)$/i;
const problems = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(dist, p);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (FORBIDDEN_EXT.test(name) || /arm[_-]?system/i.test(name) || (/\.json$/i.test(name))) problems.push(`${rel}: 배포 금지 파일 형식/이름`);
    if (!/\.(html|js|css|svg|webmanifest|json|txt|map)$/i.test(name)) continue;
    const text = readFileSync(p, 'utf8');
    for (const m of MARKERS) {
      const hit = text.match(m);
      if (hit) problems.push(`${rel}: ARM 원문으로 보이는 문자열 "${hit[0]}"`);
    }
  }
};
walk(dist);
if (problems.length) {
  console.error('번들 검사 실패 — ARM 원본 자료가 배포 산출물에 포함되었습니다:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('번들 검사 통과: ARM 원본 자료 없음');
