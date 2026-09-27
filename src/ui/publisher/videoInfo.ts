import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

/**
 * Duration, size and a thumbnail for a video file (read locally). Size and
 * length come from the file itself, so they work even where the browser can't
 * play the video; the thumbnail needs the browser to decode a frame.
 */
export async function videoInfo(blob: Blob, at = 1): Promise<{ duration: number; width: number; height: number; thumbnail?: string }> {
  const [fromFile, fromPlayer] = await Promise.all([containerInfo(blob), playerInfo(blob, at)]);
  return {
    duration: fromFile?.duration || fromPlayer.duration,
    width: fromFile?.width || fromPlayer.width,
    height: fromFile?.height || fromPlayer.height,
    thumbnail: fromPlayer.thumbnail,
  };
}

async function containerInfo(blob: Blob): Promise<{ duration: number; width: number; height: number } | null> {
  try {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const v = await input.getPrimaryVideoTrack();
    const duration = await input.computeDuration();
    const out = { duration, width: v?.displayWidth ?? 0, height: v?.displayHeight ?? 0 };
    input.dispose?.();
    return out;
  } catch { return null; }
}

function playerInfo(blob: Blob, at = 1): Promise<{ duration: number; width: number; height: number; thumbnail?: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    let settled = false;
    const done = (thumbnail?: string) => {
      if (settled) return;
      settled = true;
      const out = { duration: Number.isFinite(v.duration) ? v.duration : 0, width: v.videoWidth, height: v.videoHeight, thumbnail };
      URL.revokeObjectURL(url);
      resolve(out);
    };
    v.onloadedmetadata = () => { try { v.currentTime = Math.min(at, (v.duration || 2) / 2); } catch { done(); } };
    v.onseeked = () => {
      try {
        const k = 240 / Math.max(v.videoWidth, v.videoHeight, 1);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(v.videoWidth * k)); c.height = Math.max(1, Math.round(v.videoHeight * k));
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        done(c.toDataURL('image/jpeg', 0.75));
      } catch { done(); }
    };
    v.onerror = () => done();
    setTimeout(() => done(), 8000);
    v.src = url;
  });
}
