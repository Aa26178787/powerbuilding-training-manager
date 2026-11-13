// 근육군(Category)·운동 슬롯(Training Slot)·근육 이름. 화면 표시는 영어로 통일한다.
import type { Db, Exercise, ExerciseCategory, ExerciseMuscleWeight, TrainingSlot } from './types';

export const CATEGORIES: ExerciseCategory[] = [
  { id: 'chest', name: 'Chest', order: 1 },
  { id: 'back', name: 'Back', order: 2 },
  { id: 'delts', name: 'Delts', order: 3 },
  { id: 'arms', name: 'Arms', order: 4 },
  { id: 'forearms', name: 'Forearms', order: 5 },
  { id: 'legs', name: 'Legs', order: 6 },
  { id: 'core', name: 'Core', order: 7 },
];

const s = (id: string, name: string, categoryId: string, description: string, group?: string): TrainingSlot => ({ id, name, categoryId, description, ...(group ? { group } : {}) });

/** 기본 슬롯. Back의 Horizontal/Vertical Pull은 근육이 아니라 운동 패턴 분류다 */
export const DEFAULT_SLOTS: TrainingSlot[] = [
  s('upper_chest', 'Upper Chest', 'chest', '상부 가슴 강조'),
  s('mid_chest', 'Mid Chest', 'chest', '중부 가슴 강조'),
  s('lower_chest', 'Lower Chest', 'chest', '하부 가슴 강조'),
  s('horizontal_pull', 'Horizontal Pull', 'back', '수평 당기기(운동 패턴)'),
  s('vertical_pull', 'Vertical Pull', 'back', '수직 당기기(운동 패턴)'),
  s('upper_traps', 'Upper Traps', 'back', '상부 승모근 강조'),
  s('anterior_delt', 'Anterior Delt', 'delts', '전면삼각근'),
  s('lateral_delt', 'Lateral Delt', 'delts', '측면삼각근'),
  s('posterior_delt', 'Posterior Delt', 'delts', '후면삼각근'),
  s('biceps', 'Biceps', 'arms', '이두근'),
  s('triceps', 'Triceps', 'arms', '삼두근'),
  s('brachialis', 'Brachialis / Brachioradialis', 'arms', '상완근·상완요골근'),
  s('wrist_flexors', 'Wrist Flexors', 'forearms', '손목 굽힘'),
  s('wrist_extensors', 'Wrist Extensors', 'forearms', '손목 폄'),
  s('pronation', 'Pronation', 'forearms', '회내'),
  s('supination', 'Supination', 'forearms', '회외'),
  s('grip', 'Grip / Finger Flexors', 'forearms', '악력·손가락 굽힘'),
  s('knee_extension', 'Knee Extension', 'legs', '무릎 펴기', 'Quads'),
  s('knee_flexion', 'Knee Flexion', 'legs', '무릎 굽히기', 'Hamstrings'),
  s('hip_hinge', 'Hip Hinge', 'legs', '고관절 접기', 'Hamstrings'),
  s('hip_extension', 'Hip Extension', 'legs', '고관절 펴기', 'Glutes'),
  s('hip_abduction', 'Hip Abduction', 'legs', '고관절 벌리기', 'Glutes'),
  s('hip_adduction', 'Hip Adduction', 'legs', '고관절 모으기', 'Adductors'),
  s('gastrocnemius', 'Gastrocnemius', 'legs', '비복근(무릎 편 상태)', 'Calves'),
  s('soleus', 'Soleus', 'legs', '가자미근(무릎 굽힌 상태)', 'Calves'),
  s('abs', 'Abs', 'core', '복직근'),
  s('obliques', 'Obliques', 'core', '복사근'),
  s('anti_extension', 'Anti-extension', 'core', '허리 젖힘 버티기'),
  s('anti_rotation', 'Anti-rotation', 'core', '회전 버티기'),
  s('spinal_erectors', 'Spinal Erectors', 'core', '척추기립근'),
];

/** 슬롯이 없는 고정 운동의 운동 패턴 이름 */
const MOVEMENT_EXTRA: Record<string, string> = { squat: 'Squat', bench_press: 'Bench Press', deadlift: 'Deadlift' };

export const allSlots = (db: Pick<Db, 'settings'>): TrainingSlot[] => [...DEFAULT_SLOTS, ...(db.settings.customSlots ?? [])];
export const slotById = (db: Pick<Db, 'settings'>, id: string | undefined): TrainingSlot | undefined => (id ? allSlots(db).find((x) => x.id === id) : undefined);
export const categoryName = (id: string | undefined): string => CATEGORIES.find((c) => c.id === id)?.name ?? (id ?? 'Other');
export const movementName = (db: Pick<Db, 'settings'>, key: string): string => slotById(db, key)?.name ?? MOVEMENT_EXTRA[key] ?? key;

/** 근육 이름(영어 표시)과 묶음 */
export const MUSCLE_NAMES: [string, string, string][] = [
  ['chest', 'Chest', 'chest'],
  ['lats', 'Lats', 'back'], ['upper_back', 'Upper Back', 'back'], ['upper_traps', 'Upper Traps', 'back'],
  ['front_delt', 'Anterior Delt', 'delts'], ['side_delt', 'Lateral Delt', 'delts'], ['rear_delt', 'Posterior Delt', 'delts'],
  ['biceps', 'Biceps', 'arms'], ['triceps', 'Triceps', 'arms'], ['brachialis', 'Brachialis', 'arms'],
  ['forearms', 'Forearms', 'forearms'],
  ['quads', 'Quads', 'legs'], ['hams', 'Hamstrings', 'legs'], ['glutes', 'Glutes', 'legs'], ['adductors', 'Adductors', 'legs'], ['abductors', 'Abductors', 'legs'], ['calves', 'Calves', 'legs'],
  ['abs', 'Abs', 'core'], ['obliques', 'Obliques', 'core'], ['erectors', 'Spinal Erectors', 'core'],
];
export const muscleName = (id: string): string => MUSCLE_NAMES.find((m) => m[0] === id)?.[1] ?? id;

/** 운동의 주동근·보조근 가중치 목록(주동근 1.0, 보조근 0.5) */
export const muscleWeightsOf = (ex: Exercise, fallback: Record<string, number>): ExerciseMuscleWeight[] => {
  if (ex.primaryMuscles?.length || ex.secondaryMuscles?.length) {
    return [
      ...(ex.primaryMuscles ?? []).map((m) => ({ exerciseId: ex.id, muscle: m, weight: 1, role: 'primary' as const })),
      ...(ex.secondaryMuscles ?? []).filter((m) => !ex.primaryMuscles?.includes(m)).map((m) => ({ exerciseId: ex.id, muscle: m, weight: 0.5, role: 'secondary' as const })),
    ];
  }
  return Object.entries(ex.muscles ?? fallback).map(([m, w]) => ({ exerciseId: ex.id, muscle: m, weight: w, role: w >= 1 ? 'primary' as const : 'secondary' as const }));
};

/** 운동 패턴 집계 키: 슬롯 처방이면 슬롯, 아니면 운동의 패턴 */
export const movementOf = (ex: Exercise | undefined, slotId?: string): string => slotId ?? ex?.movement ?? ex?.slotIds?.[0] ?? 'other';

export const EQUIPMENT_NAMES: Record<string, string> = {
  barbell: 'Barbell', dumbbell: 'Dumbbell', machine: 'Machine', plate_loaded: 'Plate-loaded', cable: 'Cable', smith: 'Smith', bodyweight: 'Bodyweight', other: 'Other',
};
