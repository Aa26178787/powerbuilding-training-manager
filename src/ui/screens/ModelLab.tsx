// 모델 실험실: 개인화 계수(k), 관측 이력, 기본 모델 대비 예측 오차, 학습 설정
import { useState } from 'react';
import { fmtDateKo } from '../../engine/dates';
import { coefficientEvaluation, lambdaFor, setCoefficientManually, setObservationOverride, updateLearningSettings } from '../../application/learning';
import { ask, run, toast, useApp } from '../store';
import { Badge, Btn, Empty, Row, SectionTitle } from '../components';
import { LineChart } from '../charts';

const f3 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toFixed(3));
const f2 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(2));

export const ModelLabScreen = () => {
  const { db } = useApp();
  const [exId, setExId] = useState('comp_squat');
  const [manual, setManual] = useState('');
  if (!db) return null;
  const learnable = Object.values(db.exercises).filter((e) => e.role !== 'arm' && (e.variationOf || Object.values(db.versions).some((v) => v.days.some((d) => d.items.some((i) => i.exerciseId === e.id && i.model === 'top_backoff')))));
  const sel = learnable.find((e) => e.id === exId) ?? learnable[0];
  if (!sel) return <Empty>학습 대상 운동이 없습니다.</Empty>;
  const ev = coefficientEvaluation(db, sel.id);
  const obs = ev.rows.filter((r) => r.kind === 'observation');
  const s = db.settings;
  const k = db.exStates[sel.id]?.k ?? 1;
  return (
    <div>
      <header><h1 className="text-lg font-extrabold">모델 실험실</h1><p className="text-sm text-dust">Top Set으로 예측한 Backoff가 실제로 몇 RPE였는지 비교해, 종목별 보정계수 k를 조금씩 맞춥니다.</p></header>

      <SectionTitle>학습 설정</SectionTitle>
      <div className="rounded-xl bg-steel px-3 py-1">
        <Row label="자동 학습"><input type="checkbox" className="h-6 w-6 accent-[var(--color-p15)]" aria-label="자동 학습" checked={s.emaEnabled} onChange={(e) => void run((d, ctx) => updateLearningSettings(d, { emaEnabled: e.target.checked }, ctx))} /></Row>
        <Row label="학습률 λ — SBD·딥스·풀업">
          <select className="field num w-24" value={s.ema.lambdaStrength} onChange={(e) => void run((d, ctx) => updateLearningSettings(d, { lambdaStrength: Number(e.target.value) }, ctx))}>{[0.05, 0.1, 0.15, 0.2, 0.3].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </Row>
        <Row label="학습률 λ — Variation">
          <select className="field num w-24" value={s.ema.lambdaVariation} onChange={(e) => void run((d, ctx) => updateLearningSettings(d, { lambdaVariation: Number(e.target.value) }, ctx))}>{[0.05, 0.1, 0.15, 0.2].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </Row>
        <Row label="1회 관측 제한폭">
          <select className="field num w-24" value={s.ema.clampPct} onChange={(e) => void run((d, ctx) => updateLearningSettings(d, { clampPct: Number(e.target.value) }, ctx))}>{[2.5, 5, 7.5, 10].map((n) => <option key={n} value={n}>±{n}%</option>)}</select>
        </Row>
        <p className="pb-2 text-xs text-dust">λ와 제한폭은 초기 설계값이며 검증된 최적값이 아닙니다. 바꾸면 모든 종목의 k를 관측 이력에서 다시 계산합니다.</p>
      </div>

      <SectionTitle>종목</SectionTitle>
      <select className="field" value={sel.id} onChange={(e) => setExId(e.target.value)} aria-label="종목 선택">
        {learnable.map((e) => <option key={e.id} value={e.id}>{e.name} — k {f3(db.exStates[e.id]?.k ?? 1)}</option>)}
      </select>

      <div className="mt-2 rounded-xl bg-steel p-3">
        <div className="flex items-end justify-between gap-2">
          <div><div className="text-xs text-dust">현재 보정계수 k</div><div className="num text-3xl font-extrabold">{f3(k)}</div></div>
          <div className="num text-right text-xs text-dust">λ {lambdaFor(db, sel.id)} · 유효 관측 {ev.n}건{!s.emaEnabled ? ' · 자동 학습 꺼짐' : ''}</div>
        </div>
        <p className="mt-1 text-xs text-dust">{sel.variationOf ? `첫 수행 시작 중량 = Comp e1RM × ${sel.variationOf.kBase} × k` : 'Backoff 추천 = 보수적 e1RM × k에서 목표 반복·RPE로 환산'}. 목표는 k를 1에 맞추는 것이 아니라 예측 오차를 줄이는 것입니다.</p>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-iron p-2"><div className="num text-lg font-extrabold">{ev.maeModel === null ? '—' : ev.maeModel.toFixed(2)}</div><div className="text-[11px] text-dust">개인화 평균 오차</div></div>
          <div className="rounded-lg bg-iron p-2"><div className="num text-lg font-extrabold">{ev.maeBaseline === null ? '—' : ev.maeBaseline.toFixed(2)}</div><div className="text-[11px] text-dust">기본(k=1) 평균 오차</div></div>
          <div className="rounded-lg bg-iron p-2"><div className="num text-lg font-extrabold">{ev.overCapRate === null ? '—' : `${Math.round(ev.overCapRate * 100)}%`}</div><div className="text-[11px] text-dust">상한 초과 비율</div></div>
        </div>
        <p className="num mt-2 text-xs text-dust">평균 편향(실제 − 예측): 개인화 {f2(ev.biasModel)} · 기본 {f2(ev.biasBaseline)} RPE. {ev.n < 4 ? `표본이 ${ev.n}건뿐이라 아직 판단하기 이릅니다.` : ''}</p>
        {obs.filter((r) => r.used).length >= 2 && (
          <div className="mt-3">
            <div className="text-sm font-bold">예측 오차 (실제 RPE − 예측 RPE)</div>
            <LineChart title="예측 오차 추이" unit=" RPE" labels={obs.filter((r) => r.used).map((r) => (r.sessionDate ? `${Number(r.sessionDate.slice(5, 7))}/${Number(r.sessionDate.slice(8))}` : ''))}
              series={[{ name: '개인화', color: 'c1', values: obs.filter((r) => r.used).map((r) => r.errModel ?? null) }, { name: '기본(k=1)', color: 'c2', values: obs.filter((r) => r.used).map((r) => r.errBaseline ?? null) }]} />
          </div>
        )}
        <div className="mt-3 flex gap-1.5">
          <input className="field num min-w-0 flex-1" type="number" inputMode="decimal" step="0.001" placeholder="k 직접 지정 (0.70~1.30)" value={manual} onChange={(e) => setManual(e.target.value)} />
          <Btn disabled={!manual} onClick={async () => { const r = await run((d, ctx) => setCoefficientManually(d, sel.id, Number(manual), ctx)); if (r.ok) { setManual(''); toast('계수를 지정했습니다'); } }}>지정</Btn>
          <Btn kind="danger" onClick={async () => { if (await ask(`${sel.name}의 보정계수를 1.000으로 되돌립니다. 관측 이력은 남습니다.`, '초기화')) void run((d, ctx) => setCoefficientManually(d, sel.id, 'reset', ctx)); }}>초기화</Btn>
        </div>
      </div>

      <SectionTitle>관측 이력</SectionTitle>
      {ev.rows.length === 0 ? <Empty>아직 관측이 없습니다. Top Set과 첫 Backoff의 중량·반복·RPE를 기록하면 생깁니다.</Empty> : (
        <ul className="space-y-1.5">
          {[...ev.rows].reverse().map((r) => {
            const rec = db.coeffs[r.id];
            return (
              <li key={r.id} className="rounded-xl bg-steel p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <b className="num">{r.sessionDate ? fmtDateKo(r.sessionDate) : fmtDateKo(r.at.slice(0, 10))}</b>
                  {r.kind === 'reset' ? <Badge tone="warn">초기화</Badge> : r.kind === 'manual' ? <Badge tone="warn">직접 지정</Badge> : r.used ? <Badge tone="ok">학습에 사용</Badge> : <Badge tone="bad">제외 — {r.excludedReason}</Badge>}
                </div>
                {r.kind === 'observation' && rec && (
                  <>
                    <div className="num mt-1 text-xs text-dust">관측 세트 {rec.obsLoad}kg × {rec.obsReps} @{rec.obsRpe} · 기준 e1RM {rec.refE1rm?.toFixed(1)}kg</div>
                    <div className="num mt-0.5 text-xs">예측 @{r.predModel?.toFixed(1)} (기본 @{r.predBaseline?.toFixed(1)}) → 실제 @{r.actualRpe} · 오차 {f2(r.errModel)}</div>
                    <div className="num mt-0.5 text-xs">k {f3(r.kPrev)} → {f3(r.kNext)} <span className="text-dust">(관측 k {f3(r.kObserved)}{r.kObservedClamped !== undefined && r.kObserved !== undefined && Math.abs(r.kObservedClamped - r.kObserved) > 1e-9 ? `, 제한 후 ${f3(r.kObservedClamped)}` : ''})</span></div>
                    <div className="mt-1.5 flex gap-1.5">
                      {r.used ? <Btn onClick={() => void run((d, ctx) => setObservationOverride(d, r.id, 'exclude', ctx))}>학습에서 제외</Btn> : <Btn onClick={() => void run((d, ctx) => setObservationOverride(d, r.id, 'include', ctx))}>학습에 포함</Btn>}
                      {rec.override && <Btn kind="quiet" onClick={() => void run((d, ctx) => setObservationOverride(d, r.id, null, ctx))}>자동 판정으로</Btn>}
                    </div>
                  </>
                )}
                {r.kind !== 'observation' && <div className="num mt-1 text-xs">k {f3(r.kPrev)} → {f3(r.kNext)}</div>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-xs text-dust">각 관측의 예측은 그 관측 이전까지의 k로 계산하고, 평가한 뒤에 학습합니다. 모델 버전 {ev.modelVersion}.</p>
    </div>
  );
};
