import { describe, expect, it } from 'vitest';
import { parseProject, ProjectFormatError, serializeProject } from '../../src/core/projectIO';
import { findClip, projectDuration, splitClip } from '../../src/core/timeline';
import { createEffect } from '../../src/core/effects';
import { createTextClip, sampleProject } from './helpers';
import { insertClipAuto, updateClip } from '../../src/core/timeline';

describe('project files', () => {
  it('round-trips a full project (save → reopen)', () => {
    const { p, a } = sampleProject();
    let q = splitClip(p, a, 3)!.project;
    q = updateClip(q, a, (c) => ({ ...c, effects: [createEffect('vignette')], keyframes: { opacity: [{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: 1, ease: 'easeOut' }] } }));
    q = insertClipAuto(q, createTextClip(2, { content: 'Hello', strokeWidth: 4 })).project;
    q = { ...q, markers: [{ id: 'm1', time: 5, label: 'Drop', color: '#fff' }] };
    const back = parseProject(serializeProject(q));
    expect(back.tracks.map((t) => t.clips)).toEqual(q.tracks.map((t) => t.clips));
    expect(back.media).toEqual(q.media);
    expect(back.markers).toEqual(q.markers);
    expect(back.settings).toEqual(q.settings);
    expect(parseProject(serializeProject(back))).toEqual(back); // stable on re-save
    expect(projectDuration(back)).toBe(16);
    expect(findClip(back, a)!.clip.effects[0].type).toBe('vignette');
  });
  it('fills defaults for older or partial files', () => {
    const minimal = JSON.stringify({ settings: { width: 720, height: 1280 }, tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'c', kind: 'text', start: 1, duration: 2 }] }] });
    const p = parseProject(minimal);
    const c = p.tracks[0].clips[0];
    expect(c.text?.fontSize).toBeGreaterThan(0);
    expect(c.transform.scale).toBe(1);
    expect(p.settings.fps).toBe(30);
  });
  it('rejects corrupted and foreign files with a clear error', () => {
    expect(() => parseProject('{not json')).toThrow(ProjectFormatError);
    expect(() => parseProject('{"hello":1}')).toThrow(/doesn’t look like/);
    expect(() => parseProject(JSON.stringify({ magic: 'framewright-project', schemaVersion: 99, project: { settings: {}, tracks: [] } }))).toThrow(/newer version/);
  });
});
