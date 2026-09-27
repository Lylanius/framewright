/**
 * Local storage layer (IndexedDB).
 *
 * Stores:
 *  - projects:  full Project JSON (the edit)
 *  - summaries: lightweight rows for the project browser
 *  - blobs:     imported media bytes, keyed by media fingerprint, so the same
 *               file imported twice is stored once. These are *copies*: the
 *               user's original files are never modified or deleted.
 *  - backups:   rolling autosave snapshots per project (version history)
 *
 * Every call degrades gracefully: if IndexedDB is unavailable (private mode,
 * blocked storage) the app keeps working in memory and tells the user that
 * projects won't survive a reload.
 */
import type { Project, ProjectSummary } from '../core/types';

const DB_NAME = 'framewright';
const DB_VERSION = 1;
const MAX_BACKUPS = 20;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
        if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const t = db.transaction(store, mode);
          const req = fn(t.objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function storageAvailable(): Promise<boolean> {
  return (await openDb()) !== null;
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function saveProject(p: Project, summary: ProjectSummary): Promise<boolean> {
  const a = await tx('projects', 'readwrite', (s) => s.put(p, p.id));
  const b = await tx('summaries', 'readwrite', (s) => s.put(summary, p.id));
  return a !== null && b !== null;
}

export async function loadProject(id: string): Promise<Project | null> {
  return tx<Project>('projects', 'readonly', (s) => s.get(id) as IDBRequest<Project>);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const rows = await tx<ProjectSummary[]>('summaries', 'readonly', (s) => s.getAll() as IDBRequest<ProjectSummary[]>);
  return (rows ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  await tx('projects', 'readwrite', (s) => s.delete(id));
  await tx('summaries', 'readwrite', (s) => s.delete(id));
  await tx('backups', 'readwrite', (s) => s.delete(id));
}

export interface Backup { savedAt: number; label: string; project: Project; /** Named versions are kept until deleted. */ pinned?: boolean }

const MAX_PINNED = 50;

export async function pushBackup(p: Project, label: string, pinned = false): Promise<void> {
  const existing = (await tx<Backup[]>('backups', 'readonly', (s) => s.get(p.id) as IDBRequest<Backup[]>)) ?? [];
  const all = [...existing, { savedAt: Date.now(), label, project: p, pinned: pinned || undefined }];
  // Keep every named version (up to 50) plus the most recent automatic snapshots.
  const named = all.filter((b) => b.pinned).slice(-MAX_PINNED);
  const auto = all.filter((b) => !b.pinned).slice(-MAX_BACKUPS);
  const next = [...named, ...auto].sort((a, b) => a.savedAt - b.savedAt);
  await tx('backups', 'readwrite', (s) => s.put(next, p.id));
}

export async function deleteBackup(projectId: string, savedAt: number): Promise<void> {
  const existing = (await tx<Backup[]>('backups', 'readonly', (s) => s.get(projectId) as IDBRequest<Backup[]>)) ?? [];
  await tx('backups', 'readwrite', (s) => s.put(existing.filter((b) => b.savedAt !== savedAt), projectId));
}

export async function listBackups(projectId: string): Promise<Backup[]> {
  return ((await tx<Backup[]>('backups', 'readonly', (s) => s.get(projectId) as IDBRequest<Backup[]>)) ?? []).slice().reverse();
}

export async function putBlob(fingerprint: string, blob: Blob): Promise<boolean> {
  const existing = await tx<IDBValidKey | undefined>('blobs', 'readonly', (s) => s.getKey(fingerprint));
  if (existing) return true;
  return (await tx('blobs', 'readwrite', (s) => s.put(blob, fingerprint))) !== null;
}

export async function getBlob(fingerprint: string): Promise<Blob | null> {
  return tx<Blob>('blobs', 'readonly', (s) => s.get(fingerprint) as IDBRequest<Blob>);
}

/** Remove stored media no project references any more. Only ever touches our own copies. */
export async function pruneBlobs(): Promise<number> {
  const projects = (await tx<Project[]>('projects', 'readonly', (s) => s.getAll() as IDBRequest<Project[]>)) ?? [];
  const used = new Set(projects.flatMap((p) => p.media.flatMap((m) => [m.fingerprint, `proxy_${m.fingerprint}`])));
  const keys = ((await tx<IDBValidKey[]>('blobs', 'readonly', (s) => s.getAllKeys())) ?? []) as string[];
  let removed = 0;
  for (const k of keys) {
    if (!used.has(k)) {
      await tx('blobs', 'readwrite', (s) => s.delete(k));
      removed++;
    }
  }
  return removed;
}

export async function storageEstimate(): Promise<{ used: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { used: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

/** Tiny key/value for UI preferences (shortcuts, last panel…). */
export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`fw:${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`fw:${key}`, JSON.stringify(value));
    } catch {
      /* storage blocked: preference lasts for this session only */
    }
  },
};
