/**
 * Where an export is written while it's being made.
 *
 * Big exports used to be assembled in memory, which limits how long a video a
 * phone or small laptop can export. When the browser has a private on-disk
 * area (the Origin Private File System), exports stream there instead, so
 * memory use stays flat whatever the length; the finished file is then saved
 * or shared from disk. The desktop app streams straight to a temp file.
 * Without either, we fall back to memory.
 */
import { nativeBridge } from './native';

type WriteChunk = { type: 'write'; data: Uint8Array; position: number };

export interface FinishedFile {
  /** Disk-backed Blob (web) or an empty stand-in (desktop, where the file is `native`). */
  blob: Blob;
  native?: { token: string; url: string; size: number };
}

export interface ExportSink {
  kind: 'opfs' | 'native';
  writable: WritableStream<WriteChunk>;
  /** Close the file and return it (disk-backed, so it isn't loaded into memory). */
  finish(mime: string): Promise<FinishedFile>;
  abort(): Promise<void>;
}

const TEMP_PREFIX = 'fw-export-';

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const get = navigator.storage?.getDirectory;
    if (!get) return null;
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

export async function createExportSink(ext: string): Promise<ExportSink | null> {
  const native = nativeBridge();
  if (native?.tempWriter) {
    try {
      const w = await native.tempWriter(ext);
      let closed = false;
      const writable = new WritableStream<WriteChunk>({
        write: (chunk) => w.write(chunk.data, chunk.position),
        close: async () => { closed = true; },
      });
      return {
        kind: 'native',
        writable,
        finish: async (mime) => {
          if (!closed) await writable.close().catch(() => undefined);
          const blob = await w.finish(mime);
          return { blob, native: { token: w.token, url: w.url, size: w.size() } };
        },
        abort: async () => { await writable.abort().catch(() => undefined); await w.abort(); },
      };
    } catch { /* fall through */ }
  }
  const root = await opfsRoot();
  if (!root) return null;
  try {
    const name = `${TEMP_PREFIX}${Date.now()}.${ext}`;
    const handle = await root.getFileHandle(name, { create: true });
    if (!('createWritable' in handle)) return null;
    const fsw = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    // FileSystemWritableFileStream accepts {type:'write', data, position} chunks as-is.
    const writable = fsw as unknown as WritableStream<WriteChunk>;
    let closed = false;
    return {
      kind: 'opfs',
      writable,
      finish: async (mime) => {
        if (!closed) { closed = true; await fsw.close().catch(() => undefined); }
        const file = await handle.getFile();
        return { blob: file.type === mime ? file : new Blob([file], { type: mime }) }; // Blob-of-File stays disk-backed
      },
      abort: async () => {
        try { await fsw.abort(); } catch { /* already closed */ }
        try { await root.removeEntry(name); } catch { /* ignore */ }
      },
    };
  } catch {
    return null;
  }
}

/** Delete finished exports left in the private area (called on start-up and after saving). */
export async function cleanupExportTemp(keepNewest = 0): Promise<void> {
  const root = await opfsRoot();
  if (!root) return;
  try {
    const names: string[] = [];
    for await (const [name] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (name.startsWith(TEMP_PREFIX)) names.push(name);
    }
    names.sort();
    for (const n of names.slice(0, Math.max(0, names.length - keepNewest))) await root.removeEntry(n).catch(() => undefined);
  } catch { /* not supported */ }
}
