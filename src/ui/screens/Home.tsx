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
import { Badge, Btn, Chip, cx, Reveal, Sheet } from '../components';
import { latestE1rm } from '../../application/recommend';

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

  const meet = db.settings.meetDate === undefined ? '2026-11-29' : db.settings.meetDate;
  const dday = meet && meet >= today ? Math.round((new Date(`${meet}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000) : null;
  const lifts = [['스쿼트', 'comp_squat'], ['벤치', 'comp_bench'], ['데드', 'comp_sumo']].map(([ko, id]) => ({ ko, v: latestE1rm(db, id) }));
  const pbToday = todayGroups.filter((g) => g.instance.track === 'pb');
  const armToday = todayGroups.filter((g) => g.instance.track === 'arm');
  // 이번 주 하루별 세트(현재 계획 기준): 완료, 남음, 지난 계획 미확정
  const week = datesBetween(weekStart(today), addDays(weekStart(today), 6)).map((d) => {
    const sets = Object.values(db.plannedSets).filter((x) => x.plannedDate === d && x.track === 'pb' && x.status !== 'removed');
    const doneN = sets.filter((x) => x.status === 'done').length;
    const openN = sets.filter((x) => x.status === 'planned').length;
    return { d, total: sets.length, doneN, openN, overdue: d < today && openN > 0 };
  });
  const maxDay = Math.max(1, ...week.map((x) => x.total));
  const WD = ['월', '화', '수', '목', '금', '토', '일'];
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

  return (
    <div className="pt-3">
      <header>
        <div className="text-[13px] text-dust">V1.9 비시즌 파워빌딩</div>
        <h1 className="mt-0.5 text-[22px] leading-7 font-bold">{fmtDateKo(today)}</h1>
      </header>

      {dday !== null && (
        <section aria-label="대회까지 남은 날" className="mt-4 flex items-end justify-between gap-4 border-b border-rail pb-4">
          <div>
            <div className="text-[13px] text-dust">대회 {fmtDateKo(meet as string)}까지</div>
            <div className="num-d text-[72px] leading-[68px] font-bold tracking-[-0.01em]">{dday === 0 ? '오늘' : dday}{dday > 0 && <span className="ml-1 text-[24px] font-semibold">일</span>}</div>
          </div>
          <dl className="text-right text-[12px] leading-[22px] text-dust">
            {lifts.map((l) => <div key={l.ko} className="flex items-baseline justify-end gap-1.5"><dt>{l.ko}</dt><dd className="num-d text-[16px] text-chalk">{l.v === null ? '—' : Math.round(l.v * 2) / 2}</dd></div>)}
            <div className="text-[11px]">최근 e1RM</div>
          </dl>
        </section>
      )}

      <section aria-label="오늘 세션" className="border-b border-rail py-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-bold">{session ? `${fmtDateKo(session.date)} 세션 진행 중` : '오늘 세션'}</h2>
          {todayGroups.length > 0 && <span className="text-[12px] text-dust">{pbToday.length}종목{armToday.length ? `, ARM ${armToday.length}종목` : ''}</span>}
        </div>
        {notStarted && <p className="mt-2 text-[13px] text-dust">프로그램은 {fmtDateKo(db.settings.programStart as string)}에 시작합니다.</p>}
        {todayGroups.length > 0 ? (
          <ul className="mt-2 text-[14px] leading-[30px]">
            {pbToday.slice(0, 4).map((g) => {
              const doneN = g.sets.filter((x) => x.status === 'done').length;
              return (
                <li key={g.instance.id} className="flex items-baseline justify-between gap-3">
                  <span className={cx('min-w-0 truncate', doneN === g.sets.length && g.sets.length > 0 && 'text-dust line-through decoration-knurl')}>{g.instance.exerciseName}</span>
                  <span className="num-d shrink-0 text-[16px] text-dust">{doneN > 0 ? `${doneN}/${g.sets.length}` : `${g.sets.length}세트`}</span>
                </li>
              );
            })}
            {(pbToday.length > 4 || armToday.length > 0) && <li className="text-dust">{pbToday.length > 4 ? `그 외 ${pbToday.length - 4}종목` : ''}{pbToday.length > 4 && armToday.length ? ', ' : ''}{armToday.length ? `ARM ${armToday[0].workout.label.replace('ARM · ', '')}` : ''}</li>}
          </ul>
        ) : !notStarted && <p className="mt-2 text-[13px] text-dust">오늘은 계획된 운동이 없습니다.</p>}
        <button type="button" className="press mt-3 flex h-14 w-full items-center justify-center rounded-[14px] bg-chalk text-[16px] font-bold text-iron" onClick={() => go('day', session ? session.date : today)}>
          {session ? '이어서 기록' : todayGroups.length ? '세션 시작' : '오늘 화면 열기'}
        </button>
      </section>

      <section aria-label="기간 달성률" className="border-b border-rail py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex shrink-0 rounded-lg border border-rail p-0.5" role="tablist" aria-label="기간">
            {(['week', 'month'] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cx('press hit h-8 rounded-md px-3 text-[13px] font-semibold', mode === m ? 'bg-deck text-chalk' : 'text-dust')}>{m === 'week' ? '이번 주' : '이번 달'}</button>
            ))}
          </div>
          <span className="flex items-center">
            <Btn kind="quiet" onClick={() => shift(-1)} aria-label="이전 기간"><ChevronLeft size={18} /></Btn>
            {!isCurrent ? <Chip onClick={() => setAnchor(today)}>현재</Chip> : null}
            <Btn kind="quiet" onClick={() => shift(1)} aria-label="다음 기간"><ChevronRight size={18} /></Btn>
          </span>
        </div>
        <button type="button" className="mt-2 block w-full text-left" onClick={() => setDrill(true)} aria-label="운동별 세트 보기">
          <div className="flex items-baseline justify-between gap-2">
            <span className="num text-[13px] text-dust">{label}</span>
            <span className="text-[12px] text-dust">원본 계획 <span className="num-d text-[17px] text-chalk">{a.pb.original.done}/{a.pb.original.total}</span>세트</span>
          </div>
          {mode === 'week' && isCurrent && (
            <>
              <div className="mt-3 grid h-[76px] grid-cols-7 items-end gap-1.5" aria-hidden>
                {week.map((x) => (
                  <div key={x.d} className="flex h-full flex-col justify-end gap-0.5">
                    {x.total === 0 ? <div className="h-0.5 bg-rail" /> : (
                      <>
                        {x.total - x.doneN > 0 && <div className="rounded-[3px] bg-rail" style={{ height: `${((x.total - x.doneN) / maxDay) * 74}px`, boxShadow: x.overdue ? 'inset 0 0 0 1px var(--color-p25)' : x.d === today ? 'inset 0 0 0 2px var(--color-chalk)' : undefined }} />}
                        {x.doneN > 0 && <div className="rounded-[3px] bg-chalk" style={{ height: `${(x.doneN / maxDay) * 74}px` }} />}
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-1.5 grid grid-cols-7 gap-1.5 text-center text-[11px] text-dust">{week.map((x, i) => <span key={x.d} className={cx(x.d === today && 'font-bold text-chalk')}>{WD[i]}</span>)}</div>
              <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[11px] text-dust">
                <span><span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-[2px] bg-chalk align-[-1px]" />완료</span>
                <span><span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-[2px] bg-rail align-[-1px]" />남음</span>
                {week.some((x) => x.overdue) && <span><span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-[2px] align-[-1px] shadow-[inset_0_0_0_1px_var(--color-p25)]" />지난 계획, 미확정</span>}
              </div>
            </>
          )}
        </button>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px]">
          <div className="flex items-baseline justify-between"><dt className="text-dust">원본 달성률</dt><dd className="num-d text-[17px]">{pct(a.pb.original.pct)}</dd></div>
          <div className="flex items-baseline justify-between"><dt className="text-dust">조정 계획</dt><dd className="num-d text-[17px]">{pct(a.pb.adjusted.pct)}</dd></div>
          <div className="flex items-baseline justify-between"><dt className="text-dust">기한 경과분</dt><dd className="num-d text-[17px]">{pct(a.pb.dueSoFar.pct)}</dd></div>
          <div className="flex items-baseline justify-between"><dt className="text-dust">훈련 방문</dt><dd className="num-d text-[17px]">{a.all.visits.actual}/{a.pb.visits.planned}일</dd></div>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {a.pb.excusedSets > 0 && <Badge tone="warn">면제 {a.pb.excusedSets}세트</Badge>}
          {a.pb.movedSets > 0 && <Badge tone="info">이동·병합 {a.pb.movedSets}세트</Badge>}
          {a.pb.autoregSkippedSets > 0 && <Badge>조기 종료 {a.pb.autoregSkippedSets}세트</Badge>}
          {a.pb.skippedSets > 0 && <Badge tone="bad">건너뜀 {a.pb.skippedSets}세트</Badge>}
          {a.pb.removedSets > 0 && <Badge>삭제·축소 {a.pb.removedSets}세트</Badge>}
          {a.pb.addedSets > 0 && <Badge>추가 {a.pb.addedSets}세트</Badge>}
          {a.pb.extraSets > 0 && <Badge>계획 외 {a.pb.extraSets}세트</Badge>}
          <Chip className="ml-auto" aria-expanded={help} onClick={() => setHelp(!help)}>{help ? '설명 닫기' : '지표 설명'}</Chip>
        </div>
        {help && <Reveal><p className="mt-3 text-[12.5px] leading-[1.55] text-dust">원본 계획 달성률은 기간 전체(아직 오지 않은 날 포함)가 분모입니다. 기한 경과분 이행률은 오늘까지 예정된 세트만 봅니다. 크레딧은 옮겨서 수행해도 원래 계획일의 기간에 들어갑니다.</p></Reveal>}
      </section>

      {fatigueReport(db).length > 0 && (
        <button type="button" className="press flex w-full items-start gap-3 border-b border-rail py-3.5 text-left text-[13px]" onClick={() => go('analysis')}>
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-p25" aria-hidden />
          <span className="min-w-0"><b>기록 기반 피로 신호 {fatigueReport(db).length}건</b><span className="mt-0.5 block text-xs text-dust">{fatigueReport(db)[0].message}</span></span>
        </button>
      )}

      <section aria-label="ARM" className="border-b border-rail py-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-bold">ARM</h2>
          {db.arm ? <Chip onClick={() => go('arm')}>배정 보기</Chip> : <Chip onClick={() => go('arm')}>JSON 가져오기</Chip>}
        </div>
        {db.arm ? (
          <dl className="mt-2 space-y-1 text-[13px]">
            <div className="flex items-baseline justify-between gap-2"><dt className="text-dust">다음 배정</dt><dd>{nextArm ? `${nextArm.block} W${nextArm.week} D${nextArm.day}` : '전체 완료'}</dd></div>
            <div className="flex items-baseline justify-between gap-2"><dt className="text-dust">{mode === 'week' ? '이번 주' : '이번 달'} 세트</dt><dd className="num-d text-[16px]">{a.arm.original.total ? `${a.arm.original.done}/${a.arm.original.total}` : '배정 없음'}</dd></div>
            <div className="flex items-baseline justify-between gap-2"><dt className="text-dust">운영</dt><dd>주 {db.settings.armMode}일</dd></div>
          </dl>
        ) : <p className="mt-2 text-[13px] text-dust">구매한 ARM SYSTEM의 JSON 파일을 가져오면 배정할 수 있습니다.</p>}
      </section>

      {hasRecords && (backupAge === null || backupAge >= db.settings.backupReminderDays) && (
        <section aria-label="백업 알림" className="flex items-center gap-3 py-3.5">
          <p className="min-w-0 flex-1 text-[13px] leading-[1.5] text-dust">{backupAge === null ? '아직 백업한 적이 없습니다.' : <>백업한 지 <span className="num-d text-[15px] text-chalk">{backupAge}</span>일 지났습니다.</>} 기록은 이 기기에만 있습니다.</p>
          <button type="button" className="press h-10 shrink-0 rounded-[10px] border border-rail px-3.5 text-[13px] font-semibold" onClick={() => go('settings')}>백업</button>
        </section>
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
