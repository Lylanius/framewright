/** Short, collision-resistant ids. Uses crypto when available. */
export function uid(prefix = ''): string {
  const c = globalThis.crypto;
  let s: string;
  if (c && 'randomUUID' in c) s = c.randomUUID().replace(/-/g, '').slice(0, 12);
  else s = Math.random().toString(36).slice(2, 14);
  return prefix ? `${prefix}_${s}` : s;
}
