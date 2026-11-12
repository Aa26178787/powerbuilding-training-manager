// 워밍업 세트 제안(바벨 운동). 처방이 아니라 참고용 단계이며 기록은 선택이다.
import { roundLoad } from './rounding';

export interface WarmupStep { load: number; reps: number }

/** 작업 중량까지 빈 바 → 40% → 60% → 75% → 88% 단계. 바 무게 이하·중복 단계는 생략 */
export const warmupPlan = (workLoad: number, barWeight: number, step: number): WarmupStep[] => {
  if (!(workLoad > barWeight) || !(step > 0)) return [];
  const out: WarmupStep[] = [{ load: barWeight, reps: 8 }];
  for (const [pct, reps] of [[0.4, 5], [0.6, 3], [0.75, 2], [0.88, 1]] as const) {
    const load = roundLoad(workLoad * pct, Math.max(step, 2.5), 'nearest');
    if (load > out[out.length - 1].load && load < workLoad) out.push({ load, reps });
  }
  return out;
};
