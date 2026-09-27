import type { ProjectSettings } from './types';

export interface FormatPreset {
  id: string;
  label: string;
  platform: string;
  width: number;
  height: number;
  fps: number;
  ratio: string;
}

/** One-click canvas presets for the platforms Dan publishes to. */
export const FORMAT_PRESETS: FormatPreset[] = [
  { id: 'tiktok', label: 'TikTok', platform: 'TikTok', width: 1080, height: 1920, fps: 30, ratio: '9:16' },
  { id: 'shorts', label: 'YouTube Shorts', platform: 'YouTube', width: 1080, height: 1920, fps: 30, ratio: '9:16' },
  { id: 'reels', label: 'Instagram Reels', platform: 'Instagram', width: 1080, height: 1920, fps: 30, ratio: '9:16' },
  { id: 'ig-post', label: 'Instagram Post', platform: 'Instagram', width: 1080, height: 1080, fps: 30, ratio: '1:1' },
  { id: 'ig-portrait', label: 'Instagram Portrait', platform: 'Instagram', width: 1080, height: 1350, fps: 30, ratio: '4:5' },
  { id: 'ig-landscape', label: 'Instagram Landscape', platform: 'Instagram', width: 1920, height: 1080, fps: 30, ratio: '16:9' },
  { id: 'youtube', label: 'YouTube', platform: 'YouTube', width: 1920, height: 1080, fps: 30, ratio: '16:9' },
  { id: 'youtube-60', label: 'YouTube 60fps (gaming)', platform: 'YouTube', width: 1920, height: 1080, fps: 60, ratio: '16:9' },
  { id: 'youtube-4k', label: 'YouTube 4K', platform: 'YouTube', width: 3840, height: 2160, fps: 30, ratio: '16:9' },
  { id: 'fb-feed', label: 'Facebook Feed', platform: 'Facebook', width: 1080, height: 1350, fps: 30, ratio: '4:5' },
  { id: 'fb-story', label: 'Facebook Story / Reel', platform: 'Facebook', width: 1080, height: 1920, fps: 30, ratio: '9:16' },
  { id: 'fb-landscape', label: 'Facebook Landscape', platform: 'Facebook', width: 1920, height: 1080, fps: 30, ratio: '16:9' },
];

export function settingsFromPreset(p: FormatPreset): ProjectSettings {
  return { width: p.width, height: p.height, fps: p.fps, background: '#000000', sampleRate: 48000 };
}

/** Encoders need even dimensions; clamp a custom size into a sane range. */
export function sanitiseSize(w: number, h: number): { width: number; height: number } {
  const fix = (n: number) => {
    const v = Math.round(Math.min(7680, Math.max(16, n || 16)));
    return v % 2 === 0 ? v : v + 1;
  };
  return { width: fix(w), height: fix(h) };
}

export const FPS_OPTIONS = [23.976, 24, 25, 30, 50, 60];
