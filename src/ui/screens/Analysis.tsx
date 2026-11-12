// 분석: 근육군별 가중 세트, 운동별 추세, 주간 달성률 추이, 피로 신호
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { Exercise, ISODate } from '../../domain/types';
import { MUSCLES, musclesOf } from '../../domain/defaults';
import { addDays, addMonths, fmtDateKo, monthEnd, monthStart, weekStart } from '../../engine/dates';
import { calculateAchievement } from '../../engine/achievement';
import { exerciseTrend, fatigueReport, muscleVolume, weeklyAchievementTrend } from '../../application/analysis';
import { run, toast, todayStr, useApp } from '../store';
import { Btn, Empty, Row, SectionTitle, Sheet } from '../components';
import { LineChart, StackedBars } from '../charts';

const MUSCLE_KO = Object.fromEntries(MUSCLES);
const md = (d: ISODate) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

const WeightEditor = ({ ex, onClose }: { ex: Exercise; onClose: () => void }) => {
  const [w, setW] = useState<Record<string, number>>(musclesOf(ex));
  return (
    <Sheet title={`${ex.name} 근육군 가중치`} onClose={onClose} footer={
      <div className="flex gap-2">
        <Btn onClick={async () => { const { muscles: _drop, ...rest } = ex; void _drop; const r = await run(() => ({ put: { exercises: [rest as Exercise] } })); if (r.ok) onClose(); }}>기본값으로</Btn>
        <Btn kind="primary" className="flex-1" onClick={async () => { const r = await run(() => ({ put: { exercises: [{ ...ex, muscles: Object.fromEntries(Object.entries(w).filter(([, v]) => v > 0)) }] } })); if (r.ok) { toast('가중치를 저장했습니다'); onClose(); } }}>저장</Btn>
      </div>}>
      <p className="mb-2 text-xs text-dust">주동근 1.0, 주요 보조근 0.5가 기본입니다. 근사치이므로 본인 기준에 맞게 바꿀 수 있습니다.</p>
      <ul className="divide-y divide-rail">
        {MUSCLES.map(([id, name]) => (
          <li key={id} className="flex min-h-[48px] items-center justify-between gap-2 text-sm">
            <span>{name}</span>
            <span className="flex gap-1" role="radiogroup" aria-label={name}>
              {[0, 0.5, 1].map((v) => <button key={v} type="button" role="radio" aria-checked={(w[id] ?? 0) === v} onClick={() => setW({ ...w, [id]: v })} className={`num h-10 w-12 rounded-lg border text-sm ${(w[id] ?? 0) === v ? 'border-p15 bg-p15/15 font-bold' : 'border-rail text-dust'}`}>{v}</button>)}
            </span>
          </li>
        ))}
      </ul>
    </Sheet>
  );
};

export const AnalysisScreen = () => {
  const { db } = useApp();
  const today = todayStr();
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState<ISODate>(today);
  const [exId, setExId] = useState('comp_squat');
  const [editEx, setEditEx] = useState<Exercise | null>(null);
  if (!db) return null;
  const period = mode === 'week' ? { start: weekStart(anchor), end: addDays(weekStart(anchor), 6) } : { start: monthStart(anchor), end: monthEnd(anchor) };
  const vol = muscleVolume(db, period);
  const trend = exerciseTrend(db, exId);
  const weekly = weeklyAchievementTrend(db, today, 10);
  const fatigue = fatigueReport(db);
  const pbEx = Object.values(db.exercises).filter((e) => e.role !== 'arm');
  const ex = db.exercises[exId];
  // SBD 중심 지표: Competition·Strength 목표 세트만
  const core = new Set(pbEx.filter((e) => e.role === 'comp' || e.role === 'strength').map((e) => e.id));
  const sbd = calculateAchievement({ plannedSets: Object.values(db.plannedSets).filter((s) => core.has(s.exerciseId)), performedDates: [], extraSetCount: 0, period, today, track: 'pb' });
  const label = mode === 'week' ? `${fmtDateKo(period.start)} ~ ${fmtDateKo(period.end)}` : `${period.start.slice(0, 4)}년 ${Number(period.start.slice(5, 7))}월`;
  const shift = (n: number) => setAnchor(mode === 'week' ? addDays(anchor, 7 * n) : addMonths(anchor, n));

  return (
    <div>
      <header><h1 className="text-lg font-extrabold">분석</h1></header>

      {fatigue.length > 0 && (
        <>
          <SectionTitle>기록 기반 피로 신호</SectionTitle>
          <ul className="space-y-1.5">{fatigue.map((f, i) => <li key={i} className="rounded-xl border border-p15/60 p-3 text-sm">{f.message}</li>)}</ul>
          <p className="mt-1 text-xs text-dust">최근 3회 기록에서 찾은 검토 신호입니다. 진단이 아니며 자동으로 중량을 바꾸지 않습니다.</p>
        </>
      )}

      <SectionTitle right={
        <div className="flex items-center">
          <Btn kind="quiet" onClick={() => shift(-1)} aria-label="이전 기간"><ChevronLeft size={20} /></Btn>
          <button type="button" className="num tap text-xs whitespace-nowrap" onClick={() => { setAnchor(today); setMode(mode === 'week' ? 'month' : 'week'); }}>{label} · {mode === 'week' ? '월간으로' : '주간으로'}</button>
          <Btn kind="quiet" onClick={() => shift(1)} aria-label="다음 기간"><ChevronRight size={20} /></Btn>
        </div>}>근육군별 세트</SectionTitle>
      <div className="rounded-xl bg-steel p-3">
        {vol.length === 0 ? <p className="text-sm text-dust">이 기간에 완료한 세트가 없습니다.</p>
          : <StackedBars names={['직접(주동근)', '간접(보조근 가중)']} rows={vol.map((v) => ({ label: MUSCLE_KO[v.muscle] ?? v.muscle, a: v.direct, b: v.indirect }))} />}
        <p className="mt-3 text-xs text-dust">실제로 완료한 세트만 셉니다(계획 외 세트 포함, ARM·워밍업 제외). 주동근 1.0·보조근 0.5는 추정 관리 지표입니다.</p>
        <Row label="SBD·Strength 계획 세트">{sbd.original.total ? `${sbd.original.done}/${sbd.original.total}세트 (${sbd.original.pct}%)` : '계획 없음'}</Row>
      </div>

      <SectionTitle>운동별 추세</SectionTitle>
      <select className="field" value={exId} onChange={(e) => setExId(e.target.value)} aria-label="운동 선택">
        {pbEx.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        {Object.values(db.exercises).filter((e) => e.role === 'arm').map((e) => <option key={e.id} value={e.id}>ARM · {e.name}</option>)}
      </select>
      <div className="mt-2 rounded-xl bg-steel p-3">
        {trend.load.length === 0 ? <p className="text-sm text-dust">이 운동의 기록이 아직 없습니다.</p> : (
          <>
            {trend.hasE1rm && (
              <>
                <div className="text-sm font-bold">추정 1RM{ex?.loadMode === 'bodyweight_plus' ? ' (체중 포함 부하)' : ''}</div>
                <p className="mb-1 text-xs text-dust">세션의 대표 세트 기준. Top Set은 보수적 공식, 그 외는 반복·RPE 역산.</p>
                <LineChart title="추정 1RM 추세" unit="kg" labels={trend.e1rm.map((p) => md(p.date))} hollow={trend.e1rm.map((p) => p.flagged)} series={[{ name: '추정 1RM', color: 'c1', values: trend.e1rm.map((p) => p.value) }]} />
              </>
            )}
            <div className="mt-3 text-sm font-bold">대표 세트 중량{ex?.loadMode === 'bodyweight_plus' ? ' (추가 중량)' : ''}</div>
            <LineChart title="대표 세트 중량 추세" unit="kg" labels={trend.load.map((p) => md(p.date))} hollow={trend.load.map((p) => p.flagged)} series={[{ name: '중량', color: 'c2', values: trend.load.map((p) => p.value) }]} />
            <p className="text-xs text-dust">최근: {trend.load[trend.load.length - 1].label}</p>
          </>
        )}
        {ex && ex.role !== 'arm' && <Btn className="mt-3 w-full" onClick={() => setEditEx(ex)}>이 운동의 근육군 가중치 편집</Btn>}
      </div>

      <SectionTitle>주간 달성률 추이</SectionTitle>
      <div className="rounded-xl bg-steel p-3">
        {weekly.length === 0 ? <Empty>계획이 있는 주가 아직 없습니다.</Empty> : (
          <LineChart title="주간 달성률 추이" unit="%" labels={weekly.map((w) => md(w.week))} series={[
            { name: '원본 계획', color: 'c1', values: weekly.map((w) => w.original) },
            { name: '조정 계획', color: 'c2', values: weekly.map((w) => w.adjusted) },
          ]} />
        )}
      </div>
      {editEx && <WeightEditor ex={editEx} onClose={() => setEditEx(null)} />}
    </div>
  );
};
