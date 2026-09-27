/**
 * TikTok through the Content Posting API with your own TikTok developer app
 * (Login Kit for Desktop: PKCE + a 127.0.0.1 redirect).
 *
 * - Direct post needs the `video.publish` scope. Until TikTok audits the app,
 *   every direct post is forced to "Only me" (SELF_ONLY).
 * - "Send to drafts" (`video.upload`) puts the video in your TikTok inbox to
 *   finish in the app — works without the audit, but the caption can't be sent,
 *   so Framewright copies it for you.
 */
import { check, form, parse, PublishError, qs, sleep, type Http, type PlatformApp, type Progress, type Tokens, type VideoSource } from './http';
import type { TikTokPrivacy } from '../../core/publish';

export const TT_SCOPES = ['user.info.basic', 'video.upload', 'video.publish'];
const AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com';
const MB = 1024 * 1024;

export function tiktokAuthUrl(app: PlatformApp, redirectUri: string, state: string, challenge: string): string {
  return qs(AUTH, { client_key: app.clientId, response_type: 'code', scope: TT_SCOPES.join(','), redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' });
}

function tokensFrom(j: { access_token?: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number; open_id?: string }): Tokens & { openId?: string } {
  if (!j.access_token) throw new PublishError('TikTok didn’t return a sign-in token.');
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in ?? 86400) * 1000, refreshExpiresAt: Date.now() + (j.refresh_expires_in ?? 31536000) * 1000, openId: j.open_id };
}

async function tokenCall(http: Http, body: Record<string, string>): Promise<ReturnType<typeof tokensFrom>> {
  const r = await http({ method: 'POST', url: `${API}/v2/oauth/token/`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body) });
  const j = parse<{ access_token?: string; error?: string; error_description?: string }>(r);
  if (r.status !== 200 || j.error) throw new PublishError(`TikTok sign-in: ${j.error_description || j.error || `HTTP ${r.status}`}`, 401);
  return tokensFrom(j);
}

export function tiktokExchange(http: Http, app: PlatformApp, code: string, redirectUri: string, verifier: string) {
  return tokenCall(http, { client_key: app.clientId, client_secret: app.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier });
}

export async function tiktokFresh(http: Http, app: PlatformApp, t: Tokens): Promise<Tokens> {
  if (t.expiresAt && t.expiresAt > Date.now() + 120_000) return t;
  if (!t.refreshToken || (t.refreshExpiresAt && t.refreshExpiresAt < Date.now())) throw new PublishError('TikTok sign-in expired — reconnect the account.', 401);
  return tokenCall(http, { client_key: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token', refresh_token: t.refreshToken });
}

/** TikTok wraps errors as { error: { code, message } } with code "ok" on success. */
function tt<T>(r: Awaited<ReturnType<Http>>, what: string): T {
  const j = parse<{ data?: T; error?: { code?: string; message?: string } }>(r);
  if (r.status !== 200 || (j.error && j.error.code && j.error.code !== 'ok')) {
    const code = j.error?.code ?? '';
    const friendly: Record<string, string> = {
      unaudited_client_can_only_post_to_private_accounts: 'your TikTok app hasn’t been audited yet, so it can only post to a private account (or use “Send to drafts”).',
      spam_risk_too_many_posts: 'TikTok’s daily posting limit was reached — try again tomorrow.',
      spam_risk_too_many_pending_share: 'too many videos are waiting in your TikTok drafts — post or delete some first.',
      privacy_level_option_mismatch: 'that privacy setting isn’t allowed for this account.',
      access_token_invalid: 'sign-in expired — reconnect the account.',
      scope_not_authorized: 'the account didn’t allow posting — reconnect and tick every permission.',
    };
    throw new PublishError(`${what}: ${friendly[code] ?? j.error?.message ?? `HTTP ${r.status}`}`, r.status === 401 || code === 'access_token_invalid' ? 401 : r.status);
  }
  return (j.data ?? {}) as T;
}

export async function tiktokUser(http: Http, t: Tokens): Promise<{ openId: string; name: string; handle: string; avatar?: string }> {
  const r = await http({ method: 'GET', url: qs(`${API}/v2/user/info/`, { fields: 'open_id,display_name,avatar_url,username' }), headers: { Authorization: `Bearer ${t.accessToken}` } });
  const u = tt<{ user?: { open_id: string; display_name: string; avatar_url?: string; username?: string } }>(r, 'TikTok').user;
  if (!u) throw new PublishError('TikTok didn’t return the account.');
  return { openId: u.open_id, name: u.display_name, handle: u.username ?? '', avatar: u.avatar_url };
}

export interface CreatorInfo { privacyOptions: TikTokPrivacy[]; commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean; maxSeconds: number }

export async function tiktokCreatorInfo(http: Http, t: Tokens): Promise<CreatorInfo> {
  const d = tt<{ privacy_level_options?: TikTokPrivacy[]; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean; max_video_post_duration_sec?: number }>(
    await http({ method: 'POST', url: `${API}/v2/post/publish/creator_info/query/`, headers: { Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: '{}' }), 'TikTok');
  return { privacyOptions: d.privacy_level_options ?? ['SELF_ONLY'], commentDisabled: !!d.comment_disabled, duetDisabled: !!d.duet_disabled, stitchDisabled: !!d.stitch_disabled, maxSeconds: d.max_video_post_duration_sec ?? 600 };
}

/** TikTok's chunk rules: 5–64 MB chunks, the last one takes the remainder; under 5 MB goes in one piece. */
export function tiktokChunks(size: number, preferred = 10 * MB): { chunkSize: number; count: number; ranges: [number, number][] } {
  if (size < 5 * MB) return { chunkSize: size, count: 1, ranges: [[0, size]] };
  const chunkSize = Math.min(64 * MB, Math.max(5 * MB, preferred));
  const count = Math.max(1, Math.floor(size / chunkSize));
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) ranges.push([i * chunkSize, i === count - 1 ? size : (i + 1) * chunkSize]);
  return { chunkSize, count, ranges };
}

export interface TikTokPost { caption: string; privacy: TikTokPrivacy; allowComments: boolean; allowDuet: boolean; allowStitch: boolean; asDraft: boolean; coverAt: number }

export async function tiktokPublish(http: Http, t: Tokens, video: VideoSource, p: TikTokPost, onProgress: Progress = () => undefined,
  opts: { pollMs?: number; maxWaitMs?: number } = {}): Promise<{ id: string; url?: string; note?: string; drafted: boolean }> {
  const auth = { Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' };
  const { chunkSize, count, ranges } = tiktokChunks(video.size);
  const source_info = { source: 'FILE_UPLOAD', video_size: video.size, chunk_size: chunkSize, total_chunk_count: count };
  let note: string | undefined;
  let body: unknown;
  let url: string;
  if (p.asDraft) {
    url = `${API}/v2/post/publish/inbox/video/init/`;
    body = { source_info };
  } else {
    // Only privacy levels TikTok offers this account are allowed (unaudited apps: "Only me").
    const info = await tiktokCreatorInfo(http, t);
    let privacy = p.privacy;
    if (!info.privacyOptions.includes(privacy)) {
      privacy = info.privacyOptions.includes('SELF_ONLY') ? 'SELF_ONLY' : info.privacyOptions[0];
      note = privacy === 'SELF_ONLY'
        ? 'Posted as “Only me”: TikTok only allows that until your TikTok app passes its audit. Change it to public in the TikTok app.'
        : `Posted as ${privacy.toLowerCase().replace(/_/g, ' ')} (the only option TikTok allowed).`;
    }
    url = `${API}/v2/post/publish/video/init/`;
    body = {
      post_info: {
        title: p.caption, privacy_level: privacy,
        disable_comment: !p.allowComments || info.commentDisabled, disable_duet: !p.allowDuet || info.duetDisabled, disable_stitch: !p.allowStitch || info.stitchDisabled,
        video_cover_timestamp_ms: Math.round(p.coverAt * 1000),
      },
      source_info,
    };
  }
  onProgress(0, 'Starting upload');
  const init = tt<{ publish_id?: string; upload_url?: string }>(await http({ method: 'POST', url, headers: auth, body: JSON.stringify(body) }), 'TikTok');
  if (!init.publish_id || !init.upload_url) throw new PublishError('TikTok didn’t give an upload address.');
  for (const [a, b] of ranges) {
    const bytes = await video.read(a, b - a);
    const r = await http({ method: 'PUT', url: init.upload_url, headers: { 'Content-Type': video.mime || 'video/mp4', 'Content-Range': `bytes ${a}-${b - 1}/${video.size}` }, body: bytes });
    if (r.status !== 201 && r.status !== 206 && r.status !== 200) check(r, 'TikTok upload');
    onProgress((b / video.size) * 0.8, 'Uploading');
  }
  // Wait for TikTok to finish.
  const pollMs = opts.pollMs ?? 4000, maxWait = opts.maxWaitMs ?? 10 * 60_000, started = Date.now();
  for (;;) {
    const s = tt<{ status?: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>(
      await http({ method: 'POST', url: `${API}/v2/post/publish/status/fetch/`, headers: auth, body: JSON.stringify({ publish_id: init.publish_id }) }), 'TikTok');
    if (s.status === 'PUBLISH_COMPLETE') {
      onProgress(1, 'Posted');
      const id = s.publicaly_available_post_id?.[0];
      return { id: String(id ?? init.publish_id), url: id ? `https://www.tiktok.com/video/${id}` : undefined, note, drafted: false };
    }
    if (s.status === 'SEND_TO_USER_INBOX') {
      onProgress(1, 'In your TikTok drafts');
      return { id: init.publish_id, drafted: true, note: 'Sent to your TikTok inbox — open TikTok, tap the notification, paste the caption (it’s copied) and post.' };
    }
    if (s.status === 'FAILED') throw new PublishError(`TikTok couldn’t post it${s.fail_reason ? `: ${s.fail_reason.replace(/_/g, ' ')}` : ''}.`);
    if (Date.now() - started > maxWait) throw new PublishError('TikTok is taking too long — check the TikTok app.', 0, true);
    onProgress(0.8 + Math.min(0.19, ((Date.now() - started) / maxWait) * 0.19), 'TikTok is processing the video');
    await sleep(pollMs);
  }
}
