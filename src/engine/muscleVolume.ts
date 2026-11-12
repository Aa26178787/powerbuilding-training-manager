// 근육군별 가중 유효 세트 (SRS FR-080). 주동근 1.0 / 보조근 0.5는 추정 관리 지표다.
export const MUSCLE_VOLUME_VERSION = 'muscle-sets-1.0.0';

export interface MuscleSetInput { exerciseId: string; sets: number }
export interface MuscleVolumeRow { muscle: string; direct: number; indirect: number; total: number }

/**
 * 실제로 완료한 작업 세트만 넣는다(스킵·미실시 제외). ARM·종아리 등 제외 대상은 호출하는 쪽에서 뺀다.
 * direct = 가중치 1.0 이상인 세트 수, indirect = 1.0 미만 가중치의 합.
 */
export const calculateWeightedMuscleSets = (inputs: MuscleSetInput[], weights: Record<string, Record<string, number>>): MuscleVolumeRow[] => {
  const acc = new Map<string, { direct: number; indirect: number }>();
  for (const i of inputs) {
    if (!(i.sets > 0)) continue;
    for (const [muscle, w] of Object.entries(weights[i.exerciseId] ?? {})) {
      if (!(w > 0)) continue;
      const a = acc.get(muscle) ?? { direct: 0, indirect: 0 };
      if (w >= 1) a.direct += i.sets * w; else a.indirect += i.sets * w;
      acc.set(muscle, a);
    }
  }
  return [...acc.entries()].map(([muscle, a]) => ({ muscle, direct: a.direct, indirect: a.indirect, total: Math.round((a.direct + a.indirect) * 100) / 100 }))
    .sort((a, b) => b.total - a.total || a.muscle.localeCompare(b.muscle));
};
