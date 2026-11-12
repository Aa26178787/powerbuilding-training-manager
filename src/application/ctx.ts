// 유스케이스 실행 컨텍스트 — 현재 시각·오늘 날짜·ID 생성기를 외부에서 주입(테스트 재현성)
import type { CollectionName, Db, ISODate, Patch } from '../domain/types';

export interface Ctx { now: string; today: ISODate; newId: () => string }

export class UseCaseError extends Error {}
export const fail = (msg: string): never => { throw new UseCaseError(msg); };

/** Patch를 메모리 Db에 반영(불변 갱신). 저장소 반영과 동일한 결과를 낸다 */
export const applyPatch = (db: Db, patch: Patch): Db => {
  const next: Db = { ...db };
  for (const [name, rows] of Object.entries(patch.put ?? {}) as [CollectionName, { id?: string; exerciseId?: string }[]][]) {
    const col = { ...(next[name] as Record<string, unknown>) };
    for (const r of rows) col[keyOf(name, r)] = r;
    (next as unknown as Record<string, unknown>)[name] = col;
  }
  for (const [name, ids] of Object.entries(patch.del ?? {}) as [CollectionName, string[]][]) {
    const col = { ...(next[name] as Record<string, unknown>) };
    for (const id of ids) delete col[id];
    (next as unknown as Record<string, unknown>)[name] = col;
  }
  if (patch.settings) next.settings = { ...next.settings, ...patch.settings };
  if (patch.arm !== undefined) next.arm = patch.arm;
  return next;
};

/** exStates는 exerciseId가 키, 나머지는 id가 키 */
export const keyOf = (name: CollectionName, r: { id?: string; exerciseId?: string }): string =>
  (name === 'exStates' ? r.exerciseId : r.id) as string;

export const mergePatches = (...ps: Patch[]): Patch => {
  const out: Patch = {};
  for (const p of ps) {
    for (const [k, rows] of Object.entries(p.put ?? {})) {
      out.put = out.put ?? {};
      (out.put as Record<string, unknown[]>)[k] = [...((out.put as Record<string, unknown[]>)[k] ?? []), ...(rows as unknown[])];
    }
    for (const [k, ids] of Object.entries(p.del ?? {})) {
      out.del = out.del ?? {};
      (out.del as Record<string, string[]>)[k] = [...((out.del as Record<string, string[]>)[k] ?? []), ...(ids as string[])];
    }
    if (p.settings) out.settings = { ...out.settings, ...p.settings };
    if (p.arm !== undefined) out.arm = p.arm;
  }
  return out;
};
