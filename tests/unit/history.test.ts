import { describe, expect, it } from 'vitest';
import { emptyHistory, record, redo, undo } from '../../src/core/history';
import { deleteClips, findClip, splitClip } from '../../src/core/timeline';
import { sampleProject } from './helpers';

describe('undo / redo', () => {
  it('undoes and redoes a chain of edits', () => {
    const { p: p0, a } = sampleProject();
    let h = emptyHistory();
    const r1 = splitClip(p0, a, 3)!;
    h = record(h, p0, 'Split');
    const p1 = r1.project;
    const p2 = deleteClips(p1, [r1.rightId]);
    h = record(h, p1, 'Delete');
    const u1 = undo(h, p2)!;
    expect(u1.project).toBe(p1);
    expect(u1.label).toBe('Delete');
    const u2 = undo(u1.history, u1.project)!;
    expect(u2.project).toBe(p0);
    expect(undo(u2.history, u2.project)).toBeNull();
    const r = redo(u2.history, u2.project)!;
    expect(r.project).toBe(p1);
    const r2 = redo(r.history, r.project)!;
    expect(r2.project).toBe(p2);
    expect(findClip(r2.project, r1.rightId)).toBeNull();
  });
  it('coalesces rapid edits with the same key', () => {
    const { p } = sampleProject();
    let h = emptyHistory();
    h = record(h, p, 'Scale', 'k', 1000);
    h = record(h, p, 'Scale', 'k', 1200);
    h = record(h, p, 'Scale', 'k', 1300);
    expect(h.past).toHaveLength(1);
    h = record(h, p, 'Scale', 'k', 5000);
    expect(h.past).toHaveLength(2);
  });
  it('a new edit clears the redo stack', () => {
    const { p } = sampleProject();
    let h = record(emptyHistory(), p, 'A');
    h = undo(h, p)!.history;
    expect(h.future).toHaveLength(1);
    h = record(h, p, 'B');
    expect(h.future).toHaveLength(0);
  });
});
