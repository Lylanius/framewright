// Desktop post planner, end to end against fake YouTube / Instagram / TikTok servers:
//   xvfb-run -a node tests/desktop/publish-smoke.mjs [path-to-electron-app]
// Connects all three accounts (browser sign-in via the 127.0.0.1 callback, token paste),
// posts a video to all three at once, and schedules a YouTube post (uploaded early).
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const video = path.join(root, 'tests', 'fixtures', 'vertical-post.mp4');
const size = fs.statSync(video).size;
const results = {};
const check = (name, ok, detail = '') => { results[name] = ok ? 'ok' : `FAIL ${detail}`; console.log(ok ? '✓' : '✗', name, detail); };

/* ---------------- fake platforms ---------------- */
const seen = { ytMeta: [], ytBytes: 0, igCaption: '', igBytes: 0, ttInit: null, ttBytes: 0, tokenCalls: [] };
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const json = (res, status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
let igPolls = 0, ttPolls = 0;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const [, host, ...rest] = u.pathname.split('/');
  const p = '/' + rest.join('/');
  const b = await body(req);
  // Sign-in pages: approve straight away and send the code back to the app's callback.
  if ((host === 'accounts.google.com' && p === '/o/oauth2/v2/auth') || (host === 'www.tiktok.com' && p === '/v2/auth/authorize/')) {
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', host === 'www.tiktok.com' ? 'TTCODE' : 'GCODE');
    back.searchParams.set('state', u.searchParams.get('state'));
    seen.tokenCalls.push(`${host} challenge=${u.searchParams.get('code_challenge')?.length}`);
    res.writeHead(302, { Location: back.toString() }); res.end(); return;
  }
  if (host === 'oauth2.googleapis.com' && p === '/token') { seen.tokenCalls.push(`google ${new URLSearchParams(b.toString()).get('grant_type')}`); return json(res, 200, { access_token: 'YT_AT', refresh_token: 'YT_RT', expires_in: 3600 }); }
  if (host === 'www.googleapis.com' && p === '/youtube/v3/channels') return json(res, 200, { items: [{ id: 'UC1', snippet: { title: 'Dan Quizzes', customUrl: '@danquizzes' } }] });
  if (host === 'www.googleapis.com' && p === '/upload/youtube/v3/videos') { seen.ytMeta.push(JSON.parse(b.toString())); return json(res, 200, {}, { Location: `https://www.googleapis.com/upload/session/${seen.ytMeta.length}` }); }
  if (host === 'www.googleapis.com' && p.startsWith('/upload/session/')) { seen.ytBytes += b.length; return json(res, 200, { id: `VID${p.split('/').pop()}`, status: { privacyStatus: 'private' } }); }
  if (host === 'open.tiktokapis.com' && p === '/v2/oauth/token/') { seen.tokenCalls.push(`tiktok ${new URLSearchParams(b.toString()).get('grant_type')}`); return json(res, 200, { access_token: 'TT_AT', refresh_token: 'TT_RT', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'OPEN1' }); }
  if (host === 'open.tiktokapis.com' && p === '/v2/user/info/') return json(res, 200, { data: { user: { open_id: 'OPEN1', display_name: 'Dan TT', username: 'dan.tt' } }, error: { code: 'ok' } });
  if (host === 'open.tiktokapis.com' && p === '/v2/post/publish/creator_info/query/') return json(res, 200, { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } });
  if (host === 'open.tiktokapis.com' && p === '/v2/post/publish/video/init/') { seen.ttInit = JSON.parse(b.toString()); return json(res, 200, { data: { publish_id: 'PUB1', upload_url: 'https://open-upload.tiktokapis.com/upload/1' }, error: { code: 'ok' } }); }
  if (host === 'open-upload.tiktokapis.com') { seen.ttBytes += b.length; res.writeHead(201); res.end(); return; }
  if (host === 'open.tiktokapis.com' && p === '/v2/post/publish/status/fetch/') return json(res, 200, { data: ++ttPolls < 2 ? { status: 'PROCESSING_UPLOAD' } : { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7777] }, error: { code: 'ok' } });
  if (host === 'graph.instagram.com' && p === '/v23.0/me') return json(res, 200, { user_id: '1789', username: 'dan.quizzes', account_type: 'MEDIA_CREATOR' });
  if (host === 'graph.instagram.com' && p === '/v23.0/1789/media') { seen.igCaption = new URLSearchParams(b.toString()).get('caption'); return json(res, 200, { id: 'C1', uri: 'https://rupload.facebook.com/ig-api-upload/v23.0/C1' }); }
  if (host === 'rupload.facebook.com') { seen.igBytes += b.length; seen.igHeaders = req.headers; return json(res, 200, { success: true }); }
  if (host === 'graph.instagram.com' && p === '/v23.0/C1') return json(res, 200, { status_code: ++igPolls < 2 ? 'IN_PROGRESS' : 'FINISHED' });
  if (host === 'graph.instagram.com' && p === '/v23.0/1789/media_publish') return json(res, 200, { id: 'M1' });
  if (host === 'graph.instagram.com' && p === '/v23.0/M1') return json(res, 200, { permalink: 'https://www.instagram.com/reel/FAKE/' });
  if (host === 'graph.instagram.com' && p === '/refresh_access_token') return json(res, 200, { access_token: 'IG_AT2', expires_in: 5184000 });
  console.log('  fake server: unhandled', req.method, host, p);
  json(res, 404, { error: { message: 'not found' } });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${server.address().port}`;

/* ---------------- the app ---------------- */
const exe = process.argv[2];
const userData = path.join(process.env.HOME, '.config', 'Framewright');
fs.rmSync(path.join(userData, 'publish-secrets.json'), { force: true });
const app = await electron.launch({
  ...(exe ? { executablePath: exe, args: ['--no-sandbox'] } : { args: [path.join(root, 'desktop', 'out', 'main.cjs'), '--no-sandbox'] }),
  env: { ...process.env, FW_PUBLISH_FAKE: FAKE },
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  // Fresh planner data for a repeatable run.
  await page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('fw-kv', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => r(q.result); });
    await new Promise((r) => { const tx = db.transaction('kv', 'readwrite'); const s = tx.objectStore('kv'); for (const pre of ['post/', 'postvideo/', 'pubacct/', 'pubapp/', 'pubsettings']) s.delete(IDBKeyRange.bound(pre, pre + '￿')); tx.oncomplete = r; });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Post planner' }).click();
  await page.getByRole('tab', { name: 'Accounts' }).click();
  const section = (n) => page.locator('.acct-section').filter({ has: page.getByRole('heading', { name: n }) });

  // YouTube: client id/secret, then browser sign-in (fake approves) through the 127.0.0.1 callback.
  await section('YouTube').getByLabel('YouTube client id').fill('123-abc.apps.googleusercontent.com');
  await section('YouTube').getByLabel('YouTube client secret').fill('GOCSPX-secret');
  await section('YouTube').getByRole('button', { name: 'Connect YouTube' }).click();
  await section('YouTube').getByText('Dan Quizzes').waitFor({ timeout: 20_000 });
  check('YouTube connected via browser sign-in', true);
  await section('TikTok').getByLabel('TikTok client id').fill('awkey123');
  await section('TikTok').getByLabel('TikTok client secret').fill('ttsecret');
  await section('TikTok').getByRole('button', { name: 'Connect TikTok' }).click();
  await section('TikTok').getByText('Dan TT').waitFor({ timeout: 20_000 });
  check('TikTok connected via browser sign-in', true);
  await section('Instagram').getByLabel('Instagram access token').fill('IGAA_FAKE_TOKEN');
  await section('Instagram').getByRole('button', { name: 'Connect Instagram' }).click();
  await section('Instagram').getByText('dan.quizzes').first().waitFor({ timeout: 20_000 });
  check('Instagram connected with pasted token', true);
  check('PKCE: base64url for Google (43), hex for TikTok (64)', seen.tokenCalls.includes('accounts.google.com challenge=43') && seen.tokenCalls.includes('www.tiktok.com challenge=64'), seen.tokenCalls.join(', '));
  const secrets = fs.readFileSync(path.join(userData, 'publish-secrets.json'), 'utf8');
  check('sign-ins kept by the app, not in page storage', !secrets.includes('YT_AT') && Object.keys(JSON.parse(secrets)).length >= 5, Object.keys(JSON.parse(secrets)).join(','));
  const inPage = await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('fw-kv', 1); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').getAll(); g.onsuccess = () => r(JSON.stringify(g.result.filter((x) => !(x instanceof Blob)))); }; }));
  check('no tokens or secrets in the page’s database', !/YT_AT|TT_AT|IGAA_FAKE|GOCSPX|ttsecret/.test(inPage));

  // Post to all three now.
  await page.getByRole('button', { name: 'New post' }).first().click();
  await page.getByLabel('Video to post').setInputFiles(video);
  await page.locator('.composer small.mono').filter({ hasText: '540×960' }).waitFor();
  for (const p of ['YouTube', 'Instagram', 'TikTok']) {
    const d = page.getByRole('radiogroup', { name: `${p} delivery` });
    check(`${p}: “Post for me” chosen by default`, (await d.getByRole('radio', { name: 'Post for me' }).getAttribute('aria-checked')) === 'true');
  }
  await page.getByLabel('Caption').fill('Who is it? Comment below!');
  const tags = page.getByLabel('Hashtags', { exact: true });
  await tags.fill('quiz fyp');
  await tags.press('Enter');
  await page.getByRole('tab', { name: /YouTube/ }).click();
  await page.getByLabel('YouTube title').fill('Who’s that creature? #8');
  await page.getByRole('radio', { name: 'Post now' }).click();
  await page.getByRole('button', { name: 'Post now' }).last().click();
  await page.getByRole('tab', { name: /Posted/ }).click();
  await page.locator('.post-card .status-chip.good').nth(2).waitFor({ timeout: 60_000 });
  const card = page.locator('.post-card').first();
  const text = await card.textContent();
  check('all three posted', (await card.locator('.status-chip.good').count()) === 3, text);
  check('YouTube: whole file uploaded with title + #Shorts', seen.ytBytes === size && seen.ytMeta[0]?.snippet.title === 'Who’s that creature? #8' && seen.ytMeta[0]?.snippet.description.includes('#Shorts'), JSON.stringify(seen.ytMeta[0]));
  check('YouTube: explains private lock for unaudited projects', /audit/.test(text));
  check('Instagram: caption with hashtags, file sent straight to Instagram', seen.igCaption === 'Who is it? Comment below!\n\n#quiz #fyp' && seen.igBytes === size && seen.igHeaders?.file_size === String(size), `${JSON.stringify(seen.igCaption)} ${seen.igBytes}`);
  check('Instagram: link to the Reel', await card.getByRole('link', { name: /View on Instagram/ }).count() === 1);
  check('TikTok: “Only me” for unaudited app, explained', seen.ttInit?.post_info.privacy_level === 'SELF_ONLY' && /Only me/.test(text) && seen.ttBytes === size, JSON.stringify(seen.ttInit));

  // Scheduled YouTube post: uploaded straight away with a publish time.
  await page.getByRole('button', { name: 'New post' }).first().click();
  await page.getByLabel('Video to post').setInputFiles(video);
  await page.locator('.composer small.mono').filter({ hasText: '540×960' }).waitFor();
  await page.getByLabel('Post to Instagram').uncheck();
  await page.getByLabel('Post to TikTok').uncheck();
  await page.getByLabel('Caption').fill('Tomorrow’s quiz');
  await page.getByRole('radio', { name: 'Pick a time' }).click();
  const at = new Date(Date.now() + 26 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  await page.getByLabel('Post date and time').fill(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`);
  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.getByRole('tab', { name: /Posted/ }).click();
  await page.locator('.post-card', { hasText: 'Tomorrow’s quiz' }).locator('.status-chip', { hasText: 'Scheduled on YouTube' }).waitFor({ timeout: 60_000 });
  const m = seen.ytMeta[1];
  check('scheduled YouTube post uploaded early with publishAt', m?.status.privacyStatus === 'private' && Math.abs(new Date(m.status.publishAt).getTime() - at.getTime()) < 61_000, JSON.stringify(m?.status));
  await page.screenshot({ path: '/tmp/fw-publish-posted.png' });
  // Keep running in the tray: closing the window hides it; scheduled posts carry on.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByText('Keep running in the background').click();
  await page.waitForTimeout(500);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForTimeout(800);
  const st = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), destroyed: w.isDestroyed() })));
  check('closing the window keeps it running in the tray', st.length === 1 && !st[0].visible && !st[0].destroyed, JSON.stringify(st));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.getByText('Keep running in the background').click();
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  console.error(e);
  results.crash = String(e);
  await page.screenshot({ path: '/tmp/fw-publish-fail.png' }).catch(() => undefined);
} finally {
  await app.close().catch(() => undefined);
  server.close();
}
const failed = Object.entries(results).filter(([, v]) => v !== 'ok');
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASSED');
process.exit(failed.length ? 1 : 0);
