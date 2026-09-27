// Desktop app smoke test: `xvfb-run -a node tests/desktop/smoke.mjs [path-to-electron-app]`
// Launches the packaged (or dev) Electron app and exercises what only the desktop build does:
// in-place media, H.264 decode, FFmpeg conversion, native save, screen recording, pop-out preview.
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const fx = (n) => path.join(root, 'tests', 'fixtures', n);
const exe = process.argv[2];
const out = path.join(os.tmpdir(), 'fw-desktop-smoke');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const results = {};
const check = (name, ok, detail = '') => { results[name] = ok ? 'ok' : `FAIL ${detail}`; console.log(ok ? '✓' : '✗', name, detail); };

const app = await electron.launch({
  ...(exe ? { executablePath: exe, args: ['--no-sandbox'] } : { args: [path.join(root, 'desktop', 'out', 'main.cjs'), '--no-sandbox'] }),
  env: { ...process.env, FRAMEWRIGHT_FFMPEG: process.env.FRAMEWRIGHT_FFMPEG ?? '', ELECTRON_ENABLE_LOGGING: '1' },
});
const page = await app.firstWindow();
const errors = [];
const toasts = [];
await page.exposeFunction('__fwToast', (t) => { toasts.push(t); console.log('  toast:', t); });
await page.evaluate(() => new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList?.contains('toast') && window.__fwToast(n.textContent)))).observe(document.body, { childList: true, subtree: true })).catch(() => undefined);
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.setViewportSize?.({ width: 1440, height: 900 }).catch(() => undefined);

try {
  const shell = await page.evaluate(() => window.fwNative?.shell);
  check('native bridge present', shell === 'desktop', String(shell));
  await page.getByRole('button', { name: /^TikTok/ }).click();
  await page.locator('.editor').waitFor();

  // Import: VP9 WebM, H.264 MP4 (needs the desktop build's codecs) and an old AVI (FFmpeg converts it).
  await page.locator('.import-zone input[type=file][multiple]').first().setInputFiles([fx('landscape.mp4'), fx('h264-only.mp4'), '/tmp/old.avi']);
  await page.locator('.media-tile').nth(2).waitFor({ timeout: 120_000 }).catch(() => undefined);
  const tiles = await page.locator('.media-tile').count();
  const toast = await page.locator('.toast').allTextContents();
  check('imports incl. H.264 + AVI via FFmpeg', tiles === 3, `${tiles} tiles; ${toast.join(' | ')}`);
  const convDirs = ['Framewright', 'framewright'].map((n) => path.join(os.homedir(), '.config', n, 'converted')).filter((d) => fs.existsSync(d));
  const conv = convDirs.some((d) => fs.readdirSync(d).some((f) => f.endsWith('.mp4')));
  check('AVI converted to MP4 on disk', conv);

  // In place: media URLs point at fw-media://, not copies in browser storage.
  const inPlace = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src));
  for (const n of ['h264-only.mp4', 'old.avi']) {
    const t = page.locator('.media-tile', { hasText: n.replace('.avi', '') }).first();
    await t.hover();
    await t.getByRole('button', { name: /to timeline/ }).click();
    await page.keyboard.press('End');
  }
  await page.waitForTimeout(1500);
  const srcs = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src).filter(Boolean));
  check('media used in place (fw-media://)', srcs.some((s) => s.startsWith('fw-media://')), JSON.stringify(srcs.concat(inPlace).slice(0, 3)));

  // Preview draws the H.264 clip.
  await page.keyboard.press('Home');
  await page.waitForTimeout(1000);
  const lit = await page.evaluate(() => {
    const c = document.querySelector('.stage canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 400) if (d[i] + d[i + 1] + d[i + 2] > 60) n++; return n;
  });
  check('H.264 preview draws', lit > 50, `${lit}`);

  // Export → MP4 streamed to a temp file → native "Save as" (stubbed to a known path).
  const target = path.join(out, 'desktop-export.mp4');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, target);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'MP4', exact: true }).click();
  const codecText = await page.locator('.dialog select').nth(2).textContent().catch(() => '');
  await page.locator('.dialog footer .btn.primary').click();
  await page.getByRole('button', { name: /Save .*\.mp4/ }).waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: /Save .*\.mp4/ }).click();
  await page.waitForTimeout(1500);
  let probe = '';
  try { probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'csv=p=0', target]).toString().trim().replace(/\n/g, ' '); } catch { /* missing */ }
  check('export saved via native dialog', fs.existsSync(target) && /h264|av1|vp9|hevc/.test(probe), `${probe} (codecs offered: ${codecText})`);
  await page.getByRole('button', { name: 'Close' }).click();

  // Screen recording with the desktop picker.
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: /Record screen/ }).click();
  await page.locator('.source-grid button').first().waitFor({ timeout: 15_000 });
  const nSources = await page.locator('.source-grid button').count();
  await page.getByRole('checkbox', { name: /microphone/ }).uncheck();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.locator('.rec-time').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.locator('.media-tile', { hasText: 'Screen' }).waitFor({ timeout: 60_000 }).catch(() => undefined);
  const recDir = path.join(os.homedir(), 'Videos', 'Framewright Recordings');
  const recs = fs.existsSync(recDir) ? fs.readdirSync(recDir) : [];
  check('screen recording saved + imported', recs.length > 0 && (await page.locator('.media-tile', { hasText: 'Screen' }).count()) === 1, `${nSources} sources; files: ${recs.join(', ')}`);

  // Pop-out preview (menu command) opens a second window with a live picture.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('fw:menu', 'popout-preview'));
  const pop = await app.waitForEvent('window', { timeout: 10_000 }).catch(() => null);
  let popOk = false;
  if (pop) { await pop.waitForTimeout(1500); popOk = await pop.evaluate(() => { const v = document.querySelector('video'); return !!v && v.videoWidth > 0; }); }
  check('pop-out preview window mirrors the preview', popOk);

  await page.screenshot({ path: path.join(out, 'desktop.png') });
  check('no page errors', errors.filter((e) => !/Autofill|DevTools|Electron Security Warning/.test(e)).length === 0, errors.join(' | ').slice(0, 400));
  // Restart: the project reopens and in-place media is found again on disk (no copies were stored).
  await page.waitForTimeout(2000);
  await app.close();
  const app2 = await electron.launch({
    ...(exe ? { executablePath: exe, args: ['--no-sandbox'] } : { args: [path.join(root, 'desktop', 'out', 'main.cjs'), '--no-sandbox'] }),
  });
  const p2 = await app2.firstWindow();
  await p2.locator('.project-card').first().getByRole('button').first().click();
  await p2.locator('.media-tile').first().waitFor({ timeout: 30_000 });
  await p2.waitForTimeout(1500);
  const t2 = await p2.locator('.media-tile').count(), miss = await p2.locator('.media-tile.missing').count();
  check('reopen after restart finds in-place media', t2 >= 4 && miss === 0, `${t2} tiles, ${miss} missing`);
  await app2.close();
} catch (e) {
  check('smoke run', false, e.message);
  await page.screenshot({ path: path.join(out, 'desktop-fail.png') }).catch(() => undefined);
} finally {
  await app.close().catch(() => undefined);
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
const failed = Object.values(results).filter((v) => v !== 'ok').length;
console.log(failed ? `${failed} check(s) failed` : 'all desktop checks passed', '→', out);
process.exit(failed ? 1 : 0);
