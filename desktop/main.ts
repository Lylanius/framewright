/**
 * Framewright desktop app (Windows, macOS, Linux).
 *
 * The editor is the same web app; this shell adds what browsers can't do:
 *  - media used in place from disk (no second copy), streamed to the editor
 *    with range requests over the private fw-media:// scheme
 *  - exports streamed straight to a temp file, then moved where you choose
 *  - FFmpeg (if installed) to open formats browsers can't decode (MKV, AVI…)
 *  - a screen/window picker for the screen recorder, incl. system audio on Windows
 *  - native menus, "Open with" for project files, window state, crash restart
 *
 * Security: the page runs sandboxed with context isolation; it can only reach
 * files the user picked (by opaque token), never arbitrary paths.
 */
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, powerSaveBlocker, protocol, safeStorage, session, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import http from 'node:http';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_SCHEME = 'app';
const MEDIA_SCHEME = 'fw-media';
const isDev = !!process.env.FW_DEV_URL;

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

// One window, one app instance (a second launch hands its files to the first).
if (!app.requestSingleInstanceLock()) app.quit();

/* ------------------------------------------------------------------ */
/* Files the page may read: token → path                                */
/* ------------------------------------------------------------------ */

const tokens = new Map<string, string>();
const byPath = new Map<string, string>();

function tokenFor(p: string): string {
  const abs = path.resolve(p);
  let t = byPath.get(abs);
  if (!t) {
    t = crypto.randomBytes(12).toString('hex');
    tokens.set(t, abs);
    byPath.set(abs, t);
  }
  return t;
}

async function refFor(p: string) {
  const st = await fsp.stat(p);
  if (!st.isFile()) throw new Error('not a file');
  const token = tokenFor(p);
  return { token, name: path.basename(p), size: st.size, url: `${MEDIA_SCHEME}://file/${token}/${encodeURIComponent(path.basename(p))}`, path: path.resolve(p), mtime: st.mtimeMs };
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
};
const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|ts|m2ts|flv|wmv|3gp|mp3|wav|m4a|aac|flac|ogg|opus|png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)$/i;
const mimeOf = (p: string) => MIME[path.extname(p).slice(1).toLowerCase()] ?? 'application/octet-stream';

/** Serve a file with HTTP range support (video seeking, Mediabunny's random access). */
async function serveFile(file: string, req: Request): Promise<Response> {
  let st: fs.Stats;
  try { st = await fsp.stat(file); } catch { return new Response('Not found', { status: 404 }); }
  const size = st.size;
  const headers: Record<string, string> = { 'Accept-Ranges': 'bytes', 'Content-Type': mimeOf(file), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  const range = req.headers.get('range');
  let start = 0, end = size - 1, status = 200;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1] || 0); if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
  }
  headers['Content-Length'] = String(end - start + 1);
  if (req.method === 'HEAD') return new Response(null, { status, headers });
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 1024 * 1024 });
  return new Response(stream as unknown as ReadableStream, { status, headers });
}

/* ------------------------------------------------------------------ */
/* Temp files for streamed exports                                      */
/* ------------------------------------------------------------------ */

const tempDir = path.join(os.tmpdir(), 'framewright-exports');
const temps = new Map<string, { file: string; fd: fs.promises.FileHandle | null; size: number }>();

async function cleanTemp(): Promise<void> {
  try {
    for (const f of await fsp.readdir(tempDir)) await fsp.rm(path.join(tempDir, f), { force: true });
  } catch { /* first run */ }
}

/* ------------------------------------------------------------------ */
/* FFmpeg (optional, for formats the editor can't decode)               */
/* ------------------------------------------------------------------ */

const ffmpegExe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const downloadedFfmpeg = () => path.join(app.getPath('userData'), 'ffmpeg', ffmpegExe);

function findFfmpeg(): { path: string; version: string } | null {
  const candidates = [process.env.FRAMEWRIGHT_FFMPEG, downloadedFfmpeg(), 'ffmpeg', ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'] : []),
    ...(process.platform === 'win32' ? [path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'), 'C:\\ffmpeg\\bin\\ffmpeg.exe'] : [])].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) return { path: c, version: (r.stdout.split('\n')[0] ?? '').replace('ffmpeg version ', '').split(' ')[0] };
    } catch { /* next */ }
  }
  return null;
}

let ffmpeg: { path: string; version: string } | null | undefined;
const convertDir = () => path.join(app.getPath('userData'), 'converted');

function probeCodecs(ff: string, input: string): { video?: string; audio?: string; duration: number } {
  // ffmpeg prints stream info on stderr when given only an input.
  const r = spawnSync(ff, ['-hide_banner', '-i', input], { encoding: 'utf8', timeout: 20000 });
  const err = r.stderr ?? '';
  const video = /Stream #.*Video: (\w+)/.exec(err)?.[1];
  const audio = /Stream #.*Audio: (\w+)/.exec(err)?.[1];
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  return { video, audio, duration };
}

function runFfmpeg(ff: string, args: string[], duration: number, onProgress: (f: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ff, ['-hide_banner', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-4000);
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(chunk);
      if (m && duration > 0) onProgress(Math.min(0.99, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / duration));
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tail.split('\n').filter(Boolean).slice(-2).join(' ') || `ffmpeg exited with ${code}`))));
  });
}

/* ------------------------------------------------------------------ */
/* Window                                                               */
/* ------------------------------------------------------------------ */

/**
 * Screens and windows. Asked for separately: on some Linux setups listing
 * windows fails, and a combined request would then return nothing at all.
 */
async function captureList(thumbnailSize: { width: number; height: number }) {
  const [screens, windows] = await Promise.allSettled([
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize }),
    desktopCapturer.getSources({ types: ['window'], thumbnailSize, fetchWindowIcons: false }),
  ]);
  return [...(screens.status === 'fulfilled' ? screens.value : []), ...(windows.status === 'fulfilled' ? windows.value.filter((w) => w.name !== 'Framewright' && !w.name.endsWith('— Framewright')) : [])];
}

let win: BrowserWindow | null = null;
let pendingProject: { text: string; path: string } | null = null;
let rendererReady = false;
let captureChoice: { id: string; audio: boolean } | null = null;

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWindowState(): { width: number; height: number; x?: number; y?: number; maximized?: boolean } {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { width: 1440, height: 900 }; }
}
function saveWindowState(w: BrowserWindow): void {
  try {
    const b = w.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: w.isMaximized() }));
  } catch { /* ignore */ }
}

async function openProjectPath(p: string): Promise<void> {
  try {
    const text = await fsp.readFile(p, 'utf8');
    if (win && rendererReady) win.webContents.send('fw:open-project', text, p);
    else pendingProject = { text, path: p };
  } catch (e) {
    dialog.showErrorBox('Couldn’t open project', `${p}\n\n${(e as Error).message}`);
  }
}

function projectArg(argv: string[]): string | null {
  return argv.slice(1).find((a) => /\.framewright(\.json)?$/i.test(a) && fs.existsSync(a)) ?? null;
}

function sendMenu(cmd: string): void {
  win?.webContents.send('fw:menu', cmd);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Import media…', accelerator: 'CmdOrCtrl+I', click: () => sendMenu('import') },
        { label: 'Open project file…', accelerator: 'CmdOrCtrl+O', click: async () => {
          const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Framewright project', extensions: ['framewright', 'json'] }] });
          if (!r.canceled && r.filePaths[0]) void openProjectPath(r.filePaths[0]);
        } },
        { label: 'Save project file…', click: () => sendMenu('save-project-file') },
        { type: 'separator' },
        { label: 'Record screen…', click: () => sendMenu('record-screen') },
        { label: 'Record camera…', click: () => sendMenu('record-camera') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export') },
        { type: 'separator' },
        { label: 'Close project', click: () => sendMenu('close-project') },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendMenu('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Pop out preview (second screen)', click: () => sendMenu('popout-preview') },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        ...(isDev ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard shortcuts', click: () => sendMenu('shortcuts') },
        { label: 'Open app data folder', click: () => void shell.openPath(app.getPath('userData')) },
        { label: 'Developer tools', accelerator: 'CmdOrCtrl+Alt+I', click: () => win?.webContents.toggleDevTools() },
        { label: `About Framewright ${app.getVersion()}`, click: () => void dialog.showMessageBox(win!, { message: 'Framewright', detail: `Version ${app.getVersion()}\nA private, offline video editor.\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}` }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const st = loadWindowState();
  win = new BrowserWindow({
    width: st.width, height: st.height, x: st.x, y: st.y, minWidth: 900, minHeight: 600,
    backgroundColor: '#0b0d12', title: 'Framewright', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      backgroundThrottling: false, // exports keep full speed when the window is in the background
    },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
    if (win) saveWindowState(win);
    // Scheduled posts: keep running in the tray instead of quitting.
    if (backgroundMode && !quitting) { e.preventDefault(); win?.hide(); showTray(); }
  });
  win.on('closed', () => { win = null; });

  // Links open in the browser; the pop-out preview is our own blank window.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName === 'fw-preview') {
      return { action: 'allow', overrideBrowserWindowOptions: { title: 'Framewright preview', backgroundColor: '#000000', autoHideMenuBar: true, width: 960, height: 600, webPreferences: { sandbox: true, contextIsolation: true } } };
    }
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${APP_SCHEME}://`) && !url.startsWith(process.env.FW_DEV_URL ?? '\0')) e.preventDefault(); });

  // If the editor's process dies, offer to reload (projects autosave continuously).
  win.webContents.on('render-process-gone', async (_e, details) => {
    if (details.reason === 'clean-exit') return;
    const r = await dialog.showMessageBox({ type: 'error', buttons: ['Reload', 'Quit'], defaultId: 0, message: 'The editor stopped unexpectedly.', detail: `Reason: ${details.reason}. Your work is autosaved — reloading will offer to reopen your project.` });
    if (r.response === 0) win?.reload(); else app.quit();
  });
  win.on('unresponsive', async () => {
    const r = await dialog.showMessageBox(win!, { type: 'warning', buttons: ['Keep waiting', 'Reload'], defaultId: 0, message: 'Framewright is busy', detail: 'A long operation is running. You can wait, or reload (your work is autosaved).' });
    if (r.response === 1) win?.reload();
  });

  rendererReady = false;
  void win.loadURL(isDev ? process.env.FW_DEV_URL! : `${APP_SCHEME}://framewright/index.html`);
}

/* ------------------------------------------------------------------ */
/* IPC: what the page can ask for                                       */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  ipcMain.handle('fw:info', () => ({ version: app.getVersion(), os: `${process.platform} ${os.release()}` }));
  ipcMain.on('fw:ready', () => {
    rendererReady = true;
    if (pendingProject && win) { win.webContents.send('fw:open-project', pendingProject.text, pendingProject.path); pendingProject = null; }
  });
  ipcMain.on('fw:title', (_e, title: string) => win?.setTitle(title ? `${title} — Framewright` : 'Framewright'));

  ipcMain.handle('fw:media-open', async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', 'ts', 'm2ts', 'flv', 'wmv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled) return [];
    return Promise.all(r.filePaths.map(refFor));
  });
  ipcMain.handle('fw:media-ref', async (_e, p: string) => {
    // Paths the user handed us (drop / picker) or stored in their own projects; media files only.
    if (typeof p !== 'string' || !MEDIA_EXT.test(p)) return null;
    try { return await refFor(p); } catch { return null; }
  });

  ipcMain.handle('fw:tmp-open', async (_e, ext: string) => {
    await fsp.mkdir(tempDir, { recursive: true });
    const safe = String(ext).replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
    const file = path.join(tempDir, `export-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${safe}`);
    const fd = await fsp.open(file, 'w+');
    const token = tokenFor(file);
    temps.set(token, { file, fd, size: 0 });
    return { token, url: `${MEDIA_SCHEME}://file/${token}/${path.basename(file)}` };
  });
  ipcMain.handle('fw:tmp-write', async (_e, token: string, data: Uint8Array, position: number) => {
    const t = temps.get(token);
    if (!t?.fd) throw new Error('export file closed');
    await t.fd.write(data, 0, data.byteLength, position);
    t.size = Math.max(t.size, position + data.byteLength);
    return t.size;
  });
  ipcMain.handle('fw:tmp-close', async (_e, token: string) => {
    const t = temps.get(token);
    if (t?.fd) { await t.fd.close(); t.fd = null; }
    return t?.size ?? 0;
  });
  ipcMain.handle('fw:tmp-abort', async (_e, token: string) => {
    const t = temps.get(token);
    if (!t) return;
    if (t.fd) await t.fd.close().catch(() => undefined);
    await fsp.rm(t.file, { force: true });
    temps.delete(token);
  });
  ipcMain.handle('fw:tmp-save-as', async (_e, token: string, suggested: string) => {
    const t = temps.get(token);
    if (!t) throw new Error('That export is no longer available.');
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('videos'), suggested) });
    if (r.canceled || !r.filePath) return 'declined';
    try { await fsp.rename(t.file, r.filePath); } catch { await fsp.copyFile(t.file, r.filePath); await fsp.rm(t.file, { force: true }); }
    temps.delete(token);
    // Keep the saved file playable in the export dialog.
    tokens.set(token, r.filePath);
    shell.showItemInFolder(r.filePath);
    return 'saved';
  });
  ipcMain.handle('fw:show-in-folder', (_e, p: string) => { if (byPath.has(path.resolve(p))) shell.showItemInFolder(p); });

  ipcMain.handle('fw:ffmpeg-info', () => {
    if (ffmpeg === undefined) ffmpeg = findFfmpeg();
    return ffmpeg ? { available: true, version: ffmpeg.version, path: ffmpeg.path } : { available: false };
  });
  ipcMain.handle('fw:ffmpeg-convert', async (e, input: string, jobId: string) => {
    if (ffmpeg === undefined) ffmpeg = findFfmpeg();
    if (!ffmpeg) throw new Error('FFmpeg isn’t installed.');
    if (!byPath.has(path.resolve(input))) throw new Error('Unknown file.');
    await fsp.mkdir(convertDir(), { recursive: true });
    const st = await fsp.stat(input);
    const id = crypto.createHash('sha1').update(`${path.resolve(input)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
    const out = path.join(convertDir(), `${path.parse(input).name}-${id}.mp4`);
    if (fs.existsSync(out)) return refFor(out);
    const info = probeCodecs(ffmpeg.path, input);
    const progress = (f: number) => e.sender.send('fw:ffmpeg-progress', jobId, f);
    const tmp = `${out}.part.mp4`;
    // Fast path: the streams are fine, only the container isn't (e.g. H.264/AAC in MKV) → copy, no quality loss.
    const copyable = ['h264', 'hevc'].includes(info.video ?? '') && (!info.audio || ['aac', 'mp3'].includes(info.audio));
    try {
      if (copyable) await runFfmpeg(ffmpeg.path, ['-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', tmp], info.duration, progress);
      else throw new Error('transcode');
    } catch {
      await runFfmpeg(ffmpeg.path, ['-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', tmp], info.duration, progress);
    }
    await fsp.rename(tmp, out);
    return refFor(out);
  });

  // Optional converter download (only when the user clicks "Download"): static FFmpeg builds
  // from the ffmpeg-static project, stored in the app's data folder.
  ipcMain.handle('fw:ffmpeg-download', async (e, jobId: string) => {
    const plat = `${process.platform}-${process.arch}`;
    if (!['win32-x64', 'win32-ia32', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'].includes(plat)) throw new Error(`No FFmpeg download for ${plat}; install FFmpeg yourself.`);
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-${plat}.gz`;
    const dest = downloadedFfmpeg();
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const res = await net.fetch(url);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
    const total = Number(res.headers.get('content-length') || 0);
    let got = 0;
    const { Readable, Transform } = await import('node:stream');
    const counter = new Transform({ transform(chunk: Buffer, _enc, cb) { got += chunk.length; if (total) e.sender.send('fw:ffmpeg-progress', jobId, got / total); cb(null, chunk); } });
    const tmp = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body as never), counter, zlib.createGunzip(), fs.createWriteStream(tmp));
    await fsp.chmod(tmp, 0o755);
    await fsp.rename(tmp, dest);
    ffmpeg = findFfmpeg();
    return ffmpeg ? { available: true, version: ffmpeg.version } : { available: false };
  });

  ipcMain.handle('fw:keep-recording', async (_e, token: string, filename: string) => {
    const t = temps.get(token);
    const src = t?.file ?? tokens.get(token);
    if (!src) throw new Error('Recording not found.');
    if (t?.fd) { await t.fd.close(); t.fd = null; }
    const dir = path.join(app.getPath('videos'), 'Framewright Recordings');
    await fsp.mkdir(dir, { recursive: true });
    const safe = String(filename).replace(/[<>:"/\\|?*]+/g, '-').slice(0, 120) || `Recording-${Date.now()}.webm`;
    const dest = path.join(dir, safe);
    try { await fsp.rename(src, dest); } catch { await fsp.copyFile(src, dest); await fsp.rm(src, { force: true }); }
    temps.delete(token);
    return refFor(dest);
  });

  let blocker = -1;
  ipcMain.handle('fw:keep-awake', (_e, on: boolean) => {
    if (on && blocker < 0) blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && blocker >= 0) { powerSaveBlocker.stop(blocker); blocker = -1; }
  });

  ipcMain.handle('fw:capture-sources', async () => {
    const list = await captureList({ width: 320, height: 180 });
    return list.map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window', thumbnail: s.thumbnail.toDataURL() }));
  });
  ipcMain.handle('fw:capture-select', (_e, id: string, audio: boolean) => { captureChoice = { id, audio }; });
}


/* ------------------------------------------------------------------ */
/* Posting to YouTube / Instagram / TikTok                              */
/* ------------------------------------------------------------------ */

/** Only these services can be reached through the app's network bridge. */
const PUBLISH_HOSTS = ['googleapis.com', 'accounts.google.com', 'instagram.com', 'facebook.com', 'tiktokapis.com', 'tiktok.com'];
/** Tests: send platform requests to a local fake server instead (FW_PUBLISH_FAKE=http://127.0.0.1:port). */
const FAKE = process.env.FW_PUBLISH_FAKE ?? '';

function publishUrl(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || !PUBLISH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
    if (FAKE && raw.startsWith(FAKE)) return raw;
    throw new Error(`Blocked request to ${u.hostname}`);
  }
  return FAKE ? `${FAKE}/${u.hostname}${u.pathname}${u.search}` : raw;
}

async function publishHttp(r: { method: string; url: string; headers?: Record<string, string>; body?: string | Uint8Array | null }) {
  const body = r.body == null ? undefined : typeof r.body === 'string' ? r.body : new Uint8Array(r.body) as unknown as BodyInit;
  const res = await fetch(publishUrl(r.url), { method: r.method, headers: r.headers, body, redirect: 'manual' });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, headers, text: await res.text() };
}

/** Sign-in: a one-off local page on 127.0.0.1 receives the code after you approve in your browser. */
const oauthWaits = new Map<string, { server: http.Server; redirectUri: string; result: Promise<{ code?: string; state?: string; error?: string }> }>();

function oauthStart(): Promise<{ id: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let done: (v: { code?: string; state?: string; error?: string }) => void = () => undefined;
    const result = new Promise<{ code?: string; state?: string; error?: string }>((r) => { done = r; });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback/') { res.writeHead(404).end(); return; }
      const error = u.searchParams.get('error_description') || u.searchParams.get('error') || undefined;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Framewright</title><body style="font:16px system-ui;background:#0b0d12;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${error ? 'Sign-in didn’t finish' : 'Connected ✓'}</h2><p>${error ? String(error).replace(/[<>&]/g, '') : 'You can close this tab and go back to Framewright.'}</p></div>`);
      done({ code: u.searchParams.get('code') ?? undefined, state: u.searchParams.get('state') ?? undefined, error });
      if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const id = crypto.randomBytes(8).toString('hex');
      const redirectUri = `http://127.0.0.1:${port}/callback/`;
      oauthWaits.set(id, { server, redirectUri, result });
      setTimeout(() => oauthStop(id), 10 * 60_000).unref();
      resolve({ id, redirectUri });
    });
  });
}

function oauthStop(id: string): void {
  const w = oauthWaits.get(id);
  if (!w) return;
  w.server.close();
  oauthWaits.delete(id);
}

async function oauthWait(id: string, authUrl: string) {
  const w = oauthWaits.get(id);
  if (!w) throw new Error('Sign-in window expired — try again.');
  const u = new URL(authUrl);
  if (u.protocol !== 'https:' || !PUBLISH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) throw new Error('Blocked sign-in address');
  if (FAKE) {
    // Tests: the fake server approves instantly and redirects to our callback.
    const r = await fetch(publishUrl(authUrl), { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (loc) await fetch(loc);
  } else await shell.openExternal(authUrl);
  try { return await w.result; } finally { oauthStop(id); }
}

/** Sign-in tokens and app secrets, encrypted with the operating system's keychain where available. */
const secretsFile = () => path.join(app.getPath('userData'), 'publish-secrets.json');
function readSecrets(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) as Record<string, string>; } catch { return {}; }
}
function secretGet(key: string): string | null {
  const v = readSecrets()[key];
  if (!v) return null;
  try {
    return v.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : Buffer.from(v.slice(4), 'base64').toString('utf8');
  } catch { return null; }
}
function secretSet(key: string, value: string | null): void {
  const all = readSecrets();
  if (value === null) delete all[key];
  else all[key] = safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(value).toString('base64')}` : `b64:${Buffer.from(value, 'utf8').toString('base64')}`;
  fs.mkdirSync(path.dirname(secretsFile()), { recursive: true });
  fs.writeFileSync(secretsFile(), JSON.stringify(all), { mode: 0o600 });
}

/** Keep running in the tray (window closed) so scheduled posts still go out. */
let backgroundMode = false, quitting = false, tray: Tray | null = null;
function showTray(): void {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Framewright — posting scheduled videos');
  const open = () => { if (!win) createWindow(); else { win.show(); win.focus(); } };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Framewright', click: open },
    { type: 'separator' },
    { label: 'Quit (scheduled posts pause)', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', open);
}

function registerPublishIpc(): void {
  ipcMain.handle('fw:http', (_e, r) => publishHttp(r));
  ipcMain.handle('fw:oauth-start', () => oauthStart());
  ipcMain.handle('fw:oauth-wait', (_e, id: string, authUrl: string) => oauthWait(id, authUrl));
  ipcMain.handle('fw:oauth-cancel', (_e, id: string) => oauthStop(id));
  ipcMain.handle('fw:secret-get', (_e, key: string) => secretGet(key));
  ipcMain.handle('fw:secret-set', (_e, key: string, value: string | null) => secretSet(key, value));
  ipcMain.handle('fw:background', (_e, on: boolean) => {
    backgroundMode = on;
    if (on) showTray(); else { tray?.destroy(); tray = null; }
  });
}

/* ------------------------------------------------------------------ */
/* Start-up                                                             */
/* ------------------------------------------------------------------ */

app.setName('Framewright');
// Same data folder in development and installed builds.
app.setPath('userData', path.join(app.getPath('appData'), 'Framewright'));

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  const p = projectArg(argv);
  if (p) void openProjectPath(p);
});
app.on('open-file', (e, p) => { e.preventDefault(); void openProjectPath(p); }); // macOS "Open with"

app.whenReady().then(async () => {
  await cleanTemp();
  const dist = path.join(__dirname, '..', '..', 'dist');
  protocol.handle(APP_SCHEME, async (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(dist, rel));
    if (!file.startsWith(dist)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    // Cross-origin isolation lets the editor use SharedArrayBuffer-based speedups where available.
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    return new Response(res.body, { status: res.status, headers });
  });
  protocol.handle(MEDIA_SCHEME, (req) => {
    const m = /^fw-media:\/\/file\/([0-9a-f]+)/.exec(req.url);
    const file = m ? tokens.get(m[1]) : undefined;
    if (!file) return new Response('Not found', { status: 404 });
    return serveFile(file, req);
  });

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'window-management'].includes(permission));
  });
  // Screen recorder: the page asks for a screen, we hand over the one picked in our picker.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await captureList({ width: 0, height: 0 });
    const pick = sources.find((s) => s.id === captureChoice?.id) ?? sources.find((s) => s.id.startsWith('screen'));
    if (!pick) { cb({}); return; }
    // System sound capture is supported on Windows (and recent macOS via ScreenCaptureKit).
    const loopback = captureChoice?.audio && (process.platform === 'win32' || process.platform === 'darwin');
    cb(loopback ? { video: pick, audio: 'loopback' } : { video: pick });
  });

  registerIpc();
  registerPublishIpc();
  buildMenu();
  createWindow();
  const p = projectArg(process.argv);
  if (p) void openProjectPath(p);

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !backgroundMode) app.quit(); });
app.on('will-quit', () => { void cleanTemp(); });
