// V1.9 기본 프리셋 — 운동 목록, 요일별 처방, 기본 설정
import { MUSCLE_NAMES, muscleWeightsOf } from './slots';
import type { Exercise, ProgramDayTemplate, ProgramVersion, SetGroupSpec, Settings, PrescriptionTemplate } from './types';

const ex = (
  id: string, name: string, role: Exercise['role'], pattern: Exercise['pattern'],
  increment: number, opts: Partial<Exercise> = {},
): Exercise => ({ id, name, role, pattern, increment, rounding: 'down', loadMode: 'external', barbell: false, ...opts });

const BB = { barbell: true, equipment: 'barbell' as const };
const M = { loadUnit: 'machine' as const, equipment: 'machine' as const };
const C = { loadUnit: 'machine' as const, equipment: 'cable' as const };
const DB_ = { loadUnit: 'per_hand' as const, equipment: 'dumbbell' as const };
const mus = (primaryMuscles: string[], secondaryMuscles: string[] = []) => ({ primaryMuscles, secondaryMuscles });

export const PAUSED_CONV_DEFAULT_PAUSE = { position: '바닥에서 바가 떨어진 직후 약 2cm 이상 올라온 위치', seconds: 1 };

/** 고정 운동(V1.9 핵심 처방) + 슬롯에서 고를 수 있는 근비대 운동 라이브러리 */
export const DEFAULT_EXERCISES: Exercise[] = [
  // Fixed Exercise
  ex('comp_squat', 'Competition Low-bar Squat', 'comp', 'squat', 2.5, { ...BB, fixed: true, category: 'legs', movement: 'squat' }),
  ex('comp_bench', 'Competition Paused Bench', 'comp', 'bench', 1.25, { ...BB, fixed: true, category: 'chest', movement: 'bench_press' }),
  ex('conv_dl', 'Competition Conventional Deadlift', 'comp', 'hinge', 2.5, { ...BB, fixed: true, category: 'legs', movement: 'deadlift' }),
  ex('paused_conv', 'Paused Conventional Deadlift', 'variation', 'hinge', 2.5, { ...BB, fixed: true, category: 'legs', movement: 'deadlift', pause: PAUSED_CONV_DEFAULT_PAUSE, repRange: [3, 5] }),
  ex('sng_bench', 'Competition Stop-and-go Bench', 'variation', 'bench', 1.25, { ...BB, fixed: true, category: 'chest', movement: 'bench_press', variationOf: { compExerciseId: 'comp_bench', kBase: 1 } }),
  ex('highbar_squat', 'High-bar Squat', 'variation', 'squat', 2.5, { ...BB, fixed: true, category: 'legs', movement: 'squat', variationOf: { compExerciseId: 'comp_squat', kBase: 0.925 } }),
  ex('larsen_bench', 'Larsen Bench', 'variation', 'bench', 1.25, { ...BB, fixed: true, category: 'chest', movement: 'bench_press', variationOf: { compExerciseId: 'comp_bench', kBase: 0.925 } }),
  ex('dips_strength', 'Weighted Dips (Strength)', 'strength', 'dips', 1.25, { loadMode: 'bodyweight_plus', equipment: 'bodyweight', fixed: true, category: 'chest', movement: 'lower_chest' }),
  ex('pullup_strength', 'Weighted Pull-up (Strength)', 'strength', 'pullup', 1.25, { loadMode: 'bodyweight_plus', equipment: 'bodyweight', fixed: true, category: 'back', movement: 'vertical_pull' }),
  ex('rdl', 'Romanian Deadlift', 'variation', 'hinge', 2.5, { ...BB, fixed: true, category: 'legs', slotIds: ['hip_hinge'], movement: 'hip_hinge' }),
  // 비시즌 기본 루틴에서는 빠졌지만 기록·계수 보존과 재추가를 위해 남긴다
  ex('comp_sumo', 'Competition Sumo Deadlift', 'comp', 'hinge', 2.5, { ...BB, category: 'legs', movement: 'deadlift' }),
  // Lower Chest·Vertical Pull로 분류하되 Strength와 진행 상태는 따로
  ex('dips_volume', 'Weighted Dips (Volume)', 'accessory', 'dips', 1.25, { loadMode: 'bodyweight_plus', equipment: 'bodyweight', category: 'chest', slotIds: ['lower_chest'], relatedOf: { exerciseId: 'dips_strength', kBase: 1 } }),
  ex('pullup_volume', 'Weighted Pull-up (Volume)', 'accessory', 'pullup', 1.25, { loadMode: 'bodyweight_plus', equipment: 'bodyweight', category: 'back', slotIds: ['vertical_pull'], relatedOf: { exerciseId: 'pullup_strength', kBase: 1 } }),
  // Chest
  ex('incline_machine', 'Incline Chest Press Machine', 'accessory', 'chest_acc', 2.5, { ...M, category: 'chest', slotIds: ['upper_chest'], ...mus(['chest'], ['front_delt', 'triceps']) }),
  ex('incline_db', 'Incline DB Press', 'accessory', 'chest_acc', 2, { ...DB_, category: 'chest', slotIds: ['upper_chest'] }),
  ex('incline_smith', 'Incline Smith Press', 'accessory', 'chest_acc', 2.5, { equipment: 'smith', category: 'chest', slotIds: ['upper_chest'], ...mus(['chest'], ['front_delt', 'triceps']) }),
  ex('chest_press_machine', 'Chest Press Machine', 'accessory', 'chest_acc', 2.5, { ...M, category: 'chest', slotIds: ['mid_chest'], ...mus(['chest'], ['front_delt', 'triceps']) }),
  ex('db_bench', 'DB Bench Press', 'accessory', 'chest_acc', 2, { ...DB_, category: 'chest', slotIds: ['mid_chest'], ...mus(['chest'], ['front_delt', 'triceps']) }),
  ex('pec_deck', 'Pec Deck', 'accessory', 'chest_acc', 2.5, { ...M, category: 'chest', slotIds: ['mid_chest'], ...mus(['chest']) }),
  ex('decline_press', 'Decline Press', 'accessory', 'chest_acc', 2.5, { ...BB, category: 'chest', slotIds: ['lower_chest'], ...mus(['chest'], ['triceps']) }),
  ex('cable_fly_hl', 'High-to-low Cable Fly', 'accessory', 'chest_acc', 1.25, { ...C, category: 'chest', slotIds: ['lower_chest'], ...mus(['chest']) }),
  // Back
  ex('linear_row', 'Linear Row', 'accessory', 'row', 2.5, { equipment: 'plate_loaded', category: 'back', slotIds: ['horizontal_pull'], ...mus(['upper_back', 'lats'], ['rear_delt', 'biceps']) }),
  ex('cs_row', 'Chest-supported Row', 'accessory', 'row', 2.5, { ...M, category: 'back', slotIds: ['horizontal_pull'] }),
  ex('seated_cable_row', 'Seated Cable Row', 'accessory', 'row', 2.5, { ...C, category: 'back', slotIds: ['horizontal_pull'], ...mus(['upper_back', 'lats'], ['rear_delt', 'biceps']) }),
  ex('pullup_bw', 'Pull-up', 'accessory', 'pullup', 1.25, { equipment: 'bodyweight', bodyweightOnly: true, category: 'back', slotIds: ['vertical_pull'], ...mus(['lats'], ['biceps', 'upper_back']) }),
  ex('lat_pulldown', 'Lat Pulldown', 'accessory', 'pullup', 2.5, { ...C, category: 'back', slotIds: ['vertical_pull'], ...mus(['lats'], ['biceps', 'upper_back']) }),
  // Delts
  ex('db_front_raise', 'DB Front Raise', 'accessory', 'delts', 1, { ...DB_, category: 'delts', slotIds: ['anterior_delt'], ...mus(['front_delt']) }),
  ex('cable_front_raise', 'Cable Front Raise', 'accessory', 'delts', 1.25, { ...C, category: 'delts', slotIds: ['anterior_delt'], ...mus(['front_delt']) }),
  ex('cable_lateral', 'Cable Lateral Raise', 'accessory', 'delts', 1.25, { ...C, category: 'delts', slotIds: ['lateral_delt'], unilateral: true }),
  ex('lateral_machine', 'Lateral Raise Machine', 'accessory', 'delts', 2.5, { ...M, category: 'delts', slotIds: ['lateral_delt'], ...mus(['side_delt']) }),
  ex('rev_pec_deck', 'Reverse Pec Deck', 'accessory', 'delts', 2.5, { ...M, category: 'delts', slotIds: ['posterior_delt'] }),
  ex('rear_delt_fly', 'Rear Delt Fly', 'accessory', 'delts', 1, { ...DB_, category: 'delts', slotIds: ['posterior_delt'], ...mus(['rear_delt'], ['upper_back']) }),
  // Arms
  ex('cable_curl', 'Cable Curl', 'accessory', 'biceps', 1.25, { ...C, category: 'arms', slotIds: ['biceps'], ...mus(['biceps'], ['brachialis']) }),
  ex('preacher_curl', 'Preacher Curl', 'accessory', 'biceps', 1.25, { equipment: 'other', category: 'arms', slotIds: ['biceps'], ...mus(['biceps'], ['brachialis']) }),
  ex('db_curl', 'DB Curl', 'accessory', 'biceps', 1, { ...DB_, category: 'arms', slotIds: ['biceps'], ...mus(['biceps'], ['brachialis', 'forearms']) }),
  ex('oh_triceps', 'Overhead Cable Extension', 'accessory', 'triceps', 1.25, { ...C, category: 'arms', slotIds: ['triceps'] }),
  ex('pushdown', 'Pushdown', 'accessory', 'triceps', 1.25, { ...C, category: 'arms', slotIds: ['triceps'], ...mus(['triceps']) }),
  // Legs
  ex('leg_ext', 'Leg Extension', 'accessory', 'quads', 2.5, { ...M, category: 'legs', slotIds: ['knee_extension'] }),
  ex('leg_curl', 'Seated Leg Curl', 'accessory', 'hams', 2.5, { ...M, category: 'legs', slotIds: ['knee_flexion'] }),
  ex('lying_leg_curl', 'Lying Leg Curl', 'accessory', 'hams', 2.5, { ...M, category: 'legs', slotIds: ['knee_flexion'], ...mus(['hams']) }),
  // Core
  ex('hlr', 'Hanging Leg Raise', 'accessory', 'core', 1.25, { bodyweightOnly: true, equipment: 'bodyweight', category: 'core', slotIds: ['abs'] }),
  ex('cable_crunch', 'Cable Crunch', 'accessory', 'core', 2.5, { ...C, category: 'core', slotIds: ['abs'], ...mus(['abs']) }),
  ex('back_extension', 'Back Extension', 'accessory', 'erectors', 2.5, { equipment: 'bodyweight', category: 'core', slotIds: ['spinal_erectors'], ...mus(['erectors'], ['glutes', 'hams']) }),
];

/** [id, 표시 이름] 목록(영어 표시) */
export const MUSCLES: [string, string][] = MUSCLE_NAMES.map(([id, name]) => [id, name]);

/** 근육군 가중치 기본표: 주동근 1.0, 주요 보조근 0.5. 추정 관리 지표이며 운동별로 편집 가능 */
export const DEFAULT_MUSCLES: Record<string, Record<string, number>> = {
  comp_squat: { quads: 1, glutes: 1, adductors: 0.5, erectors: 0.5 },
  highbar_squat: { quads: 1, glutes: 1, adductors: 0.5, erectors: 0.5 },
  comp_bench: { chest: 1, triceps: 0.5, front_delt: 0.5 },
  sng_bench: { chest: 1, triceps: 0.5, front_delt: 0.5 },
  larsen_bench: { chest: 1, triceps: 0.5, front_delt: 0.5 },
  comp_sumo: { glutes: 1, hams: 0.5, adductors: 0.5, quads: 0.5, erectors: 0.5, upper_back: 0.5 },
  conv_dl: { glutes: 1, hams: 1, erectors: 1, upper_back: 0.5 },
  paused_conv: { glutes: 1, hams: 1, erectors: 1, upper_back: 0.5 },
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
/** 운동별 근육 가중치. 주동근·보조근 목록이 있으면 그것(1.0/0.5), 없으면 직접 넣은 값, 그다음 기본표 */
export const musclesOf = (ex: Exercise): Record<string, number> =>
  Object.fromEntries(muscleWeightsOf(ex, DEFAULT_MUSCLES[ex.id] ?? {}).map((w) => [w.muscle, w.weight]));

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
  opts: Partial<SetGroupSpec> & { required?: boolean; dpCriterion?: 'all_sets' | 'last_set'; note?: string; slotId?: string } = {},
): PrescriptionTemplate => {
  const { required, dpCriterion, note, slotId, ...g } = opts;
  return {
    id, exerciseId, ...(slotId ? { slotId } : {}), model: 'double_progression', required: required ?? false, dpCriterion: dpCriterion ?? 'all_sets', note,
    groups: [{ type: 'volume', count: sets, repMin, repMax, targetRpe: 7.5, targetRpeMin: 7, targetRpeMax: 8, rpeCap: 8, ...g }],
  };
};

/** 금요일 Paused Conventional: 3~4세트 × 3~5회 @6.5~7.5, 상한 8, Double Progression. 처음은 3세트 */
export const PAUSED_CONV_ITEM: PrescriptionTemplate = {
  id: 'fri_pconv', exerciseId: 'paused_conv', model: 'double_progression', required: true, dpCriterion: 'all_sets',
  note: '처음은 3×4로 시작. 정지 위치·시간은 운동 설정에서 변경',
  groups: [{ type: 'volume', count: 3, repMin: 3, repMax: 5, targetRpe: 7, targetRpeMin: 6.5, targetRpeMax: 7.5, rpeCap: 8 }],
};
export const CONV_MAIN_ITEM: PrescriptionTemplate = topBackoff('tue_conv', 'conv_dl', 4, 4);

/** V1.9 B안: 화요일 Conventional Main, 금요일 Paused Conventional. 보조 운동은 슬롯 처방(세트 수는 기존과 같음) */
export const DEFAULT_DAYS: ProgramDayTemplate[] = [
  { weekday: 1, label: '월', items: [
    topBackoff('mon_sq', 'comp_squat', 5, 4),
    dp('mon_sng', 'sng_bench', 4, 8, 10, { required: true }),
    dp('mon_dipsv', 'dips_volume', 2, 8, 12, { slotId: 'lower_chest' }),
    dp('mon_row', 'linear_row', 5, 8, 12, { slotId: 'horizontal_pull' }),
    dp('mon_lat', 'cable_lateral', 3, 12, 20, { slotId: 'lateral_delt' }),
    dp('mon_legext', 'leg_ext', 3, 10, 15, { slotId: 'knee_extension' }),
  ] },
  { weekday: 2, label: '화', items: [
    topBackoff('tue_conv', 'conv_dl', 4, 4),
    topBackoff('tue_pull', 'pullup_strength', 5, 2),
    dp('tue_row', 'linear_row', 4, 10, 12, { slotId: 'horizontal_pull' }),
    dp('tue_legcurl', 'leg_curl', 2, 10, 15, { slotId: 'knee_flexion' }),
    dp('tue_hlr', 'hlr', 3, 10, 15, { slotId: 'abs' }),
  ] },
  { weekday: 3, label: '수', items: [
    topBackoff('wed_bp', 'comp_bench', 5, 4),
    dp('wed_hsq', 'highbar_squat', 4, 8, 10, { required: true, targetRpe: 7, targetRpeMin: 6.5, targetRpeMax: 7, note: '고강도보다 볼륨. 첫 세트 약 @6.5~7' }),
    dp('wed_incline', 'incline_machine', 2, 8, 12, { required: true, note: '필수 유지', slotId: 'upper_chest' }),
    dp('wed_rpd', 'rev_pec_deck', 3, 12, 20, { slotId: 'posterior_delt' }),
    dp('wed_legcurl', 'leg_curl', 3, 10, 15, { slotId: 'knee_flexion' }),
  ] },
  { weekday: 4, label: '목', items: [
    topBackoff('thu_dips', 'dips_strength', 5, 2),
    dp('thu_larsen', 'larsen_bench', 4, 8, 10, { required: true }),
    dp('thu_lat', 'cable_lateral', 4, 12, 20, { slotId: 'lateral_delt' }),
    dp('thu_tri', 'oh_triceps', 2, 10, 15, { slotId: 'triceps' }),
  ] },
  { weekday: 5, label: '금', items: [
    PAUSED_CONV_ITEM,
    dp('fri_rdl', 'rdl', 2, 8, 10, { required: true, dpCriterion: 'last_set', targetRpe: 7, targetRpeMin: 6.5, targetRpeMax: 7.5, note: 'Paused Conventional 다음 후면사슬 보조. 데드리프트 중량과 연동하지 않음' }),
    dp('fri_pullv', 'pullup_volume', 3, 8, 12, { slotId: 'vertical_pull' }),
    dp('fri_hlr', 'hlr', 3, 10, 15, { slotId: 'abs' }),
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
  meetDate: '2026-11-29',
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

/** 예전 버전에서 만든 운동 목록에 새 기본 속성(환산 기준, 중량 단위 등)을 채운다. 사용자가 바꾼 값은 건드리지 않는다 */
export const exerciseDefaultsPatch = (existing: Record<string, Exercise>): Exercise[] => {
  const keys = ['variationOf', 'relatedOf', 'loadUnit', 'bodyweightOnly', 'category', 'slotIds', 'movement', 'equipment', 'fixed', 'pause', 'repRange', 'unilateral', 'primaryMuscles', 'secondaryMuscles'] as const;
  const out: Exercise[] = [];
  for (const d of DEFAULT_EXERCISES) {
    const cur = existing[d.id];
    if (!cur) continue;
    const add: Partial<Exercise> = {};
    for (const k of keys) if (cur[k] === undefined && d[k] !== undefined) (add as Record<string, unknown>)[k] = d[k];
    if (Object.keys(add).length) out.push({ ...cur, ...add });
  }
  return out;
};
