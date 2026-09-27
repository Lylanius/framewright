/**
 * Small key/value store in IndexedDB for things that aren't projects:
 * templates, brand kits, uploaded fonts. Keys are "area/id".
 * Values can hold Blobs (fonts, logos, intro clips).
 */
const DB = 'fw-kv', STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbp = null; reject(r.error); };
  });
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const kv = {
  get: <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined),
  set: (key: string, value: unknown) => run('readwrite', (s) => s.put(value, key)).then(() => true, () => false),
  del: (key: string) => run('readwrite', (s) => s.delete(key)).then(() => true, () => false),
  /** All values whose key starts with `prefix`. */
  async list<T>(prefix: string): Promise<T[]> {
    try {
      const range = IDBKeyRange.bound(prefix, prefix + '￿');
      return await run<T[]>('readonly', (s) => s.getAll(range) as IDBRequest<T[]>);
    } catch { return []; }
  },
};
