/**
 * Live preview player.
 *
 * Pictures come from <video> elements (hardware decoded, cheap to play),
 * composited every animation frame by the shared compositor. Sound is routed
 * through Web Audio so volume above 100 %, fades and keyframes behave like the
 * export. A small pool of media elements is kept around the playhead.
 */
import { valueAt } from '../core/keyframes';
import { clipEnd, projectDuration } from '../core/timeline';
import { clipActiveRanges, sourceTimeExtended } from '../core/transitions';
import type { Clip, Project } from '../core/types';
import { clipGain } from './audio';
import { renderFrame, type ClipBounds, type FrameSources, type VisualFrame } from './compositor';
import { renderCache } from './renderCache';
import { CHUNK_SECONDS } from '../core/renderPlan';
import { animatedFrame, getAnimatedSync, getImage, getImageSync, getPlaybackUrl, loadAnimated } from './media';
import { segmentPerson } from './ai';
import { buildChain, chainKey, loadWorklets, type Chain } from './audioChain';
import { syncLuts } from './gpu';

interface ElementEntry {
  el: HTMLMediaElement;
  mediaId: string;
  clipId: string;
  node?: MediaElementAudioSourceNode;
  gain?: GainNode;
  chain?: Chain;
  chainKey?: string;
  lastUsed: number;
  wantPlay: boolean;
}

type Listener = (t: number) => void;

/** Audio clips shorter than this (sound effects) never drive the playback clock. */
const MIN_AUDIO_MASTER = 3;
const PRELOAD_AHEAD = 1.5;
const MAX_ELEMENTS = 10;

export class Player {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private project: Project;
  private _time = 0;
  private _playing = false;
  private startWall = 0;
  private startTime = 0;
  private raf = 0;
  private renderQueued = false;
  private elements = new Map<string, ElementEntry>();
  private audioCtx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analysers: AnalyserNode[] = [];
  private timeListeners = new Set<Listener>();
  private stateListeners = new Set<(playing: boolean) => void>();
  selectedIds: string[] = [];
  lastBounds: ClipBounds[] = [];
  /** Playback diagnostics (read by tests and the dev console as window.__fwPlayer.stats). */
  stats = { seeks: 0, frames: 0, longGaps: 0, maxGap: 0, holds: 0, lastTick: 0, drawMs: 0, syncMs: 0, cachedFrames: 0, cacheMiss: { none: 0, loading: 0, drift: 0 } };
  loop = false;
  /** Play only this range (e.g. a selection); null = whole project. */
  range: [number, number] | null = null;

  constructor(canvas: HTMLCanvasElement, project: Project) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.project = project;
    this.ranges = clipActiveRanges(project);
    syncLuts(project.luts);
    renderCache.setProject(project);
    (window as unknown as { __fwPlayer?: Player }).__fwPlayer = this;
  }

  get time(): number { return this._time; }
  get playing(): boolean { return this._playing; }
  get scale(): number { return this.canvas.width / this.project.settings.width; }

  onTime(fn: Listener): () => void { this.timeListeners.add(fn); return () => this.timeListeners.delete(fn); }
  onState(fn: (p: boolean) => void): () => void { this.stateListeners.add(fn); return () => this.stateListeners.delete(fn); }

  private ranges = new Map<string, [number, number]>();

  private clipRange(clip: Clip): [number, number] {
    return this.ranges.get(clip.id) ?? [clip.start, clipEnd(clip)];
  }

  private srcTime(clip: Clip, t: number): number {
    return sourceTimeExtended(clip, t, this.project.media.find((m) => m.id === clip.mediaId));
  }

  setProject(p: Project): void {
    this.project = p;
    renderCache.setProject(p);
    this.ranges = clipActiveRanges(p);
    syncLuts(p.luts);
    for (const e of this.elements.values()) {
      this.rebuildChain(e);
      const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === e.clipId);
      if (c) (e.el as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch = c.keepPitch !== false;
    }
    // Drop elements for clips that no longer exist or changed media.
    const live = new Map<string, Clip>();
    for (const t of p.tracks) for (const c of t.clips) live.set(c.id, c);
    for (const [id, e] of this.elements) {
      const c = live.get(id);
      if (!c || c.mediaId !== e.mediaId) this.destroyElement(id);
    }
    if (!this._playing) this.syncPaused();
    this.requestRender();
  }

  private box = { w: 0, h: 0, dpr: 1 };
  /** Render-resolution factor; drops while playing on slow devices, restored when paused. */
  private quality = 1;
  private drawEma = 0;

  /** Fit the canvas to a box (CSS px) at device pixel ratio, never above project resolution. */
  resize(boxW: number, boxH: number, dpr = window.devicePixelRatio || 1): { cssW: number; cssH: number } {
    this.box = { w: boxW, h: boxH, dpr };
    const { width: PW, height: PH } = this.project.settings;
    const s = Math.min(boxW / PW, boxH / PH);
    const cssW = Math.max(1, Math.floor(PW * s)), cssH = Math.max(1, Math.floor(PH * s));
    this.applyCanvasSize(cssW);
    this.requestRender();
    return { cssW, cssH };
  }

  private applyCanvasSize(cssW?: number): void {
    const { width: PW, height: PH } = this.project.settings;
    const cw = cssW ?? Math.floor(PW * Math.min(this.box.w / PW, this.box.h / PH));
    // Mirrored to a pop-out window: render at least ~1080p-ish on the long side.
    const base = this._mirror ? Math.max(cw * this.box.dpr, (1080 / Math.max(PW, PH)) * PW) : cw * this.box.dpr;
    const pxScale = Math.min(1, (base * this.quality) / PW);
    const w = Math.max(2, Math.round(PW * pxScale)), h = Math.max(2, Math.round(PH * pxScale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private _mirror = false;
  /** A pop-out window mirrors the preview: render sharper. */
  get mirrorBoost(): boolean { return this._mirror; }
  set mirrorBoost(on: boolean) { if (on !== this._mirror) { this._mirror = on; if (this.box.w) this.applyCanvasSize(); this.requestRender(); } }

  private setQuality(q: number): void {
    if (Math.abs(q - this.quality) < 1e-3 || !this.box.w) return;
    this.quality = q;
    this.applyCanvasSize();
  }

  /* --------------------------- transport --------------------------- */

  seek(t: number): void {
    const dur = projectDuration(this.project);
    this._time = Math.max(0, Math.min(t, Math.max(dur, 0)));
    if (this._playing) {
      this.startTime = this._time;
      this.startWall = performance.now();
      this.holdSince = 0;
      for (const e of this.elements.values()) { e.el.pause(); e.wantPlay = false; }
    } else this.syncPaused();
    this.emitTime();
    this.requestRender();
  }

  async play(): Promise<void> {
    if (this._playing) return;
    this.ensureAudio();
    const dur = projectDuration(this.project);
    const end = this.range ? this.range[1] : dur;
    const start = this.range ? this.range[0] : 0;
    if (dur <= 0) return;
    if (this._time >= end - 1e-3 || this._time < start) this._time = start;
    this._playing = true;
    renderCache.setPaused(true);
    this.startTime = this._time;
    this.startWall = performance.now();
    try { await this.audioCtx?.resume(); } catch { /* ignore */ }
    this.stateListeners.forEach((f) => f(true));
    this.tick();
  }

  pause(): void {
    if (!this._playing) return;
    this._playing = false;
    renderCache.setPaused(false);
    for (const c of this.cacheEls) c.pause();
    cancelAnimationFrame(this.raf);
    for (const e of this.elements.values()) { e.el.pause(); e.wantPlay = false; }
    this.masterEl = null;
    this.setQuality(1);
    this.stateListeners.forEach((f) => f(false));
    this.syncPaused();
    this.requestRender();
  }

  toggle(): void { if (this._playing) this.pause(); else void this.play(); }

  /** Step by whole frames. */
  step(frames: number): void {
    this.pause();
    const fps = this.project.settings.fps;
    this.seek(Math.round(this._time * fps + frames) / fps);
  }

  /* --------------------------- audio --------------------------- */

  private ensureAudio(): void {
    if (this.audioCtx) return;
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.audioCtx.createGain();
      const splitter = this.audioCtx.createChannelSplitter(2);
      this.master.connect(this.audioCtx.destination);
      this.master.connect(splitter);
      for (let i = 0; i < 2; i++) {
        const an = this.audioCtx.createAnalyser();
        an.fftSize = 1024;
        splitter.connect(an, i);
        this.analysers.push(an);
      }
      for (const e of this.elements.values()) this.routeAudio(e);
      void loadWorklets(this.audioCtx).then((ok) => {
        this.workletsReady = ok;
        this.workletsFailed = !ok;
        for (const e of this.elements.values()) this.rebuildChain(e);
      });
    } catch {
      this.audioCtx = null;
    }
  }

  private workletsReady = false;
  /** True once we know this browser blocks AudioWorklets (noise gate + pitch then can't run). */
  workletsFailed = false;
  /** Audio effects that couldn't run in this browser (shown in the inspector). */
  skippedAudioFx: string[] = [];

  private routeAudio(e: ElementEntry): void {
    if (!this.audioCtx || !this.master || e.node) return;
    try {
      e.node = this.audioCtx.createMediaElementSource(e.el);
      e.gain = this.audioCtx.createGain();
      e.gain.gain.value = 0;
      e.gain.connect(this.master);
      e.el.muted = false;
      e.el.volume = 1;
      this.rebuildChain(e);
    } catch { /* element already routed or not allowed */ }
  }

  /** (Re)build a clip's audio-effect chain between its element and its volume. */
  private rebuildChain(e: ElementEntry): void {
    if (!this.audioCtx || !e.node || !e.gain) return;
    const clip = this.project.tracks.flatMap((t) => t.clips).find((c) => c.id === e.clipId);
    const key = clip ? chainKey(clip) + (this.workletsReady ? '|w' : '') : '';
    if (key === e.chainKey) return;
    try { e.node.disconnect(); e.chain?.output.disconnect(); } catch { /* not connected */ }
    e.chainKey = key;
    if (!clip || !clip.audioFx?.some((f) => f.enabled)) { e.chain = undefined; e.node.connect(e.gain); return; }
    // Speed changes keep their pitch through the browser's own playback here, so no compensation.
    e.chain = buildChain(this.audioCtx, { ...clip, keepPitch: false, speed: 1 }, this.workletsReady);
    this.skippedAudioFx = e.chain.skipped;
    e.node.connect(e.chain.input);
    e.chain.output.connect(e.gain);
  }

  /** Peak level per channel in dBFS (for meters). */
  levels(): [number, number] {
    const out: [number, number] = [-Infinity, -Infinity];
    const buf = new Float32Array(1024);
    this.analysers.forEach((an, i) => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      out[i] = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    });
    return out;
  }

  setMasterVolume(v: number): void {
    if (this.master) this.master.gain.value = v;
  }

  /* --------------------------- elements --------------------------- */

  private element(clip: Clip): ElementEntry | null {
    if (!clip.mediaId) return null;
    let e = this.elements.get(clip.id);
    if (e) { e.lastUsed = performance.now(); return e; }
    const url = getPlaybackUrl(clip.mediaId);
    if (!url) return null;
    const el = document.createElement(clip.kind === 'audio' ? 'audio' : 'video');
    // Keeps the canvas readable (effects, scopes) and Web Audio audible with desktop in-place files.
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = url;
    el.muted = !this.audioCtx;
    // Some browsers (notably Safari) only decode smoothly for elements that are in the page.
    mediaHost().appendChild(el);
    (el as HTMLVideoElement).playsInline = true;
    el.setAttribute('playsinline', '');
    // Export keeps the pitch when speed changes (unless switched off per clip); match it here.
    (el as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch = clip.keepPitch !== false;
    const rerender = () => { if (!this._playing) this.requestRender(); };
    el.addEventListener('loadeddata', rerender);
    el.addEventListener('seeked', rerender);
    e = { el, mediaId: clip.mediaId, clipId: clip.id, lastUsed: performance.now(), wantPlay: false };
    this.elements.set(clip.id, e);
    this.routeAudio(e);
    this.pruneElements();
    return e;
  }

  private destroyElement(id: string): void {
    const e = this.elements.get(id);
    if (!e) return;
    e.el.pause();
    try { e.node?.disconnect(); e.gain?.disconnect(); } catch { /* ignore */ }
    e.el.removeAttribute('src');
    e.el.load();
    e.el.remove();
    this.elements.delete(id);
  }

  private pruneElements(): void {
    if (this.elements.size <= MAX_ELEMENTS) return;
    const sorted = [...this.elements.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id] of sorted.slice(0, this.elements.size - MAX_ELEMENTS)) this.destroyElement(id);
  }

  /** Rebuild elements for a media file (e.g. when its preview proxy becomes ready). */
  invalidateMedia(mediaId: string): void {
    for (const [id, e] of [...this.elements]) if (e.mediaId === mediaId) this.destroyElement(id);
    if (!this._playing) this.syncPaused();
    this.requestRender();
  }

  private mediaClips(): { clip: Clip; trackMuted: boolean; trackHidden: boolean; visual: boolean }[] {
    const out = [];
    for (const t of this.project.tracks) for (const c of t.clips) {
      if (c.kind === 'video' || c.kind === 'audio') out.push({ clip: c, trackMuted: !!t.muted, trackHidden: !!t.hidden, visual: t.kind === 'visual' });
    }
    return out;
  }

  private hasAudio(clip: Clip): boolean {
    return !!this.project.media.find((m) => m.id === clip.mediaId)?.hasAudio;
  }

  /** While paused: park every nearby element on the right frame. */
  private syncPaused(): void {
    const t = this._time;
    // Have the rendered chunk (if any) ready at the playhead so playback can start from it at once.
    const hit = renderCache.lookup(t);
    if (hit) {
      const el = this.cacheEl(hit.url, true)!;
      if (Math.abs(el.currentTime - (t - hit.start)) > 0.02) try { el.currentTime = t - hit.start; } catch { /* not ready */ }
    }
    const tol = 0.5 / this.project.settings.fps;
    for (const { clip } of this.mediaClips()) {
      if (clip.kind !== 'video') continue;
      const [rs, re] = this.clipRange(clip);
      if (t < rs - PRELOAD_AHEAD || t >= re) continue;
      const e = this.element(clip);
      if (!e) continue;
      const target = this.srcTime(clip, Math.max(t, rs));
      if (Math.abs(e.el.currentTime - target) > tol) {
        try { e.el.currentTime = target; } catch { /* not ready */ }
      }
      if (e.gain) e.gain.gain.value = 0;
    }
  }

  /** While playing: keep elements in step with the clock. */
  private syncPlaying(t: number): void {
    const fps = this.project.settings.fps;
    for (const { clip, trackMuted } of this.mediaClips()) {
      const [rs, re] = this.clipRange(clip);
      const active = t >= rs && t < re;
      const upcoming = !active && t >= rs - PRELOAD_AHEAD && t < rs;
      const existing = this.elements.get(clip.id);
      if (!active && !upcoming) {
        if (existing && !existing.el.paused) existing.el.pause();
        if (existing) existing.wantPlay = false;
        continue;
      }
      const e = existing ?? this.element(clip);
      if (!e) continue;
      e.lastUsed = performance.now();
      const el = e.el;
      if (upcoming) {
        const target = this.srcTime(clip, rs);
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - target) > 0.15 && !el.seeking) el.currentTime = target;
        continue;
      }
      const local = t - clip.start;
      const expected = this.srcTime(clip, t);
      const inside = t >= clip.start && t < clipEnd(clip);
      const audible = inside && !trackMuted && !clip.muted && this.hasAudio(clip) && !clip.reverse;
      const g = audible ? clipGain(clip, local) : 0;
      if (e.gain && this.audioCtx) e.gain.gain.setTargetAtTime(g, this.audioCtx.currentTime, 0.01);
      else el.volume = Math.min(1, g);
      // Transition overlap beyond the media's own start/end: hold that frame.
      const unclamped = clip.reverse ? clip.sourceIn + (clip.duration - local) * clip.speed : clip.sourceIn + local * clip.speed;
      if (clip.reverse || Math.abs(unclamped - expected) > 1e-3) {
        // Browsers can't play backwards; step through frames instead.
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - expected) > 1 / fps && !el.seeking) el.currentTime = expected;
        continue;
      }
      const signed = el.currentTime - expected;
      const drift = Math.abs(signed);
      // Nudge the speed to catch up instead of seeking: seeks force a re-buffer, which is what stutters.
      let rate = clip.speed;
      if (e !== this.masterEl && !el.paused && drift > 0.04) rate = clip.speed * (1 - Math.max(-0.08, Math.min(0.08, signed * 0.5)));
      rate = Math.min(16, Math.max(0.0625, rate));
      if (Math.abs(el.playbackRate - rate) > 1e-3) {
        try { el.playbackRate = rate; } catch { /* unsupported rate */ }
      }
      if (el.paused || !e.wantPlay) {
        if (drift > 0.05) { el.currentTime = expected; this.stats.seeks++; }
        e.wantPlay = true;
        el.play().catch(() => { e.wantPlay = false; });
      } else if (drift > 0.75 && !el.seeking && e !== this.masterEl) {
        el.currentTime = expected;
        this.stats.seeks++;
      }
    }
  }

  /* --------------------------- render loop --------------------------- */

  private masterEl: ElementEntry | null = null;
  private holdSince = 0;

  /**
   * Let the main video drive the clock. While it plays, the timeline time is
   * read from the video itself, so the picture never drifts or needs seeking;
   * while it is still buffering, the clock waits for it (up to 1.5 s).
   */
  private followMaster(t: number): number {
    let best: { e: ElementEntry; clip: Clip; order: number } | null = null;
    this.project.tracks.forEach((track, ti) => {
      if (track.kind !== 'visual' || track.hidden) return;
      for (const clip of track.clips) {
        if (clip.kind !== 'video' || clip.reverse || clip.freeze || t < clip.start || t >= clipEnd(clip)) continue;
        const e = this.elements.get(clip.id);
        if (!e) continue;
        if (!best || ti > best.order) best = { e, clip, order: ti }; // bottom-most track = main footage
      }
    });
    if (!best) {
      // No video here: a long audio clip (music, voiceover) can drive the clock instead. Short
      // one-shots (ticks, whooshes) never do — waiting for each one to load made playback stop-start.
      for (const clip of this.project.tracks.filter((x) => x.kind === 'audio' && !x.muted).flatMap((x) => x.clips)) {
        if (clip.reverse || clip.freeze || t < clip.start || t >= clipEnd(clip)) continue;
        if (clip.duration < MIN_AUDIO_MASTER || clipEnd(clip) - t < 0.5) continue;
        const e = this.elements.get(clip.id);
        if (e) { best = { e, clip, order: -1 }; break; }
      }
    }
    const found = best as { e: ElementEntry; clip: Clip } | null;
    this.masterEl = found?.e ?? null;
    if (!found) { this.holdSince = 0; return t; }
    const { e, clip } = found;
    const el = e.el;
    const now = performance.now();
    const ready = e.wantPlay && !el.paused && !el.seeking && el.readyState >= 3;
    if (!ready) {
      if (!this.holdSince) this.holdSince = now;
      // Wait for a buffering video (so picture and sound stay together); audio alone waits far less.
      if (now - this.holdSince < (clip.kind === 'audio' ? 300 : 1500)) {
        this.stats.holds++;
        this.startTime = this._time;
        this.startWall = now;
        return this._time;
      }
      return t;
    }
    this.holdSince = 0;
    const media = this.project.media.find((m) => m.id === clip.mediaId);
    const limit = media?.duration ? media.duration - 0.05 : Infinity;
    if (el.currentTime >= limit) return t;
    const tm = clip.start + (el.currentTime - clip.sourceIn) / clip.speed;
    if (Math.abs(tm - t) > 0.5 || tm < this._time - 0.02) return t;
    this.startTime = tm;
    this.startWall = now;
    return tm;
  }

  private tick = (): void => {
    if (!this._playing) return;
    const dur = projectDuration(this.project);
    const end = this.range ? Math.min(this.range[1], dur) : dur;
    let t = this.startTime + ((performance.now() - this.startWall) / 1000);
    t = this.followMaster(t);
    if (t >= end) {
      if (this.loop) {
        t = this.range ? this.range[0] : 0;
        this.startTime = t;
        this.startWall = performance.now();
        for (const e of this.elements.values()) e.el.pause();
      } else {
        this._time = end;
        this.pause();
        this.emitTime();
        return;
      }
    }
    const nowMs = performance.now();
    if (this.stats.lastTick) {
      const gap = nowMs - this.stats.lastTick;
      if (gap > 50) this.stats.longGaps++;
      this.stats.maxGap = Math.max(this.stats.maxGap, gap);
    }
    this.stats.lastTick = nowMs;
    this.stats.frames++;
    this._time = t;
    const a0 = performance.now();
    this.syncPlaying(t);
    const a1 = performance.now();
    this.draw();
    const a2 = performance.now();
    this.stats.syncMs += a1 - a0;
    this.stats.drawMs += a2 - a1;
    // Adaptive preview resolution: keep frame times under ~22 ms on slow devices.
    this.drawEma = this.drawEma * 0.85 + (a2 - a1) * 0.15;
    if (this.stats.frames > 10) {
      if (this.drawEma > 22 && this.quality > 0.5) { this.setQuality(Math.max(0.5, this.quality - 0.25)); this.drawEma = 0; }
    }
    this.emitTime();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** True when every video needed at the playhead has its frame ready and the picture is drawn (tests/benchmarks). */
  settled(): boolean {
    if (this.renderQueued) return false;
    const t = this._time;
    for (const { clip, trackHidden, visual } of this.mediaClips()) {
      if (clip.kind !== 'video' || !visual || trackHidden) continue;
      const [rs, re] = this.clipRange(clip);
      if (t < rs || t >= re) continue;
      const e = this.elements.get(clip.id);
      if (!e || e.el.seeking || e.el.readyState < 2) return false;
    }
    return true;
  }

  requestRender(): void {
    if (this._playing || this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.draw();
    });
  }

  private sources: FrameSources = {
    getMask: (clip, st) => this.getMask(clip, st),
    getVisual: (clip, st) => {
      if (clip.kind === 'image' && clip.mediaId) {
        const anim = this.project.media.find((m) => m.id === clip.mediaId)?.meta?.animated ? getAnimatedSync(clip.mediaId) : null;
        if (anim) { const f = animatedFrame(anim, st); return { src: f, width: f.width, height: f.height, displayWidth: anim.width, displayHeight: anim.height }; }
        if (anim === undefined) void loadAnimated(clip.mediaId).then(() => this.requestRender());
        const img = getImageSync(clip.mediaId);
        if (!img) {
          getImage(clip.mediaId)?.then(() => this.requestRender(), () => undefined);
          return null;
        }
        return { src: img, width: img.naturalWidth, height: img.naturalHeight };
      }
      if (clip.kind === 'video') {
        const e = this.element(clip);
        const v = e?.el as HTMLVideoElement | undefined;
        if (v && v.readyState >= 2 && v.videoWidth && (this._playing || !v.seeking)) return { src: v, width: v.videoWidth, height: v.videoHeight };
        // Not decoded yet (new clip, fresh seek): show the nearest filmstrip thumbnail instead of a black flash.
        return this.thumbnailFrame(clip, this.srcTime(clip, this._time));
      }
      return null;
    },
  };

  private thumbs = new Map<string, HTMLImageElement>();
  private thumbnailFrame(clip: Clip, srcTime: number): VisualFrame | null {
    const m = this.project.media.find((x) => x.id === clip.mediaId);
    if (!m?.thumbnails?.length || !m.duration || !m.width || !m.height) return null;
    const i = Math.min(m.thumbnails.length - 1, Math.max(0, Math.floor((srcTime / m.duration) * m.thumbnails.length)));
    const key = `${m.id}:${i}`;
    let img = this.thumbs.get(key);
    if (!img) {
      img = new Image();
      img.onload = () => this.requestRender();
      img.src = m.thumbnails[i];
      this.thumbs.set(key, img);
    }
    // Report the media's real size so layout matches the full-resolution frame.
    return img.complete && img.naturalWidth ? { src: img, width: img.naturalWidth, height: img.naturalHeight, displayWidth: m.width, displayHeight: m.height } : null;
  }

  /* Background-removal masks, computed one frame at a time and cached. */
  private masks = new Map<string, HTMLCanvasElement>();
  private lastMask = new Map<string, HTMLCanvasElement>();
  private maskBusy = false;
  maskError: string | null = null;

  private getMask(clip: Clip, st: number): HTMLCanvasElement | null {
    const key = `${clip.mediaId}:${clip.kind === 'image' ? 0 : Math.round(st * 15)}`;
    const hit = this.masks.get(key);
    if (hit) return hit;
    if (!this.maskBusy && !this.maskError) {
      const vf = this.sources.getVisual(clip, st);
      if (vf) {
        this.maskBusy = true;
        segmentPerson(vf.src, vf.width, vf.height)
          .then((m) => {
            this.masks.set(key, m);
            this.lastMask.set(clip.mediaId!, m);
            if (this.masks.size > 240) this.masks.delete(this.masks.keys().next().value!);
            this.requestRender();
          })
          .catch((e: Error) => { this.maskError = e.message; this.stateListeners.forEach((f) => f(this._playing)); })
          .finally(() => { this.maskBusy = false; });
      }
    }
    return this.lastMask.get(clip.mediaId!) ?? null;
  }

  /* ---- playback from background-rendered chunks (see renderCache.ts) ---- */
  private cacheEls: HTMLVideoElement[] = [];

  private cacheEl(url: string, create: boolean): HTMLVideoElement | null {
    const hit = this.cacheEls.find((e) => e.dataset.url === url);
    if (hit || !create) return hit ?? null;
    let el = this.cacheEls.length < 2 ? null : this.cacheEls.find((e) => e.paused) ?? this.cacheEls[0];
    if (!el) {
      el = document.createElement('video');
      el.crossOrigin = 'anonymous';
      el.muted = true; el.playsInline = true; el.preload = 'auto';
      mediaHost().appendChild(el);
      this.cacheEls.push(el);
    }
    el.pause();
    el.dataset.url = url;
    el.src = url;
    return el;
  }

  /** Draw from a pre-rendered chunk. Returns false to fall back to live compositing. */
  private drawCached(): boolean {
    const t = this._time;
    const hit = renderCache.lookup(t);
    if (!hit) { this.stats.cacheMiss.none++; return false; }
    const local = t - hit.start;
    const el = this.cacheEl(hit.url, true)!;
    for (const other of this.cacheEls) if (other !== el && !other.paused) other.pause();
    if (el.paused && el.readyState >= 1) {
      if (Math.abs(el.currentTime - local) > 0.05) el.currentTime = local;
      el.play().catch(() => undefined);
    }
    // Get the next chunk ready so the hand-over is seamless.
    const next = renderCache.lookup(hit.start + CHUNK_SECONDS + 1e-3);
    if (next && next.url !== hit.url && !this.cacheEl(next.url, false) && CHUNK_SECONDS - local < 1.5) {
      const pre = this.cacheEl(next.url, true)!;
      pre.currentTime = 0;
    }
    if (el.readyState < 2 || el.seeking) { this.stats.cacheMiss.loading++; return false; }
    const drift = el.currentTime - local;
    if (Math.abs(drift) > 0.15) { el.currentTime = local; this.stats.cacheMiss.drift++; return false; }
    el.playbackRate = Math.min(1.1, Math.max(0.9, 1 - drift * 0.5));
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.imageSmoothingQuality = 'low';
    this.ctx.drawImage(el, 0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    this.stats.cachedFrames++;
    return true;
  }

  draw(): void {
    if (this._playing && this.drawCached()) return;
    try {
      this.lastBounds = renderFrame(this.ctx, this.project, this._time, this.sources, {
        scale: this.scale,
        placeholders: true,
        selectedIds: this._playing ? [] : this.selectedIds,
        staticIds: this._playing ? [] : this.selectedIds,
        draft: this._playing,
      });
    } catch (err) {
      console.error('Render failed', err);
    }
  }

  /**
   * Colour of a clip's source picture at (u, v) (0..1 of the full source
   * frame) at the playhead, before any effects. Averages a small patch.
   */
  sampleSource(clip: Clip, u: number, v: number): [number, number, number] | null {
    const vf = this.sources.getVisual(clip, this.srcTime(clip, this._time));
    if (!vf) return null;
    const c = document.createElement('canvas');
    c.width = 5; c.height = 5;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    const sx = Math.max(0, Math.min(vf.width - 5, u * vf.width - 2)), sy = Math.max(0, Math.min(vf.height - 5, v * vf.height - 2));
    x.drawImage(vf.src, sx, sy, 5, 5, 0, 0, 5, 5);
    const d = x.getImageData(0, 0, 5, 5).data;
    const acc = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { acc[0] += d[i]; acc[1] += d[i + 1]; acc[2] += d[i + 2]; }
    return [Math.round(acc[0] / 25), Math.round(acc[1] / 25), Math.round(acc[2] / 25)];
  }

  /** Current frame as a PNG/JPEG blob at preview resolution. */
  snapshot(type = 'image/png'): Promise<Blob | null> {
    this.draw();
    return new Promise((r) => this.canvas.toBlob(r, type, 0.92));
  }

  private emitTime(): void {
    renderCache.playhead = this._time;
    this.timeListeners.forEach((f) => f(this._time));
  }

  /** Visual value helper for overlays (e.g. inspector readouts at the playhead). */
  valueAt(clip: Clip, prop: 'x' | 'y' | 'scale' | 'rotation' | 'opacity'): number {
    return valueAt(clip, prop, this._time - clip.start);
  }

  dispose(): void {
    this.pause();
    for (const id of [...this.elements.keys()]) this.destroyElement(id);
    for (const c of this.cacheEls) { c.removeAttribute('src'); c.load(); c.remove(); }
    this.cacheEls = [];
    void this.audioCtx?.close();
  }
}

let host: HTMLDivElement | null = null;
/** Invisible container for the preview's media elements. */
function mediaHost(): HTMLDivElement {
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(host);
  return host;
}
