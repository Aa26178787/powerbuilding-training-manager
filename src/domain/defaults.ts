// V1.9 기본 프리셋 — 운동 목록, 요일별 처방, 기본 설정
import type { Exercise, ProgramDayTemplate, ProgramVersion, SetGroupSpec, Settings, PrescriptionTemplate } from './types';

const ex = (
  id: string, name: string, role: Exercise['role'], pattern: Exercise['pattern'],
  increment: number, opts: Partial<Exercise> = {},
): Exercise => ({ id, name, role, pattern, increment, rounding: 'down', loadMode: 'external', barbell: false, ...opts });

export const DEFAULT_EXERCISES: Exercise[] = [
  ex('comp_squat', 'Competition Low-bar Squat', 'comp', 'squat', 2.5, { barbell: true }),
  ex('comp_bench', 'Competition Paused Bench', 'comp', 'bench', 1.25, { barbell: true }),
  ex('comp_sumo', 'Competition Sumo Deadlift', 'comp', 'hinge', 2.5, { barbell: true }),
  ex('conv_dl', 'Conventional Deadlift', 'strength', 'hinge', 2.5, { barbell: true }),
  ex('dips_strength', 'Weighted Dips (Strength)', 'strength', 'dips', 1.25, { loadMode: 'bodyweight_plus' }),
  ex('pullup_strength', 'Weighted Pull-up (Strength)', 'strength', 'pullup', 1.25, { loadMode: 'bodyweight_plus' }),
  ex('sng_bench', 'Competition Stop-and-go Bench', 'variation', 'bench', 1.25, { barbell: true }),
  ex('highbar_squat', 'High-bar Squat', 'variation', 'squat', 2.5, { barbell: true, variationOf: { compExerciseId: 'comp_squat', kBase: 0.925 } }),
  ex('larsen_bench', 'Larsen Bench', 'variation', 'bench', 1.25, { barbell: true, variationOf: { compExerciseId: 'comp_bench', kBase: 0.925 } }),
  ex('rdl', 'Romanian Deadlift', 'variation', 'hinge', 2.5, { barbell: true }),
  ex('dips_volume', 'Weighted Dips (Volume)', 'accessory', 'dips', 1.25, { loadMode: 'bodyweight_plus' }),
  ex('pullup_volume', 'Weighted Pull-up (Volume)', 'accessory', 'pullup', 1.25, { loadMode: 'bodyweight_plus' }),
  ex('cs_row', 'Chest-supported Row', 'accessory', 'row', 2.5),
  ex('incline_db', 'Incline DB Press', 'accessory', 'chest_acc', 2),
  ex('cable_lateral', 'Cable Lateral Raise', 'accessory', 'delts', 1.25),
  ex('rev_pec_deck', 'Reverse Pec Deck', 'accessory', 'delts', 2.5),
  ex('leg_ext', 'Leg Extension', 'accessory', 'quads', 2.5),
  ex('leg_curl', 'Seated Leg Curl', 'accessory', 'hams', 2.5),
  ex('hlr', 'Hanging Leg Raise', 'accessory', 'core', 1.25),
  ex('oh_triceps', 'Overhead Cable Triceps Extension', 'accessory', 'triceps', 1.25),
];

export const MUSCLES: [string, string][] = [
  ['chest', '가슴'], ['lats', '광배'], ['upper_back', '등 상부'], ['front_delt', '전면삼각근'], ['side_delt', '측면삼각근'], ['rear_delt', '후면삼각근'],
  ['triceps', '삼두'], ['biceps', '이두'], ['quads', '대퇴사두근'], ['hams', '햄스트링'], ['glutes', '둔근'], ['adductors', '내전근'], ['erectors', '척추기립근'], ['abs', '복근'],
];

/** 근육군 가중치 기본표: 주동근 1.0, 주요 보조근 0.5. 추정 관리 지표이며 운동별로 편집 가능 */
export const DEFAULT_MUSCLES: Record<string, Record<string, number>> = {
  comp_squat: { quads: 1, glutes: 1, adductors: 0.5, erectors: 0.5 },
  highbar_squat: { quads: 1, glutes: 1, adductors: 0.5, erectors: 0.5 },
  comp_bench: { chest: 1, triceps: 0.5, front_delt: 0.5 },
  sng_bench: { chest: 1, triceps: 0.5, front_delt: 0.5 },
  larsen_bench: { chest: 1, triceps: 0.5, front_delt: 0.5 },
  comp_sumo: { glutes: 1, hams: 0.5, adductors: 0.5, quads: 0.5, erectors: 0.5, upper_back: 0.5 },
  conv_dl: { glutes: 1, hams: 1, erectors: 1, upper_back: 0.5 },
  rdl: { hams: 1, glutes: 1, erectors: 0.5 },
  dips_strength: { chest: 1, triceps: 1, front_delt: 0.5 },
  dips_volume: { chest: 1, triceps: 1, front_delt: 0.5 },
  pullup_strength: { lats: 1, biceps: 0.5, upper_back: 0.5 },
  pullup_volume: { lats: 1, biceps: 0.5, upper_back: 0.5 },
  cs_row: { upper_back: 1, lats: 1, rear_delt: 0.5, biceps: 0.5 },
  incline_db: { chest: 1, front_delt: 0.5, triceps: 0.5 },
  cable_lateral: { side_delt: 1 },
  rev_pec_deck: { rear_delt: 1, upper_back: 0.5 },
  leg_ext: { quads: 1 },
  leg_curl: { hams: 1 },
  hlr: { abs: 1 },
  oh_triceps: { triceps: 1 },
};
export const musclesOf = (ex: Exercise): Record<string, number> => ex.muscles ?? DEFAULT_MUSCLES[ex.id] ?? {};

// Top 1×reps(@7.5 목표, 상한 8) + Backoff n×reps(첫 세트 @7 기준, 상한 8)
const topBackoff = (id: string, exerciseId: string, reps: number, backoffSets: number): PrescriptionTemplate => ({
  id, exerciseId, model: 'top_backoff', required: true,
  groups: [
    { type: 'top', count: 1, reps, targetRpe: 7.5, targetRpeMin: 7, targetRpeMax: 8, rpeCap: 8 },
    { type: 'backoff', count: backoffSets, reps, targetRpe: 7, targetRpeMin: 6.5, targetRpeMax: 7, rpeCap: 8 },
  ],
});
const dp = (
  id: string, exerciseId: string, sets: number, repMin: number, repMax: number,
  opts: Partial<SetGroupSpec> & { required?: boolean; dpCriterion?: 'all_sets' | 'last_set'; note?: string } = {},
): PrescriptionTemplate => {
  const { required, dpCriterion, note, ...g } = opts;
  return {
    id, exerciseId, model: 'double_progression', required: required ?? false, dpCriterion: dpCriterion ?? 'all_sets', note,
    groups: [{ type: 'volume', count: sets, repMin, repMax, targetRpe: 7.5, targetRpeMin: 7, targetRpeMax: 8, rpeCap: 8, ...g }],
  };
};

export const DEFAULT_DAYS: ProgramDayTemplate[] = [
  { weekday: 1, label: '월', items: [
    topBackoff('mon_sq', 'comp_squat', 5, 4),
    dp('mon_sng', 'sng_bench', 4, 8, 10, { required: true }),
    dp('mon_dipsv', 'dips_volume', 2, 8, 12),
    dp('mon_row', 'cs_row', 5, 8, 12),
    dp('mon_lat', 'cable_lateral', 3, 12, 20),
    dp('mon_legext', 'leg_ext', 3, 10, 15),
  ] },
  { weekday: 2, label: '화', items: [
    topBackoff('tue_sumo', 'comp_sumo', 4, 4),
    topBackoff('tue_pull', 'pullup_strength', 5, 2),
    dp('tue_row', 'cs_row', 4, 10, 12),
    dp('tue_legcurl', 'leg_curl', 2, 10, 15),
    dp('tue_hlr', 'hlr', 3, 10, 15),
  ] },
  { weekday: 3, label: '수', items: [
    topBackoff('wed_bp', 'comp_bench', 5, 4),
    dp('wed_hsq', 'highbar_squat', 4, 8, 10, { required: true, targetRpe: 7, targetRpeMin: 6.5, targetRpeMax: 7, note: '고강도보다 볼륨. 첫 세트 약 @6.5~7' }),
    dp('wed_incline', 'incline_db', 2, 8, 12, { required: true, note: '필수 유지' }),
    dp('wed_rpd', 'rev_pec_deck', 3, 12, 20),
    dp('wed_legcurl', 'leg_curl', 3, 10, 15),
  ] },
  { weekday: 4, label: '목', items: [
    topBackoff('thu_dips', 'dips_strength', 5, 2),
    dp('thu_larsen', 'larsen_bench', 4, 8, 10, { required: true }),
    dp('thu_lat', 'cable_lateral', 4, 12, 20),
    dp('thu_tri', 'oh_triceps', 2, 10, 15),
  ] },
  { weekday: 5, label: '금', items: [
    { id: 'fri_conv', exerciseId: 'conv_dl', model: 'straight_linear', required: true,
      groups: [{ type: 'straight', count: 4, reps: 4, targetRpe: 7.5, targetRpeMin: 7, targetRpeMax: 8, rpeCap: 8 }] },
    dp('fri_rdl', 'rdl', 2, 8, 10, { required: true, dpCriterion: 'last_set', targetRpe: 7, targetRpeMin: 6.5, targetRpeMax: 7.5, note: '컨벤 이후 후면사슬 보조. 컨벤 중량과 연동하지 않음' }),
    dp('fri_pullv', 'pullup_volume', 3, 8, 12),
    dp('fri_hlr', 'hlr', 3, 10, 15),
  ] },
];

export const defaultProgramVersion = (createdAt: string, effectiveFrom: string): ProgramVersion => ({
  id: 'pv-1', name: 'V1.9 Off-season Powerbuilding', version: 1, createdAt, effectiveFrom,
  days: structuredClone(DEFAULT_DAYS),
});

export const DEFAULT_SETTINGS: Settings = {
  timezone: 'Asia/Seoul',
  unit: 'kg',
  bodyweight: null,
  barWeight: 20,
  plates: [25, 20, 15, 10, 5, 2.5, 1.25, 0.75, 0.25],
  programStart: null,
  onboardingDone: false,
  armMode: 3,
  armWeekdays3: [1, 3, 5],
  armWeekdays2: [1, 5],
  armSideMode: 'separate',
  armCursor: 0,
  lastBackupAt: null,
  backupReminderDays: 7,
  theme: 'dark',
  keepAwake: true,
  haptics: true,
  restTimer: true,
  emaEnabled: true,
  rpeDriftPerSet: 0.5,
  ema: { lambdaStrength: 0.15, lambdaVariation: 0.1, clampPct: 5 },
};

/** 통합 SBD 프로그램과 겹쳐 활성 ARM 뷰에서 제외하는 운동(OCR 오타 허용) */
export const isArmOverlapExercise = (name: string): boolean => {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  return n === 'benchpress' || n === 'dips' || n === 'weighteddips' || /^(weighted)?pu[i]?ll?ups$/.test(n);
};

export const emptyDb = () => ({
  settings: structuredClone(DEFAULT_SETTINGS),
  exercises: {}, versions: {}, workouts: {}, instances: {}, plannedSets: {}, performed: {}, sessions: {},
  recs: {}, changes: {}, exStates: {}, coeffs: {}, armOverrides: {}, armLinks: {}, audit: {}, arm: null,
});
