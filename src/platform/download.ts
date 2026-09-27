/**
 * Saving files to the user's device.
 *
 * - Inside a claude.ai artifact, downloads must go through the host's
 *   `downloads` capability (the viewer confirms each save).
 * - Everywhere else (standalone web build, desktop shell) we use the File
 *   System Access "Save as" picker when available, falling back to a normal
 *   browser download.
 */

interface DownloadsCap {
  save(req: { filename: string; data: Blob | string }): Promise<{ status: string }>;
}
interface ClaudeHost { use(name: string): Promise<unknown> }

let capPromise: Promise<DownloadsCap | null> | null = null;
function hostDownloads(): Promise<DownloadsCap | null> {
  const host = (window as unknown as { claude?: ClaudeHost }).claude;
  if (!host?.use) return Promise.resolve(null);
  capPromise ??= host.use('downloads').then((c) => (c as DownloadsCap) ?? null).catch(() => null);
  return capPromise;
}

export function inArtifactHost(): boolean {
  return !!(window as unknown as { claude?: ClaudeHost }).claude?.use;
}

/** File types the claude.ai host allows a page to save. */
const HOST_ALLOWED = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'txt', 'json', 'md', 'csv', 'zip', 'svg', 'html', 'pdf'];

export function canSaveExtension(ext: string): boolean {
  return !inArtifactHost() || HOST_ALLOWED.includes(ext.toLowerCase());
}

export type SaveOutcome = 'saved' | 'declined' | 'unavailable';

export async function saveFile(filename: string, data: Blob | string): Promise<SaveOutcome> {
  const cap = await hostDownloads();
  if (cap) {
    try {
      await cap.save({ filename, data });
      return 'saved';
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'declined') return 'declined';
      if (code === 'rate_limited') throw new Error('Another save is waiting for confirmation. Finish that one first.');
      if (code === 'rejected_extension' || code === 'extension_not_enabled') throw new Error(`.${filename.split('.').pop()} files can't be saved from this page. Choose MP4, WebM, GIF, PNG or JPEG.`);
      if (inArtifactHost()) return 'unavailable';
    }
  }
  if (inArtifactHost()) return 'unavailable';
  const blob = typeof data === 'string' ? new Blob([data], { type: 'application/json' }) : data;
  const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker && blob.size > 50 * 1024 * 1024) {
    try {
      const handle = await picker({ suggestedName: filename });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return 'saved';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'declined';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'saved';
}
