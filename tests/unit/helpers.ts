import { createClipFromMedia, createProject, createTextClip } from '../../src/core/defaults';
import { addClipToTrack } from '../../src/core/timeline';
import type { MediaItem, Project } from '../../src/core/types';

export function media(id: string, duration: number, kind: MediaItem['kind'] = 'video'): MediaItem {
  return { id, name: `${id}.mp4`, kind, mimeType: 'video/mp4', size: 1000, duration, width: 1920, height: 1080, hasAudio: true, fingerprint: `fp_${id}`, importedAt: 0 };
}

/** Project with media A (10s) and B (6s) and one clip of each on the main track. */
export function sampleProject(): { p: Project; a: string; b: string } {
  let p = createProject('Test', { width: 1080, height: 1920, fps: 30, background: '#000', sampleRate: 48000 });
  p = { ...p, media: [media('A', 10), media('B', 6), media('M', 30, 'audio')] };
  const main = p.tracks.find((t) => t.kind === 'visual')!;
  const ca = createClipFromMedia(p.media[0], 0);
  const cb = createClipFromMedia(p.media[1], 10);
  p = addClipToTrack(p, main.id, ca)!;
  p = addClipToTrack(p, main.id, cb)!;
  return { p, a: ca.id, b: cb.id };
}

export { createTextClip };
