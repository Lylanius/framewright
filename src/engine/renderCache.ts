/**
 * Background rendering. While you're not touching anything, heavy parts of the
 * timeline (see core/renderPlan.ts) are rendered to small preview videos, one
 * 2-second chunk at a time. Playback then shows those instead of compositing
 * live, so complex edits play smoothly even on slow devices. Any edit to a
 * chunk changes its key, so stale renders are never shown.
 *
 * Renders are kept for this session only (they're cheap to redo) and use the
 * same compositor as export, so they look identical.
 */
import { CanvasSource, Output, BufferTarget, WebMOutputFormat, Mp4OutputFormat, canEncodeVideo, type VideoCodec } from 'mediabunny';
import { CHUNK_SECONDS, chunkCount, chunkKey, chunkRange, isHeavyChunk } from '../core/renderPlan';
import { projectDuration } from '../core/timeline';
import type { Project } from '../core/types';
import { renderFrame } from './compositor';
import { ExportSources } from './exporter';
import { syncLuts } from './gpu';

export type ChunkState = 'light' | 'pending' | 'rendering' | 'ready';

interface Entry { key: string; url: string; bytes: number; used: number }

const MAX_BYTES = 400 * 1024 * 1024;
const IDLE_MS = 1200;

class RenderCacheImpl {
  private entries = new Map<string, Entry>();
  private project: Project | null = null;
  private keys = new Map<number, string>();
  private heavy = new Map<number, boolean>();
  private listeners = new Set<() => void>();
  private lastInput = 0;
  private busy: { index: number; key: string; abort: AbortController } | null = null;
  private codec: { codec: VideoCodec; container: 'webm' | 'mp4' } | null | undefined;
  enabled = true;
  /** Set by the player: true while playing or exporting (no background work then). */
  paused = false;
  playhead = 0;
  /** Output size for chunk renders (short side). */
  shortSide = 720;

  constructor() {
    if (typeof window === 'undefined') return;
    const mark = () => {
      this.lastInput = performance.now();
      // Leave the CPU to the user while they're working.
      if (this.busy) this.busy.abort.abort();
    };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, mark, { passive: true, capture: true });
    window.setInterval(() => void this.tick(), 400);
  }

  /** Playing or exporting: stop background work so it doesn't compete. */
  setPaused(v: boolean): void {
    this.paused = v;
    if (v && this.busy) this.busy.abort.abort();
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { this.listeners.forEach((f) => f()); }

  setProject(p: Project): void {
    if (p === this.project) return;
    this.project = p;
    this.keys.clear();
    this.heavy.clear();
    if (this.busy && this.busy.key !== this.keyFor(this.busy.index)) this.busy.abort.abort();
    this.emit();
  }

  private keyFor(i: number): string {
    let k = this.keys.get(i);
    if (k === undefined && this.project) { k = chunkKey(this.project, i); this.keys.set(i, k); }
    return k ?? '';
  }

  private isHeavy(i: number): boolean {
    let h = this.heavy.get(i);
    if (h === undefined && this.project) { h = isHeavyChunk(this.project, i); this.heavy.set(i, h); }
    return !!h;
  }

  /** Rendered video covering time t, if there's an up-to-date one. */
  lookup(t: number): { url: string; start: number } | null {
    if (!this.enabled || !this.project) return null;
    const i = Math.floor(t / CHUNK_SECONDS);
    const e = this.entries.get(this.keyFor(i));
    if (!e) return null;
    e.used = performance.now();
    return { url: e.url, start: chunkRange(i)[0] };
  }

  states(): ChunkState[] {
    if (!this.project) return [];
    const n = chunkCount(projectDuration(this.project));
    return Array.from({ length: n }, (_, i) => {
      if (!this.isHeavy(i)) return 'light';
      if (this.entries.has(this.keyFor(i))) return 'ready';
      if (this.busy?.index === i) return 'rendering';
      return 'pending';
    });
  }

  clear(): void {
    for (const e of this.entries.values()) URL.revokeObjectURL(e.url);
    this.entries.clear();
    this.busy?.abort.abort();
    this.emit();
  }

  /** Render every heavy chunk now (menu command); resolves when done or interrupted. */
  async renderAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const todo = this.states().map((s, i) => (s === 'pending' ? i : -1)).filter((i) => i >= 0);
    let done = 0;
    for (const i of todo) {
      if (!this.project) return;
      if (this.entries.has(this.keyFor(i))) { done++; continue; }
      await this.renderChunk(i, false);
      onProgress?.(++done, todo.length);
    }
  }

  private async tick(): Promise<void> {
    if (!this.enabled || this.paused || this.busy || !this.project) return;
    if (performance.now() - this.lastInput < IDLE_MS) return;
    if (document.visibilityState === 'hidden') return;
    const n = chunkCount(projectDuration(this.project));
    if (!n) return;
    // Nearest first: from the playhead forwards, then backwards.
    const start = Math.min(n - 1, Math.floor(this.playhead / CHUNK_SECONDS));
    const order = [...Array.from({ length: n - start }, (_, k) => start + k), ...Array.from({ length: start }, (_, k) => start - 1 - k)];
    const next = order.find((i) => this.isHeavy(i) && !this.entries.has(this.keyFor(i)));
    if (next === undefined) return;
    await this.renderChunk(next, true);
  }

  private async pickCodec(w: number, h: number): Promise<{ codec: VideoCodec; container: 'webm' | 'mp4' } | null> {
    if (this.codec !== undefined) return this.codec;
    for (const [codec, container] of [['vp9', 'webm'], ['avc', 'mp4'], ['vp8', 'webm'], ['av1', 'webm']] as const) {
      try { if (await canEncodeVideo(codec, { width: w, height: h })) return (this.codec = { codec, container }); } catch { /* next */ }
    }
    return (this.codec = null);
  }

  private async renderChunk(index: number, yieldToUser: boolean): Promise<void> {
    const project = this.project;
    if (!project || typeof VideoEncoder === 'undefined') return;
    const key = this.keyFor(index);
    const abort = new AbortController();
    this.busy = { index, key, abort };
    this.emit();
    const { width: PW, height: PH, fps } = project.settings;
    const s = Math.min(1, this.shortSide / Math.min(PW, PH));
    const even = (x: number) => Math.max(2, Math.round((x * s) / 2) * 2);
    const W = even(PW), H = even(PH);
    try {
      const codec = await this.pickCodec(W, H);
      if (!codec) { this.enabled = false; return; }
      syncLuts(project.luts);
      const [a, b0] = chunkRange(index);
      const b = Math.min(b0, projectDuration(project));
      const frames = Math.max(1, Math.round((b - a) * fps));
      const times = Array.from({ length: frames }, (_, k) => a + k / fps);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { alpha: false })!;
      const target = new BufferTarget();
      const output = new Output({ format: codec.container === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
      const src = new CanvasSource(canvas, { codec: codec.codec, bitrate: Math.round(W * H * fps * 0.12), keyFrameInterval: 0.5, latencyMode: 'quality' });
      output.addVideoTrack(src, { frameRate: fps });
      await output.start();
      const sources = new ExportSources(project, times);
      try {
        await sources.prepare();
        for (let k = 0; k < frames; k++) {
          if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');
          await sources.load(times[k]);
          renderFrame(ctx, project, times[k], sources.sources, { scale: W / PW });
          await src.add(k / fps, 1 / fps);
          // Keep the page responsive: give the browser a turn between frames.
          if (yieldToUser) await new Promise((r) => setTimeout(r, 0));
        }
        await output.finalize();
      } catch (e) {
        await output.cancel().catch(() => undefined);
        throw e;
      } finally {
        sources.dispose();
      }
      // Only keep it if nothing changed while rendering.
      if (this.project && this.keyFor(index) === key) {
        const blob = new Blob([target.buffer!], { type: codec.container === 'webm' ? 'video/webm' : 'video/mp4' });
        this.entries.set(key, { key, url: URL.createObjectURL(blob), bytes: blob.size, used: performance.now() });
        this.evict();
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.warn('Background render failed', e);
    } finally {
      this.busy = null;
      this.emit();
    }
  }

  private evict(): void {
    let total = 0;
    for (const e of this.entries.values()) total += e.bytes;
    const byAge = [...this.entries.values()].sort((x, y) => x.used - y.used);
    while (total > MAX_BYTES && byAge.length) {
      const e = byAge.shift()!;
      URL.revokeObjectURL(e.url);
      this.entries.delete(e.key);
      total -= e.bytes;
    }
  }
}

export const renderCache = new RenderCacheImpl();
