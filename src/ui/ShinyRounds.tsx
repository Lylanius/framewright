/**
 * Rounds for the "Spot the real shiny" quiz: you add the normal picture and the
 * real shiny; the app makes two decoy colourings and shuffles the four into A–D.
 */
import { useRef } from 'react';
import { Icon } from './components/Icon';
import { makeFakes } from './shinyFakes';

/** Sources, always in this order: normal, real shiny, decoy 1, decoy 2. */
export const SHINY_SOURCES = ['Normal', 'Real shiny', 'Decoy 1', 'Decoy 2'] as const;
export interface ShinyDraft {
  id: number;
  files: (File | null)[]; // by source
  urls: (string | null)[];
  /** order[slot] = which source is shown in slot A, B, C, D. */
  order: number[];
  /** Decoys you picked yourself (kept when the other pictures change). */
  own: boolean[];
  busy?: boolean;
}
let seq = 1;
export function shuffled(): number[] {
  const a = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export const blankShiny = (): ShinyDraft => ({ id: seq++, files: [null, null, null, null], urls: [null, null, null, null], order: shuffled(), own: [false, false, false, false] });
export const shinyReady = (r: ShinyDraft) => r.files.every(Boolean) && !r.busy;
export const shinyCorrect = (r: ShinyDraft) => r.order.indexOf(1);

export function ShinyRounds({ rounds, setRounds, firstRound, onActive, activeId, onError }: {
  rounds: ShinyDraft[];
  setRounds: (fn: (rs: ShinyDraft[]) => ShinyDraft[]) => void;
  firstRound: number;
  onActive: (id: number) => void;
  activeId: number;
  onError: (msg: string) => void;
}) {
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const patch = (id: number, fn: (r: ShinyDraft) => ShinyDraft) => setRounds((rs) => rs.map((r) => (r.id === id ? fn(r) : r)));
  const setFile = (r: ShinyDraft, src: number, f: File, own = src >= 2) => patch(r.id, (x) => {
    if (x.urls[src]) URL.revokeObjectURL(x.urls[src]!);
    return { ...x, files: x.files.map((v, i) => (i === src ? f : v)), urls: x.urls.map((v, i) => (i === src ? URL.createObjectURL(f) : v)), own: x.own.map((v, i) => (i === src ? own : v)) };
  });

  const pick = async (r: ShinyDraft, src: number, f: File) => {
    onActive(r.id);
    setFile(r, src, f);
    if (src >= 2) return;
    // Once both real pictures are in, make the decoys (unless you chose your own).
    const normal = src === 0 ? f : r.files[0], shiny = src === 1 ? f : r.files[1];
    if (!normal || !shiny || (r.own[2] && r.own[3])) return;
    patch(r.id, (x) => ({ ...x, busy: true }));
    try {
      const fakes = await makeFakes(normal, shiny);
      fakes.forEach((fk, i) => { if (!r.own[2 + i]) setFile(r, 2 + i, fk, false); });
    } catch (e) { onError((e as Error).message); } finally { patch(r.id, (x) => ({ ...x, busy: false })); }
  };

  return (
    <div className="quiz-rounds">
      {rounds.map((r, i) => (
        <div key={r.id} className={`quiz-round shiny-round${r.id === activeId && rounds.length > 1 ? ' previewing' : ''}`} onFocus={() => onActive(r.id)}>
          <div className="row"><b className="grow">Round {firstRound + i}</b>
            {r.files[1] && <span className="shiny-answer">Real shiny is <b>{'ABCD'[shinyCorrect(r)]}</b></span>}
            <button className="btn sm ghost" onClick={() => { onActive(r.id); patch(r.id, (x) => ({ ...x, order: shuffled() })); }} aria-label={`Shuffle round ${i + 1}`}>Shuffle</button>
            {rounds.length > 1 && <button className="icon-btn sm" onClick={() => setRounds((rs) => rs.filter((x) => x.id !== r.id))} aria-label={`Remove round ${i + 1}`}><Icon name="trash" size={13} /></button>}
          </div>
          <div className="shiny-slots">
            {SHINY_SOURCES.map((name, src) => (
              <div key={src} className="shiny-slot">
                <button className={`quiz-pic${src === 1 ? ' real' : ''}`} onClick={() => inputs.current.get(`${r.id}-${src}`)?.click()} aria-label={`${name} picture for round ${i + 1}`}>
                  {r.urls[src] ? <img src={r.urls[src]!} alt="" /> : src < 2 ? <><Icon name="image" size={20} /><small>Add</small></> : <small>{r.busy ? 'Making…' : 'Made for you'}</small>}
                  {r.urls[src] && <span className="shiny-letter">{'ABCD'[r.order.indexOf(src)]}</span>}
                </button>
                <small className={src === 1 ? 'shiny-name real' : 'shiny-name'}>{name}</small>
                <input ref={(el) => { if (el) inputs.current.set(`${r.id}-${src}`, el); }} type="file" accept="image/*" hidden aria-label={`Round ${i + 1} ${name.toLowerCase()} file`}
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(r, src, f); }} />
              </div>
            ))}
          </div>
          <small className="faint">Add the normal one and the real shiny — two decoy colours are made for you (tap a decoy to use your own picture instead). The letters are shuffled; tap Shuffle for a different order.</small>
        </div>
      ))}
      <button className="btn" onClick={() => setRounds((rs) => [...rs, blankShiny()])}><Icon name="plus" size={14} />Add a round</button>
    </div>
  );
}
