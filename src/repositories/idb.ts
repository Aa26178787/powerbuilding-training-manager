// IndexedDB 저장소 어댑터. 모든 변경은 한 트랜잭션으로 반영하고 rev로 동시 수정 충돌을 검사한다.
import { openDB, IDBPDatabase } from 'idb';
import type { CollectionName, Db, Patch } from '../domain/types';
import { DEFAULT_SETTINGS, emptyDb } from '../domain/defaults';
import { COLLECTIONS } from '../data-import/backup';
import { keyOf } from '../application/ctx';

const DB_NAME = 'ptm';
const DB_VERSION = 2;
const KV = 'kv';

export class ConflictError extends Error {}

export const openStore = (name = DB_NAME): Promise<IDBPDatabase> =>
  openDB(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      // 버전 마이그레이션: 새 버전은 아래에 단계별로 추가한다
      if (oldVersion < 1) db.createObjectStore(KV);
      // v1: 기본 컬렉션, v2: 개인화 계수 관측 기록(coeffs) 추가. 없는 저장소만 만든다
      for (const c of COLLECTIONS) if (!db.objectStoreNames.contains(c)) db.createObjectStore(c);
    },
  });

export const loadAll = async (idb: IDBPDatabase): Promise<Db> => {
  const db = emptyDb() as Db;
  const tx = idb.transaction([...COLLECTIONS, KV], 'readonly');
  for (const c of COLLECTIONS) {
    const [keys, vals] = await Promise.all([tx.objectStore(c).getAllKeys(), tx.objectStore(c).getAll()]);
    (db as unknown as Record<string, unknown>)[c] = Object.fromEntries(keys.map((k, i) => [String(k), vals[i]]));
  }
  const settings = await tx.objectStore(KV).get('settings');
  db.settings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  db.arm = (await tx.objectStore(KV).get('arm')) ?? null;
  await tx.done;
  return db;
};

/**
 * Patch를 원자적으로 저장. rev가 있는 레코드는 저장된 rev가 (새 rev − 1)이 아니면 충돌로 보고 전체를 취소한다.
 * (다른 탭에서 같은 세트를 먼저 수정한 경우 등)
 */
export const commitPatch = async (idb: IDBPDatabase, patch: Patch): Promise<void> => {
  const names = new Set<string>([...Object.keys(patch.put ?? {}), ...Object.keys(patch.del ?? {})]);
  if (patch.settings || patch.arm !== undefined) names.add(KV);
  if (!names.size) return;
  const tx = idb.transaction([...names], 'readwrite');
  try {
    for (const [name, rows] of Object.entries(patch.put ?? {}) as [CollectionName, { rev?: number; id?: string; exerciseId?: string }[]][]) {
      const store = tx.objectStore(name);
      for (const r of rows) {
        const key = keyOf(name, r);
        if (typeof r.rev === 'number') {
          const cur = await store.get(key);
          const curRev = cur?.rev ?? 0;
          if (curRev !== r.rev - 1) throw new ConflictError(`다른 곳에서 먼저 수정된 데이터입니다 (${name}/${key})`);
        }
        await store.put(r, key);
      }
    }
    for (const [name, ids] of Object.entries(patch.del ?? {}) as [CollectionName, string[]][]) {
      for (const id of ids) await tx.objectStore(name).delete(id);
    }
    if (patch.settings) {
      const cur = (await tx.objectStore(KV).get('settings')) ?? DEFAULT_SETTINGS;
      await tx.objectStore(KV).put({ ...cur, ...patch.settings }, 'settings');
    }
    if (patch.arm !== undefined) {
      if (patch.arm === null) await tx.objectStore(KV).delete('arm');
      else await tx.objectStore(KV).put(patch.arm, 'arm');
    }
    await tx.done;
  } catch (e) {
    try { tx.abort(); } catch { /* 이미 중단됨 */ }
    await tx.done.catch(() => undefined);
    throw e;
  }
};

/** 백업 복원: 전체 교체 */
export const replaceAll = async (idb: IDBPDatabase, db: Db): Promise<void> => {
  const tx = idb.transaction([...COLLECTIONS, KV], 'readwrite');
  for (const c of COLLECTIONS) {
    const store = tx.objectStore(c);
    await store.clear();
    for (const [k, v] of Object.entries(db[c] as Record<string, unknown>)) await store.put(v, k);
  }
  await tx.objectStore(KV).clear();
  await tx.objectStore(KV).put(db.settings, 'settings');
  if (db.arm) await tx.objectStore(KV).put(db.arm, 'arm');
  await tx.done;
};
