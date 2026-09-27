/**
 * Fonts are bundled with the app (SIL Open Font License, via @fontsource) so
 * text renders identically offline and no request ever leaves the device.
 */
import '@fontsource/archivo-black/latin-400.css';
import '@fontsource/figtree/latin-300.css';
import '@fontsource/figtree/latin-400.css';
import '@fontsource/figtree/latin-600.css';
import '@fontsource/figtree/latin-700.css';
import '@fontsource/figtree/latin-800.css';
import '@fontsource/bangers/latin-400.css';
import '@fontsource/monoton/latin-400.css';
import '@fontsource/permanent-marker/latin-400.css';
import '@fontsource/dm-serif-display/latin-400.css';
import '@fontsource/dm-serif-display/latin-400-italic.css';
import '@fontsource/anton/latin-400.css';
import '@fontsource/bebas-neue/latin-400.css';
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-700.css';
import '@fontsource/poppins/latin-800.css';
import '@fontsource/montserrat/latin-400.css';
import '@fontsource/montserrat/latin-700.css';
import '@fontsource/montserrat/latin-900.css';
import '@fontsource/oswald/latin-400.css';
import '@fontsource/oswald/latin-700.css';
import '@fontsource/lobster/latin-400.css';
import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/rubik-mono-one/latin-400.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';

const uploaded = new Set<string>();

/** Register a user-supplied font file (TTF/OTF/WOFF/WOFF2) for use in text clips. */
export async function registerFontFile(file: File, persist = true): Promise<string> {
  const family = file.name.replace(/\.(ttf|otf|woff2?|)$/i, '').replace(/[^\w\s-]/g, ' ').trim() || 'Custom font';
  const face = new FontFace(family, await file.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  uploaded.add(family);
  // Keep it for next time (fonts you upload used to vanish on reload).
  if (persist) void import('../storage/kv').then(({ kv }) => kv.set(`font/${family}`, { family, name: file.name, blob: file }));
  return family;
}

/** Re-register fonts uploaded in earlier sessions. Called once at start-up. */
export async function restoreUploadedFonts(): Promise<void> {
  const { kv } = await import('../storage/kv');
  const list = await kv.list<{ family: string; name: string; blob: Blob }>('font/');
  await Promise.all(list.map(async (f) => {
    try { await registerFontFile(new File([f.blob], f.name), false); } catch { /* damaged font: skip */ }
  }));
}

export function uploadedFonts(): string[] {
  return [...uploaded];
}

/** Make sure a font is ready before drawing it to a canvas. */
export async function ensureFont(family: string, weight = 400, italic = false): Promise<void> {
  try {
    await document.fonts.load(`${italic ? 'italic ' : ''}${weight} 32px "${family}"`);
  } catch {
    /* fall back to system font */
  }
}
