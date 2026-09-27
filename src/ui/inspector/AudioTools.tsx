import { useState } from 'react';
import { mergeRanges, type Range } from '../../core/analysis';
import { activityRanges, AUDIO_EFFECTS, createAudioEffect, duckingKeys, gainToDb, getAudioFxDef, normaliseGain } from '../../core/audioFx';
import { PEAKS_PER_SECOND } from '../../engine/media';
import { updateClip } from '../../core/timeline';
import type { AudioEffect, AudioEffectType, Clip, Project } from '../../core/types';
import { PropRow, Section } from '../components/Controls';
import { Icon } from '../components/Icon';
import { keyframeState, patchClip, propValue, setProp, toggleKeyframe } from '../propEdit';
import { useApp } from '../store';

function AudioFxCard({ clip, fx, index }: { clip: Clip; fx: AudioEffect; index: number }) {
  const def = getAudioFxDef(fx.type);
  if (!def) return null;
  const update = (fn: (e: AudioEffect) => AudioEffect, label: string) =>
    patchClip(clip.id, (c) => ({ ...c, audioFx: (c.audioFx ?? []).map((e) => (e.id === fx.id ? fn(e) : e)) }), label);
  const move = (dir: -1 | 1) => patchClip(clip.id, (c) => {
    const list = (c.audioFx ?? []).slice();
    const j = index + dir;
    if (j < 0 || j >= list.length) return c;
    [list[index], list[j]] = [list[j], list[index]];
    return { ...c, audioFx: list };
  }, 'Reorder audio effects');
  return (
    <div className={`fx-card${fx.enabled ? '' : ' off'}`} data-afx={fx.type}>
      <header>
        <input type="checkbox" checked={fx.enabled} onChange={() => update((e) => ({ ...e, enabled: !e.enabled }), 'Toggle audio effect')} aria-label={`Enable ${def.name}`} />
        <span title={def.description}>{def.name}</span>
        <button className="icon-btn sm" onClick={() => move(-1)} aria-label="Move up"><Icon name="back" size={13} style={{ transform: 'rotate(90deg)' }} /></button>
        <button className="icon-btn sm" onClick={() => move(1)} aria-label="Move down"><Icon name="back" size={13} style={{ transform: 'rotate(-90deg)' }} /></button>
        <button className="icon-btn sm" onClick={() => patchClip(clip.id, (c) => ({ ...c, audioFx: (c.audioFx ?? []).filter((e) => e.id !== fx.id) }), 'Remove audio effect')} aria-label={`Remove ${def.name}`}><Icon name="trash" size={13} /></button>
      </header>
      {def.params.map((p) => {
        const path = `afx.${fx.id}.${p.key}`;
        return (
          <PropRow key={p.key} label={p.label} value={propValue(clip, path)} min={p.min} max={p.max} step={p.step} unit={p.unit}
            onChange={(v) => setProp(clip.id, path, v, def.name)} keyframe={{ ...keyframeState(clip, path), toggle: () => toggleKeyframe(clip.id, path) }} />
        );
      })}
    </div>
  );
}

export function AudioEffectsSection({ clip }: { clip: Clip }) {
  const [adding, setAdding] = useState(false);
  const player = useApp((s) => s.player);
  const list = clip.audioFx ?? [];
  const blocked = player?.workletsFailed && list.some((f) => f.enabled && (f.type === 'gate' || f.type === 'pitch'));
  const add = (type: AudioEffectType) => {
    patchClip(clip.id, (c) => ({ ...c, audioFx: [...(c.audioFx ?? []), createAudioEffect(type)] }), 'Add audio effect');
    setAdding(false);
  };
  return (
    <Section title="Sound effects" right={<button className="btn sm" onClick={() => setAdding(!adding)} aria-expanded={adding}><Icon name="plus" size={13} />Add</button>}>
      {adding && (
        <div className="afx-grid">
          {AUDIO_EFFECTS.map((d) => (
            <button key={d.type} className="afx-pick" onClick={() => add(d.type)} title={d.description}>
              <b>{d.name}</b><small>{d.description}</small>
            </button>
          ))}
        </div>
      )}
      {list.length === 0 && !adding && <small className="faint">Clean up a voice (Noise reduction, Voice enhance), shape the tone (EQ), or add Reverb, Echo, Pan or Pitch. Effects run in order, top to bottom.</small>}
      {blocked && <small style={{ color: 'var(--danger)' }}>This browser blocks the audio add-ons that Noise reduction and Pitch need, so those two are skipped here. The installed app runs them.</small>}
      {list.map((fx, i) => <AudioFxCard key={fx.id} clip={clip} fx={fx} index={i} />)}
    </Section>
  );
}

/** Timeline ranges where other clips (voices, video sound) are audibly active. */
function foregroundRanges(p: Project, music: Clip): Range[] {
  const out: Range[] = [];
  for (const t of p.tracks) {
    if (t.muted) continue;
    for (const c of t.clips) {
      if (c.id === music.id || c.muted || (c.kind !== 'video' && c.kind !== 'audio') || !c.mediaId) continue;
      if (c.kind === 'audio' && t.clips.includes(music)) continue;
      if (c.start >= music.start + music.duration || c.start + c.duration <= music.start) continue;
      const m = p.media.find((x) => x.id === c.mediaId);
      if (!m?.loudness?.length) continue;
      out.push(...activityRanges(m.loudness, m.peaksPerSecond ?? PEAKS_PER_SECOND, c, -38));
    }
  }
  return mergeRanges(out, 0.3);
}

export function LevelTools({ clip }: { clip: Clip }) {
  const project = useApp((s) => s.project)!;
  const { apply, toast } = useApp();
  const [duck, setDuck] = useState(12);
  const media = project.media.find((m) => m.id === clip.mediaId);
  const normalise = () => {
    if (!media?.loudness?.length) { toast('Still measuring this clip’s loudness — try again in a moment.'); return; }
    const pps = media.peaksPerSecond ?? PEAKS_PER_SECOND;
    const from = Math.floor(clip.sourceIn * pps), to = Math.ceil((clip.sourceIn + clip.duration * clip.speed) * pps);
    const g = normaliseGain(media.loudness.slice(from, to));
    apply('Normalise', (p) => updateClip(p, clip.id, (c) => {
      const kf = { ...c.keyframes };
      delete kf.volume;
      return { ...c, volume: +g.toFixed(3), keyframes: kf };
    }));
    toast(`Volume set to ${Math.round(g * 100)}% (${gainToDb(g) >= 0 ? '+' : ''}${gainToDb(g).toFixed(1)} dB).`, 'success');
  };
  const autoDuck = () => {
    const ranges = foregroundRanges(project, clip);
    if (!ranges.length) { toast('No other sound found under this clip to duck for (or loudness still measuring).'); return; }
    apply('Auto-duck', (p) => updateClip(p, clip.id, (c) => ({ ...c, keyframes: { ...c.keyframes, volume: duckingKeys(c, ranges, -duck) } })));
    toast(`Ducked under ${ranges.length} stretch${ranges.length === 1 ? '' : 'es'} of speech.`, 'success');
  };
  return (
    <Section title="Levels">
      <div className="row">
        <button className="btn sm" onClick={normalise} title="Bring this clip to a standard loudness"><Icon name="volume" size={13} />Normalise</button>
        {clip.kind === 'audio' && <button className="btn sm" onClick={autoDuck} title="Lower this clip whenever someone speaks"><Icon name="ai" size={13} />Auto-duck</button>}
      </div>
      {clip.kind === 'audio' && (
        <PropRow label="Duck by" value={duck} min={3} max={30} step={1} unit="dB" onChange={setDuck} />
      )}
      {clip.kind === 'audio' && <small className="faint">Auto-duck writes volume keyframes on this clip (you can tweak them), dipping it whenever other clips have speech.</small>}
    </Section>
  );
}
