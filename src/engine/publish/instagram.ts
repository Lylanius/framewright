/**
 * Instagram Reels through the Instagram API with Instagram Login
 * (professional — Business or Creator — accounts). You paste an access token
 * generated in your own Meta app's dashboard; it lasts 60 days and is renewed
 * automatically while in use. The video is uploaded straight from this device
 * (resumable upload), then published.
 *
 * Instagram has no built-in scheduling for API posts, so Framewright posts at
 * the chosen time itself.
 */
import { check, form, parse, PublishError, qs, sleep, type Http, type Progress, type Tokens, type VideoSource } from './http';

export const IG_VERSION = 'v23.0';
const GRAPH = 'https://graph.instagram.com';
const RUPLOAD = 'https://rupload.facebook.com/ig-api-upload';

export async function instagramAccount(http: Http, token: string): Promise<{ userId: string; username: string; avatar?: string }> {
  const r = check(await http({ method: 'GET', url: qs(`${GRAPH}/${IG_VERSION}/me`, { fields: 'user_id,username,profile_picture_url,account_type', access_token: token }) }), 'Instagram');
  const j = parse<{ user_id?: string; id?: string; username?: string; profile_picture_url?: string; account_type?: string }>(r);
  if (!j.username) throw new PublishError('Instagram didn’t recognise that token.');
  if (j.account_type && !/BUSINESS|MEDIA_CREATOR|CREATOR/i.test(j.account_type)) throw new PublishError('Posting needs an Instagram professional account (Business or Creator). Switch it in the Instagram app: Settings → Account type and tools.');
  return { userId: String(j.user_id ?? j.id), username: j.username, avatar: j.profile_picture_url };
}

/** Tokens last 60 days; renew when older than a day and within 10 days of running out. */
export async function instagramFresh(http: Http, t: Tokens): Promise<Tokens> {
  if (t.expiresAt && t.expiresAt < Date.now()) throw new PublishError('Instagram token has run out — generate a new one and reconnect.', 401);
  if (t.expiresAt && t.expiresAt - Date.now() > 10 * 86400_000) return t;
  const r = await http({ method: 'GET', url: qs(`${GRAPH}/refresh_access_token`, { grant_type: 'ig_refresh_token', access_token: t.accessToken }) });
  if (r.status !== 200) return t; // still valid for now; try again next time
  const j = parse<{ access_token?: string; expires_in?: number }>(r);
  return j.access_token ? { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 5184000) * 1000 } : t;
}

export interface InstagramPost { caption: string; shareToFeed: boolean; coverAt: number }

export async function instagramPublish(http: Http, t: Tokens, userId: string, video: VideoSource, p: InstagramPost, onProgress: Progress = () => undefined,
  opts: { pollMs?: number; maxWaitMs?: number } = {}): Promise<{ id: string; url?: string }> {
  const pollMs = opts.pollMs ?? 5000, maxWait = opts.maxWaitMs ?? 15 * 60_000;
  onProgress(0, 'Preparing Reel');
  // 1. Container
  const c = parse<{ id?: string; uri?: string }>(check(await http({
    method: 'POST', url: `${GRAPH}/${IG_VERSION}/${userId}/media`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ media_type: 'REELS', upload_type: 'resumable', caption: p.caption, share_to_feed: p.shareToFeed, thumb_offset: Math.round(p.coverAt * 1000), access_token: t.accessToken }),
  }), 'Instagram'));
  if (!c.id) throw new PublishError('Instagram didn’t create the Reel.');
  // 2. Upload the file straight to Instagram
  onProgress(0.05, 'Uploading');
  const bytes = await video.read(0, video.size);
  const up = await http({
    method: 'POST', url: c.uri ?? `${RUPLOAD}/${IG_VERSION}/${c.id}`,
    headers: { Authorization: `OAuth ${t.accessToken}`, offset: '0', file_size: String(video.size), 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  check(up, 'Instagram upload');
  onProgress(0.6, 'Instagram is processing the video');
  // 3. Wait for Instagram to process it
  const started = Date.now();
  for (;;) {
    const s = parse<{ status_code?: string; status?: string }>(check(await http({ method: 'GET', url: qs(`${GRAPH}/${IG_VERSION}/${c.id}`, { fields: 'status_code,status', access_token: t.accessToken }) }), 'Instagram'));
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new PublishError(`Instagram couldn’t process the video${s.status ? `: ${s.status}` : ''}.`);
    if (Date.now() - started > maxWait) throw new PublishError('Instagram is taking too long to process the video — try again later.', 0, true);
    onProgress(Math.min(0.95, 0.6 + ((Date.now() - started) / maxWait) * 0.35), 'Instagram is processing the video');
    await sleep(pollMs);
  }
  // 4. Publish
  const pub = parse<{ id?: string }>(check(await http({
    method: 'POST', url: `${GRAPH}/${IG_VERSION}/${userId}/media_publish`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ creation_id: c.id, access_token: t.accessToken }),
  }), 'Instagram publish'));
  if (!pub.id) throw new PublishError('Instagram didn’t confirm the post.');
  const link = await http({ method: 'GET', url: qs(`${GRAPH}/${IG_VERSION}/${pub.id}`, { fields: 'permalink', access_token: t.accessToken }) });
  onProgress(1, 'Posted');
  return { id: pub.id, url: link.status === 200 ? parse<{ permalink?: string }>(link).permalink : undefined };
}
