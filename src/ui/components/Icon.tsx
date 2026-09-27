/**
 * Framewright icon set — simple original line icons drawn on a 24px grid.
 */
import type { CSSProperties } from 'react';

const P: Record<string, string> = {
  play: 'M8 5.5v13l10.5-6.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  back: 'M15 18l-6-6 6-6',
  stepBack: 'M18 6v12l-8-6zM7 6h2v12H7z',
  stepFwd: 'M6 6v12l8-6zM15 6h2v12h-2z',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 000 11H13',
  split: 'M12 3v18M7 7l-3 5 3 5M17 7l3 5-3 5',
  trash: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6',
  ripple: 'M4 7h16M6.5 7l1 13h9l1-13M3 12h4m-2-2l2 2-2 2M21 12h-4m2-2l-2 2 2 2',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  media: 'M4 5h16v14H4zM4 9h16M9 5v4M15 5v4',
  audio: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  sticker: 'M5 4h10l4 4v11a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM15 4v4h4M9 13.5c.8 1 1.8 1.5 3 1.5s2.2-.5 3-1.5M9 10h.01M15 10h.01',
  effects: 'M12 3l1.8 4.7L19 9.5l-4.3 3.2L16 18l-4-2.8L8 18l1.3-5.3L5 9.5l5.2-1.8z',
  transitions: 'M4 5h7v14H4zM13 5h7v14h-7zM8 12h8m-2-2l2 2-2 2',
  filters: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 4v16M4.5 9h15M4.5 15h15',
  adjust: 'M5 6h9M18 6h1M5 12h3M12 12h7M5 18h11M20 18h-1M16 4v4M10 10v4M18 16v4',
  ai: 'M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2M12 8a4 4 0 100 8 4 4 0 000-8z',
  templates: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  captions: 'M3 6h18v12H3zM7 14h4M13 14h4M7 10h10',
  canvas: 'M7 3v14h14M3 7h14v14',
  brand: 'M12 3l2.4 5 5.6.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8 9.6 8z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  lock: 'M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z',
  unlock: 'M7 11V8a5 5 0 019.6-2M5 11h14v10H5z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10.4 10.4 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.5 4.9-1.3M9.9 9.9a3 3 0 004.2 4.2',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
  magnet: 'M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4zM6 8h4M14 8h4',
  snap: 'M5 5v14M19 5v14M9 12h6M9 12l2-2M9 12l2 2M15 12l-2-2M15 12l-2 2',
  marker: 'M6 3h12v13l-6 5-6-5z',
  zoomIn: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  export: 'M12 15V3M7 8l5-5 5 5M4 14v6h16v-6',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  folder: 'M3 6h6l2 2h10v11H3z',
  folderOpen: 'M3 6h6l2 2h8v3M3 19l3-8h16l-3 8z',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 10a3.5 3.5 0 100 7 3.5 3.5 0 000-7z',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
  keyframe: 'M12 4l8 8-8 8-8-8z',
  detach: 'M4 8h16M4 16h7M15 16h5M13 13l-2 3 2 3',
  loop: 'M17 2l3 3-3 3M20 5H8a4 4 0 00-4 4v1M7 22l-3-3 3-3M4 19h12a4 4 0 004-4v-1',
  settings: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  warning: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  device: 'M7 3h10v18H7zM11 18h2',
  flipH: 'M12 3v18M8 7L3 12l5 5zM16 7l5 5-5 5z',
  flipV: 'M3 12h18M7 8l5-5 5 5zM7 16l5 5 5-5z',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5h.01',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  history: 'M3 12a9 9 0 103-6.7L3 8M3 3v5h5M12 7v5l3 3',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 8.5h.01',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, style, className }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  const filled = name === 'play' || name === 'pause' || name === 'stepBack' || name === 'stepFwd' || name === 'keyframe';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className} style={style}
      fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={P[name]} />
    </svg>
  );
}

/** Framewright mark: a frame corner bracket crossed by an amber playhead. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Framewright">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#1d2130" />
      <path d="M8 13V8h5M24 19v5h-5" fill="none" stroke="#dfe3ee" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="15" y="5" width="2.6" height="22" rx="1.3" fill="#f2b544" />
      <path d="M13.2 5h6.2l-3.1 3.2z" fill="#f2b544" />
    </svg>
  );
}
