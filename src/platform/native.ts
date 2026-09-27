/**
 * Native shells. The same web app runs everywhere; when it's inside the
 * desktop app (Electron) or the phone apps (Capacitor), extra abilities appear
 * here. Everything is optional: callers check before using, and the web
 * version keeps working without any of it.
 */

export type ShellKind = 'web' | 'desktop' | 'ios' | 'android';

export interface NativeFileRef {
  /** Opaque id the desktop app uses to serve the file (never a path the page can open itself). */
  token: string;
  name: string;
  size: number;
  /** URL the page can play/read with range requests (desktop: fw-media://…). */
  url: string;
  /** Absolute path on disk (desktop only; shown to the user, stored for re-opening). */
  path: string;
  mtime: number;
}

export interface TempWriter {
  write(data: Uint8Array, position: number): Promise<void>;
  /** Close; returns an empty stand-in Blob (the real file stays on disk, see `token`). */
  finish(mime: string): Promise<Blob>;
  abort(): Promise<void>;
  token: string;
  url: string;
  size(): number;
}

export interface CaptureSource { id: string; name: string; kind: 'screen' | 'window'; thumbnail: string }

export interface NativeBridge {
  shell: ShellKind;
  version: string;
  os: string;
  /** Desktop: pick media files and use them in place (no copy). */
  openMedia?(): Promise<NativeFileRef[]>;
  /** Desktop: re-open a file used in place in an earlier session. */
  reopenMedia?(path: string): Promise<NativeFileRef | null>;
  /** Desktop: where a dropped/picked file lives on disk ('' if unknown). */
  pathForFile?(file: File): string;
  /** Desktop: menu commands (import, export, undo…). */
  onMenu?(fn: (cmd: string) => void): void;
  /** Desktop: files dropped/picked in the page → in-place refs. */
  refForFile?(file: File): Promise<NativeFileRef | null>;
  /** Desktop: stream an export to a temp file. */
  tempWriter?(ext: string): Promise<TempWriter>;
  /** Desktop: "Save as…" for a finished temp export (moves it; no copy in memory). */
  saveExport?(token: string, suggestedName: string): Promise<'saved' | 'declined'>;
  showInFolder?(path: string): Promise<void>;
  /** Desktop: FFmpeg on this computer (bundled or on PATH) for formats browsers can't read. */
  ffmpegInfo?(): Promise<{ available: boolean; version?: string; path?: string }>;
  convertForEditing?(path: string, onProgress: (f: number) => void): Promise<NativeFileRef>;
  /** Desktop: screens/windows for the screen recorder's picker. */
  captureSources?(): Promise<CaptureSource[]>;
  selectCaptureSource?(id: string, withAudio: boolean): Promise<void>;
  /** Desktop: open a project file handed to the app (double-click / "Open with"). */
  onOpenProjectFile?(fn: (text: string, path: string) => void): void;
  setTitle?(title: string): void;
  /** Phones: share or save a finished file through the system share sheet. */
  shareFile?(blob: Blob, filename: string): Promise<'shared' | 'declined'>;
  /** Phones: Android back button. Return true if handled. */
  onBack?(fn: () => boolean): void;
  /** Keep the screen on (exports, recordings). */
  keepAwake?(on: boolean): Promise<void>;
  /** Desktop: move a finished recording (a streamed temp file) into Videos/Framewright and use it in place. */
  keepRecording?(token: string, filename: string): Promise<NativeFileRef>;
  /** Desktop: download the optional FFmpeg converter (≈30 MB) into the app's data folder. */
  downloadFfmpeg?(onProgress: (f: number) => void): Promise<{ available: boolean; version?: string }>;
  /** Desktop: network requests to YouTube / Instagram / TikTok (only those hosts). */
  http?(r: import('../engine/publish/http').HttpReq): Promise<import('../engine/publish/http').HttpRes>;
  /** Desktop: sign in through the system browser with a one-off 127.0.0.1 callback. */
  oauthStart?(): Promise<{ id: string; redirectUri: string }>;
  oauthWait?(id: string, authUrl: string): Promise<{ code?: string; state?: string; error?: string }>;
  oauthCancel?(id: string): Promise<void>;
  /** Desktop: small secrets (sign-in tokens), encrypted with the system keychain. */
  secretGet?(key: string): Promise<string | null>;
  secretSet?(key: string, value: string | null): Promise<void>;
  /** Desktop: keep running in the tray when the window is closed (for scheduled posts). */
  setBackground?(on: boolean): Promise<void>;
  /** Phones: schedule / cancel a reminder notification. */
  notifyAt?(id: number, at: number, title: string, body: string): Promise<void>;
  cancelNotify?(id: number): Promise<void>;
}

export function nativeBridge(): NativeBridge | null {
  return (window as unknown as { fwNative?: NativeBridge }).fwNative ?? null;
}

export function shellKind(): ShellKind {
  return nativeBridge()?.shell ?? 'web';
}
