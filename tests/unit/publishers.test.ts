// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { newPost, type Post } from '../../src/core/publish';
import { pkce, type Http, type HttpReq, type VideoSource } from '../../src/engine/publish/http';
import { publishTarget, type Account } from '../../src/engine/publish/index';
import { instagramAccount, instagramFresh, instagramPublish } from '../../src/engine/publish/instagram';
import { tiktokAuthUrl, tiktokChunks, tiktokPublish } from '../../src/engine/publish/tiktok';
import { fitTags, youtubeAuthUrl, youtubeFresh, youtubeUpload } from '../../src/engine/publish/youtube';

const MB = 1024 * 1024;
function source(size: number): VideoSource & { bytes: Uint8Array } {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return { bytes, size, mime: 'video/mp4', name: 'quiz.mp4', read: async (o, n) => bytes.slice(o, o + n) };
}
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({ status, headers, text: typeof body === 'string' ? body : JSON.stringify(body) });

/** Records every request and answers with `route`. */
function fake(route: (r: HttpReq, log: HttpReq[]) => ReturnType<typeof res>): Http & { log: HttpReq[] } {
  const log: HttpReq[] = [];
  const f = (async (r: HttpReq) => { log.push(r); return route(r, log); }) as Http & { log: HttpReq[] };
  f.log = log;
  return f;
}

describe('sign-in helpers', () => {
  it('PKCE: base64url for Google, hex for TikTok', async () => {
    const g = await pkce('base64url'), t = await pkce('hex');
    expect(g.verifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(g.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.challenge).toMatch(/^[0-9a-f]{64}$/);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t.verifier)));
    expect(t.challenge).toBe(Array.from(h, (b) => b.toString(16).padStart(2, '0')).join(''));
  });
  it('builds the right sign-in addresses', () => {
    const y = new URL(youtubeAuthUrl({ clientId: 'cid', clientSecret: 's' }, 'http://127.0.0.1:5000/cb', 'st', 'ch'));
    expect(y.origin).toBe('https://accounts.google.com');
    expect(y.searchParams.get('scope')).toContain('youtube.upload');
    expect(y.searchParams.get('access_type')).toBe('offline');
    expect(y.searchParams.get('code_challenge_method')).toBe('S256');
    const t = new URL(tiktokAuthUrl({ clientId: 'ck', clientSecret: 's' }, 'http://127.0.0.1:5000/callback/', 'st', 'ch'));
    expect(t.searchParams.get('client_key')).toBe('ck');
    expect(t.searchParams.get('scope')).toBe('user.info.basic,video.upload,video.publish');
  });
});

describe('YouTube', () => {
  it('resumable upload in 8 MB pieces, picking up where YouTube says it got to', async () => {
    const v = source(20 * MB + 123);
    let received = 0, meta: Record<string, any> = {};
    const http = fake((r) => {
      if (r.method === 'POST') { meta = JSON.parse(String(r.body)); return res(200, {}, { Location: 'https://upload.example/session1' }); }
      const range = r.headers!['Content-Range'];
      const [a, b] = range.replace('bytes ', '').split('/')[0].split('-').map(Number);
      expect(a).toBe(received);
      // Pretend the first piece only half arrived.
      received = received === 0 ? 4 * MB : b + 1;
      if (received >= v.size) return res(201, { id: 'VID123', status: { privacyStatus: 'public' } });
      return res(308, '', { Range: `bytes=0-${received - 1}` });
    });
    const progress: number[] = [];
    const r = await youtubeUpload(http, { accessToken: 'tok' }, v, { title: 'Round 8', description: 'Guess! #quiz', tags: ['quiz'], categoryId: '24', privacy: 'public', madeForKids: false, short: true }, (f) => progress.push(f));
    expect(r).toMatchObject({ id: 'VID123', url: 'https://youtube.com/shorts/VID123' });
    expect(r.note).toBeUndefined();
    expect(meta.snippet).toMatchObject({ title: 'Round 8', tags: ['quiz'], categoryId: '24' });
    expect(meta.status).toMatchObject({ privacyStatus: 'public', selfDeclaredMadeForKids: false });
    const start = http.log[0];
    expect(start.url).toContain('uploadType=resumable');
    expect(start.headers!['X-Upload-Content-Length']).toBe(String(v.size));
    expect(start.headers!.Authorization).toBe('Bearer tok');
    const puts = http.log.filter((x) => x.method === 'PUT');
    expect((puts[0].body as Uint8Array).length).toBe(8 * MB);
    expect(puts[1].headers!['Content-Range']).toBe(`bytes ${4 * MB}-${12 * MB - 1}/${v.size}`);
    expect(progress.at(-1)).toBe(1);
  });
  it('scheduled: uploads now as private with a publish time; warns when YouTube locks it private', async () => {
    const at = Date.now() + 3 * 86400_000;
    let meta: Record<string, any> = {};
    const http = fake((r) => r.method === 'POST' ? (meta = JSON.parse(String(r.body)), res(200, {}, { location: 'https://u/s' })) : res(200, { id: 'X', status: { privacyStatus: 'private' } }));
    const r = await youtubeUpload(http, { accessToken: 't' }, source(1000), { title: 't', description: '', tags: [], categoryId: '22', privacy: 'public', madeForKids: true, publishAt: at, short: false });
    expect(meta.status).toEqual({ privacyStatus: 'private', selfDeclaredMadeForKids: true, publishAt: new Date(at).toISOString() });
    expect(r.note).toMatch(/publish it on/);
    expect(r.url).toBe('https://youtu.be/X');
    const locked = await youtubeUpload(fake((q) => q.method === 'POST' ? res(200, {}, { location: 'https://u/s' }) : res(200, { id: 'Y', status: { privacyStatus: 'private' } })),
      { accessToken: 't' }, source(10), { title: 't', description: '', tags: [], categoryId: '22', privacy: 'public', madeForKids: false, short: false });
    expect(locked.note).toMatch(/audit/);
  });
  it('renews an expired sign-in; explains 7-day test-mode expiry', async () => {
    const http = fake((r) => { expect(String(r.body)).toContain('grant_type=refresh_token'); return res(200, { access_token: 'new', expires_in: 3600 }); });
    const t = await youtubeFresh(http, { clientId: 'c', clientSecret: 's' }, { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() - 1 });
    expect(t).toMatchObject({ accessToken: 'new', refreshToken: 'r' });
    await expect(youtubeFresh(fake(() => res(400, { error: 'invalid_grant' })), { clientId: 'c', clientSecret: 's' }, { accessToken: 'o', refreshToken: 'r', expiresAt: 0 })).rejects.toThrow(/7 days/);
    expect(fitTags(Array.from({ length: 100 }, (_, i) => `tag number ${i}`)).join(',').length).toBeLessThanOrEqual(500);
  });
});

describe('Instagram', () => {
  it('container → upload straight from the device → wait → publish', async () => {
    const v = source(3 * MB);
    let polls = 0;
    const http = fake((r) => {
      if (r.url.endsWith('/1789/media')) return res(200, { id: 'C1', uri: 'https://rupload.facebook.com/ig-api-upload/v23.0/C1' });
      if (r.url.startsWith('https://rupload.facebook.com')) return res(200, { success: true });
      if (r.url.includes('/C1?')) return res(200, { status_code: ++polls < 3 ? 'IN_PROGRESS' : 'FINISHED' });
      if (r.url.endsWith('/media_publish')) return res(200, { id: 'M9' });
      if (r.url.includes('/M9?')) return res(200, { permalink: 'https://www.instagram.com/reel/abc/' });
      return res(404);
    });
    const r = await instagramPublish(http, { accessToken: 'IGT' }, '1789', v, { caption: 'Who is it? #quiz', shareToFeed: true, coverAt: 2.5 }, undefined, { pollMs: 1 });
    expect(r).toEqual({ id: 'M9', url: 'https://www.instagram.com/reel/abc/' });
    const create = new URLSearchParams(String(http.log[0].body));
    expect(Object.fromEntries(create)).toMatchObject({ media_type: 'REELS', upload_type: 'resumable', caption: 'Who is it? #quiz', share_to_feed: 'true', thumb_offset: '2500' });
    const up = http.log[1];
    expect(up.headers).toMatchObject({ Authorization: 'OAuth IGT', offset: '0', file_size: String(v.size) });
    expect((up.body as Uint8Array).length).toBe(v.size);
    expect(polls).toBe(3);
    expect(String(http.log.find((x) => x.url.endsWith('/media_publish'))!.body)).toContain('creation_id=C1');
  });
  it('reports processing errors and non-professional accounts; renews tokens near expiry', async () => {
    const bad = fake((r) => r.url.endsWith('/media') ? res(200, { id: 'C' }) : r.url.includes('/C?') ? res(200, { status_code: 'ERROR', status: 'Unsupported video' }) : res(200, {}));
    await expect(instagramPublish(bad, { accessToken: 't' }, 'U', source(10), { caption: '', shareToFeed: true, coverAt: 0 }, undefined, { pollMs: 1 })).rejects.toThrow(/Unsupported video/);
    await expect(instagramAccount(fake(() => res(200, { user_id: '1', username: 'dan', account_type: 'PERSONAL' })), 't')).rejects.toThrow(/professional account/);
    expect(await instagramAccount(fake(() => res(200, { user_id: '1', username: 'dan', account_type: 'MEDIA_CREATOR' })), 't')).toMatchObject({ userId: '1', username: 'dan' });
    const fresh = await instagramFresh(fake((r) => { expect(r.url).toContain('ig_refresh_token'); return res(200, { access_token: 'N', expires_in: 5184000 }); }), { accessToken: 'O', expiresAt: Date.now() + 2 * 86400_000 });
    expect(fresh.accessToken).toBe('N');
    const untouched = await instagramFresh(fake(() => { throw new Error('should not refresh'); }), { accessToken: 'O', expiresAt: Date.now() + 40 * 86400_000 });
    expect(untouched.accessToken).toBe('O');
  });
});

describe('TikTok', () => {
  it('splits files the way TikTok requires', () => {
    expect(tiktokChunks(3 * MB)).toMatchObject({ chunkSize: 3 * MB, count: 1 });
    const c = tiktokChunks(47 * MB + 5);
    expect(c.count).toBe(4);
    expect(c.ranges.at(-1)).toEqual([30 * MB, 47 * MB + 5]); // last chunk takes the remainder
    expect(c.ranges.reduce((a, [x, y]) => a + (y - x), 0)).toBe(47 * MB + 5);
  });
  it('direct post: falls back to "Only me" for unaudited apps and says so', async () => {
    const v = source(12 * MB);
    let init: Record<string, any> = {}, status = 0;
    const http = fake((r) => {
      if (r.url.endsWith('/creator_info/query/')) return res(200, { data: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 600 }, error: { code: 'ok' } });
      if (r.url.endsWith('/video/init/')) { init = JSON.parse(String(r.body)); return res(200, { data: { publish_id: 'P1', upload_url: 'https://upload.tiktok/x' }, error: { code: 'ok' } }); }
      if (r.method === 'PUT') return res(206);
      if (r.url.endsWith('/status/fetch/')) return res(200, { data: ++status < 2 ? { status: 'PROCESSING_UPLOAD' } : { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7123] }, error: { code: 'ok' } });
      return res(404);
    });
    const r = await tiktokPublish(http, { accessToken: 'T' }, v, { caption: 'Guess! #fyp', privacy: 'PUBLIC_TO_EVERYONE', allowComments: true, allowDuet: false, allowStitch: true, asDraft: false, coverAt: 1 }, undefined, { pollMs: 1 });
    expect(r).toMatchObject({ id: '7123', url: 'https://www.tiktok.com/video/7123', drafted: false });
    expect(r.note).toMatch(/Only me/);
    expect(init.post_info).toMatchObject({ title: 'Guess! #fyp', privacy_level: 'SELF_ONLY', disable_duet: true, disable_comment: false, video_cover_timestamp_ms: 1000 });
    expect(init.source_info).toEqual({ source: 'FILE_UPLOAD', video_size: v.size, chunk_size: 10 * MB, total_chunk_count: 1 });
    const puts = http.log.filter((x) => x.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].headers!['Content-Range']).toBe(`bytes 0-${v.size - 1}/${v.size}`);
  });
  it('send to drafts: no caption sent, lands in the TikTok inbox', async () => {
    const http = fake((r) => {
      if (r.url.endsWith('/inbox/video/init/')) { expect(JSON.parse(String(r.body)).post_info).toBeUndefined(); return res(200, { data: { publish_id: 'D1', upload_url: 'https://u/x' }, error: { code: 'ok' } }); }
      if (r.method === 'PUT') return res(201);
      return res(200, { data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } });
    });
    const r = await tiktokPublish(http, { accessToken: 'T' }, source(1000), { caption: 'x', privacy: 'PUBLIC_TO_EVERYONE', allowComments: true, allowDuet: true, allowStitch: true, asDraft: true, coverAt: 0 }, undefined, { pollMs: 1 });
    expect(r.drafted).toBe(true);
    expect(r.note).toMatch(/inbox/);
  });
  it('turns TikTok error codes into plain English', async () => {
    const http = fake(() => res(403, { error: { code: 'spam_risk_too_many_posts', message: 'x' } }));
    await expect(tiktokPublish(http, { accessToken: 'T' }, source(10), { caption: '', privacy: 'SELF_ONLY', allowComments: true, allowDuet: true, allowStitch: true, asDraft: true, coverAt: 0 })).rejects.toThrow(/daily posting limit/);
  });
});

describe('posting one platform of a post', () => {
  const account = (platform: Account['platform']): Account => ({ id: 'a', platform, name: 'Dan', handle: 'dan', remoteId: '1789', tokens: { accessToken: 'T', expiresAt: Date.now() + 90 * 86400_000 }, addedAt: 0 });
  const post = (): Post => {
    const p = newPost({ key: 'k', name: 'q.mp4', size: 10, mime: 'video/mp4', duration: 20, width: 1080, height: 1920 });
    p.caption = 'Can you guess?'; p.hashtags = ['quiz']; p.when = 'now'; p.publishAt = Date.now();
    p.targets.instagram.enabled = true;
    return p;
  };
  it('succeeds with the final caption, and failures are recorded, not thrown', async () => {
    let caption = '';
    const ok = fake((r) => {
      if (r.url.endsWith('/media')) { caption = new URLSearchParams(String(r.body)).get('caption')!; return res(200, { id: 'C' }); }
      if (r.url.includes('/C?')) return res(200, { status_code: 'FINISHED' });
      if (r.url.endsWith('/media_publish')) return res(200, { id: 'M' });
      return res(200, {});
    });
    const out = await publishTarget(ok, post(), 'instagram', account('instagram'), null, source(10));
    expect(caption).toBe('Can you guess?\n\n#quiz');
    expect(out.target).toMatchObject({ status: 'posted', result: { id: 'M' } });
    const fail = await publishTarget(fake(() => res(401, { error: { message: 'Invalid OAuth access token' } })), post(), 'instagram', account('instagram'), null, source(10));
    expect(fail.target.status).toBe('failed');
    expect(fail.target.error).toMatch(/reconnect/);
    const noApp = await publishTarget(ok, post(), 'youtube', account('youtube'), null, source(10));
    expect(noApp.target.error).toMatch(/client ID/);
  });
});
