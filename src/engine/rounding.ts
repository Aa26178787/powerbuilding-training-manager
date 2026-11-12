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
export const minBarbellStep = (plates: number[]): number => {
  const p = plates.filter((x) => x > 0);
  return p.length ? Math.min(...p) * 2 : 2.5;
};

export interface PlateBreakdown { perSide: number[]; achieved: number; remainder: number }

/** 총중량을 바 + 한쪽 원판 조합으로 분해(큰 원판부터). 원판은 종류별 충분히 있다고 가정 */
export const plateBreakdown = (total: number, barWeight: number, plates: number[]): PlateBreakdown | null => {
  if (!Number.isFinite(total) || total < barWeight) return null;
  let side = (total - barWeight) / 2;
  const perSide: number[] = [];
  for (const p of [...plates].filter((x) => x > 0).sort((a, b) => b - a)) {
    while (side + EPS >= p) { perSide.push(p); side -= p; }
  }
  const remainder = Math.round(side * 2 * 1000) / 1000;
  return { perSide, achieved: Math.round((total - remainder) * 1000) / 1000, remainder };
};
