// 공용 UI 부품. 계산식·저장 로직은 두지 않는다(결과 객체만 렌더링).
import { ReactNode, useEffect, useId, useRef } from 'react';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

export const fmtKg = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${Math.round(n * 100) / 100}`);

type BtnKind = 'primary' | 'ghost' | 'quiet' | 'danger';
export const Btn = ({ kind = 'ghost', className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind }) => (
  <button
    type="button"
    {...p}
    className={cx(
      'inline-flex min-h-[42px] min-w-[42px] items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold select-none',
      kind === 'primary' && 'bg-p15 text-[#1b1608]',
      kind === 'ghost' && 'border border-rail bg-steel',
      kind === 'quiet' && 'text-dust',
      kind === 'danger' && 'border border-p25 text-p25',
      className,
    )}
  />
);

/** 상태 표시: 색만으로 구분하지 않도록 항상 글자를 함께 쓴다 */
export const Badge = ({ tone = 'mute', children }: { tone?: 'mute' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) => (
  <span className={cx(
    'inline-flex shrink-0 items-center self-start rounded-md px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap',
    tone === 'mute' && 'bg-rail text-dust', tone === 'ok' && 'bg-p10/20 text-p10', tone === 'warn' && 'bg-p15/20 text-p15',
    tone === 'bad' && 'bg-p25/20 text-p25', tone === 'info' && 'bg-p20/20 text-p20',
  )}>{children}</span>
);

/**
 * 달성률 게이지 — 정면에서 본 원판 모양(바깥 테 + 가운데 구멍).
 * 퍼센트·분수·라벨을 함께 제공하고, 계획이 없으면 100%가 아니라 '—'로 표시한다.
 */
export const PlateGauge = ({ pct, label, sub, secondaryPct, size = 200 }: { pct: number | null; label: string; sub: string; secondaryPct?: number | null; size?: number }) => {
  const r = 78;
  const c = 2 * Math.PI * r;
  const r2 = 62;
  const c2 = 2 * Math.PI * r2;
  const off = (p: number | null | undefined, circ: number) => circ * (1 - Math.min(100, Math.max(0, p ?? 0)) / 100);
  return (
    <div className="relative" style={{ width: size, height: size }} role="img" aria-label={`${label} ${pct === null ? '계획 없음' : `${pct}%`}, ${sub}`}>
      <svg viewBox="0 0 200 200" width={size} height={size} className="-rotate-90">
        <circle cx="100" cy="100" r={r} fill="none" stroke="var(--color-rail)" strokeWidth="18" />
        <circle className="gauge-arc" cx="100" cy="100" r={r} fill="none" stroke="var(--color-p15)" strokeWidth="18" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off(pct, c)} />
        {secondaryPct !== undefined && (
          <>
            <circle cx="100" cy="100" r={r2} fill="none" stroke="var(--color-rail)" strokeWidth="5" opacity="0.6" />
            <circle className="gauge-arc" cx="100" cy="100" r={r2} fill="none" stroke="var(--color-p20)" strokeWidth="5" strokeLinecap="round" strokeDasharray={c2} strokeDashoffset={off(secondaryPct, c2)} />
          </>
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="num leading-none font-extrabold" style={{ fontSize: size * 0.21 }}>{pct === null ? '—' : pct}<span className="text-sm font-bold">{pct === null ? '' : '%'}</span></div>
        <div className="num mt-1 text-xs text-dust">{sub}</div>
      </div>
    </div>
  );
};

/** 열려 있는 시트의 닫기 함수 목록(안드로이드 뒤로가기 처리용) */
const openSheets: { current: () => void }[] = [];
/** 맨 위 시트를 닫는다. 닫은 시트가 있으면 true */
export const closeTopSheet = (): boolean => {
  const top = openSheets[openSheets.length - 1];
  if (!top) return false;
  top.current();
  return true;
};

/** 화면 아래에서 올라오는 시트(모달). Esc·배경 탭·뒤로가기로 닫힘 */
export const Sheet = ({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    openSheets.push(closeRef);
    return () => { const i = openSheets.indexOf(closeRef); if (i >= 0) openSheets.splice(i, 1); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id}
        className="sheet flex max-h-[92dvh] w-full max-w-[520px] flex-col rounded-t-2xl bg-steel outline-none sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-rail px-4 py-2">
          <h2 id={id} className="text-base font-bold">{title}</h2>
          <Btn kind="quiet" onClick={onClose} aria-label="닫기">닫기</Btn>
        </div>
        <div className="overflow-y-auto px-4 py-3">{children}</div>
        {footer && <div className="border-t border-rail px-4 py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>{footer}</div>}
      </div>
    </div>
  );
};

/** 숫자 입력 + 빠른 증감 버튼(한 손 조작) */
export const Stepper = ({ label, value, onChange, steps, min = 0, unit, decimal = true, disabled }: {
  label: string; value: string; onChange: (v: string) => void; steps: number[]; min?: number; unit?: string; decimal?: boolean; disabled?: boolean;
}) => {
  const bump = (d: number) => {
    const cur = Number(value) || 0;
    onChange(String(Math.max(min, Math.round((cur + d) * 1000) / 1000)));
  };
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-dust">{label}{unit ? ` (${unit})` : ''}</span>
      <div className="flex items-stretch gap-1">
        {steps.slice().reverse().map((s) => (
          <button key={`m${s}`} type="button" disabled={disabled} onClick={() => bump(-s)} className="num min-h-[42px] min-w-[40px] rounded-lg border border-rail px-1 text-[13px] text-dust" aria-label={`${label} ${s} 줄이기`}>−{s}</button>
        ))}
        <input
          className="field num min-w-0 flex-1 text-center text-lg font-bold" type="number" inputMode={decimal ? 'decimal' : 'numeric'} step="any" min={min}
          value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} onFocus={(e) => e.target.select()}
        />
        {steps.map((s) => (
          <button key={`p${s}`} type="button" disabled={disabled} onClick={() => bump(s)} className="num min-h-[42px] min-w-[40px] rounded-lg border border-rail px-1 text-[13px] text-dust" aria-label={`${label} ${s} 늘리기`}>+{s}</button>
        ))}
      </div>
    </label>
  );
};

const RPES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
/** RPE 선택(0.5 단위). 상한을 넘는 값은 글자로도 표시한다 */
export const RpePicker = ({ value, onChange, cap, disabled }: { value: number | null; onChange: (v: number | null) => void; cap?: number; disabled?: boolean }) => (
  <div>
    <div className="mb-0.5 flex items-baseline justify-between text-[11px] text-dust">
      <span>실제 RPE</span>
      {value !== null && cap !== undefined && value > cap && <span className="font-semibold text-p25">상한 @{cap} 초과</span>}
    </div>
    <div className="grid grid-cols-9 gap-1" role="radiogroup" aria-label="실제 RPE">
      {RPES.map((r) => (
        <button
          key={r} type="button" role="radio" aria-checked={value === r} disabled={disabled}
          onClick={() => onChange(value === r ? null : r)}
          className={cx('num h-[42px] rounded-lg border text-[13px] font-bold', value === r ? (cap !== undefined && r > cap ? 'border-p25 bg-p25 text-white' : 'border-p15 bg-p15 text-[#1b1608]') : 'border-rail text-dust')}
        >{r}</button>
      ))}
    </div>
  </div>
);

const PLATE_COLOR: Record<string, string> = { 25: '#d8402f', 20: '#3f7fe0', 15: '#f2c230', 10: '#3fa568', 5: '#e8e6df', 2.5: '#30343b', 1.25: '#9aa0aa' };
/** 한쪽 원판 구성. 색은 경기용 원판 색, 숫자를 함께 표기 */
export const PlateChips = ({ perSide, remainder }: { perSide: number[]; remainder: number }) => (
  <div className="flex flex-wrap items-center gap-1 text-xs text-dust" aria-label={`한쪽 원판: ${perSide.join(', ') || '없음'}`}>
    <span>한쪽</span>
    {perSide.length === 0 && <span>빈 바</span>}
    {perSide.map((p, i) => (
      <span key={i} className="num rounded px-1.5 py-0.5 font-bold" style={{ background: PLATE_COLOR[String(p)] ?? '#6b7280', color: [5, 15].includes(p) ? '#1b1608' : '#fff', border: '1px solid rgba(255,255,255,.18)' }}>{p}</span>
    ))}
    {remainder > 0 && <span className="text-p25">보유 원판으로 {remainder}kg 부족</span>}
  </div>
);

export const Row = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <div className="flex min-h-[42px] items-center justify-between gap-3 py-1">
    <div className="text-sm text-dust">{label}</div>
    <div className="text-right text-sm">{children}</div>
  </div>
);

export const SectionTitle = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <div className="mt-4 mb-1.5 flex items-end justify-between gap-2">
    <h2 className="text-xs font-bold text-dust">{children}</h2>
    {right}
  </div>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="rounded-xl border border-dashed border-rail px-3 py-4 text-center text-sm text-dust">{children}</div>
);
