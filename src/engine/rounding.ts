// 중량 반올림·원판 조합 계산
const EPS = 1e-6;

/** 기구에서 가능한 단위로 반올림. 기본은 목표보다 높아지지 않는 내림 */
export const roundLoad = (raw: number, increment: number, mode: 'down' | 'nearest' = 'down'): number => {
  if (!Number.isFinite(raw) || !Number.isFinite(increment) || increment <= 0) throw new RangeError('반올림 입력이 유효하지 않습니다');
  if (raw <= 0) return 0;
  const q = raw / increment;
  const n = mode === 'down' ? Math.floor(q + EPS) : Math.round(q);
  return Math.round(n * increment * 1000) / 1000;
};

/** 보유 원판으로 만들 수 있는 바벨 최소 증량 단위(양쪽 한 장씩) */
export const minBarbellStep = (plates: number[], stock?: PlateStock[]): number => {
  const p = stock ? stock.filter((x) => x.kg > 0 && x.pairs !== 0).map((x) => x.kg) : plates.filter((x) => x > 0);
  return p.length ? Math.min(...p) * 2 : 2.5;
};

export interface PlateBreakdown { perSide: number[]; achieved: number; remainder: number }

/** 보유 원판 한 종류. pairs는 가진 쌍 수(한쪽에 끼울 수 있는 장수). null이면 제한 없음 */
export interface PlateStock { kg: number; pairs: number | null }

/**
 * 총중량을 바 + 한쪽 원판 조합으로 분해한다.
 * stock이 있으면 종류별 보유 쌍 수를 넘지 않는다. 목표에 가장 가깝게(넘지 않게), 같으면 장수가 적은 조합.
 * 끼우는 순서는 큰 원판이 안쪽(칼라 쪽)이다.
 */
export const plateBreakdown = (total: number, barWeight: number, plates: number[], stock?: PlateStock[]): PlateBreakdown | null => {
  if (!Number.isFinite(total) || total < barWeight) return null;
  const G = 1000; // 0.001kg 단위 정수로 계산
  const sideG = Math.round(((total - barWeight) / 2) * G);
  const kinds = (stock ?? plates.map((kg) => ({ kg, pairs: null })))
    .filter((x) => x.kg > 0 && x.pairs !== 0)
    .map((x) => ({ g: Math.round(x.kg * G), kg: x.kg, max: x.pairs === null ? Infinity : x.pairs }))
    .sort((a, b) => b.g - a.g);
  const caps = kinds.map((k) => Math.min(k.max, Math.floor(sideG / k.g)));
  const restMax = kinds.map((_, i) => kinds.slice(i).reduce((sum, k, j) => sum + k.g * caps[i + j], 0));
  let best = { sum: -1, n: Infinity, counts: [] as number[] };
  let nodes = 0;
  const counts: number[] = [];
  const dfs = (i: number, sum: number, n: number) => {
    if (++nodes > 200000) return;
    if (sum > best.sum || (sum === best.sum && n < best.n)) best = { sum, n, counts: [...counts] };
    if (i === kinds.length) return;
    if (sum + restMax[i] < best.sum) return;
    if (best.sum === sideG && n >= best.n) return;
    for (let c = Math.min(caps[i], Math.floor((sideG - sum) / kinds[i].g)); c >= 0; c--) {
      counts[i] = c;
      dfs(i + 1, sum + c * kinds[i].g, n + c);
    }
    counts[i] = 0;
  };
  dfs(0, 0, 0);
  const perSide: number[] = [];
  kinds.forEach((k, i) => { for (let c = 0; c < (best.counts[i] ?? 0); c++) perSide.push(k.kg); });
  const remainder = Math.round(((sideG - Math.max(0, best.sum)) * 2) / G * 1000) / 1000;
  return { perSide, achieved: Math.round((total - remainder) * 1000) / 1000, remainder };
};
