// 그래프 부품(SVG 직접 작성 — 외부 라이브러리 없음). 축은 하나만 쓰고, 글자는 본문 색, 계열 구분은 범례+직접 라벨로 한다.
import { useRef, useState } from 'react';
import { cx } from './components';

export interface Series { name: string; color: 'c1' | 'c2'; values: (number | null)[] }

/** 꺾은선 그래프: 2px 선, 8px 점, 누르거나 올리면 십자선과 값 표시, 아래에 표 보기 제공 */
export const LineChart = ({ labels, series, unit, hollow, title }: {
  labels: string[]; series: Series[]; unit: string; title: string;
  /** 속이 빈 점으로 표시할 지점(이상 태그가 있는 기록 등) */
  hollow?: boolean[];
}) => {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 340; const H = 170; const L = 38; const R = 44; const T = 12; const B = 24;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (labels.length === 0 || all.length === 0) return null;
  let lo = Math.min(...all); let hi = Math.max(...all);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const x = (i: number) => (labels.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (labels.length - 1));
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, '');
  const onMove = (e: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    labels.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
    setHover(best);
  };
  return (
    <figure className="m-0">
      {series.length > 1 && (
        <div className="mb-1 flex gap-3 text-xs text-dust">
          {series.map((s) => <span key={s.name} className="flex items-center gap-1"><span className="inline-block h-0.5 w-4" style={{ background: `var(--color-${s.color})` }} />{s.name}</span>)}
        </div>
      )}
      <div className="relative">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="block w-full touch-pan-y" role="img" aria-label={title} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--color-rail)" strokeWidth="1" />
              <text x={L - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--color-dust)" className="num">{fmt(t)}</text>
            </g>
          ))}
          <text x={L} y={H - 6} fontSize="10" fill="var(--color-dust)" className="num">{labels[0]}</text>
          {labels.length > 1 && <text x={W - R} y={H - 6} textAnchor="end" fontSize="10" fill="var(--color-dust)" className="num">{labels[labels.length - 1]}</text>}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--color-knurl)" strokeWidth="1" />}
          {series.map((s) => {
            const pts = s.values.map((v, i) => (v === null ? null : [x(i), y(v)] as const));
            const d = pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p![0].toFixed(1)},${p![1].toFixed(1)}`).join(' ');
            const lastIdx = s.values.reduce<number>((m, v, i) => (v !== null ? i : m), -1);
            return (
              <g key={s.name}>
                <path d={d} fill="none" stroke={`var(--color-${s.color})`} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                {pts.map((p, i) => p && (
                  <circle key={i} cx={p[0]} cy={p[1]} r={hover === i ? 5 : 4} fill={hollow?.[i] ? 'var(--color-steel)' : `var(--color-${s.color})`} stroke={hollow?.[i] ? `var(--color-${s.color})` : 'var(--color-steel)'} strokeWidth="2" />
                ))}
                {lastIdx >= 0 && hover === null && (
                  <text x={x(lastIdx) + 8} y={y(s.values[lastIdx] as number) + 4} fontSize="11" fontWeight="700" fill="var(--color-chalk)" className="num">{fmt(s.values[lastIdx] as number)}</text>
                )}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className={cx('num pointer-events-none absolute top-0 rounded-lg border border-rail bg-iron px-2 py-1 text-xs shadow', x(hover) > W / 2 ? 'left-10' : 'right-2')}>
            <div className="font-bold">{labels[hover]}</div>
            {series.map((s) => <div key={s.name}><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: `var(--color-${s.color})` }} />{series.length > 1 ? `${s.name} ` : ''}{s.values[hover] === null ? '—' : `${fmt(s.values[hover] as number)}${unit}`}</div>)}
          </div>
        )}
      </div>
      <details className="mt-1">
        <summary className="tap flex cursor-pointer items-center text-xs text-dust">표로 보기</summary>
        <table className="num w-full text-xs">
          <thead><tr className="text-left text-dust"><th className="py-1 font-normal">날짜</th>{series.map((s) => <th key={s.name} className="py-1 text-right font-normal">{s.name} ({unit})</th>)}</tr></thead>
          <tbody>{labels.map((l, i) => <tr key={i} className="border-t border-rail"><td className="py-1">{l}{hollow?.[i] ? ' *' : ''}</td>{series.map((s) => <td key={s.name} className="py-1 text-right">{s.values[i] === null ? '—' : fmt(s.values[i] as number)}</td>)}</tr>)}</tbody>
        </table>
        {hollow?.some(Boolean) && <p className="mt-1 text-xs text-dust">* 이상 태그가 있는 기록(그래프에서 속이 빈 점)</p>}
      </details>
    </figure>
  );
};

/** 가로 막대(두 구간 누적): 직접 세트 + 간접 가중 세트. 값은 막대 끝에 본문 색 글자로 표기 */
export const StackedBars = ({ rows, names }: { rows: { label: string; a: number; b: number }[]; names: [string, string] }) => {
  const max = Math.max(1, ...rows.map((r) => r.a + r.b));
  return (
    <div>
      <div className="mb-2 flex gap-3 text-xs text-dust">
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-c1" />{names[0]}</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-c2" />{names[1]}</span>
      </div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.label} className="grid grid-cols-[5.5rem_1fr_2.75rem] items-center gap-2 text-sm" title={`${r.label}: ${names[0]} ${r.a}, ${names[1]} ${r.b}`}>
            <span className="truncate text-dust">{r.label}</span>
            <span className="flex h-3.5 gap-[2px]">
              {r.a > 0 && <span className="h-full bg-c1" style={{ width: `${(r.a / max) * 100}%`, borderRadius: r.b > 0 ? '0' : '0 4px 4px 0' }} />}
              {r.b > 0 && <span className="h-full rounded-r bg-c2" style={{ width: `${(r.b / max) * 100}%` }} />}
            </span>
            <span className="num text-right font-bold">{Math.round((r.a + r.b) * 10) / 10}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
