// ARM JSON 가져오기 검증·정규화 (SRS FR-070). 파일은 사용자가 브라우저에서 직접 선택하며 번들에 포함하지 않는다.
import type { ArmData, ArmPrescription } from '../domain/types';
import { isArmOverlapExercise } from '../domain/defaults';

export const ARM_MAX_BYTES = 5 * 1024 * 1024;

export interface ArmImportResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  data?: ArmData;
  summary?: { total: number; active: number; excluded: number; sourceMissing: number; days: number; blocks: string[] };
}

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const numOrNull = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => str(x, 80)).slice(0, 10) : []);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export const parseArmJson = (text: string, now: string): ArmImportResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (text.length > ARM_MAX_BYTES) return { ok: false, errors: ['파일이 너무 큽니다(최대 5MB)'], warnings };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch { return { ok: false, errors: ['JSON 형식이 아닙니다'], warnings }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['최상위 구조가 올바르지 않습니다'], warnings };
  const version = str(raw.schema_version, 20);
  if (!/^1\.\d+\.\d+$/.test(version)) errors.push(`지원하지 않는 schema_version: "${version || '없음'}" (1.x.x 필요)`);
  const list = raw.exercises;
  if (!Array.isArray(list) || list.length === 0 || list.length > 5000) errors.push('exercises 배열이 없거나 크기가 올바르지 않습니다');
  if (errors.length) return { ok: false, errors, warnings };

  const schedule = (raw.schedule ?? {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const exercises: ArmPrescription[] = [];
  (list as Record<string, unknown>[]).forEach((e, idx) => {
    const id = str(e?.id, 80);
    const block = str(e?.block, 60);
    const week = numOrNull(e?.week, 1, 52);
    const day = numOrNull(e?.day, 1, 7);
    const order = numOrNull(e?.order, 1, 50);
    const exercise = str(e?.exercise, 80);
    if (!id || !block || week === null || day === null || order === null || !exercise) { errors.push(`항목 ${idx + 1}: 필수 필드(id/block/week/day/order/exercise) 누락`); return; }
    if (seen.has(id)) { errors.push(`중복 ID: ${id}`); return; }
    seen.add(id);
    const sets = numOrNull(e.sets, 1, 30);
    const reps = numOrNull(e.reps, 1, 200);
    const dur = numOrNull(e.duration_seconds, 1, 600);
    const rpe = numOrNull(e.rpe, 5, 10);
    const pct = numOrNull(e.percent_1rm, 1, 120);
    const rr = Array.isArray(e.rpe_range) && e.rpe_range.length === 2 && e.rpe_range.every((x) => typeof x === 'number' && x >= 5 && x <= 10)
      ? [e.rpe_range[0], e.rpe_range[1]] as [number, number] : null;
    // 누락 여부는 파일의 표시를 믿지 않고 값으로 다시 판정(불명확한 수치를 임의로 채우지 않음)
    const missing: string[] = [];
    if (sets === null || (reps === null && dur === null)) missing.push('sets_reps');
    if (rpe === null && rr === null && pct === null) missing.push('intensity');
    exercises.push({
      id, block, week, day, order, source_page: numOrNull(e.source_page, 1, 999) ?? 0,
      prescription_source: str(e.prescription_source, 300), exercise, exercise_key: slug(exercise),
      load_note: str(e.load_note, 40) || null, rom: str(e.rom, 40) || null, execution: strList(e.execution), notes: strList(e.notes),
      is_static: e.is_static === true || dur !== null, sets, reps, duration_seconds: dur, percent_1rm: pct, rpe, rpe_range: rr,
      source_missing: missing, filtered_from_integrated_program: isArmOverlapExercise(exercise),
      verification_status: str(e.verification_status, 40) || 'unknown',
    });
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 20), warnings };

  const blocksInData = [...new Set(exercises.map((e) => e.block))];
  const declared = Array.isArray(schedule.block_order) ? strList(schedule.block_order).filter((b) => blocksInData.includes(b)) : [];
  const blockOrder = [...declared, ...blocksInData.filter((b) => !declared.includes(b))];
  const days = new Set(exercises.map((e) => `${e.block}|${e.week}|${e.day}`)).size;
  const sourceMissing = exercises.filter((e) => e.source_missing.length && !e.filtered_from_integrated_program).length;
  if (version.startsWith('1.0.')) warnings.push('v1.0 추출본입니다. 운동명 오타와 미검수 항목이 남아 있을 수 있어 v1.1 정정본 사용을 권장합니다');
  if (days !== 108) warnings.push(`훈련일 수가 ${days}일입니다(원본 기준 108일)`);
  if (sourceMissing) warnings.push(`원본 누락 ${sourceMissing}건은 자동 추정하지 않고 '직접 입력 필요'로 표시합니다`);
  const videoLibrary = (Array.isArray(raw.video_library) ? raw.video_library : []).slice(0, 60)
    .map((v: Record<string, unknown>) => ({ id: str(v?.id, 60), title: str(v?.title, 80), source_page: numOrNull(v?.source_page, 1, 999) ?? 0 }))
    .filter((v: { id: string; title: string }) => v.id && v.title);
  const data: ArmData = {
    schemaVersion: version, importedAt: now, blockOrder,
    guidelines: (raw.program_guidelines && typeof raw.program_guidelines === 'object' ? JSON.parse(JSON.stringify(raw.program_guidelines)) : {}) as Record<string, unknown>,
    videoLibrary, exercises,
  };
  const excluded = exercises.filter((e) => e.filtered_from_integrated_program).length;
  return { ok: true, errors, warnings, data, summary: { total: exercises.length, active: exercises.length - excluded, excluded, sourceMissing, days, blocks: blockOrder } };
};
