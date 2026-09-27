/**
 * Crash recovery.
 *
 * Projects autosave a moment after every change, so a crash loses at most
 * the last second or so. On top of that we remember which project was open;
 * if the app didn't close cleanly (tab crash, phone killed the app, power
 * cut), the home screen offers to reopen it. Recent unexpected errors are
 * kept (on this device only) to help troubleshooting.
 */
const KEY = 'fw.session';
const ERR_KEY = 'fw.errors';

export interface SessionMark { projectId: string; name: string; openedAt: number; lastBeat: number; savedAt?: number }

function read<T>(k: string): T | null {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
}
function write(k: string, v: unknown): void {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ }
}

let beat = 0;
/** The session that was open when the app last stopped without closing it, if any. Read once at start-up. */
export const crashedSession: SessionMark | null = (() => {
  if (typeof window === 'undefined') return null;
  const m = read<SessionMark>(KEY);
  // Another tab may be editing right now: only count it as a crash if its heartbeat stopped.
  return m && Date.now() - m.lastBeat > 25_000 ? m : null;
})();

export function markSessionOpen(projectId: string, name: string): void {
  const now = Date.now();
  write(KEY, { projectId, name, openedAt: now, lastBeat: now });
  clearInterval(beat);
  beat = window.setInterval(() => {
    const m = read<SessionMark>(KEY);
    if (m && m.projectId === projectId) write(KEY, { ...m, lastBeat: Date.now() });
  }, 10_000);
}

export function noteSaved(projectId: string, name: string): void {
  const m = read<SessionMark>(KEY);
  if (m && m.projectId === projectId) write(KEY, { ...m, name, savedAt: Date.now(), lastBeat: Date.now() });
}

export function markSessionClosed(): void {
  clearInterval(beat);
  write(KEY, null);
}

export function dismissCrash(): void {
  write(KEY, null);
}

export interface ErrorNote { at: number; message: string; where: string }

export function logError(message: string, where: string): void {
  const list = read<ErrorNote[]>(ERR_KEY) ?? [];
  list.push({ at: Date.now(), message: message.slice(0, 400), where });
  write(ERR_KEY, list.slice(-20));
}

export function recentErrors(): ErrorNote[] {
  return read<ErrorNote[]>(ERR_KEY) ?? [];
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => logError(e.message || String(e.error), 'window'));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { name?: string; message?: string } | undefined;
    if (r?.name === 'AbortError') return;
    logError(r?.message ?? String(r), 'promise');
  });
}
