// 테스트 공용 도우미: 기본 프리셋으로 메모리 Db 구성
import type { Db, Patch } from '../domain/types';
import { DEFAULT_EXERCISES, defaultProgramVersion, emptyDb } from '../domain/defaults';
import { applyPatch, Ctx } from '../application/ctx';
import { ensureWeeks } from '../application/plan';

export const START = '2026-11-30'; // 월요일

export const makeCtx = (today = START, now = `${today}T10:00:00.000Z`): Ctx => {
  let n = 0;
  return { now, today, newId: () => `t${(n += 1)}` };
};

export const makeDb = (weeks: string[] = [START]): Db => {
  let db = emptyDb() as Db;
  db.exercises = Object.fromEntries(DEFAULT_EXERCISES.map((e) => [e.id, e]));
  const v = defaultProgramVersion('2026-11-13T00:00:00.000Z', START);
  db.versions = { [v.id]: v };
  db.settings = { ...db.settings, programStart: START, onboardingDone: true, bodyweight: 66, formulaVersion: 'e1rm-rts-2.0.0' };
  db = applyPatch(db, ensureWeeks(db, weeks));
  return db;
};

export const run = (db: Db, patch: Patch): Db => applyPatch(db, patch);

/** 합성 ARM 데이터(실제 PDF 내용 아님) */
export const fakeArmJson = () => JSON.stringify({
  schema_version: '1.1.0',
  schedule: { block_order: ['Block A'] },
  video_library: [{ id: 'test_curl', title: 'Test Curl', source_page: 1 }],
  exercises: [
    { id: 'a-w01-d1-e01', block: 'Block A', week: 1, day: 1, order: 1, source_page: 1, prescription_source: 'Test Curl - 6x3 RPE 9.5', exercise: 'Test Curl', rom: 'Short ROM', execution: ['explosive start'], notes: [], sets: 3, reps: 6, duration_seconds: null, percent_1rm: null, rpe: 9.5, rpe_range: null },
    { id: 'a-w01-d1-e02', block: 'Block A', week: 1, day: 1, order: 2, source_page: 1, prescription_source: 'Bench Press - 70% 4x5', exercise: 'Bench Press', sets: 5, reps: 4, percent_1rm: 70, rpe: null },
    { id: 'a-w01-d1-e03', block: 'Block A', week: 1, day: 1, order: 3, source_page: 1, prescription_source: 'Weighted Puill-ups - 70% 5x6', exercise: 'Weighted Puill-ups', sets: 6, reps: 5, percent_1rm: 70, rpe: null },
    { id: 'a-w01-d1-e04', block: 'Block A', week: 1, day: 1, order: 4, source_page: 1, prescription_source: 'Static Hold - 12 sec x 3 RPE 8', exercise: 'Static Hold', sets: 3, reps: null, duration_seconds: 12, rpe: 8 },
    { id: 'a-w01-d1-e05', block: 'Block A', week: 1, day: 1, order: 5, source_page: 1, prescription_source: 'Mystery Curl - x RPE 9', exercise: 'Mystery Curl', sets: null, reps: null, rpe: 9 },
    { id: 'a-w01-d2-e01', block: 'Block A', week: 1, day: 2, order: 1, source_page: 1, prescription_source: 'Test Curl - 8x2 RPE 6', exercise: 'Test Curl', sets: 2, reps: 8, rpe: 6 },
  ],
});
