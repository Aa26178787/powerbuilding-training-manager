// 홈: 주·월 달성률 게이지, 오늘 운동, ARM 현황, 백업 알림
import { ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ISODate } from '../../domain/types';
import { addDays, addMonths, fmtDateKo, monthEnd, monthStart, weekStart, datesBetween } from '../../engine/dates';
import { dayView, periodAchievement } from '../../application/selectors';
import { activeSession } from '../../application/session';
import { armDayList } from '../../application/arm';
import { fatigueReport } from '../../application/analysis';
import { ensureWeeksFor, todayStr, useApp } from '../store';
import { Badge, Btn, Chip, cx, PlateGauge, Row, SectionTitle, Sheet } from '../components';

export const HomeScreen = ({ go }: { go: (tab: string, date?: ISODate) => void }) => {
  const { db } = useApp();
  const today = todayStr();
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [help, setHelp] = useState(false);
  const [anchor, setAnchor] = useState<ISODate>(today);
  const [drill, setDrill] = useState(false);
  const period = mode === 'week' ? { start: weekStart(anchor), end: addDays(weekStart(anchor), 6) } : { start: monthStart(anchor), end: monthEnd(anchor) };
  useEffect(() => { ensureWeeksFor(datesBetween(period.start, period.end).filter((_, i) => i % 7 === 0).concat(period.end)); }, [period.start, period.end, db?.settings.programStart]);
  if (!db) return null;
  const a = periodAchievement(db, period, today);
  const todayGroups = dayView(db, today);
  const session = activeSession(db);
  const isCurrent = today >= period.start && today <= period.end;
  const label = mode === 'week' ? `${fmtDateKo(period.start)} ~ ${fmtDateKo(period.end)}` : `${period.start.slice(0, 4)}년 ${Number(period.start.slice(5, 7))}월`;
  const shift = (n: number) => setAnchor(mode === 'week' ? addDays(anchor, 7 * n) : addMonths(anchor, n));
  const backupAge = db.settings.lastBackupAt ? Math.floor((Date.now() - new Date(db.settings.lastBackupAt).getTime()) / 86400000) : null;
  const hasRecords = Object.keys(db.performed).length > 0;
  const armDays = db.arm ? armDayList(db.arm) : [];
  const nextArm = armDays[db.settings.armCursor];
  const notStarted = db.settings.programStart && today < db.settings.programStart;

  // 드릴다운: 기간 내 운동별 완료/계획 세트
  const byExercise = new Map<string, { name: string; done: number; total: number; moved: number; excused: number }>();
  for (const s of Object.values(db.plannedSets)) {
    if (s.originalDate < period.start || s.originalDate > period.end || !s.inOriginalPlan) continue;
    const name = db.instances[s.instanceId]?.exerciseName ?? s.exerciseId;
    const key = `${s.track}:${name}`;
    const e = byExercise.get(key) ?? { name: s.track === 'arm' ? `${name} (ARM)` : name, done: 0, total: 0, moved: 0, excused: 0 };
    e.total += 1; if (s.status === 'done') e.done += 1; if (s.plannedDate !== s.originalDate) e.moved += 1; if (s.status === 'excused') e.excused += 1;
    byExercise.set(key, e);
  }

  return (
    <div>
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-extrabold">{fmtDateKo(today)}</h1>
        <span className="text-xs text-dust">V1.9 Off-season Powerbuilding</span>
      </header>

      <Btn kind="primary" className="mt-2 h-12 w-full text-base" onClick={() => go('day', session ? session.date : today)}>
        {session ? `${fmtDateKo(session.date)} 세션 이어서 기록` : todayGroups.length ? '오늘 운동 시작' : '오늘 화면 열기'}
      </Btn>
      {notStarted && <p className="mt-2 text-sm text-dust">프로그램은 {fmtDateKo(db.settings.programStart as string)}에 시작합니다.</p>}
      {todayGroups.length > 0 && (
        <ul className="mt-1.5 overflow-hidden rounded-xl bg-steel">
          {(() => {
            const pb = todayGroups.filter((g) => g.instance.track === 'pb');
            const arm = todayGroups.filter((g) => g.instance.track === 'arm');
            const rows = pb.map((g) => ({ id: g.instance.id, name: g.instance.exerciseName, done: g.sets.filter((x) => x.status === 'done').length, total: g.sets.length, main: g.exercise.role === 'comp' || g.exercise.role === 'strength' }));
            if (arm.length) rows.push({ id: 'arm', name: `ARM ${arm[0].workout.label.replace('ARM · ', '')}, ${arm.length}종목`, done: arm.reduce((n, g) => n + g.sets.filter((x) => x.status === 'done').length, 0), total: arm.reduce((n, g) => n + g.sets.length, 0), main: false });
            return rows.map((r) => (
              <li key={r.id} className="flex min-h-[40px] items-center gap-3 border-b border-rail/70 px-3.5 last:border-b-0">
                <span className={cx('min-w-0 flex-1 truncate text-[13px]', r.main && 'font-semibold')}>{r.name}</span>
                <span className={cx('num-d text-[15px]', r.done === r.total && r.total > 0 ? 'text-p10' : 'text-dust')}>{r.done}/{r.total}</span>
              </li>
            ));
          })()}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-between">
        <div className="flex shrink-0 rounded-lg bg-steel p-0.5 whitespace-nowrap" role="tablist" aria-label="기간">
          {(['week', 'month'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`press h-9 rounded-md px-3 text-[13px] font-semibold ${mode === m ? 'bg-deck text-chalk' : 'text-dust'}`}>{m === 'week' ? '주간' : '월간'}</button>
          ))}
        </div>
        <div className="flex items-center">
          <Btn kind="quiet" onClick={() => shift(-1)} aria-label="이전 기간"><ChevronLeft size={20} /></Btn>
          <span className="flex items-center gap-2"><span className="num text-[13px] whitespace-nowrap">{label}</span>{!isCurrent && <Chip onClick={() => setAnchor(today)}>현재</Chip>}</span>
          <Btn kind="quiet" onClick={() => shift(1)} aria-label="다음 기간"><ChevronRight size={20} /></Btn>
        </div>
      </div>

      <button type="button" className="mt-1.5 flex w-full items-center gap-3 rounded-xl bg-steel p-3 text-left" onClick={() => setDrill(true)} aria-label="달성률 상세 보기">
        <PlateGauge pct={a.pb.original.pct} secondaryPct={a.pb.adjusted.pct} label="원본 계획 달성률" sub={a.pb.original.total ? `${a.pb.original.done}/${a.pb.original.total}세트` : '계획 없음'} size={128} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold"><span className="mr-1 inline-block h-2 w-2 rounded-full bg-p15 align-middle" aria-hidden />원본 계획 달성률</div>
          <dl className="mt-1 space-y-0.5 text-[13px] whitespace-nowrap">
            <div className="flex items-baseline justify-between gap-2"><dt className="text-dust"><span className="mr-1 inline-block h-2 w-2 rounded-full bg-p20 align-middle" aria-hidden />조정 계획</dt><dd className="num-d text-[17px]">{a.pb.adjusted.pct === null ? '—' : `${a.pb.adjusted.pct}%`}</dd></div>
            <div className="flex items-baseline justify-between gap-2"><dt className="text-dust">기한 경과분</dt><dd className="num-d text-[17px]">{a.pb.dueSoFar.pct === null ? '—' : `${a.pb.dueSoFar.pct}%`}</dd></div>
            <div className="flex items-baseline justify-between gap-2"><dt className="text-dust">훈련 방문</dt><dd className="num-d text-[17px]">{a.all.visits.actual}/{a.pb.visits.planned}일</dd></div>
            <div className="flex items-baseline justify-between gap-2"><dt className="text-dust">ARM</dt><dd className="num-d text-[17px]">{a.armDays.total ? `${a.armDays.done}/${a.armDays.total}일` : '—'}</dd></div>
          </dl>
        </div>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {a.pb.excusedSets > 0 && <Badge tone="warn">면제 {a.pb.excusedSets}세트</Badge>}
        {a.pb.movedSets > 0 && <Badge tone="info">이동·병합 {a.pb.movedSets}세트</Badge>}
        {a.pb.autoregSkippedSets > 0 && <Badge>조기 종료 {a.pb.autoregSkippedSets}세트</Badge>}
        {a.pb.skippedSets > 0 && <Badge tone="bad">건너뜀 {a.pb.skippedSets}세트</Badge>}
        {a.pb.removedSets > 0 && <Badge>삭제·축소 {a.pb.removedSets}세트</Badge>}
        {a.pb.addedSets > 0 && <Badge>추가 {a.pb.addedSets}세트</Badge>}
        {a.pb.extraSets > 0 && <Badge>계획 외 {a.pb.extraSets}세트</Badge>}
        <Chip className="ml-auto" aria-expanded={help} onClick={() => setHelp(!help)}>{help ? '설명 닫기' : '지표 설명'}</Chip>
      </div>
      {help && <p className="mt-2 rounded-xl bg-steel px-3.5 py-3 text-[12.5px] leading-[1.55] text-dust">원본 계획 달성률은 기간 전체(아직 오지 않은 날 포함)가 분모입니다. 기한 경과분 이행률은 오늘까지 예정된 세트만 봅니다. 크레딧은 옮겨서 수행해도 원래 계획일의 기간에 들어갑니다.</p>}

      {fatigueReport(db).length > 0 && (
        <button type="button" className="press mt-3 flex w-full items-start gap-3 rounded-xl bg-steel px-3.5 py-3 text-left text-[13px]" onClick={() => go('analysis')}>
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-p15" aria-hidden />
          <span className="min-w-0"><b>기록 기반 피로 신호 {fatigueReport(db).length}건</b>
          <span className="mt-0.5 block text-xs text-dust">{fatigueReport(db)[0].message}</span></span>
        </button>
      )}

      <SectionTitle>ARM</SectionTitle>
      <div className="rounded-xl bg-steel px-3 py-0.5">
        {!db.arm ? (
          <Row label="데이터 없음"><Chip onClick={() => go('arm')}>JSON 가져오기</Chip></Row>
        ) : (
          <>
            <Row label="다음 배정할 Day">{nextArm ? `${nextArm.block} W${nextArm.week} D${nextArm.day}` : '전체 완료'}</Row>
            <Row label={`${label} ARM 세트`}>{a.arm.original.total ? `${a.arm.original.done}/${a.arm.original.total}세트 (${a.arm.original.pct}%)` : '배정 없음'}</Row>
            <Row label="운영 방식"><span className="flex items-center justify-end gap-2">주 {db.settings.armMode}일<Chip onClick={() => go('arm')}>배정 보기</Chip></span></Row>
          </>
        )}
      </div>

      {hasRecords && (backupAge === null || backupAge >= db.settings.backupReminderDays) && (
        <div className="mt-3 rounded-xl bg-steel px-3.5 py-3 text-[13px] leading-[1.5]">
          <b className="text-p15">{backupAge === null ? '아직 백업한 적이 없습니다.' : `마지막 백업이 ${backupAge}일 전입니다.`}</b> 기록은 이 기기의 브라우저에만 저장됩니다.
          <Btn className="mt-2 w-full" onClick={() => go('settings')}>백업 파일 내보내기</Btn>
        </div>
      )}

      {drill && (
        <Sheet title={`${label} 운동별 세트`} onClose={() => setDrill(false)}>
          <ul className="divide-y divide-rail">
            {[...byExercise.values()].map((e) => (
              <li key={e.name} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span>{e.name}</span>
                <span className="num flex items-center gap-1.5">{e.moved > 0 && <Badge tone="info">이동 {e.moved}</Badge>}{e.excused > 0 && <Badge tone="warn">면제 {e.excused}</Badge>}<b>{e.done}/{e.total}</b></span>
              </li>
            ))}
            {byExercise.size === 0 && <li className="py-6 text-center text-sm text-dust">이 기간에 계획된 세트가 없습니다.</li>}
          </ul>
        </Sheet>
      )}
    </div>
  );
};
