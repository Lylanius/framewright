/**
 * Network plumbing for the publishers. Requests go through an injected
 * `Http` function: in the desktop app it's the app itself (no browser
 * cross-site limits); tests use a fake platform server.
 */
export interface HttpReq { method: 'GET' | 'POST' | 'PUT'; url: string; headers?: Record<string, string>; body?: string | Uint8Array | null }
export interface HttpRes { status: number; headers: Record<string, string>; text: string }
export type Http = (r: HttpReq) => Promise<HttpRes>;

/** Where the video bytes come from (a Blob in the page, a file on desktop). */
export interface VideoSource { size: number; mime: string; name: string; read(offset: number, length: number): Promise<Uint8Array> }

export function blobSource(b: Blob, name: string): VideoSource {
  return { size: b.size, mime: b.type || 'video/mp4', name, read: async (o, n) => new Uint8Array(await b.slice(o, o + n).arrayBuffer()) };
}

export interface Tokens { accessToken: string; refreshToken?: string; expiresAt?: number; refreshExpiresAt?: number }
/** Your own developer app on the platform (YouTube / TikTok). */
export interface PlatformApp { clientId: string; clientSecret: string }

export class PublishError extends Error {
  constructor(message: string, readonly status = 0, readonly retry = false) { super(message); }
}

export function form(o: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

export function qs(url: string, o: Record<string, string | number | boolean | undefined>): string {
  const q = form(o);
  return q ? `${url}${url.includes('?') ? '&' : '?'}${q}` : url;
}

export function parse<T = Record<string, unknown>>(r: HttpRes): T {
  try { return (r.text ? JSON.parse(r.text) : {}) as T; } catch { return {} as T; }
}

export function header(r: HttpRes, name: string): string | undefined {
  const k = Object.keys(r.headers).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? r.headers[k] : undefined;
}

/** Throws a readable error for a failed response. */
export function check(r: HttpRes, what: string): HttpRes {
  if (r.status >= 200 && r.status < 300) return r;
  const j = parse<{ error?: { message?: string; code?: string | number; error_user_msg?: string } | string; error_description?: string; message?: string }>(r);
  const e = typeof j.error === 'object' ? (j.error.error_user_msg || j.error.message || String(j.error.code ?? '')) : (j.error_description || j.error || j.message);
  const msg = e ? String(e) : `HTTP ${r.status}`;
  if (r.status === 401) throw new PublishError(`${what}: sign-in expired or was revoked — reconnect the account. (${msg})`, 401);
  throw new PublishError(`${what}: ${msg}`, r.status, r.status === 429 || r.status >= 500);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* PKCE (sign-in without exposing a password or needing a server). */
function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(n = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const r = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(r, (x) => chars[x % chars.length]).join('');
}

export async function pkce(encoding: 'base64url' | 'hex'): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(64);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = encoding === 'hex' ? Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('') : b64url(hash);
  return { verifier, challenge };
}

export type Progress = (fraction: number, note?: string) => void;
