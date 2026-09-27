# Framewright

A private, offline-first video editor for short-form and long-form video. Every tool is unlocked: no account, no subscription, no watermark, no export limits, nothing uploaded.

All five phases are in: the editor, transitions and captions, pro colour/masking/audio, on-device AI tools, **desktop and phone apps**, and the performance work. It runs in a browser, as a desktop app (Windows, macOS, Linux) or as a phone app (iOS, Android) — see [docs/NATIVE.md](docs/NATIVE.md). See [ROADMAP.md](ROADMAP.md) for exactly what's done and what's next.

## Run it

Requires Node 20+.

```bash
npm install
npm run dev          # http://localhost:5173 (use --host to open it from your phone on the same Wi-Fi)
npm run build        # production build in dist/ (installable PWA, works offline once opened)
npm run build:single # one self-contained HTML file in dist-single/ (fonts and all)
npm test             # unit tests
npm run test:e2e     # end-to-end tests in Chromium (desktop + phone viewports)
npm run bench        # performance benchmarks (results in tests/perf/results/)

npm run desktop        # run the desktop app (Electron) from source
npm run desktop:linux  # build the Linux AppImage into release/ (also :win, :mac on those systems)
npm run mobile:sync    # copy the web build into the android/ and ios/ projects
xvfb-run -a node tests/desktop/smoke.mjs release/linux-unpacked/framewright   # desktop smoke test
```

**AI tools need the installed/standalone app** (not the embedded web view): auto-captions download a speech model once, and background removal / face finding load models bundled in `dist/vendor/`. `npm run build` copies these in automatically.

For the fastest transcription, serve with these headers so the speech engine can use several CPU cores (optional):
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.

To put it on your phone: serve `dist/` over HTTPS (any static host or your own server), open it in Safari/Chrome and choose **Add to Home Screen**. It then opens full-screen and works without internet.

**Best browsers:** current Chrome, Edge or Safari (16.4+). Firefox 130+ also works. The export dialog only offers the codecs your device can actually encode (for example, some browsers export AV1 or VP9 instead of H.264).

## Installing the full app (for the AI tools)

The embedded link is great for quick edits, but auto-captions, background removal and face-following need the full app, because it ships model files and can download the speech model.

1. Unzip `framewright-app.zip` (the ready-built `dist/` folder).
2. Upload the folder to any static web host over HTTPS — Netlify Drop, Cloudflare Pages, GitHub Pages, or your own server. No backend is needed.
3. Open that address on your phone or computer and choose **Add to Home Screen / Install**. It then opens like an app and works offline; the speech model downloads the first time you use auto-captions.

(Opening `index.html` straight from a folder won't work: browsers block the background workers on `file://` pages.)

## Quick workflow (Shorts / TikTok)

1. Home → **TikTok** (1080×1920).
2. **Media** → Import (or drop files on the preview). Tap **+** on a clip to add it at the playhead.
3. Select a clip → **S** (or the split button) to cut; drag edges to trim; **Shift+Del** to ripple-delete.
4. **Audio** → import your music → **+**.
5. **Text** → pick a style → edit in the inspector; tap a layer in the preview to drag, pinch or scroll to scale.
6. **Effects / Filters** with a clip selected.
7. Tap a **◇** between two clips → pick a **transition**.
8. **Captions** → import an SRT/VTT → pick a style → set words per caption to 2 → Re-cut.
9. Or **AI tools** → **Auto-captions** to have them written for you, **Remove silences** to tighten talking bits, **Highlight finder** to pull the best 30 s out of a long gaming session, **Auto-reframe** to turn landscape gameplay vertical.
10. Select a clip → inspector **Colour** tab to grade it (or **Adjust → Add adjustment layer** to grade everything at once); turn on **Scopes** under the preview.
11. **Cutout** tab for masks and green screen; **Audio** tab for voice clean-up, reverb, normalise and auto-duck; **Speed** tab for ramps and freeze frames.
12. **Stickers** for reactions, shapes and emoji (they pop in; change motion in the Animate tab). **Templates** to start from a ready-made edit and drop your clips into the numbered slots. **Brand** to keep your colours, fonts, logo and intro/outro and apply them in one tap.
13. **Design mode:** Elements → Backgrounds (speed lines, sunburst…), Design pieces (glow ring, countdown, answer buttons); drag, resize and rotate on the preview with snapping guides; Transform tab to align and change layer order. **Templates → Quiz maker** builds “guess who” quiz rounds for you.
14. **Export** → MP4 → 1080p → Save.

## Post planner

Schedule a finished video to YouTube, Instagram and TikTok at once — shared or per-platform captions, titles and hashtags, a weekly posting queue and a calendar. In the desktop app it can post for you once you connect your accounts (your own free developer access for each platform); everywhere else it reminds you at the time with the caption copied and the video ready to share. Set-up and limits: [docs/POSTING.md](docs/POSTING.md).

## Architecture

```
src/
  core/        Pure TypeScript, no browser APIs. Unit-tested.
    types.ts        Project model (serialisable; same on every platform)
    timeline.ts     Immutable timeline ops: add, move, trim, split, ripple, speed, detach audio, snapping
    history.ts      Undo/redo (snapshots with structural sharing, coalesced drags)
    keyframes.ts    Interpolation (incl. Bézier), keyframe paths for any property, rebasing on trim/split
    masks.ts        Mask shapes, outlines, animation
    grade.ts        Colour grade maths (curves, wheels, HSL), .cube LUT parse/bake/write, chroma key
    audioFx.ts      Audio effect catalogue, normalise, speech detection, ducking
    motion.ts       In/out/loop motion presets;  stickers.ts  original sticker pack (SVG)
    templates.ts    Slots, fill, project ⇄ template;  builtinTemplates.ts  starter templates
    brand.ts        Brand kits: restyle, logo placement, intro/outro
    quiz.ts         Quiz maker (rounds → clips);  sfx.ts  synthesised sound effects;  snap.ts  smart guides, align, distribute
    effects.ts      Effect catalogue + colour-matrix maths
    transitions.ts  Transition catalogue, windows at cuts, extended source timing
    captions.ts     SRT/VTT parse + write, word timing, chunking, caption operations
    analysis.ts     Silence, filler words, scenes, highlights, reframe paths, tracking → keyframes, range cutting
    projectIO.ts    Versioned project file format, validation, migration defaults
    presets.ts, defaults.ts, time.ts
  engine/      Browser media engines
    media.ts        Import, probing (Mediabunny → <video> fallback), fingerprints, thumbnails, waveform peaks
    compositor.ts   Draws one frame (shared by preview AND export: what you see is what you get)
    effectsRender.ts, textRender.ts (incl. spoken-word highlight), transitionRender.ts
    gpu.ts          WebGL colour pipeline (matrix, grade, LUT, chroma key)
    maskRender.ts   Mask compositing;  scopes.ts  histogram / waveform / vectorscope
    audioChain.ts   Web Audio effect chains (shared by preview and export) + AudioWorklets
    player.ts       Live preview: <video> elements synced to a clock, audio through Web Audio, level meters
    audio.ts        Volume envelopes; chunked offline mixdown for export (bounded memory)
    exporter.ts     Frame-accurate export via WebCodecs + Mediabunny muxers; GIF, WAV, MP3, stills
    media.worker.ts Background jobs: audio analysis, preview proxies, scene/motion analysis, point tracking
    asr.worker.ts   On-device Whisper transcription (transformers.js)
    ai.ts           AI orchestration: transcription, MediaPipe (background removal, faces), local image generation
    recorder.ts     Screen / camera / voiceover recording (streamed, then re-packaged for smooth scrubbing)
    renderCache.ts  Background rendering of heavy timeline sections
    mediaSource.ts  Media bytes from a Blob (browser) or a local URL (desktop, used in place)
  platform/      Platform integrations: file saving, streamed export sinks, native bridge (desktop/phone), wake lock
  storage/       IndexedDB, crash recovery, optional sync folder
desktop/       Electron shell (main process + preload bridge), packaging via electron-builder.yml
android/, ios/ Capacitor phone projects (web build copied in by `npx cap sync`)
.github/workflows/build-apps.yml   Builds Windows/macOS/Linux/Android/iOS on GitHub's machines
  ui/            React UI: Home, Editor, Timeline, Preview, Inspector, panels, dialogs, shortcuts
```

Key decisions:

- **One render path.** The compositor takes a project, a time and a "frame source". Preview feeds it live `<video>` frames; export feeds it frame-exact decoded frames. Effects, text and transforms are therefore identical in both.
- **Immutable project data.** Every edit returns a new project, so undo/redo is reliable and the engine is easy to test.
- **Non-destructive.** Imported files are copied into browser storage (deduplicated by content). Originals are never written to or deleted.
- **Bounded memory.** Audio is decoded and mixed in 5-second chunks, and video frames are streamed, so long gaming recordings export without loading the whole file.
- **Honest gaps.** Unbuilt features appear in the UI as "Planned · Phase N" and are listed in ROADMAP.md.

## Project files

Projects autosave to the device. **… → Save project file** writes a `.framewright.json` containing the whole edit and media references (not the media itself). Opening it on another device asks you to re-link any media that isn't there; files are matched by content fingerprint.

## Keyboard shortcuts (desktop)

Space play/pause · S or Ctrl+B split · Del delete · Shift+Del ripple delete · Ctrl+D duplicate · Ctrl+Z / Ctrl+Shift+Z undo/redo · ←/→ frame step (Shift = 1 s) · ↑/↓ previous/next edit point · , / . nudge clip · M marker · T text · +/− zoom · Ctrl+S save · Ctrl+E export · ? shortcut editor (all rebindable).

## Licences

Your code: private. Third-party components are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
