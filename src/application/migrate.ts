// 한 번만 실행하는 데이터 변환. 수행 기록·계수·ARM 데이터는 건드리지 않는다.
import type { Db, Exercise, Patch, PrescriptionTemplate, ProgramDayTemplate, ProgramVersion } from '../domain/types';
import { CONV_MAIN_ITEM, DEFAULT_EXERCISES, PAUSED_CONV_ITEM } from '../domain/defaults';
import { dropUntouchedFuture, nextEffectiveFrom } from './plan';
import { Ctx } from './ctx';

export const MIGRATION_V19B = 'v19b-conv-slots';

/** 예전 보조 운동 → 슬롯과 기본 선택 운동 */
const SLOT_OF: Record<string, { slotId: string; exerciseId: string }> = {
  incline_db: { slotId: 'upper_chest', exerciseId: 'incline_machine' },
  cs_row: { slotId: 'horizontal_pull', exerciseId: 'linear_row' },
  cable_lateral: { slotId: 'lateral_delt', exerciseId: 'cable_lateral' },
  rev_pec_deck: { slotId: 'posterior_delt', exerciseId: 'rev_pec_deck' },
  oh_triceps: { slotId: 'triceps', exerciseId: 'oh_triceps' },
  leg_ext: { slotId: 'knee_extension', exerciseId: 'leg_ext' },
  leg_curl: { slotId: 'knee_flexion', exerciseId: 'leg_curl' },
  hlr: { slotId: 'abs', exerciseId: 'hlr' },
  dips_volume: { slotId: 'lower_chest', exerciseId: 'dips_volume' },
  pullup_volume: { slotId: 'vertical_pull', exerciseId: 'pullup_volume' },
};

/**
 * 요일 구성 변환(순수 함수): 화요일 Sumo Top+Backoff → Conventional Main, 금요일 Conventional Straight → Paused Conventional,
 * 보조 운동 → 슬롯 처방. 세트 수는 바꾸지 않는다(금요일 데드리프트만 명세대로 3세트로 시작).
 */
export const transformDaysV19B = (days: ProgramDayTemplate[]): ProgramDayTemplate[] => {
  const out = structuredClone(days);
  for (const d of out) {
    d.items = d.items.map((it): PrescriptionTemplate => {
      if (it.exerciseId === 'comp_sumo' && it.model === 'top_backoff') return { ...structuredClone(CONV_MAIN_ITEM), required: it.required };
      if (it.exerciseId === 'conv_dl' && it.model === 'straight_linear') return structuredClone(PAUSED_CONV_ITEM);
      const m = !it.slotId ? SLOT_OF[it.exerciseId] : undefined;
      return m ? { ...it, slotId: m.slotId, exerciseId: m.exerciseId } : it;
    });
    // 금요일 순서: Paused Conventional → RDL → 나머지
    const pi = d.items.findIndex((x) => x.exerciseId === 'paused_conv');
    const ri = d.items.findIndex((x) => x.exerciseId === 'rdl');
    if (pi > -1 && ri > -1 && pi > ri) { const [p] = d.items.splice(pi, 1); d.items.splice(ri, 0, p); }
  }
  return out;
};

/** 새 운동을 라이브러리에 넣고, 예전 기본 운동에 새 속성을 채운다. 사용자가 바꾼 값은 유지 */
const exercisePatch = (db: Db): Exercise[] => {
  const out: Exercise[] = [];
  for (const d of DEFAULT_EXERCISES) {
    const cur = db.exercises[d.id];
    if (!cur) { out.push(d); continue; }
    if (d.id === 'conv_dl' && cur.role === 'strength') {
      // 화요일 메인 리프트가 되므로 이름·역할만 바꾼다(id·기록·진행 상태는 그대로)
      out.push({ ...cur, name: cur.name === 'Conventional Deadlift' ? d.name : cur.name, role: 'comp' });
    }
  }
  return out;
};

export const migrateV19B = (db: Db, ctx: Ctx): Patch | null => {
  if (db.settings.migrations?.includes(MIGRATION_V19B)) return null;
  const exercises = exercisePatch(db);
  const patch: Patch = { put: { exercises }, settings: { migrations: [...(db.settings.migrations ?? []), MIGRATION_V19B] } };
  const latest = Object.values(db.versions).sort((a, b) => b.version - a.version)[0];
  if (latest) {
    const days = transformDaysV19B(latest.days);
    if (JSON.stringify(days) !== JSON.stringify(latest.days)) {
      // 지난 주·이번 주 계획은 그대로 두고, 프로그램 시작 전이면 시작 주부터, 시작 후면 다음 주부터 적용
      const effectiveFrom = nextEffectiveFrom(db, ctx.today, '2000-01-03');
      const version: ProgramVersion = {
        id: `pv-${ctx.newId()}`, name: latest.name, version: latest.version + 1, createdAt: ctx.now, effectiveFrom, days,
        changeNote: 'B안: 화 Conventional Main, 금 Paused Conventional, 보조 운동 슬롯화',
      };
      // 새 운동이 아직 없는 상태에서 계산하지 않도록 exercises를 먼저 반영한 db로 미래 계획을 정리
      const drop = dropUntouchedFuture(db, effectiveFrom);
      patch.put!.versions = [version];
      patch.del = drop.del;
    }
  }
  return patch;
};

/** 예전 기본 이름 → 새 이름(Competition → Comp, Stop-and-go는 Comp 없이). 사용자가 직접 바꾼 이름은 건드리지 않는다 */
const RENAMES: Record<string, string> = {
  'Competition Low-bar Squat': 'Comp Low-bar Squat',
  'Competition Paused Bench': 'Comp Paused Bench',
  'Competition Conventional Deadlift': 'Comp Conventional Deadlift',
  'Conventional Deadlift': 'Comp Conventional Deadlift',
  'Competition Sumo Deadlift': 'Comp Sumo Deadlift',
  'Competition Stop-and-go Bench': 'Stop-and-go Bench',
};

/** 운동 이름과 처방 스냅샷의 표시 이름만 바꾼다(id·기록은 그대로). 바꿀 것이 없으면 null */
export const migrateNames = (db: Db): Patch | null => {
  const exercises = Object.values(db.exercises).filter((e) => RENAMES[e.name] && (e.name !== 'Conventional Deadlift' || e.id === 'conv_dl')).map((e) => ({ ...e, name: RENAMES[e.name] }));
  const instances = Object.values(db.instances).filter((i) => RENAMES[i.exerciseName] && (i.exerciseName !== 'Conventional Deadlift' || i.exerciseId === 'conv_dl'))
    .map((i) => ({ ...i, exerciseName: RENAMES[i.exerciseName], rev: i.rev + 1 }));
  return exercises.length || instances.length ? { put: { exercises, instances } } : null;
};
