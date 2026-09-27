/**
 * Bridge between the editor page and the desktop app. Exposes `window.fwNative`
 * (see src/platform/native.ts for what each call does). Only these calls are
 * available to the page — no Node, no file system.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

type Ref = { token: string; name: string; size: number; url: string; path: string; mtime: number };

let convertSeq = 0;
const progressFns = new Map<string, (f: number) => void>();
ipcRenderer.on('fw:ffmpeg-progress', (_e, job: string, f: number) => progressFns.get(job)?.(f));

const bridge = {
  shell: 'desktop' as const,
  version: '',
  os: process.platform,
  async openMedia(): Promise<Ref[]> { return ipcRenderer.invoke('fw:media-open'); },
  async reopenMedia(p: string): Promise<Ref | null> { return ipcRenderer.invoke('fw:media-ref', p); },
  async refForFile(file: File): Promise<Ref | null> {
    const p = webUtils.getPathForFile(file);
    return p ? ipcRenderer.invoke('fw:media-ref', p) : null;
  },
  async tempWriter(ext: string) {
    const { token, url } = (await ipcRenderer.invoke('fw:tmp-open', ext)) as { token: string; url: string };
    let size = 0;
    return {
      token, url,
      size: () => size,
      async write(data: Uint8Array, position: number) { size = await ipcRenderer.invoke('fw:tmp-write', token, data, position); },
      async finish(mime: string) { size = await ipcRenderer.invoke('fw:tmp-close', token); return new Blob([], { type: mime }); },
      async abort() { await ipcRenderer.invoke('fw:tmp-abort', token); },
    };
  },
  async saveExport(token: string, suggestedName: string) { return ipcRenderer.invoke('fw:tmp-save-as', token, suggestedName); },
  async showInFolder(p: string) { await ipcRenderer.invoke('fw:show-in-folder', p); },
  async ffmpegInfo() { return ipcRenderer.invoke('fw:ffmpeg-info'); },
  async convertForEditing(p: string, onProgress: (f: number) => void): Promise<Ref> {
    const job = `c${++convertSeq}`;
    progressFns.set(job, onProgress);
    try { return await ipcRenderer.invoke('fw:ffmpeg-convert', p, job); } finally { progressFns.delete(job); }
  },
  pathForFile(file: File): string { return webUtils.getPathForFile(file); },
  async keepRecording(token: string, filename: string): Promise<Ref> { return ipcRenderer.invoke('fw:keep-recording', token, filename); },
  async downloadFfmpeg(onProgress: (f: number) => void) {
    const job = `d${++convertSeq}`;
    progressFns.set(job, onProgress);
    try { return await ipcRenderer.invoke('fw:ffmpeg-download', job); } finally { progressFns.delete(job); }
  },
  async keepAwake(on: boolean) { await ipcRenderer.invoke('fw:keep-awake', on); },
  async captureSources() { return ipcRenderer.invoke('fw:capture-sources'); },
  async selectCaptureSource(id: string, withAudio: boolean) { await ipcRenderer.invoke('fw:capture-select', id, withAudio); },
  onOpenProjectFile(fn: (text: string, path: string) => void) {
    ipcRenderer.on('fw:open-project', (_e, text: string, p: string) => fn(text, p));
    ipcRenderer.send('fw:ready');
  },
  onMenu(fn: (cmd: string) => void) { ipcRenderer.on('fw:menu', (_e, cmd: string) => fn(cmd)); },
  setTitle(title: string) { ipcRenderer.send('fw:title', title); },
  // Posting to YouTube / Instagram / TikTok
  async http(r: unknown) { return ipcRenderer.invoke('fw:http', r); },
  async oauthStart() { return ipcRenderer.invoke('fw:oauth-start'); },
  async oauthWait(id: string, authUrl: string) { return ipcRenderer.invoke('fw:oauth-wait', id, authUrl); },
  async oauthCancel(id: string) { await ipcRenderer.invoke('fw:oauth-cancel', id); },
  async secretGet(key: string) { return ipcRenderer.invoke('fw:secret-get', key); },
  async secretSet(key: string, value: string | null) { await ipcRenderer.invoke('fw:secret-set', key, value); },
  async setBackground(on: boolean) { await ipcRenderer.invoke('fw:background', on); },
};

void ipcRenderer.invoke('fw:info').then((i: { version: string; os: string }) => { bridge.version = i.version; });
contextBridge.exposeInMainWorld('fwNative', bridge);
