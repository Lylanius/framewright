/**
 * Framewright's own sticker pack: original vector designs (no brand logos,
 * characters or anyone else's artwork). Each is an SVG string; adding one
 * imports it as an image, so it scales crisply and works everywhere.
 */
export interface StickerDef { id: string; name: string; tags: string; svg: string }

const FONT = `font-family="'Arial Black','Arial Bold',Impact,'Helvetica Neue',sans-serif" font-weight="900"`;

function burstPath(cx: number, cy: number, r1: number, r2: number, n: number): string {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 ? r2 : r1;
    d += `${i ? 'L' : 'M'}${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`;
  }
  return d + 'Z';
}

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

const pill = (text: string, bg: string, fg: string, w = 620, extra = '') => svg(w, 170,
  `<rect x="10" y="14" width="${w - 20}" height="142" rx="71" fill="#000" opacity=".25"/><rect x="6" y="6" width="${w - 20}" height="142" rx="71" fill="${bg}" stroke="#111" stroke-width="8"/>${extra}` +
  `<text x="${(w - 8) / 2}" y="98" text-anchor="middle" font-size="64" ${FONT} fill="${fg}" letter-spacing="2">${text}</text>`);

const burstWord = (text: string, fill: string, ink: string, size = 150) => svg(560, 560,
  `<path d="${burstPath(284, 290, 262, 190, 16)}" fill="#111"/><path d="${burstPath(280, 280, 262, 190, 16)}" fill="${fill}" stroke="#111" stroke-width="10" stroke-linejoin="round"/>` +
  `<text x="280" y="${280 + size * 0.36}" text-anchor="middle" font-size="${size}" ${FONT} fill="${ink}" stroke="#111" stroke-width="10" paint-order="stroke" transform="rotate(-8 280 280)">${text}</text>`);

const bubble = (text: string, fill: string, ink: string) => svg(620, 440,
  `<path d="M60 40 H560 Q600 40 600 80 V280 Q600 320 560 320 H230 L120 420 L150 320 H60 Q20 320 20 280 V80 Q20 40 60 40Z" fill="${fill}" stroke="#111" stroke-width="12" stroke-linejoin="round"/>` +
  `<text x="310" y="222" text-anchor="middle" font-size="130" ${FONT} fill="${ink}">${text}</text>`);

const tag = (text: string, bg: string) => svg(560, 200,
  `<path d="M20 30 H470 L540 100 L470 170 H20 Z" fill="${bg}" stroke="#111" stroke-width="10" stroke-linejoin="round"/><circle cx="78" cy="100" r="18" fill="#111"/>` +
  `<text x="290" y="128" text-anchor="middle" font-size="84" ${FONT} fill="#fff" stroke="#111" stroke-width="8" paint-order="stroke">${text}</text>`);

const sparkle = (x: number, y: number, r: number, c: string) =>
  `<path d="M${x} ${y - r} Q${x + r * 0.16} ${y - r * 0.16} ${x + r} ${y} Q${x + r * 0.16} ${y + r * 0.16} ${x} ${y + r} Q${x - r * 0.16} ${y + r * 0.16} ${x - r} ${y} Q${x - r * 0.16} ${y - r * 0.16} ${x} ${y - r}Z" fill="${c}"/>`;

export const STICKERS: StickerDef[] = [
  { id: 'wow', name: 'WOW!', tags: 'reaction hype', svg: burstWord('WOW!', '#ffd23f', '#ff3b5c') },
  { id: 'omg', name: 'OMG', tags: 'reaction bubble', svg: bubble('OMG', '#ffffff', '#ff3b5c') },
  { id: 'lol', name: 'LOL', tags: 'reaction bubble funny', svg: bubble('LOL', '#8ef0b4', '#111111') },
  { id: 'new', name: 'NEW', tags: 'badge', svg: burstWord('NEW', '#ff3b5c', '#ffffff', 170) },
  {
    id: 'rare', name: 'RARE PULL!', tags: 'cards pack opening gaming', svg: svg(700, 260,
      `<defs><linearGradient id="h" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#ff7ad9"/><stop offset=".33" stop-color="#7ae7ff"/><stop offset=".66" stop-color="#b8ff7a"/><stop offset="1" stop-color="#ffd86b"/></linearGradient></defs>` +
      `<rect x="16" y="22" width="668" height="220" rx="36" fill="#111"/><rect x="8" y="10" width="668" height="220" rx="36" fill="url(#h)" stroke="#111" stroke-width="10"/>` +
      sparkle(70, 60, 30, '#fff') + sparkle(630, 190, 24, '#fff') +
      `<text x="342" y="158" text-anchor="middle" font-size="96" ${FONT} fill="#fff" stroke="#111" stroke-width="12" paint-order="stroke">RARE PULL!</text>`),
  },
  { id: 'gg', name: 'GG', tags: 'gaming win', svg: svg(420, 300, `<rect x="16" y="22" width="388" height="264" rx="28" fill="#111"/><rect x="8" y="10" width="388" height="264" rx="28" fill="#5b8cff" stroke="#111" stroke-width="10"/><text x="202" y="196" text-anchor="middle" font-size="170" ${FONT} fill="#fff" stroke="#111" stroke-width="12" paint-order="stroke">GG</text>`) },
  {
    id: 'epic', name: 'EPIC', tags: 'gaming banner', svg: svg(700, 240,
      `<path d="M10 70 L90 40 L90 200 L10 170 L50 120Z M690 70 L610 40 L610 200 L690 170 L650 120Z" fill="#b8321f" stroke="#111" stroke-width="8" stroke-linejoin="round"/>` +
      `<rect x="80" y="30" width="540" height="160" rx="14" fill="#ff5a36" stroke="#111" stroke-width="10"/><text x="350" y="148" text-anchor="middle" font-size="110" ${FONT} fill="#fff4d6" stroke="#111" stroke-width="10" paint-order="stroke" letter-spacing="8">EPIC</text>`),
  },
  { id: 'ten', name: '10/10', tags: 'rating review', svg: svg(420, 420, `<circle cx="214" cy="218" r="192" fill="#111"/><circle cx="210" cy="210" r="192" fill="#4fc58d" stroke="#111" stroke-width="10"/><circle cx="210" cy="210" r="160" fill="none" stroke="#fff" stroke-width="6" stroke-dasharray="10 12"/><text x="210" y="250" text-anchor="middle" font-size="112" ${FONT} fill="#fff" stroke="#111" stroke-width="10" paint-order="stroke">10/10</text>`) },
  { id: 'follow', name: 'FOLLOW FOR MORE', tags: 'cta social', svg: pill('FOLLOW FOR MORE', '#ff3b5c', '#fff', 760) },
  { id: 'part2', name: 'PART 2', tags: 'series cta', svg: pill('PART 2 ➜', '#ffd23f', '#111', 480) },
  { id: 'bio', name: 'LINK IN BIO', tags: 'cta social', svg: pill('LINK IN BIO', '#ffffff', '#111', 600) },
  { id: 'live', name: 'LIVE', tags: 'badge stream', svg: pill('LIVE', '#e5242b', '#fff', 360, '<circle cx="70" cy="77" r="20" fill="#fff"/>') },
  { id: 'before', name: 'BEFORE', tags: 'comparison reveal makeover', svg: tag('BEFORE', '#6b7280') },
  { id: 'after', name: 'AFTER', tags: 'comparison reveal makeover', svg: tag('AFTER', '#22a06b') },
  { id: 'sale', name: 'SALE', tags: 'shop offer', svg: tag('SALE', '#e5242b') },
  { id: 'sparkles', name: 'Sparkles', tags: 'shine magic', svg: svg(420, 420, sparkle(160, 170, 120, '#ffe27a') + sparkle(320, 110, 60, '#fff') + sparkle(310, 310, 46, '#ffe27a')) },
  {
    id: 'circle', name: 'Circle it', tags: 'highlight scribble', svg: svg(600, 420,
      `<path d="M300 40 C470 34 572 110 566 208 C560 318 430 386 290 382 C140 378 36 312 38 206 C40 110 150 52 280 44 C380 38 470 60 520 96" fill="none" stroke="#ff3b30" stroke-width="16" stroke-linecap="round"/>`),
  },
  {
    id: 'arrowdraw', name: 'Look here', tags: 'arrow scribble pointer', svg: svg(520, 360,
      `<path d="M40 300 C120 180 260 110 430 90" fill="none" stroke="#ffd23f" stroke-width="18" stroke-linecap="round"/><path d="M360 40 L450 88 L380 160" fill="none" stroke="#ffd23f" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>`),
  },
  { id: 'subscribe', name: 'SUBSCRIBE', tags: 'cta youtube', svg: pill('SUBSCRIBE', '#e5242b', '#fff', 560) },
  { id: 'wait', name: 'WAIT FOR IT…', tags: 'hook tease', svg: bubble('WAIT…', '#ffd23f', '#111') },
];

export const EMOJI = ['🔥', '😂', '😱', '🤯', '😍', '👀', '💯', '🎉', '✨', '⭐', '❤️', '👍', '👏', '🙌', '💥', '⚡', '🏆', '🎮', '🃏', '💎', '🤑', '😎', '🥶', '😭', '🤔', '😤', '🚀', '📦', '🎁', '✅', '❌', '⬇️', '➡️', '👉', '🎯', '🍀'];

export function stickerFile(def: StickerDef): File {
  return new File([def.svg], `Sticker - ${def.name.replace(/[^\w ]+/g, '').trim() || def.id}.svg`, { type: 'image/svg+xml' });
}
