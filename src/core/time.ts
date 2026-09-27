/** Time helpers. All values are seconds. */

export const EPS = 1e-6;

/** Round a time to the nearest frame boundary. */
export function snapToFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

export function frameDuration(fps: number): number {
  return 1 / fps;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 00:01:02:15 (hh:mm:ss:ff) */
export function formatTimecode(t: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(t * fps));
  const f = totalFrames % fps;
  const totalSec = Math.floor(totalFrames / fps);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(Math.round(f))}`;
}

/** 1:02.5 — compact label for clip durations. */
export function formatShort(t: number): string {
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const sStr = s.toFixed(1).padStart(m > 0 ? 4 : 1, '0');
  return m > 0 ? `${sign}${m}:${sStr}` : `${sign}${sStr}s`;
}

/** Parse "1:02.5", "62.5", "00:01:02:15" (with fps) into seconds. Returns null if invalid. */
export function parseTime(input: string, fps = 30): number | null {
  const str = input.trim().replace(/s$/, '');
  if (!str) return null;
  const parts = str.split(':');
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return null;
  const nums = parts.map(Number);
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 4) return nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / fps;
  return null;
}
