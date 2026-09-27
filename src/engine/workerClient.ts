/**
 * Promise-based client for the background media workers.
 * Two lanes: "fast" for quick jobs the user is waiting on (probing new imports)
 * and "bulk" for long jobs (proxies, analysis, tracking), so a big proxy never
 * holds up the next file's import.
 * Falls back to "unavailable" (callers then skip the feature) if workers can't start.
 */
import MediaWorker from './media.worker?worker&inline';
import type { WorkerRequest, WorkerResponse } from './media.worker';

type Pending = { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void; onProgress?: (p: number) => void; lane: Lane };
type Lane = 'fast' | 'bulk';

const workers: Partial<Record<Lane, Worker>> = {};
let failed = false;
const pending = new Map<string, Pending>();
let seq = 0;

function getWorker(lane: Lane): Worker | null {
  const existing = workers[lane];
  if (existing || failed) return existing ?? null;
  try {
    const w = new MediaWorker();
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { p.onProgress?.(m.progress); return; }
      pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    w.onerror = () => {
      for (const [id, p] of pending) if (p.lane === lane) { p.reject(new Error('Background worker stopped.')); pending.delete(id); }
      w.terminate();
      delete workers[lane];
    };
    workers[lane] = w;
    return w;
  } catch {
    failed = true;
    return null;
  }
}

export interface Job<T> { id: string; promise: Promise<T>; cancel(): void }

type Req = WorkerRequest extends infer R ? (R extends { type: 'cancel' } ? never : R) : never;
type ReqNoId = Req extends infer R ? (R extends { id: string } ? Omit<R, 'id'> : never) : never;

export function runJob<T extends WorkerResponse>(req: ReqNoId, onProgress?: (p: number) => void): Job<T> {
  const id = `job${++seq}`;
  const lane: Lane = req.type === 'probe' ? 'fast' : 'bulk';
  const w = getWorker(lane);
  if (!w) return { id, promise: Promise.reject(new Error('Background processing isn’t available in this browser.')), cancel() {} };
  const promise = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: WorkerResponse) => void, reject, onProgress, lane });
    w.postMessage({ ...req, id });
  });
  return { id, promise, cancel: () => { w.postMessage({ type: 'cancel', id }); } };
}
