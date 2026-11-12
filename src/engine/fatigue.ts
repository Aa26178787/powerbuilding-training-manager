// 개인 기록 기반 피로 신호(P1). 진단이 아니라 검토 신호이며, 숫자 기준은 설정 가능한 초기값이다.
export interface SessionSummary { date: string; topLoad: number; maxRpe: number; rpeCap: number; avgRpe: number; flagged: boolean }
export interface FatigueSignal { code: 'over_cap_repeat' | 'rpe_creep' | 'load_drop'; message: string }

/** 최근 세션(오래된 순)에서 반복되는 상한 초과, 같은 중량에서의 RPE 상승, 중량 하락을 찾는다 */
export const fatigueSignals = (sessions: SessionSummary[], name: string): FatigueSignal[] => {
  const s = sessions.filter((x) => !x.flagged).slice(-3);
  const out: FatigueSignal[] = [];
  if (s.length < 2) return out;
  const over = s.filter((x) => x.maxRpe > x.rpeCap).length;
  if (over >= 2) out.push({ code: 'over_cap_repeat', message: `${name}: 최근 ${s.length}회 중 ${over}회에서 RPE 상한을 넘었습니다. 중량 유지·감량이나 회복 상태를 검토하세요` });
  if (s.length === 3 && s[2].topLoad <= s[0].topLoad && s[2].avgRpe - s[0].avgRpe >= 0.75 && s[1].avgRpe >= s[0].avgRpe) {
    out.push({ code: 'rpe_creep', message: `${name}: 중량이 늘지 않았는데 평균 RPE가 3회 연속 올랐습니다 (${s[0].avgRpe.toFixed(1)} → ${s[2].avgRpe.toFixed(1)})` });
  }
  if (s.length === 3 && s[2].topLoad < s[1].topLoad && s[1].topLoad < s[0].topLoad) {
    out.push({ code: 'load_drop', message: `${name}: 작업 중량이 3회 연속 내려갔습니다 (${s[0].topLoad} → ${s[2].topLoad}kg)` });
  }
  return out;
};
