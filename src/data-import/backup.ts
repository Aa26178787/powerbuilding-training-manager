// 백업 내보내기·가져오기(복원). 가져오기 전 스키마·크기·필수 필드를 검증한다.
import type { CollectionName, Db, PrescriptionInstance } from '../domain/types';
import { DEFAULT_SETTINGS, emptyDb } from '../domain/defaults';
import { isISODate } from '../engine/dates';

export const BACKUP_APP_ID = 'powerbuilding-training-manager';
export const BACKUP_SCHEMA = 1;
export const BACKUP_MAX_BYTES = 30 * 1024 * 1024;
export const COLLECTIONS: CollectionName[] = ['exercises', 'versions', 'workouts', 'instances', 'plannedSets', 'performed', 'sessions', 'recs', 'changes', 'exStates', 'coeffs', 'armOverrides', 'armLinks', 'audit'];

export interface BackupFile {
  app: string;
  backupSchema: number;
  exportedAt: string;
  /** ARM 원문·처방 라이브러리 포함 여부(저작권 자료). 파일을 공유·업로드하기 전에 확인 */
  includesArm: boolean;
  notice: string;
  data: Omit<Db, 'arm'> & { arm: Db['arm'] };
}

export const buildBackup = (db: Db, includeArm: boolean, now: string): BackupFile => {
  const data = structuredClone(db);
  if (!includeArm) {
    data.arm = null;
    data.armOverrides = {};
    data.armLinks = {};
    // 수행 기록은 남기되 ARM 원문 텍스트는 지운다
    for (const inst of Object.values(data.instances) as PrescriptionInstance[]) {
      if (inst.arm) inst.arm = { ...inst.arm, sourceText: '', notes: [], execution: [] };
    }
  }
  return {
    app: BACKUP_APP_ID, backupSchema: BACKUP_SCHEMA, exportedAt: now, includesArm: includeArm,
    notice: includeArm ? 'ARM 저작권 자료가 들어 있습니다. 공개 저장소에 올리거나 공유하지 마세요' : 'ARM 원문·처방 라이브러리 제외(수행 기록만 포함)',
    data,
  };
};

export interface BackupCheck {
  ok: boolean;
  errors: string[];
  db?: Db;
  summary?: { exportedAt: string; includesArm: boolean; counts: Record<string, number> };
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const PLANNED_STATUS = ['planned', 'done', 'skipped', 'skipped_by_autoregulation', 'excused', 'removed'];

/** 컬렉션별 필수 필드 검사(가벼운 구조 검증). 문자열은 화면에서 항상 텍스트로만 렌더링된다 */
const REQUIRED: Record<CollectionName, (r: Record<string, unknown>) => boolean> = {
  exercises: (r) => typeof r.id === 'string' && typeof r.name === 'string' && typeof r.increment === 'number' && r.increment > 0,
  versions: (r) => typeof r.id === 'string' && Array.isArray(r.days) && isISODate(r.effectiveFrom),
  workouts: (r) => typeof r.id === 'string' && isISODate(r.originalDate) && (r.track === 'pb' || r.track === 'arm'),
  instances: (r) => typeof r.id === 'string' && typeof r.workoutId === 'string' && typeof r.exerciseId === 'string' && Array.isArray(r.groups),
  plannedSets: (r) => typeof r.id === 'string' && typeof r.instanceId === 'string' && isISODate(r.originalDate) && isISODate(r.plannedDate) && PLANNED_STATUS.includes(r.status as string) && typeof r.inOriginalPlan === 'boolean',
  performed: (r) => typeof r.id === 'string' && typeof r.exerciseId === 'string' && isISODate(r.sessionDate) && (r.weight === null || typeof r.weight === 'number') && Array.isArray(r.flags),
  sessions: (r) => typeof r.id === 'string' && isISODate(r.date) && typeof r.startedAt === 'string',
  recs: (r) => typeof r.id === 'string' && typeof r.exerciseId === 'string',
  changes: (r) => typeof r.id === 'string' && Array.isArray(r.setPatches),
  exStates: (r) => typeof r.exerciseId === 'string' && typeof r.k === 'number',
  coeffs: (r) => typeof r.id === 'string' && typeof r.exerciseId === 'string' && typeof r.at === 'string',
  armOverrides: (r) => typeof r.id === 'string',
  armLinks: (r) => typeof r.id === 'string' && typeof r.url === 'string' && r.url.startsWith('https://'),
  audit: (r) => typeof r.id === 'string' && typeof r.at === 'string',
};

export const parseBackup = (text: string): BackupCheck => {
  if (text.length > BACKUP_MAX_BYTES) return { ok: false, errors: ['파일이 너무 큽니다(최대 30MB)'] };
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch { return { ok: false, errors: ['JSON 형식이 아닙니다'] }; }
  if (!isRec(raw) || raw.app !== BACKUP_APP_ID) return { ok: false, errors: ['이 앱의 백업 파일이 아닙니다'] };
  if (raw.backupSchema !== BACKUP_SCHEMA) return { ok: false, errors: [`지원하지 않는 백업 버전: ${String(raw.backupSchema)}`] };
  const data = raw.data;
  if (!isRec(data) || !isRec(data.settings)) return { ok: false, errors: ['data 또는 settings가 없습니다'] };
  const errors: string[] = [];
  const db = emptyDb() as Db;
  const counts: Record<string, number> = {};
  for (const name of COLLECTIONS) {
    const col = data[name];
    if (col === undefined) continue;
    if (!isRec(col)) { errors.push(`${name}: 구조가 올바르지 않습니다`); continue; }
    const entries = Object.entries(col);
    const bad = entries.filter(([, r]) => !isRec(r) || !REQUIRED[name](r)).length;
    if (bad) errors.push(`${name}: 필수 필드가 없거나 형식이 잘못된 항목 ${bad}건`);
    // 프로토타입 오염 방지를 위해 일반 객체로 다시 담는다
    (db as unknown as Record<string, unknown>)[name] = Object.fromEntries(entries.filter(([k]) => k !== '__proto__'));
    counts[name] = entries.length;
  }
  const s = data.settings as Record<string, unknown>;
  if (typeof s.timezone !== 'string' || (s.programStart !== null && !isISODate(s.programStart))) errors.push('settings: 시간대 또는 시작일 형식 오류');
  db.settings = { ...DEFAULT_SETTINGS, ...(s as object) };
  if (data.arm !== null && data.arm !== undefined) {
    const a = data.arm;
    if (!isRec(a) || !Array.isArray(a.exercises) || !Array.isArray(a.blockOrder)) errors.push('arm: 구조가 올바르지 않습니다');
    else db.arm = a as unknown as Db['arm'];
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors, db, summary: { exportedAt: String(raw.exportedAt ?? ''), includesArm: raw.includesArm === true && !!db.arm, counts } };
};
