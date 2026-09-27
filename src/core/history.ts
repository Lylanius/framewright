/**
 * Undo/redo history. Because timeline operations are immutable, each entry is
 * simply the previous Project value (structural sharing keeps this cheap).
 * Consecutive edits with the same `coalesceKey` (e.g. dragging a slider) are
 * merged into one undo step.
 */
import type { Project } from './types';

export interface HistoryState {
  past: { project: Project; label: string }[];
  future: { project: Project; label: string }[];
  lastKey: string | null;
  lastAt: number;
}

export const HISTORY_LIMIT = 500;
const COALESCE_MS = 800;

export function emptyHistory(): HistoryState {
  return { past: [], future: [], lastKey: null, lastAt: 0 };
}

export function record(h: HistoryState, before: Project, label: string, coalesceKey?: string, now = Date.now()): HistoryState {
  if (coalesceKey && h.lastKey === coalesceKey && now - h.lastAt < COALESCE_MS && h.past.length) {
    return { ...h, future: [], lastAt: now };
  }
  const past = [...h.past, { project: before, label }];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, future: [], lastKey: coalesceKey ?? null, lastAt: now };
}

export function undo(h: HistoryState, current: Project): { history: HistoryState; project: Project; label: string } | null {
  const prev = h.past[h.past.length - 1];
  if (!prev) return null;
  return {
    history: { past: h.past.slice(0, -1), future: [...h.future, { project: current, label: prev.label }], lastKey: null, lastAt: 0 },
    project: prev.project,
    label: prev.label,
  };
}

export function redo(h: HistoryState, current: Project): { history: HistoryState; project: Project; label: string } | null {
  const next = h.future[h.future.length - 1];
  if (!next) return null;
  return {
    history: { past: [...h.past, { project: current, label: next.label }], future: h.future.slice(0, -1), lastKey: null, lastAt: 0 },
    project: next.project,
    label: next.label,
  };
}
