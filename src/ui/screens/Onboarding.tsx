// 첫 실행: 프로그램 시작일과 선택 입력(체중·기준 기록). 입력이 없어도 시작할 수 있다.
import { useState } from 'react';
import type { ISODate } from '../../domain/types';
import { addDays, fmtDateKo, isISODate, weekStart } from '../../engine/dates';
import { requestPersist, run, todayStr, useApp } from '../store';
import { Btn, cx } from '../components';
import { SEED_EXERCISES, SeedEditor } from './Settings';

export const Onboarding = () => {
  const { db } = useApp();
  const today = todayStr();
  const thisMon = weekStart(today);
  const options: [string, ISODate][] = [['이번 주', thisMon], ['다음 주', addDays(thisMon, 7)], ['2주 뒤', addDays(thisMon, 14)], ['3주 뒤', addDays(thisMon, 21)]];
  const [start, setStart] = useState<ISODate>(addDays(thisMon, 7));
  const [bw, setBw] = useState('');
  if (!db) return null;
  const begin = async () => {
    const n = bw === '' ? null : Number(bw);
    const versions = Object.values(db.versions).map((v) => ({ ...v, effectiveFrom: weekStart(start) }));
    const r = await run(() => ({ put: { versions }, settings: { programStart: start, onboardingDone: true, ...(n && n > 20 && n < 300 ? { bodyweight: n } : {}) } }));
    if (r.ok) void requestPersist();
  };
  return (
    <div className="mx-auto max-w-[520px] px-4 py-8">
      <h1 className="text-2xl leading-tight font-extrabold">V1.9 파워빌딩을<br />언제부터 시작할까요</h1>
      <p className="mt-2 text-sm text-dust">시작 주부터 월~금 계획이 만들어집니다. 나중에 기록이 생기기 전까지는 설정에서 바꿀 수 있습니다.</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {options.map(([l, d]) => (
          <button key={d} type="button" aria-pressed={start === d} onClick={() => setStart(d)} className={cx('tap rounded-xl border p-3 text-left', start === d ? 'border-p15 bg-p15/15' : 'border-rail')}>
            <div className="text-sm font-bold">{l}</div><div className="num text-xs text-dust">{fmtDateKo(d)} 시작</div>
          </button>
        ))}
      </div>
      <label className="mt-3 block text-xs text-dust">날짜 직접 선택
        <input className="field num mt-1" type="date" value={start} onChange={(e) => { if (isISODate(e.target.value)) setStart(e.target.value); }} />
      </label>

      <h2 className="mt-8 text-base font-bold">선택 입력</h2>
      <p className="text-sm text-dust">비워 두어도 됩니다. 기록이 없는 운동은 첫 세션에서 직접 중량을 정합니다.</p>
      <label className="mt-3 block text-xs text-dust">현재 체중(kg). 딥스와 풀업 중량 계산에 씁니다
        <input className="field num mt-1" type="number" inputMode="decimal" placeholder="예: 66.0" value={bw} onChange={(e) => setBw(e.target.value)} />
      </label>
      <div className="mt-3 text-xs text-dust">최근 기록(중량, 반복, RPE). 칸을 벗어나면 저장됩니다</div>
      <div className="divide-y divide-rail rounded-xl bg-steel px-3">
        {SEED_EXERCISES.map((id) => <SeedEditor key={id} db={db} exerciseId={id} compact />)}
      </div>
      <Btn kind="primary" className="mt-6 h-14 w-full text-base" onClick={begin}>{fmtDateKo(start)}부터 시작</Btn>
      <p className="mt-3 text-xs text-dust">모든 기록은 이 기기의 브라우저에만 저장됩니다. ARM SYSTEM 데이터는 시작한 뒤 ARM 탭에서 파일을 직접 가져옵니다.</p>
    </div>
  );
};
