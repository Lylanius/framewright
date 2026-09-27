/**
 * Sync folder (optional, off by default).
 *
 * Instead of a Framewright cloud, you pick any folder — e.g. one inside
 * OneDrive, Dropbox, Google Drive or iCloud Drive — and each project's edit
 * (a small .framewright.json file, never your media) is written there after
 * saving. On another computer, pick the same folder and those projects show up
 * on the home screen. Your sync service does the syncing; Framewright never
 * talks to a server.
 *
 * Uses the File System Access API (desktop app, Chrome, Edge). Not available on
 * phones or in Safari/Firefox — the UI says so.
 */
import { parseProject, serializeProject } from '../core/projectIO';
import type { Project } from '../core/types';

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  values(): AsyncIterable<FileSystemHandle>;
};

const DB = 'fw-sync', STORE = 'kv';

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}

export function syncSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

let cached: DirHandle | null | undefined;

async function handle(): Promise<DirHandle | null> {
  if (cached !== undefined) return cached;
  try { cached = ((await idb('readonly', (s) => s.get('dir'))) as DirHandle | undefined) ?? null; } catch { cached = null; }
  return cached;
}

export type SyncStatus = { state: 'unsupported' } | { state: 'off' } | { state: 'needs-permission'; name: string } | { state: 'on'; name: string };

export async function syncStatus(): Promise<SyncStatus> {
  if (!syncSupported()) return { state: 'unsupported' };
  const h = await handle();
  if (!h) return { state: 'off' };
  const perm = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
  return perm === 'granted' ? { state: 'on', name: h.name } : { state: 'needs-permission', name: h.name };
}

/** Ask for a folder (needs a click). */
export async function chooseSyncFolder(): Promise<string | null> {
  const pick = (window as unknown as { showDirectoryPicker(o: object): Promise<DirHandle> }).showDirectoryPicker;
  try {
    const h = await pick({ id: 'framewright-sync', mode: 'readwrite', startIn: 'documents' });
    await idb('readwrite', (s) => s.put(h, 'dir'));
    cached = h;
    return h.name;
  } catch {
    return null;
  }
}

/** Browsers forget folder permission between sessions; this re-asks (needs a click). */
export async function reconnectSyncFolder(): Promise<boolean> {
  const h = await handle();
  if (!h) return false;
  return ((await h.requestPermission?.({ mode: 'readwrite' })) ?? 'granted') === 'granted';
}

export async function stopSync(): Promise<void> {
  cached = null;
  await idb('readwrite', (s) => s.delete('dir')).catch(() => undefined);
}

const fileName = (p: Pick<Project, 'id' | 'name'>) =>
  `${(p.name.replace(/[^\w\- ]+/g, '').trim() || 'Project').slice(0, 60)} (${p.id.slice(-6)}).framewright.json`;

/** Write a project's edit to the folder (called after saves). Silently does nothing when sync is off. */
export async function pushProject(p: Project): Promise<boolean> {
  const st = await syncStatus();
  if (st.state !== 'on') return false;
  const h = (await handle())!;
  try {
    // Remove an older copy saved under a previous name.
    for await (const e of h.values()) {
      if (e.kind === 'file' && e.name.endsWith(`(${p.id.slice(-6)}).framewright.json`) && e.name !== fileName(p)) await h.removeEntry(e.name).catch(() => undefined);
    }
    const f = await h.getFileHandle(fileName(p), { create: true });
    const w = await (f as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await w.write(serializeProject(p));
    await w.close();
    return true;
  } catch {
    return false;
  }
}

export interface RemoteProject { id: string; name: string; updatedAt: number; fileName: string }

/** Projects in the sync folder (newest first). */
export async function listSynced(): Promise<RemoteProject[]> {
  const st = await syncStatus();
  if (st.state !== 'on') return [];
  const h = (await handle())!;
  const out: RemoteProject[] = [];
  for await (const e of h.values()) {
    if (e.kind !== 'file' || !e.name.endsWith('.framewright.json')) continue;
    try {
      const p = parseProject(await (await (e as FileSystemFileHandle).getFile()).text());
      out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt ?? 0, fileName: e.name });
    } catch { /* not a project file */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readSynced(name: string): Promise<File | null> {
  const h = await handle();
  if (!h) return null;
  try { return await (await h.getFileHandle(name)).getFile(); } catch { return null; }
}
