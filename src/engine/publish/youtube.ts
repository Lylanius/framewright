/**
 * YouTube: sign in with your own Google Cloud "Desktop app" OAuth client,
 * then resumable uploads through the YouTube Data API v3 (videos.insert).
 * Scheduling is done by YouTube itself (status.publishAt).
 *
 * Note from Google: videos uploaded from API projects that haven't passed the
 * (free) YouTube API audit are locked to private.
 */
import { check, form, header, parse, PublishError, qs, sleep, type Http, type PlatformApp, type Progress, type Tokens, type VideoSource } from './http';

export const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB

export function youtubeAuthUrl(app: PlatformApp, redirectUri: string, state: string, challenge: string): string {
  return qs(AUTH, {
    client_id: app.clientId, redirect_uri: redirectUri, response_type: 'code', scope: YT_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
}

function tokensFrom(j: { access_token?: string; refresh_token?: string; expires_in?: number }, old?: Tokens): Tokens {
  if (!j.access_token) throw new PublishError('YouTube didn’t return a sign-in token.');
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? old?.refreshToken, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
}

export async function youtubeExchange(http: Http, app: PlatformApp, code: string, redirectUri: string, verifier: string): Promise<Tokens> {
  const r = check(await http({ method: 'POST', url: TOKEN, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: app.clientId, client_secret: app.clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }) }), 'YouTube sign-in');
  return tokensFrom(parse(r));
}

export async function youtubeFresh(http: Http, app: PlatformApp, t: Tokens): Promise<Tokens> {
  if (t.expiresAt && t.expiresAt > Date.now() + 120_000) return t;
  if (!t.refreshToken) throw new PublishError('YouTube sign-in expired — reconnect the account.', 401);
  const r = await http({ method: 'POST', url: TOKEN, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: app.clientId, client_secret: app.clientSecret, refresh_token: t.refreshToken, grant_type: 'refresh_token' }) });
  if (r.status === 400 || r.status === 401) throw new PublishError('YouTube sign-in expired — reconnect the account. (If your Google project is in “Testing”, Google ends sign-ins after 7 days; set it to “In production”.)', 401);
  return tokensFrom(parse(check(r, 'YouTube sign-in')), t);
}

export async function youtubeChannel(http: Http, t: Tokens): Promise<{ id: string; name: string; handle: string; avatar?: string }> {
  const r = check(await http({ method: 'GET', url: qs(`${API}/channels`, { part: 'snippet', mine: 'true' }), headers: { Authorization: `Bearer ${t.accessToken}` } }), 'YouTube channel');
  const it = parse<{ items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } } }[] }>(r).items?.[0];
  if (!it) throw new PublishError('This Google account has no YouTube channel yet.');
  return { id: it.id, name: it.snippet.title, handle: it.snippet.customUrl ?? '', avatar: it.snippet.thumbnails?.default?.url };
}

export interface YouTubeUpload {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacy: 'public' | 'unlisted' | 'private';
  madeForKids: boolean;
  /** Publish later (YouTube does it): the video is uploaded as private with this time. */
  publishAt?: number;
  short: boolean;
}

/** Tags YouTube accepts: ≤ 500 characters in total. */
export function fitTags(tags: string[]): string[] {
  const out: string[] = [];
  let n = 0;
  for (const t of tags) {
    const cost = t.length + (t.includes(' ') ? 2 : 0) + (out.length ? 1 : 0);
    if (n + cost > 500) break;
    out.push(t); n += cost;
  }
  return out;
}

export async function youtubeUpload(http: Http, t: Tokens, video: VideoSource, u: YouTubeUpload, onProgress: Progress = () => undefined): Promise<{ id: string; url: string; note?: string }> {
  const scheduled = !!u.publishAt && u.publishAt > Date.now() + 60_000;
  const meta = {
    snippet: { title: u.title, description: u.description, tags: fitTags(u.tags), categoryId: u.categoryId },
    status: {
      privacyStatus: scheduled ? 'private' : u.privacy,
      selfDeclaredMadeForKids: u.madeForKids,
      ...(scheduled ? { publishAt: new Date(u.publishAt!).toISOString() } : {}),
    },
  };
  onProgress(0, 'Starting upload');
  const start = check(await http({
    method: 'POST', url: qs(UPLOAD, { uploadType: 'resumable', part: 'snippet,status' }),
    headers: { Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(video.size), 'X-Upload-Content-Type': video.mime || 'video/mp4' },
    body: JSON.stringify(meta),
  }), 'YouTube upload');
  const session = header(start, 'location');
  if (!session) throw new PublishError('YouTube didn’t give an upload address.');
  let offset = 0, tries = 0;
  let done: { id?: string; status?: { privacyStatus?: string } } | null = null;
  while (!done) {
    const end = Math.min(video.size, offset + CHUNK);
    const body = await video.read(offset, end - offset);
    const r = await http({ method: 'PUT', url: session, headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${video.size}`, 'Content-Type': video.mime || 'video/mp4' }, body });
    if (r.status === 308) {
      const range = header(r, 'range');
      offset = range ? Number(range.split('-')[1]) + 1 : 0;
      tries = 0;
      onProgress(offset / video.size, 'Uploading');
    } else if (r.status === 200 || r.status === 201) {
      done = parse(r);
    } else if ((r.status >= 500 || r.status === 429) && tries < 5) {
      // Ask YouTube how much arrived, then carry on from there.
      await sleep(1000 * 2 ** tries++);
      const q = await http({ method: 'PUT', url: session, headers: { 'Content-Range': `bytes */${video.size}` }, body: null });
      if (q.status === 200 || q.status === 201) done = parse(q);
      else { const range = header(q, 'range'); offset = range ? Number(range.split('-')[1]) + 1 : 0; }
    } else check(r, 'YouTube upload');
  }
  if (!done.id) throw new PublishError('YouTube finished the upload but didn’t return a video id.');
  onProgress(1, 'Uploaded');
  const url = u.short ? `https://youtube.com/shorts/${done.id}` : `https://youtu.be/${done.id}`;
  const wanted = scheduled ? 'private' : u.privacy;
  const got = done.status?.privacyStatus;
  const note = got && got !== wanted
    ? 'YouTube kept this video private: your Google project needs the free YouTube API audit before it can post publicly. Open it in YouTube Studio to make it public.'
    : scheduled ? `Uploaded — YouTube will publish it on ${new Date(u.publishAt!).toLocaleString()}.` : undefined;
  return { id: done.id, url, note };
}
