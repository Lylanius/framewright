import { useEffect, useRef, useState } from 'react';
import { newBrandKit, type BrandKit, type Corner } from '../../core/brand';
import { BUILTIN_FONTS } from '../../core/defaults';
import { registerFontFile, uploadedFonts } from '../../styles/fonts';
import { PropRow, Seg } from '../components/Controls';
import { Icon } from '../components/Icon';
import { addKitBookend, addKitLogo, applyKit, assetFromFile, brandKits, deleteBrandKit, registerKitFonts, saveBrandKit } from '../library';
import { useApp } from '../store';

export const BRAND_EVENT = 'fw-brand-changed';

/** Colours from every brand kit (for the swatch rows in the inspector). */
export function useBrandColors(): string[] {
  const [cols, setCols] = useState<string[]>([]);
  useEffect(() => {
    const load = () => void brandKits().then((ks) => setCols([...new Set(ks.flatMap((k) => k.colors))].slice(0, 12)));
    load();
    window.addEventListener(BRAND_EVENT, load);
    return () => window.removeEventListener(BRAND_EVENT, load);
  }, []);
  return cols;
}

function AssetRow({ label, name, accept, onPick, onClear }: { label: string; name?: string; accept: string; onPick: (f: File) => void; onClear: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="row">
      <span className="grow" style={{ fontSize: 13 }}>{label}: <span className="faint">{name ?? 'none'}</span></span>
      <button className="btn sm" onClick={() => ref.current?.click()}>{name ? 'Change' : 'Add'}</button>
      {name && <button className="icon-btn sm" onClick={onClear} aria-label={`Remove ${label}`}><Icon name="close" size={13} /></button>}
      <input ref={ref} type="file" accept={accept} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
    </div>
  );
}

function KitEditor({ kit, onChange, onDelete }: { kit: BrandKit; onChange: (k: BrandKit) => void; onDelete: () => void }) {
  const project = useApp((s) => s.project);
  const toast = useApp((s) => s.toast);
  const fontRef = useRef<HTMLInputElement>(null);
  const [opts, setOpts] = useState<{ fonts: boolean; title: number | null; captions: boolean; shapes: boolean }>({ fonts: true, title: 0, captions: true, shapes: true });
  const titleColour = opts.title !== null ? kit.colors[opts.title] ?? null : null;
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!kit.logo) { setLogoUrl(null); return; }
    const u = URL.createObjectURL(kit.logo.blob);
    setLogoUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [kit.logo]);
  const fonts = [...new Set([...BUILTIN_FONTS, ...uploadedFonts()])];
  const set = (patch: Partial<BrandKit>) => onChange({ ...kit, ...patch });

  return (
    <div className="brand-editor">
      <div className="row">
        <input className="input grow" value={kit.name} onChange={(e) => set({ name: e.target.value })} aria-label="Brand kit name" />
        <button className="icon-btn sm" onClick={onDelete} aria-label="Delete brand kit" title="Delete this kit"><Icon name="trash" size={14} /></button>
      </div>

      <div className="label">Colours</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {kit.colors.map((c, i) => (
          <span key={i} className="brand-swatch">
            <input type="color" className="swatch" value={c} aria-label={`Brand colour ${i + 1}`} onChange={(e) => { const cols = kit.colors.slice(); cols[i] = e.target.value; set({ colors: cols }); }} />
            <button className="x" onClick={() => set({ colors: kit.colors.filter((_, j) => j !== i) })} aria-label={`Remove colour ${i + 1}`}>×</button>
          </span>
        ))}
        {kit.colors.length < 8 && <button className="btn sm" onClick={() => set({ colors: [...kit.colors, '#ffffff'] })} aria-label="Add colour"><Icon name="plus" size={13} /></button>}
      </div>

      <div className="label">Fonts</div>
      <div className="grid2">
        <label className="field"><span>Titles</span>
          <select className="input" value={kit.headingFont} onChange={(e) => set({ headingFont: e.target.value })} style={{ fontFamily: `"${kit.headingFont}"` }} aria-label="Title font">
            {fonts.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="field"><span>Captions</span>
          <select className="input" value={kit.bodyFont} onChange={(e) => set({ bodyFont: e.target.value })} style={{ fontFamily: `"${kit.bodyFont}"` }} aria-label="Caption font">
            {fonts.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
      </div>
      <button className="btn sm" onClick={() => fontRef.current?.click()}><Icon name="upload" size={13} />Upload a brand font (.ttf, .otf, .woff)</button>
      {kit.fonts.length > 0 && <small className="faint">Kit fonts: {kit.fonts.map((f) => f.name).join(', ')}</small>}
      <input ref={fontRef} type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        try { const fam = await registerFontFile(f); set({ fonts: [...kit.fonts, assetFromFile(f)], headingFont: fam }); toast(`Added font “${fam}”.`, 'success'); }
        catch { toast(`${f.name} couldn’t be read as a font.`, 'error'); }
      }} />

      <div className="label">Logo</div>
      <AssetRow label="Logo image" name={kit.logo?.name} accept="image/png,image/svg+xml,image/webp,image/jpeg" onPick={(f) => set({ logo: assetFromFile(f) })} onClear={() => set({ logo: undefined })} />
      {logoUrl && <img src={logoUrl} alt="Logo preview" className="brand-logo" />}
      {kit.logo && <>
        <Seg label="Logo corner" value={kit.logoCorner} onChange={(logoCorner: Corner) => set({ logoCorner })}
          options={[{ value: 'tl', label: '↖ Top left' }, { value: 'tr', label: 'Top right ↗' }, { value: 'bl', label: '↙ Bottom left' }, { value: 'br', label: 'Bottom right ↘' }]} />
        <PropRow label="Size" value={kit.logoSize} min={0.05} max={0.5} step={0.01} display={100} unit="% width" onChange={(logoSize) => set({ logoSize })} />
        <PropRow label="Opacity" value={kit.logoOpacity} min={0.1} max={1} step={0.01} display={100} unit="%" onChange={(logoOpacity) => set({ logoOpacity })} />
      </>}

      <div className="label">Intro & outro</div>
      <AssetRow label="Intro clip" name={kit.intro?.name} accept="video/*,image/*" onPick={(f) => set({ intro: assetFromFile(f) })} onClear={() => set({ intro: undefined })} />
      <AssetRow label="Outro clip" name={kit.outro?.name} accept="video/*,image/*" onPick={(f) => set({ outro: assetFromFile(f) })} onClear={() => set({ outro: undefined })} />

      {project ? (
        <div className="ai-card">
          <h4><Icon name="brand" size={16} /><span>Use on this project</span></h4>
          <label className="row"><input type="checkbox" checked={opts.fonts} onChange={() => setOpts({ ...opts, fonts: !opts.fonts })} /> Brand fonts on titles and captions</label>
          <div className="row">
            <label className="row grow"><input type="checkbox" checked={opts.title !== null} onChange={() => setOpts({ ...opts, title: opts.title !== null ? null : 0 })} /> Title colour</label>
            {opts.title !== null && kit.colors.map((c, i) => <button key={i} className={`chip-swatch${opts.title === i ? ' on' : ''}`} style={{ background: c }} onClick={() => setOpts({ ...opts, title: i })} aria-label={`Title colour ${c}`} />)}
          </div>
          <label className="row"><input type="checkbox" checked={opts.captions} onChange={() => setOpts({ ...opts, captions: !opts.captions })} /> Captions (font + highlight colour)</label>
          <label className="row"><input type="checkbox" checked={opts.shapes} onChange={() => setOpts({ ...opts, shapes: !opts.shapes })} /> Shapes in brand colours</label>
          <button className="btn primary" onClick={async () => {
            const n = await applyKit(kit, { fonts: opts.fonts, titleColour, captions: opts.captions, shapes: opts.shapes });
            toast(n ? `Restyled ${n} item${n === 1 ? '' : 's'}.` : 'No titles, captions or shapes to restyle yet.', n ? 'success' : 'info');
          }}><Icon name="check" size={15} />Apply brand style</button>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm" disabled={!kit.logo} onClick={async () => { if (await addKitLogo(kit)) toast('Logo added for the whole video.', 'success'); }}>Add logo</button>
            <button className="btn sm" disabled={!kit.intro} onClick={async () => { if (await addKitBookend(kit, 'intro')) toast('Intro added at the start.', 'success'); }}>Add intro</button>
            <button className="btn sm" disabled={!kit.outro} onClick={async () => { if (await addKitBookend(kit, 'outro')) toast('Outro added at the end.', 'success'); }}>Add outro</button>
          </div>
        </div>
      ) : <small className="faint">Open a project to apply this kit.</small>}
    </div>
  );
}

export function BrandPanel() {
  const [kits, setKits] = useState<BrandKit[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const toast = useApp((s) => s.toast);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void brandKits().then((ks) => { setKits(ks); setActive(ks[0]?.id ?? null); ks.forEach((k) => void registerKitFonts(k)); });
  }, []);

  const update = (k: BrandKit) => {
    setKits((ks) => (ks ?? []).map((x) => (x.id === k.id ? k : x)));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveBrandKit(k).then(() => window.dispatchEvent(new Event(BRAND_EVENT))); }, 400);
  };
  const create = async () => {
    const k = newBrandKit(kits?.length ? `Brand ${kits.length + 1}` : 'My brand');
    await saveBrandKit(k);
    setKits([k, ...(kits ?? [])]);
    setActive(k.id);
    window.dispatchEvent(new Event(BRAND_EVENT));
  };
  if (!kits) return null;
  const kit = kits.find((k) => k.id === active);

  return (
    <>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>Keep your colours, fonts, logo and intro/outro in a kit, then style any video in one tap. Kits are saved on this device.</p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {kits.map((k) => (
          <button key={k.id} className={`chip${k.id === active ? ' on' : ''}`} onClick={() => setActive(k.id)}>
            <span className="kit-dots">{k.colors.slice(0, 3).map((c, i) => <i key={i} style={{ background: c }} />)}</span>{k.name}
          </button>
        ))}
        <button className="btn sm" onClick={() => void create()}><Icon name="plus" size={13} />New kit</button>
      </div>
      {kit ? (
        <KitEditor key={kit.id} kit={kit} onChange={update} onDelete={() => {
          if (!confirm) { setConfirm(true); toast('Tap delete again to remove this kit.'); return; }
          void deleteBrandKit(kit.id).then(() => { const rest = kits.filter((k) => k.id !== kit.id); setKits(rest); setActive(rest[0]?.id ?? null); setConfirm(false); window.dispatchEvent(new Event(BRAND_EVENT)); });
        }} />
      ) : (
        <div className="empty-note">No brand kit yet. <button className="btn sm primary" onClick={() => void create()}>Create one</button></div>
      )}
    </>
  );
}
