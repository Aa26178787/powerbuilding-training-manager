// 운동 라이브러리: 운동 추가·수정, 즐겨찾기, 검색
import type { Db, Exercise, EquipmentType, Patch, Pattern } from '../domain/types';
import { allSlots, CATEGORIES, MUSCLE_NAMES } from '../domain/slots';
import { Ctx, fail } from './ctx';

export interface ExerciseDraft {
  id?: string;
  name: string;
  category: string;
  slotId: string | null;
  equipment: EquipmentType;
  increment: number;
  loadStep?: number;
  repRange?: [number, number];
  primaryMuscles: string[];
  secondaryMuscles: string[];
  unilateral: boolean;
  pause?: { position: string; seconds: number };
}

const MUSCLE_IDS = new Set(MUSCLE_NAMES.map((m) => m[0]));
/** 슬롯에서 중복 경고에 쓰는 동작 계열 */
const PATTERN_OF_SLOT: Record<string, Pattern> = {
  upper_chest: 'chest_acc', mid_chest: 'chest_acc', lower_chest: 'chest_acc', horizontal_pull: 'row', vertical_pull: 'pullup', upper_traps: 'traps',
  anterior_delt: 'delts', lateral_delt: 'delts', posterior_delt: 'delts', biceps: 'biceps', triceps: 'triceps', brachialis: 'biceps',
  wrist_flexors: 'forearms', wrist_extensors: 'forearms', pronation: 'forearms', supination: 'forearms', grip: 'forearms',
  knee_extension: 'quads', knee_flexion: 'hams', hip_hinge: 'hinge', hip_extension: 'glutes', hip_abduction: 'glutes', hip_adduction: 'adductors',
  gastrocnemius: 'calves', soleus: 'calves', abs: 'core', obliques: 'core', anti_extension: 'core', anti_rotation: 'core', spinal_erectors: 'erectors',
};

/** 운동 추가·수정. 고정 운동의 처방·진행 방식은 바꾸지 않고, 이름·분류·장비·근육 정보만 고친다 */
export const saveExercise = (db: Db, d: ExerciseDraft, ctx: Ctx): Patch => {
  const name = d.name.trim().slice(0, 60);
  if (!name) fail('운동 이름을 넣으세요');
  if (!CATEGORIES.some((c) => c.id === d.category)) fail('Category를 고르세요');
  if (d.slotId && !allSlots(db).some((s) => s.id === d.slotId && s.categoryId === d.category)) fail('Slot이 Category와 맞지 않습니다');
  if (!(d.increment > 0 && d.increment <= 20)) fail('증량 단위를 확인하세요');
  if (d.loadStep !== undefined && !(d.loadStep > 0 && d.loadStep <= 20)) fail('중량 단위를 확인하세요');
  if (d.repRange && !(d.repRange[0] >= 1 && d.repRange[1] >= d.repRange[0] && d.repRange[1] <= 50)) fail('반복수 범위를 확인하세요');
  if (![...d.primaryMuscles, ...d.secondaryMuscles].every((m) => MUSCLE_IDS.has(m))) fail('알 수 없는 근육입니다');
  if (!d.primaryMuscles.length) fail('주요 근육군을 하나 이상 고르세요');
  if (d.pause && !(d.pause.seconds >= 0 && d.pause.seconds <= 10)) fail('정지 시간을 확인하세요');
  const dup = Object.values(db.exercises).find((e) => e.id !== d.id && !e.archived && e.name.toLowerCase() === name.toLowerCase());
  if (dup) fail('같은 이름의 운동이 있습니다');
  const prev = d.id ? db.exercises[d.id] : undefined;
  if (d.id && !prev) fail('운동을 찾을 수 없습니다');
  const slotIds = prev?.fixed && prev.slotIds ? prev.slotIds : d.slotId ? [d.slotId, ...(prev?.slotIds ?? []).filter((x) => x !== d.slotId)] : (prev?.slotIds ?? []);
  const base: Exercise = prev ?? {
    id: `custom_${ctx.newId()}`, name, role: 'accessory', pattern: (d.slotId && PATTERN_OF_SLOT[d.slotId]) || 'other', increment: d.increment,
    rounding: 'down', loadMode: 'external', barbell: d.equipment === 'barbell', custom: true,
  };
  const next: Exercise = {
    ...base, name, category: d.category, slotIds, equipment: d.equipment, increment: d.increment,
    loadStep: d.loadStep, repRange: d.repRange, primaryMuscles: d.primaryMuscles, secondaryMuscles: d.secondaryMuscles.filter((m) => !d.primaryMuscles.includes(m)),
    unilateral: d.unilateral || undefined,
    loadUnit: base.loadUnit ?? (d.equipment === 'dumbbell' ? 'per_hand' : d.equipment === 'machine' || d.equipment === 'cable' ? 'machine' : undefined),
    ...(d.pause ? { pause: { position: d.pause.position.trim().slice(0, 80), seconds: d.pause.seconds } } : {}),
  };
  if (!prev && next.equipment === 'bodyweight') next.bodyweightOnly = true;
  return { put: { exercises: [next] } };
};

export const toggleFavorite = (db: Db, exerciseId: string): Patch => {
  const f = new Set(db.settings.favorites ?? []);
  if (f.has(exerciseId)) f.delete(exerciseId); else f.add(exerciseId);
  return { settings: { favorites: [...f] } };
};

/** 검색: 이름·슬롯·Category·근육 이름 */
export const searchExercises = (db: Db, q: string): Exercise[] => {
  const t = q.trim().toLowerCase();
  const slots = allSlots(db);
  return Object.values(db.exercises).filter((e) => !e.archived && e.role !== 'arm').filter((e) => {
    if (!t) return true;
    const hay = [e.name, CATEGORIES.find((c) => c.id === e.category)?.name ?? '', ...(e.slotIds ?? []).map((id) => slots.find((s) => s.id === id)?.name ?? ''),
      ...[...(e.primaryMuscles ?? []), ...(e.secondaryMuscles ?? [])].map((m) => MUSCLE_NAMES.find((x) => x[0] === m)?.[1] ?? '')].join(' ').toLowerCase();
    return hay.includes(t);
  });
};
