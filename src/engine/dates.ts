// 날짜 유틸 — 'YYYY-MM-DD' 문자열만 다루는 순수 함수(현재 시각은 항상 인자로 주입)
import type { ISODate } from '../domain/types';

const toUTC = (d: ISODate): number => {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
};
const fromUTC = (t: number): ISODate => new Date(t).toISOString().slice(0, 10);

export const isISODate = (s: unknown): s is ISODate =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUTC(toUTC(s)) === s;
export const addDays = (d: ISODate, n: number): ISODate => fromUTC(toUTC(d) + n * 86400000);
export const diffDays = (a: ISODate, b: ISODate): number => Math.round((toUTC(a) - toUTC(b)) / 86400000);
/** 1=월 … 7=일 */
export const weekdayOf = (d: ISODate): number => ((new Date(toUTC(d)).getUTCDay() + 6) % 7) + 1;
export const weekStart = (d: ISODate): ISODate => addDays(d, 1 - weekdayOf(d));
export const weekDates = (start: ISODate): ISODate[] => Array.from({ length: 7 }, (_, i) => addDays(start, i));
export const monthStart = (d: ISODate): ISODate => d.slice(0, 8) + '01';
export const monthEnd = (d: ISODate): ISODate => {
  const [y, m] = d.split('-').map(Number);
  return fromUTC(Date.UTC(y, m, 0));
};
export const addMonths = (d: ISODate, n: number): ISODate => {
  const [y, m] = d.split('-').map(Number);
  return fromUTC(Date.UTC(y, m - 1 + n, 1));
};
export const datesBetween = (a: ISODate, b: ISODate): ISODate[] => {
  const out: ISODate[] = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
};
/** 타임스탬프를 지정 시간대의 달력 날짜로 변환(자정 넘긴 세션의 귀속일 계산에 사용) */
export const dateInTz = (iso: string, timezone: string): ISODate =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export const WEEKDAY_KO = ['', '월', '화', '수', '목', '금', '토', '일'];
export const fmtDateKo = (d: ISODate): string => {
  const [, m, dd] = d.split('-').map(Number);
  return `${m}/${dd}(${WEEKDAY_KO[weekdayOf(d)]})`;
};
