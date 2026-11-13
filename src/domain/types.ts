import type { Rounding } from '../engine/rounding';
// 도메인 타입 정의 — UI/저장소와 무관한 순수 데이터 구조

export type ISODate = string; // 'YYYY-MM-DD' (설정 시간대 기준 달력 날짜)
export type ISODateTime = string; // ISO 8601 타임스탬프
export type Track = 'pb' | 'arm'; // 파워빌딩 / ARM SYSTEM

export type SetType = 'top' | 'backoff' | 'straight' | 'volume' | 'arm' | 'arm_static';
export type PerformedType = SetType | 'warmup' | 'extra';
export type ProgressionModel = 'top_backoff' | 'straight_linear' | 'double_progression' | 'arm_manual';
export type ExerciseRole = 'comp' | 'strength' | 'variation' | 'accessory' | 'arm';
export type Pattern =
  | 'squat' | 'bench' | 'hinge' | 'dips' | 'pullup' | 'row'
  | 'chest_acc' | 'delts' | 'quads' | 'hams' | 'core' | 'triceps' | 'biceps' | 'forearms' | 'glutes' | 'adductors' | 'calves' | 'traps' | 'erectors' | 'arm' | 'other';

/** 장비 유형. 같은 이름이라도 장비가 다르면 다른 운동으로 등록해 기록·진행을 따로 둔다 */
export type EquipmentType = 'barbell' | 'dumbbell' | 'machine' | 'plate_loaded' | 'cable' | 'smith' | 'bodyweight' | 'other';

export interface Exercise {
  id: string;
  name: string;
  role: ExerciseRole;
  pattern: Pattern;
  /** 증량 및 반올림 단위(kg) */
  increment: number;
  /** 예전 반올림 설정(무시). 지금은 roundingOverride와 설정의 종류별 정책을 쓴다 */
  rounding: Rounding;
  /** 운동별 반올림 지정. 비우면 설정의 세트 종류별 정책을 따른다 */
  roundingOverride?: 'nearest' | 'floor' | 'ceil';
  /** 사용 가능한 중량 단위(kg). 증량 단위(increment)와 별개. 비우면 increment */
  loadStep?: number;
  /** bodyweight_plus: 체중 + 추가 중량(딥스·풀업). weight 필드는 추가 중량만 저장 */
  loadMode: 'external' | 'bodyweight_plus';
  barbell: boolean;
  /** Variation 시작 중량 산출 기준(Comp 종목과 기본 계수) */
  variationOf?: { compExerciseId: string; kBase: number };
  /** 같은 동작의 다른 처방(예: 딥스 Volume ← 딥스 Strength). 자기 기록이 없을 때만 임시 추정에 쓴다 */
  relatedOf?: { exerciseId: string; kBase: number };
  /** 덤벨 한 손 중량, 머신 스택 표시값, 그 외 총중량 */
  loadUnit?: 'total' | 'per_hand' | 'machine';
  /** 외부 중량 없이 반복수로 진행(Hanging Leg Raise) */
  bodyweightOnly?: boolean;
  /** 근육군별 세트 가중치(주동근 1.0, 보조근 0.5 근사). 없으면 기본표 사용 */
  muscles?: Record<string, number>;
  /** 주동근·보조근(가중치 1.0 / 0.5). 있으면 muscles보다 우선 */
  primaryMuscles?: string[];
  secondaryMuscles?: string[];
  /** 라이브러리 분류(Category). 운동이 들어갈 수 있는 슬롯은 slotIds */
  category?: string;
  slotIds?: string[];
  /** 운동 패턴 집계용 키(슬롯이 없는 고정 운동: squat, bench_press, deadlift 등) */
  movement?: string;
  equipment?: EquipmentType;
  /** 권장 반복수 범위(선택) */
  repRange?: [number, number];
  /** 한쪽씩 하는 운동 */
  unilateral?: boolean;
  /** V1.9 고정 운동(슬롯 교체 대상이 아님) */
  fixed?: boolean;
  /** 정지 변형의 정지 위치·시간(Paused Conventional 등). 사용자가 바꿀 수 있다 */
  pause?: { position: string; seconds: number };
  /** 사용자가 만든 운동 */
  custom?: boolean;
  archived?: boolean;
}

/** 프로그램 템플릿의 세트 묶음. 표기: count 세트 × reps(또는 repMin~repMax)회 */
export interface SetGroupSpec {
  type: SetType;
  count: number;
  reps?: number;
  repMin?: number;
  repMax?: number;
  seconds?: number;
  targetRpe?: number;
  targetRpeMin?: number;
  targetRpeMax?: number;
  rpeCap: number;
}

export interface PrescriptionTemplate {
  id: string;
  /** 슬롯 처방이면 기본 선택 운동. 실제 운동은 슬롯 배정(settings.slotAssignments)을 따른다 */
  exerciseId: string;
  /** 근비대 보조 슬롯(Upper Chest 등). 없으면 고정 운동 */
  slotId?: string;
  model: ProgressionModel;
  groups: SetGroupSpec[];
  required: boolean;
  /** Double Progression 증량 판정 기준 */
  dpCriterion?: 'all_sets' | 'last_set';
  note?: string;
}

export interface ProgramDayTemplate {
  /** 1=월 … 7=일 */
  weekday: number;
  label: string;
  items: PrescriptionTemplate[];
}

export interface ProgramVersion {
  id: string;
  name: string;
  version: number;
  createdAt: ISODateTime;
  /** 이 주(월요일)부터 적용 */
  effectiveFrom: ISODate;
  days: ProgramDayTemplate[];
  changeNote?: string;
}

export type WorkoutClose = 'completed' | 'partial' | 'missed' | 'excused' | 'cancelled';

/** 원본 세션(계획 단위). 날짜가 옮겨져도 originalDate는 불변 */
export interface Workout {
  id: string;
  track: Track;
  label: string;
  originalDate: ISODate;
  versionId?: string;
  arm?: { block: string; week: number; day: number; dayIndex: number };
  closedAs: WorkoutClose | null;
  closedAt?: ISODateTime;
  rev: number;
}

export interface ArmInstanceInfo {
  prescriptionId: string;
  sourcePage: number;
  sourceText: string;
  rom: string | null;
  execution: string[];
  notes: string[];
  loadNote: string | null;
  percent1rm: number | null;
  rpe: number | null;
  rpeRange: [number, number] | null;
  sourceMissing: string[];
  /** 원본 누락값을 사용자가 직접 채웠는지 */
  userFilled?: boolean;
}

/** 한 세션 안의 한 운동 처방(스냅샷). 이동해도 id 불변 */
export interface PrescriptionInstance {
  id: string;
  workoutId: string;
  track: Track;
  exerciseId: string;
  exerciseName: string;
  /** 슬롯 처방이면 슬롯 id. 운동을 바꿔도 슬롯과 처방(세트·반복·RPE)은 그대로 */
  slotId?: string;
  order: number;
  model: ProgressionModel;
  groups: SetGroupSpec[];
  required: boolean;
  dpCriterion?: 'all_sets' | 'last_set';
  originalDate: ISODate;
  arm?: ArmInstanceInfo;
  rev: number;
}

export type PlannedStatus =
  | 'planned' | 'done' | 'skipped' | 'skipped_by_autoregulation' | 'excused' | 'removed';

export interface PlannedSet {
  id: string;
  instanceId: string;
  workoutId: string;
  track: Track;
  exerciseId: string;
  index: number;
  type: SetType;
  reps?: number;
  repMin?: number;
  repMax?: number;
  seconds?: number;
  targetRpe?: number;
  targetRpeMax?: number;
  rpeCap: number;
  originalDate: ISODate;
  /** 현재 수행 예정일(이동·병합 시 변경) */
  plannedDate: ISODate;
  status: PlannedStatus;
  /** 기간 시작 스냅샷에 있던 세트인지(false = 이후 승인된 추가 세트) */
  inOriginalPlan: boolean;
  statusReason?: string;
  rev: number;
}

export type IssueFlag =
  | 'equipment_failure' | 'grip_slip' | 'j_cup_collision' | 'unusual_shoes'
  | 'range_of_motion_changed' | 'technique_breakdown' | 'pain'
  | 'exceptional_fatigue' | 'merged_session' | 'other';

export type Side = 'L' | 'R' | 'both';

export interface PerformedSet {
  id: string;
  plannedSetId: string | null;
  instanceId: string | null;
  sessionId: string;
  exerciseId: string;
  type: PerformedType;
  /** external: 바벨·기구 중량 / bodyweight_plus: 추가 중량(kg). 미기록 가능 */
  weight: number | null;
  bodyweight?: number;
  reps?: number;
  seconds?: number;
  rpe?: number;
  side: Side | null;
  flags: IssueFlag[];
  note?: string;
  performedAt: ISODateTime;
  /** 귀속 훈련일(세션 시작일 또는 사용자가 선택한 계획일) */
  sessionDate: ISODate;
  recommendationId?: string;
  /** 밴드·어시스트 머신 보조. 외부 추가 중량과 같은 값으로 취급하지 않는다(e1RM·진행 판정 제외) */
  assist?: 'band' | 'machine';
  deleted?: boolean;
  rev: number;
}

export interface Session {
  id: string;
  date: ISODate;
  startedAt: ISODateTime;
  endedAt?: ISODateTime;
  bodyweight?: number;
  status: 'in_progress' | 'ended';
  rev: number;
}

export interface Recommendation {
  id: string;
  kind: 'top_start' | 'backoff' | 'next_set' | 'variation_start' | 'progression' | 'related_start' | 'calibration' | 'arm_percent' | 'bodyweight_only';
  /** 산출 방법과 신뢰도(참고 기록 있음 / 추정치 / 기록 없음) */
  method?: string;
  confidence?: 'record' | 'estimate' | 'none';
  /** 추천과 다른 중량으로 수행했을 때 사용자가 고른 사유(선택) */
  editReason?: string;
  exerciseId: string;
  instanceId?: string;
  plannedSetId?: string;
  algorithmVersion: string;
  inputs: Record<string, unknown>;
  rawLoad: number | null;
  roundedLoad: number | null;
  acceptedLoad?: number | null;
  message: string;
  createdAt: ISODateTime;
}

export type ProgressionAction = 'increase' | 'hold' | 'hold_or_reduce' | 'review' | 'not_counted';

export interface ProgressionDecisionFastTrack {
  applied: boolean;
  /** 보정에 쓴 Top Set 기록. 같은 기록으로 두 번 보정하지 않는다 */
  sourceId: string;
  base: number;
  rtsLoad: number | null;
  cap: number | null;
  raw: number;
  rounded: number;
  rounding: string;
  step: number;
}

export interface ProgressionDecision {
  fastTrack?: ProgressionDecisionFastTrack;
  action: ProgressionAction;
  nextLoad: number | null;
  failStreak: number;
  reason: string;
  /** 2회 연속 미달 시 제시하는 감량 후보(사용자 승인 필요) */
  reduceOptions?: { pct: number; load: number }[];
  decidedAt: ISODateTime;
  instanceId: string;
  /** 이 판정 직전의 연속 미달 횟수(재판정 시 이중 가산 방지) */
  prevFailStreak?: number;
}

export interface FirstSessionSummary {
  date: ISODate;
  recommendedLoad: number | null;
  method: string;
  confidence: 'record' | 'estimate' | 'none';
  baseExerciseId?: string;
  kBase?: number;
  kIndividual?: number;
  actualLoad: number | null;
  modified: boolean;
  sets: { weight: number | null; reps?: number; seconds?: number; rpe?: number }[];
  nextLoad: number | null;
  action: ProgressionAction | null;
}

export interface ExerciseState {
  exerciseId: string;
  /** 다음 세션 추천 작업 중량(Top/Straight/DP 공통) */
  nextLoad: number | null;
  failStreak: number;
  /** 개인 보정계수(P0에서는 1.000 고정, 학습은 P1) */
  k: number;
  /** 첫 실행 시 입력한 기준 기록 */
  seed?: { weight: number; reps: number; rpe: number; bodyweight?: number };
  /** 머신·케이블 장비 정보(같은 이름이라도 기구가 다르면 중량이 다르다) */
  equipment?: { id?: string; unit?: 'kg' | 'lb'; pinStep?: number; note?: string };
  /** 첫 세션 요약: 최초 추천과 실제 수행, 진행 시작 상태 */
  firstSession?: FirstSessionSummary;
  lastDecision?: ProgressionDecision;
  updatedAt: ISODateTime;
}

export type ChangeType =
  | 'move' | 'swap' | 'merge' | 'split' | 'defer' | 'excuse' | 'skip'
  | 'remove_duplicate' | 'reduce_sets' | 'add_sets' | 'arm_assign' | 'reorder';

export type ChangeReason =
  | 'gym_closed' | 'unavoidable_personal' | 'travel' | 'health_issue' | 'user_choice' | 'other';

export interface ScheduleWarning {
  code: string;
  severity: 'info' | 'warn' | 'approval';
  message: string;
  date?: ISODate;
}

export interface SetPatch {
  id: string;
  before: Partial<Pick<PlannedSet, 'plannedDate' | 'status' | 'statusReason'>>;
  after: Partial<Pick<PlannedSet, 'plannedDate' | 'status' | 'statusReason'>>;
}

export interface ScheduleChange {
  id: string;
  type: ChangeType;
  reason: ChangeReason;
  note?: string;
  createdAt: ISODateTime;
  approvedAt: ISODateTime;
  setPatches: SetPatch[];
  /** 이 변경으로 새로 만든 세트(추가 세트). 취소 시 removed 처리 */
  createdSetIds: string[];
  orderPatches: { instanceId: string; before: number; after: number }[];
  warnings: ScheduleWarning[];
  summary: string;
  undoneAt?: ISODateTime;
}

/** 개인화 계수 관측 기록. k 자체는 저장하지 않고 이 기록들을 시간순으로 다시 계산해 얻는다 */
export interface CoefficientRecord {
  id: string;
  exerciseId: string;
  kind: 'observation' | 'manual' | 'reset';
  at: ISODateTime;
  sessionDate?: ISODate;
  instanceId?: string;
  /** 기준 e1RM(Top Set 보수적 e1RM, 또는 Comp e1RM × k_base) */
  refE1rm?: number;
  /** 관측 세트(첫 Backoff 또는 Variation 대표 세트). 추가 중량 운동은 체중 포함 부하 */
  obsLoad?: number;
  obsReps?: number;
  obsRpe?: number;
  rpeCap?: number;
  /** 자동 판정: 비정상 조건이면 false(학습 제외 후보) */
  autoValid?: boolean;
  excludedReason?: string;
  /** 사용자가 직접 포함/제외를 지정 */
  override?: 'include' | 'exclude' | null;
  /** kind=manual일 때 사용자가 지정한 계수 */
  manualK?: number;
}

export interface ArmPrescription {
  id: string;
  block: string;
  week: number;
  day: number;
  order: number;
  source_page: number;
  prescription_source: string;
  exercise: string;
  exercise_key: string;
  load_note: string | null;
  rom: string | null;
  execution: string[];
  notes: string[];
  is_static: boolean;
  sets: number | null;
  reps: number | null;
  duration_seconds: number | null;
  percent_1rm: number | null;
  rpe: number | null;
  rpe_range: [number, number] | null;
  source_missing: string[];
  filtered_from_integrated_program: boolean;
  verification_status: string;
}

export interface ArmVideoCategory { id: string; title: string; source_page: number }

export interface ArmData {
  schemaVersion: string;
  importedAt: ISODateTime;
  blockOrder: string[];
  guidelines: Record<string, unknown>;
  videoLibrary: ArmVideoCategory[];
  exercises: ArmPrescription[];
}

/** 사용자가 원본 페이지를 보고 교정한 값. OCR 원문은 덮어쓰지 않는다 */
export interface ArmOverride {
  id: string;
  sets?: number | null;
  reps?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
  verifiedBy: string;
  verifiedAt: ISODateTime;
  sourcePage: number;
  note?: string;
}

export interface ArmVideoLink { id: string; url: string; updatedAt: ISODateTime }

export interface AuditEvent {
  id: string;
  at: ISODateTime;
  entity: string;
  entityId: string;
  op: 'create' | 'update' | 'delete' | 'restore';
  prev?: unknown;
  next?: unknown;
}

export interface Settings {
  timezone: string;
  unit: 'kg';
  bodyweight: number | null;
  barWeight: number;
  /** 보유 원판(kg, 한쪽에 끼울 수 있는 종류) */
  plates: number[];
  /** 세트 종류별 반올림 정책(Top·Backoff·최초·Fast-track·감량·세트 중 증량) */
  roundingPolicy?: Partial<Record<'top' | 'backoff' | 'start' | 'fast_track' | 'reduce' | 'next_set', 'nearest' | 'floor' | 'ceil'>>;
  /** Fast-track 상한: 지난 작업 중량 대비 최대 증량 비율 */
  fastTrackMaxPct?: number;
  /** ARM 운동별 기준 1RM(kg). PDF %1RM 처방을 계산할 때만 쓴다 */
  armOneRm?: Record<string, number>;
  /** 대회 날짜. 홈에 남은 날을 보여 준다 */
  meetDate?: ISODate | null;
  /** 종류별 보유 쌍 수. 없으면 plates의 종류를 제한 없이 쓴다 */
  plateStock?: { kg: number; pairs: number | null }[];
  /** 프로그램 시작 주(월요일). 이 주부터 주간 계획을 생성 */
  programStart: ISODate | null;
  onboardingDone: boolean;
  armMode: 3 | 2;
  armWeekdays3: number[];
  armWeekdays2: number[];
  armSideMode: 'separate' | 'both';
  /** 다음에 배정할 ARM Day의 순번(0부터, 전체 108일 기준) */
  armCursor: number;
  lastBackupAt: ISODateTime | null;
  backupReminderDays: number;
  theme: 'dark' | 'light' | 'system';
  /** 세션 진행 중 화면 꺼짐 방지(지원 브라우저만) */
  keepAwake: boolean;
  /** 세트 완료 시 진동 피드백(지원 기기만) */
  haptics: boolean;
  /** 세트 완료 후 휴식 타이머 표시 */
  restTimer: boolean;
  /** 저장된 계수 관측이 계산된 e1RM 공식 버전(바뀌면 관측을 다시 계산) */
  formulaVersion?: string;
  /** 개인화 계수 자동 학습(끄면 관측만 기록하고 k는 그대로) */
  emaEnabled: boolean;
  /** Backoff 세트 간 예상 RPE 상승폭(다음 세트 상한 초과 예측용, 조정 가능) */
  rpeDriftPerSet: number;
  /** P1 EMA 설정(초기 설계값) */
  ema: { lambdaStrength: number; lambdaVariation: number; clampPct: number };
  /** 슬롯별 현재 선택 운동 */
  slotAssignments?: Record<string, ExerciseAssignment>;
  /** 사용자가 만든 슬롯 */
  customSlots?: TrainingSlot[];
  /** 즐겨찾기 운동 id */
  favorites?: string[];
  /** 한 번만 실행하는 데이터 변환 기록 */
  migrations?: string[];
}

/** 근육군 묶음(Chest, Back, Delts …) */
export interface ExerciseCategory { id: string; name: string; order: number }
/** 운동 슬롯: 훈련 목적(부위·패턴). 처방은 프로그램 항목(SlotPrescription)이 가진다 */
export interface TrainingSlot { id: string; name: string; categoryId: string; group?: string; description: string; custom?: boolean }
/** 슬롯 처방 = 슬롯이 지정된 프로그램 항목 */
export type SlotPrescription = PrescriptionTemplate & { slotId: string };
/** 슬롯에 지금 배정된 실제 운동 */
export interface ExerciseAssignment { slotId: string; exerciseId: string; since: ISODateTime }
/** 운동별 진행 상태(작업 중량·연속 실패·계수). 운동 id마다 독립 */
export type ExerciseProgression = ExerciseState;
/** 운동별 근육 가중치(주동근 1.0, 보조근 0.5) */
export interface ExerciseMuscleWeight { exerciseId: string; muscle: string; weight: number; role: 'primary' | 'secondary' }
/** 운동의 장비 조건 */
export interface Equipment { type: EquipmentType; loadStep?: number; loadUnit?: 'total' | 'per_hand' | 'machine'; detail?: ExerciseState['equipment'] }

export interface Db {
  settings: Settings;
  exercises: Record<string, Exercise>;
  versions: Record<string, ProgramVersion>;
  workouts: Record<string, Workout>;
  instances: Record<string, PrescriptionInstance>;
  plannedSets: Record<string, PlannedSet>;
  performed: Record<string, PerformedSet>;
  sessions: Record<string, Session>;
  recs: Record<string, Recommendation>;
  changes: Record<string, ScheduleChange>;
  exStates: Record<string, ExerciseState>;
  coeffs: Record<string, CoefficientRecord>;
  armOverrides: Record<string, ArmOverride>;
  armLinks: Record<string, ArmVideoLink>;
  audit: Record<string, AuditEvent>;
  arm: ArmData | null;
}

export type CollectionName = Exclude<keyof Db, 'settings' | 'arm'>;

/** 유스케이스가 반환하는 변경 묶음. 저장소가 한 트랜잭션으로 반영한다 */
export interface Patch {
  put?: { [K in CollectionName]?: Db[K][string][] };
  del?: { [K in CollectionName]?: string[] };
  settings?: Partial<Settings>;
  arm?: ArmData | null;
}
