import { uid } from './ids';
import {
  PROJECT_SCHEMA_VERSION,
  type Clip,
  type MediaItem,
  type Project,
  type ProjectSettings,
  type ShapeStyle,
  type TextStyle,
  type Track,
  type TrackKind,
  type Transform,
} from './types';

export const DEFAULT_IMAGE_DURATION = 4;
export const DEFAULT_TEXT_DURATION = 3;

export function defaultTransform(): Transform {
  return {
    x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}

export function createTrack(kind: TrackKind, name?: string): Track {
  return { id: uid('trk'), kind, name: name ?? (kind === 'visual' ? 'Video' : 'Audio'), clips: [] };
}

export function createProject(name: string, settings: ProjectSettings): Project {
  const now = Date.now();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: uid('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    settings,
    tracks: [createTrack('visual', 'Main'), createTrack('audio', 'Audio 1')],
    media: [],
    markers: [],
    magnetic: false,
  };
}

function baseClip(kind: Clip['kind'], name: string, start: number, duration: number): Clip {
  return {
    id: uid('clp'),
    kind,
    name,
    start,
    duration,
    sourceIn: 0,
    speed: 1,
    reverse: false,
    transform: defaultTransform(),
    fit: 'contain',
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    videoFadeIn: 0,
    videoFadeOut: 0,
    effects: [],
    keyframes: {},
  };
}

export function createClipFromMedia(media: MediaItem, start: number): Clip {
  const duration = media.kind === 'image' ? DEFAULT_IMAGE_DURATION : Math.max(0.1, media.duration);
  const kind = media.kind === 'image' ? 'image' : media.kind === 'audio' ? 'audio' : 'video';
  const clip = baseClip(kind, media.name, start, duration);
  clip.mediaId = media.id;
  return clip;
}

export function createSolidClip(color: string, start: number, duration = DEFAULT_IMAGE_DURATION): Clip {
  const clip = baseClip('solid', 'Colour', start, duration);
  clip.color = color;
  clip.fit = 'fill';
  return clip;
}

/** Vector shape or emoji sticker clip. */
export function createShapeClip(shape: ShapeStyle, start: number, duration = DEFAULT_IMAGE_DURATION): Clip {
  const clip = baseClip('shape', shape.type === 'emoji' ? `Emoji ${shape.emoji ?? ''}` : shapeName(shape.type) ?? 'Shape', start, duration);
  clip.shape = shape;
  clip.fit = 'contain';
  return clip;
}

const shapeName = (t: ShapeStyle['type']) => ({ rect: 'Rectangle', ellipse: 'Circle', triangle: 'Triangle', star: 'Star', heart: 'Heart', arrow: 'Arrow', line: 'Line', bubble: 'Speech bubble', burst: 'Burst', emoji: 'Emoji', speedlines: 'Speed lines', rays: 'Sunburst', dots: 'Comic dots', gradient: 'Gradient', streaks: 'Streaks', starburst: 'Starburst', countdown: 'Countdown' })[t];

/** Background shapes fill the frame: pass the project size. */
export const BACKGROUND_SHAPES: ShapeStyle['type'][] = ['speedlines', 'rays', 'dots', 'gradient', 'streaks'];

export function defaultShape(type: ShapeStyle['type'], frame = { width: 1080, height: 1920 }): ShapeStyle {
  const base: ShapeStyle = { type, width: 420, height: 420, fill: '#f2b544', fill2: null, stroke: '#111111', strokeWidth: 0, radius: 36, shadow: 0 };
  const full = { width: frame.width, height: frame.height };
  switch (type) {
    case 'speedlines': return { ...base, ...full, fill: '#d9101f', fill2: '#ff3b3b', color2: '#3d7bff', animate: true };
    case 'rays': return { ...base, ...full, fill: '#ffb800', color2: '#ffd84a', points: 18, animate: true };
    case 'dots': return { ...base, ...full, fill: '#2f6bff', color2: '#1d4fd1', animate: false };
    case 'streaks': return { ...base, ...full, fill: '#e3141f', fill2: '#ff6a3c', color2: '#b30a18', angle: -18, animate: true };
    case 'starburst': return { ...base, width: 900, height: 900, fill: '#4f9ff0', fill2: '#ffffff', color2: '#b9ddff', points: 64, animate: true };
    case 'gradient': return { ...base, ...full, fill: '#7a2cff', fill2: '#ff3fa4', gradientKind: 'linear', angle: 160, animate: false };
    case 'countdown': return { ...base, width: 260, height: 260, fill: 'rgba(0,0,0,0.45)', stroke: '#ffd23f', strokeWidth: 22, textColor: '#ffffff', countStyle: 'ring' };
    case 'arrow': return { ...base, width: 520, height: 260, fill: '#ffffff', stroke: '#111111', strokeWidth: 10 };
    case 'line': return { ...base, width: 640, height: 16, fill: '#ffffff' };
    case 'bubble': return { ...base, width: 560, height: 360, fill: '#ffffff', stroke: '#111111', strokeWidth: 8, radius: 60 };
    case 'burst': return { ...base, width: 480, height: 480, fill: '#ffd23f', stroke: '#e5484d', strokeWidth: 10, points: 14 };
    case 'star': return { ...base, fill: '#ffd23f', points: 5 };
    case 'heart': return { ...base, fill: '#ef4b6b' };
    case 'rect': return { ...base, width: 600, height: 340 };
    case 'ellipse': return { ...base, fill: 'transparent', stroke: '#ef4444', strokeWidth: 14 };
    case 'emoji': return { ...base, width: 320, height: 320, fill: 'transparent', emoji: '🔥' };
    default: return base;
  }
}

/** Adjustment layer: its effects and masks apply to everything on the tracks below it. */
export function createAdjustmentClip(start: number, duration = DEFAULT_IMAGE_DURATION): Clip {
  const clip = baseClip('adjustment', 'Adjustment', start, duration);
  clip.fit = 'fill';
  return clip;
}

export function defaultTextStyle(content = 'Your text'): TextStyle {
  return {
    content,
    fontFamily: 'Archivo Black',
    fontSize: 96,
    fontWeight: 400,
    italic: false,
    align: 'center',
    letterSpacing: 0,
    lineHeight: 1.15,
    color: '#ffffff',
    gradient: null,
    strokeColor: '#000000',
    strokeWidth: 0,
    shadowColor: 'rgba(0,0,0,0.55)',
    shadowBlur: 12,
    shadowOffsetX: 0,
    shadowOffsetY: 4,
    glow: 0,
    background: null,
    backgroundPadding: 18,
    backgroundRadius: 14,
    boxWidth: 0.86,
    uppercase: false,
    animIn: 'pop',
    animOut: 'fade',
    animDuration: 0.35,
  };
}

/** Text without colour markup ({#ff0|A)} → A)), for names and lists. */
export function plainText(s: string): string {
  return s.replace(/\{(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\|([^{}]*)\}/g, '$1');
}

export function createTextClip(start: number, style: Partial<TextStyle> = {}, duration = DEFAULT_TEXT_DURATION): Clip {
  const text = { ...defaultTextStyle(), ...style };
  const clip = baseClip('text', plainText(text.content).replace(/\s+/g, ' ').slice(0, 24) || 'Text', start, duration);
  clip.text = text;
  return clip;
}

/** Original text presets. Sizes assume a 1080-wide canvas and are scaled on insert. */
export interface TextPreset { id: string; name: string; style: Partial<TextStyle>; y?: number }

export const TEXT_PRESETS: TextPreset[] = [
  { id: 'headline', name: 'Headline', style: { content: 'BIG NEWS', fontFamily: 'Archivo Black', fontSize: 120, uppercase: true, strokeWidth: 0, animIn: 'pop' }, y: -0.25 },
  { id: 'caption-box', name: 'Caption box', style: { content: 'Wait for it…', fontFamily: 'Figtree', fontWeight: 800, fontSize: 64, color: '#111111', background: '#ffffff', backgroundRadius: 16, shadowBlur: 0, shadowOffsetY: 0, animIn: 'slideUp' }, y: 0.25 },
  { id: 'outline', name: 'Bold outline', style: { content: 'NO WAY', fontFamily: 'Bangers', fontSize: 140, color: '#ffd23f', strokeColor: '#111111', strokeWidth: 10, letterSpacing: 2, animIn: 'pop' } },
  { id: 'neon', name: 'Neon', style: { content: 'level up', fontFamily: 'Monoton', fontSize: 110, color: '#ffe9ff', glow: 28, shadowColor: '#ff3fd1', shadowBlur: 0, animIn: 'fade' } },
  { id: 'gradient', name: 'Gradient', style: { content: 'Top 5 Picks', fontFamily: 'Archivo Black', fontSize: 110, gradient: { from: '#ffe066', to: '#ff5f6d' }, animIn: 'slideUp' } },
  { id: 'lower-third', name: 'Lower third', style: { content: 'Dan · Creator', fontFamily: 'Figtree', fontWeight: 700, fontSize: 52, align: 'left', background: 'rgba(15,17,24,0.82)', backgroundRadius: 10, boxWidth: 0.6, animIn: 'slideUp', animOut: 'slideDown' }, y: 0.36 },
  { id: 'handwritten', name: 'Marker note', style: { content: 'so good!', fontFamily: 'Permanent Marker', fontSize: 100, color: '#ffffff', shadowBlur: 0, shadowOffsetY: 6, shadowColor: '#ff3f7f', animIn: 'typewriter' } },
  { id: 'subtitle', name: 'Subtitle', style: { content: 'Here is what happened next', fontFamily: 'Figtree', fontWeight: 800, fontSize: 58, strokeColor: '#000000', strokeWidth: 6, shadowBlur: 0, shadowOffsetY: 0, animIn: 'wordByWord', animOut: 'none' }, y: 0.3 },
  { id: 'retro', name: 'Retro serif', style: { content: 'Chapter One', fontFamily: 'DM Serif Display', fontSize: 110, italic: true, color: '#f7e7c6', animIn: 'fade' } },
  { id: 'minimal', name: 'Minimal', style: { content: 'less is more', fontFamily: 'Figtree', fontWeight: 300, fontSize: 64, letterSpacing: 8, shadowBlur: 0, shadowOffsetY: 0, animIn: 'fade' } },
];

/** Fonts bundled via Google Fonts (all SIL Open Font License). Uploads are added at runtime. */
export const BUILTIN_FONTS = [
  'Archivo Black', 'Figtree', 'Bangers', 'Monoton', 'Permanent Marker', 'DM Serif Display',
  'Anton', 'Bebas Neue', 'Poppins', 'Montserrat', 'Oswald', 'Lobster', 'Press Start 2P', 'Rubik Mono One',
];
