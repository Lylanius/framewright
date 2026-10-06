/**
 * Framewright project model.
 *
 * Everything in here is plain, serialisable data. The UI, the render engine and
 * the export engine all read the same structure, which is what lets a project
 * made on a phone open unchanged on a desktop.
 *
 * Units: all times are seconds (floating point). Positions are fractions of the
 * canvas (0 = centre, -0.5 = left/top edge, +0.5 = right/bottom edge) so a
 * project can be re-sized without breaking layouts.
 */

export const PROJECT_SCHEMA_VERSION = 1;

export type MediaKind = 'video' | 'image' | 'audio';

export interface MediaItem {
  id: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  size: number;
  /** Seconds. Images get Infinity-like behaviour via clip duration; stored as 0. */
  duration: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  /** Content fingerprint used for duplicate detection. */
  fingerprint: string;
  importedAt: number;
  favourite?: boolean;
  folder?: string;
  /** Small JPEG data URLs for timeline filmstrips / library tiles. */
  thumbnails?: string[];
  /** Normalised peak values (0..1), `peaksPerSecond` per second of media. */
  peaks?: number[];
  peaksPerSecond?: number;
  /** Desktop app: the original file is used in place from here (no copy in app storage). */
  localPath?: string;
  /** RMS loudness (absolute, 0..1) at `peaksPerSecond`; drives silence removal and highlights. */
  loudness?: number[];
  /** Speech transcript in source-media seconds (from on-device transcription). */
  transcript?: { words: WordTiming[]; wordLevel: boolean; model: string; language: string | null; createdAt: number };
  /** Low-res preview copy for smooth playback of 4K / high-frame-rate footage. */
  proxy?: 'pending' | 'ready' | 'failed';
  /** Extra metadata shown in the library (codec, fps, sample rate…). */
  meta?: Record<string, string | number>;
  /** Set when import succeeded but something is off (e.g. undecodable audio). */
  warning?: string;
}

export type TrackKind = 'visual' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** Special-purpose tracks. Caption tracks feed SRT/VTT export and caption styling. */
  role?: 'captions' | 'background';
  clips: Clip[];
  locked?: boolean;
  hidden?: boolean;
  muted?: boolean;
}

export type ClipKind = 'video' | 'image' | 'audio' | 'text' | 'solid' | 'adjustment' | 'shape';

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold' | 'bezier';

export interface Keyframe {
  /** Clip-local time in seconds (0 = clip start). */
  t: number;
  v: number;
  ease: Easing;
  /** Control points for `ease: 'bezier'` (CSS cubic-bezier x1, y1, x2, y2). */
  bez?: [number, number, number, number];
}

/** Transform/volume properties that can be animated with keyframes. */
export type AnimatableProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume';
/**
 * Any animatable number: a transform prop, or a path such as 'crop.left',
 * 'text.fontSize', 'fx.<effectId>.<param>' or 'afx.<audioEffectId>.<param>'.
 */
export type ParamPath = AnimatableProp | string;

export type MaskType = 'rect' | 'ellipse' | 'polygon' | 'freeform';

/**
 * A mask cuts a clip down to (or out of) a shape. Positions are relative to the
 * clip's own picture, so the mask moves, scales and rotates with the clip.
 * x/y: centre offset (-0.5..0.5 of the picture); w/h: size as a fraction of it.
 */
export interface Mask {
  id: string;
  name: string;
  type: MaskType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** Rectangle corner rounding, 0..1. */
  roundness: number;
  /** Polygon / freehand points, 0..1 of the picture (before x/y/w/h are applied they are used as-is). */
  points: { x: number; y: number }[];
  /** Edge softness in project pixels. */
  feather: number;
  opacity: number;
  invert: boolean;
  mode: 'add' | 'subtract' | 'intersect';
  keyframes: Partial<Record<string, Keyframe[]>>;
}

export type AudioEffectType = 'eq' | 'compressor' | 'limiter' | 'gate' | 'voice' | 'reverb' | 'echo' | 'pan' | 'pitch' | 'highpass' | 'lowpass';

export interface AudioEffect {
  id: string;
  type: AudioEffectType;
  enabled: boolean;
  params: Record<string, number>;
}

/** A 3D colour lookup table imported from a .cube file. */
export interface LutAsset {
  id: string;
  name: string;
  size: number;
  /** size³ RGB triplets as 16-bit values (0..65535), base64-encoded, red varying fastest. */
  data: string;
}

export interface Transform {
  x: number;
  y: number;
  /** 1 = the clip's natural fitted size. */
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  /** 0..1 */
  opacity: number;
  flipH: boolean;
  flipV: boolean;
  /** Fractions of the source trimmed from each edge (0..0.9). */
  crop: { left: number; top: number; right: number; bottom: number };
}

export type FitMode = 'contain' | 'cover' | 'fill';

export interface EffectInstance {
  id: string;
  type: string;
  enabled: boolean;
  params: Record<string, number>;
  /** Non-numeric settings (curve points, LUT id, key colour…). */
  data?: Record<string, unknown>;
}

/** A transition on the cut between this clip and the next clip on the same track. */
export interface TransitionInstance {
  type: string;
  /** Seconds; the transition is centred on the cut. */
  duration: number;
  params: Record<string, number>;
  color?: string;
}

/** Word timing for captions (clip-local seconds). */
export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

export type HighlightMode = 'none' | 'color' | 'box' | 'karaoke' | 'underline';

export type TextAnimation =
  | 'none'
  | 'fade'
  | 'pop'
  | 'slideUp'
  | 'slideDown'
  | 'typewriter'
  | 'wordByWord';

export interface TextStyle {
  content: string;
  fontFamily: string;
  fontSize: number; // px at project resolution
  fontWeight: number;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing: number; // px
  lineHeight: number; // multiplier
  color: string;
  /** Optional two-stop vertical gradient; overrides color when set. */
  gradient?: { from: string; to: string } | null;
  strokeColor: string;
  strokeWidth: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  glow: number;
  background: string | null;
  backgroundPadding: number;
  backgroundRadius: number;
  /** Max line width as a fraction of canvas width. */
  boxWidth: number;
  uppercase: boolean;
  animIn: TextAnimation;
  animOut: TextAnimation;
  animDuration: number;
  /** Border around the background box. */
  backgroundBorder?: string | null;
  backgroundBorderWidth?: number;
  /** One background box the full box width (buttons) instead of one per line. */
  backgroundFull?: boolean;
  /** Spoken-word highlighting (captions). */
  highlightMode?: HighlightMode;
  highlightColor?: string;
  highlightTextColor?: string;
}

export type ShapeType = 'rect' | 'ellipse' | 'triangle' | 'star' | 'heart' | 'arrow' | 'line' | 'bubble' | 'burst' | 'emoji'
  | 'speedlines' | 'rays' | 'dots' | 'gradient' | 'streaks' | 'starburst' | 'countdown' | 'sparkles';

/** Vector shape / emoji sticker. Sizes are in project pixels. */
export interface ShapeStyle {
  type: ShapeType;
  width: number;
  height: number;
  fill: string;
  /** Second colour for a vertical gradient fill (optional). */
  fill2?: string | null;
  stroke: string;
  strokeWidth: number;
  /** Corner rounding for rect / bubble (px). */
  radius: number;
  /** Star/burst points. */
  points?: number;
  /** Emoji character(s) for 'emoji'. */
  emoji?: string;
  shadow?: number;
  /** Coloured outer glow (px) — e.g. a glowing ring. */
  glow?: number;
  glowColor?: string;
  /** Backgrounds: second colour (lines / rays / dots). */
  color2?: string;
  /** Backgrounds animate (flicker, rotate, drift). */
  animate?: boolean;
  /** Gradient backgrounds: 'linear' | 'radial'; angle in degrees. */
  gradientKind?: 'linear' | 'radial';
  angle?: number;
  /** Countdown: look and number colour. */
  countStyle?: 'ring' | 'bar' | 'number';
  textColor?: string;
}

export type MotionIn = 'none' | 'fade' | 'pop' | 'zoom' | 'slam' | 'slideUp' | 'slideDown' | 'slideLeft' | 'slideRight' | 'spin' | 'drop';
export type MotionLoop = 'none' | 'pulse' | 'wiggle' | 'bounce' | 'float' | 'spin' | 'shake' | 'swing';

/** Preset in / out / looping animation for any visual clip (stickers, logos, overlays). */
export interface ClipMotion {
  in: MotionIn;
  out: MotionIn;
  loop: MotionLoop;
  /** Seconds for in and out. */
  duration: number;
  /** Loop speed multiplier. */
  speed: number;
}

/** An empty slot in a template, waiting for media. */
export interface Placeholder {
  label: string;
  /** Order in which "Fill slots" uses your clips. */
  index: number;
  accepts: 'visual' | 'audio';
}

export interface Clip {
  id: string;
  kind: ClipKind;
  name: string;
  mediaId?: string;
  /** Timeline position (seconds). */
  start: number;
  /** Length on the timeline (seconds, after speed is applied). */
  duration: number;
  /** Where in the source media this clip begins (seconds). */
  sourceIn: number;
  /** Playback rate; 2 = twice as fast. */
  speed: number;
  reverse: boolean;
  transform: Transform;
  fit: FitMode;
  /** 0..2 (1 = unity). */
  volume: number;
  muted: boolean;
  fadeIn: number;
  fadeOut: number;
  /** Visual opacity fades (seconds). */
  videoFadeIn: number;
  videoFadeOut: number;
  effects: EffectInstance[];
  keyframes: Partial<Record<ParamPath, Keyframe[]>>;
  masks?: Mask[];
  /** Freeze frame: shows the frame at `sourceIn` for the whole clip. */
  freeze?: boolean;
  audioFx?: AudioEffect[];
  /** Keep the voice's pitch when the speed changes (default on). */
  keepPitch?: boolean;
  text?: TextStyle;
  /** For solid colour clips. */
  color?: string;
  shape?: ShapeStyle;
  motion?: ClipMotion;
  placeholder?: Placeholder;
  locked?: boolean;
  /** Colour tag shown on the timeline. */
  label?: string;
  /** Transition into the next clip on the same track (only used while the clips touch). */
  transitionOut?: TransitionInstance;
  /** Marks a text clip as a caption (subtitle). */
  caption?: boolean;
  /** Real word timings (from transcription). When absent, timing is estimated from the text. */
  words?: WordTiming[];
}

export interface Marker {
  id: string;
  time: number;
  label: string;
  color: string;
  chapter?: boolean;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  background: string;
  sampleRate: number;
}

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettings;
  tracks: Track[];
  media: MediaItem[];
  markers: Marker[];
  /** Magnetic timeline: deletions and trims close gaps on the same track. */
  magnetic: boolean;
  luts?: LutAsset[];
  folder?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  width: number;
  height: number;
  duration: number;
  folder?: string;
  thumbnail?: string;
}
