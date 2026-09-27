# Framewright roadmap and feature status

This file tracks every section of the original brief against what actually works today.
**Done** means built, wired into the UI and exercised by tests or a real browser run.
**Partial** means the core works but part of the brief is missing (listed).
**TODO** means not built. The app marks these areas as "Planned" instead of faking them.

## Phase 1: functional editor ✅

| Brief § | Area | Status | Notes |
|---|---|---|---|
| 2 | Original dark UI, desktop layout | Done | Left tool rail + panel, centre preview, right inspector, bottom multi-track timeline, resizable. |
| 2, 26 | Mobile touch UI | Done | Bottom tool bar, swipe-down sheets, tap-to-select, drag selected clips, pinch-zoom timeline, pinch/rotate layers in preview, portrait + landscape layouts. |
| 3 | Import | Partial | File picker, multi-select, folders (picker + drag-and-drop), phone camera capture, drag-and-drop anywhere. Thumbnails, waveforms, search, sort, folders, favourites, duplicate detection (content fingerprint), metadata. **Missing:** MKV/AVI/MPEG only import when the browser can decode them (FFmpeg.wasm transcode is a TODO); HEIC only in Safari; animated GIF/WebP show their first frame. "Recent media" = sort by Recent. |
| 4 | Timeline | Partial | Unlimited video/overlay/audio tracks, split, trim, move (across tracks), duplicate, delete, ripple delete, ripple insert/close gap (engine), snapping, magnetic main track, frame nudge, keyframe diamonds, clip + track locking, track hide/mute, zoom, filmstrips, waveforms, markers, undo/redo. Adjustment layers spanning clips (Phase 2b), caption track. **Missing:** chapter-marker export. |
| 5 | Video editing | Partial | Crop, rotate, flip, scale, position, opacity, speed (0.1–8×), reverse, fades, numeric entry for everything. Freeze frames and speed ramps (Phase 2b). **Missing:** stabilisation, frame interpolation (optical flow). |
| 6 | Keyframes | Partial | Every numeric property: position, scale, rotation, opacity, crop, volume, every video and audio effect parameter, colour-grade sliders, mask shapes (Phase 2b). Linear, ease in/out/smooth, hold and custom Bézier curves with presets; jump between keys. **Missing:** a dedicated graph-editor lane; keyframing text size/colour from the UI (the engine supports `text.*` paths). |
| 7 | Text | Partial | 15 bundled fonts + font upload, size, weight, italic, alignment, letter/line spacing, colour, gradient, outline, shadow, glow, rounded label backgrounds, text box width, uppercase, in/out animations (fade, pop, slide, typewriter, word-by-word), 10 original presets. **Missing:** curved text, per-character styling, keyframed text properties, persisting uploaded fonts across sessions. |
| 10 | Audio | Done | Volume up to 400 % (keyframable), fades, mute, detach, level meters, plus Phase 2b: noise reduction, voice enhance, EQ, compressor, limiter, low/high cut, reverb, echo, stereo pan, pitch shift, normalise, auto-ducking, pitch-preserving speed. |
| 11 | Audio library | Done | Import your own music/SFX, folders, favourites, waveforms. No bundled copyrighted audio. |
| 13 | Effects | Partial | Stackable, reorderable: colour adjust, blur, sharpen, vignette, film grain, glow, pixelate, RGB split, glitch, camera shake, zoom pulse, invert, black & white, sepia, 10 filter looks. Every parameter keyframable; colour work runs on the GPU (WebGL) with a CPU fallback (Phase 2b). **Missing:** motion blur, fisheye/distortion, light leaks, edge effects; GPU versions of blur/glow (still canvas). |
| 14 | Colour | Done | See Phase 2b. |
| 20 | Social presets | Done | TikTok, Shorts, Reels, IG post/portrait/landscape, YouTube (30/60 fps, 4K), Facebook feed/story/landscape, custom size + fps. |
| 21 | Export | Partial | MP4, MOV, WebM, GIF, WAV, MP3, PNG, JPEG. H.264, HEVC, VP9, AV1 (whichever the device can encode), resolution presets 720p–4K, fps, quality/bitrate, audio bitrate + sample rate, GPU/CPU preference, no watermark, no limits. Frame-accurate rendering. **Missing:** export of a selected range from the UI (engine supports it). |
| 24 | Projects | Done | Autosave, manual save + snapshot, duplicate, rename, delete, recent projects, rolling version history (20 snapshots, restorable), portable `.framewright.json` project file with media re-linking. **Missing:** project folders in the UI. |
| 27 | Desktop | Partial | Mouse, keyboard, customisable shortcuts, drag-and-drop, full-screen preview, hi-DPI. **Missing:** multi-monitor (pop-out preview window). |
| 29 | Undo/redo | Done | 500 steps, slider drags merge into one step, every edit reversible, restoring a version is undoable. |
| 30 | File safety | Done | Originals are never written to. The app keeps its own copy in browser storage; deleting clips/projects never touches your files. |
| 31, 32 | Offline, no locks | Done | No account, no network calls, fonts bundled, no paywalls/watermarks/limits/ads. Installable as an app (PWA) with offline cache when served normally. |
| 34 | Privacy | Done | No uploads anywhere. "Everything stays on this device" is shown on the home screen and export dialog. |
| 35 | Architecture | Done | See README. `core/` is pure TypeScript with no browser APIs. |
| 37 | Tests | Partial | 140 unit tests (incl. subtitle parsing, caption split/merge/re-cut, transition timing, silence/scene/highlight/reframe/tracking maths) (project creation, timeline ops, split, trim, undo/redo, keyframes, effects, project save/reopen, corrupt files, media classification) + Playwright end-to-end on desktop and phone viewports (import incl. a corrupt file, edit, undo/redo, keyframe, export MP4/WebM/GIF/WAV/PNG verified with ffprobe, a transition + SRT captions flow with SRT export and a mid-transition frame check, the AI tools (silence removal, scene split, highlights, tracking accuracy, reframe, background removal, transcription start-up), a no-seek playback check, Phase 2b grading/green screen/masks/LUT/adjustment layer/scopes/audio effects/ramps/freeze checked with exported-pixel and duration checks, reload + reopen, no horizontal overflow on phones). **Missing:** real-device iOS/Android runs. |

## Phase 2a: transitions and captions ✅

| Brief § | Area | Status | Notes |
|---|---|---|---|
| 12 | Transitions | Done | 19 original transitions across every category in the brief: dissolve, dip to colour, slide, push, wipe, zoom in/out, spin, blur, warp (distortion), glitch, flash, light burn, circle/diamond/clock reveals, whip pan, letterbox, film fade. Adjustable length, direction, easing, colour and per-type settings; one tap to use on every cut. Centred on the cut, so clip lengths never change; frames are held when there's no spare footage. Rendered identically in preview and export. **Missing:** audio crossfade during transitions. |
| 8 | Captions | Partial | SRT and WebVTT import (including VTT word timings) and export, a caption editor (edit, split at the nearest word, merge, delete, add at playhead), re-cut into 1/2/3/5-word captions, 6 original caption styles, size/position for all, spoken-word highlight (colour, box, karaoke fill, underline). Captions are normal text clips, so every text style and animation works on them. **Missing:** automatic transcription (Phase 3). Without it, word timing is estimated from word length. |

## Phase 2b: professional editing ✅

| Brief § | Area | Status | Notes |
|---|---|---|---|
| 14 | Colour grading | Done | Inspector **Colour** tab: exposure, contrast, saturation, vibrance, temperature, tint, highlights, shadows, whites, blacks; lift/gamma/gain colour wheels with level sliders; RGB + master curves; 8-band HSL (hue/saturation/lightness); every slider keyframable. Runs as a WebGL shader, with an identical CPU path when WebGL isn't available. |
| 14 | LUTs | Done | Import `.cube` 3D LUTs, intensity slider, stored inside the project. **Export this clip's grade as a 33³ `.cube`** for Premiere/Resolve/etc. (In the embedded web view the file is saved as `.cube.txt`; rename it.) |
| 14 | Scopes | Done | Histogram (RGB + luma), luma waveform, vectorscope with colour targets and skin-tone line; live under the preview. |
| 13 | Adjustment layers | Done | A clip on its own top track that applies its colour grade, effects and masks to everything underneath; blend amount + fades. |
| 15 | Chroma key | Done | Remove green / blue in one tap, or eyedropper any colour from the original frame; strength, edge softness, spill removal, shrink edges; keyframable. GPU with CPU fallback. |
| 16 | Masks | Done | Rectangle (rounded), ellipse, polygon (add/remove points), freehand drawing; move/resize/rotate on the preview; feather, strength, invert, add/subtract/intersect combining; every value keyframable ("Key shape here"). Works on video, photos, text, colour clips and adjustment layers. |
| 16, 17 | Tracked blur | Done | AI tools → **Tracked blur**: click a face/name/number plate; the on-device tracker follows it forwards and backwards and a blurred or pixelated, feathered ellipse follows it. Result is ordinary clips/masks/keyframes you can edit. |
| 10 | Audio effects | Done | Per-clip chain, reorderable: noise reduction (noise gate + hiss cut), voice enhance, 3-band EQ, compressor, limiter, low cut, high cut, reverb, echo, stereo pan, pitch shift; all parameters keyframable. Same chain in preview (Web Audio) and export (offline render, with lead-in so reverb/echo tails are exact across cuts). |
| 10 | Normalise & ducking | Done | Normalise sets a clip to a standard loudness; Auto-duck writes volume keyframes on music whenever other clips have speech (adjustable depth). |
| 5 | Speed ramps & freeze | Done | 7 ramp presets (speed up, slow down, hero moment, bullet time, flash in/out, montage) built from short pieces so everything else keeps working; pitch-preserving speed toggle; freeze frame of any length at the playhead. **Missing:** hand-drawn custom speed curves; frame blending for very slow motion. |
| 6 | Keyframes & easing | Done | See Phase 1 row 6. |

**Honest caveats**

- **Noise reduction** is a smart noise gate + hiss filter, not a machine-learning denoiser: great for room tone between words, it won't remove noise *under* the voice.
- **Pitch shift / pitch-preserving speed** use a lightweight granular shifter (an AudioWorklet). Voices sound natural for moderate changes (±4 semitones, 0.5–2×); extreme settings get a "phasey" sound. If a browser blocks AudioWorklets, those two effects are skipped and the app says so.
- **Preview vs export:** colour, masks, chroma key and audio effects use the same code in both. Heavy stacks (e.g. several masks + chroma key on 4K) may preview below full frame rate; export is always exact.
- Stickers & shapes (§18), templates (§19) and brand kits were added later — see the section below.

## Phase 3: local AI ✅

| Brief § | Tool | Status | Where it runs | Notes |
|---|---|---|---|---|
| 8, 9 | Auto-captions (transcription) | Built, **untested against the live model** | Device; Whisper model downloaded once from Hugging Face | Whisper (tiny/base, English or multilingual) via transformers.js + ONNX Runtime in a worker; WebGPU when available, CPU otherwise. Word-level timings → animated captions (1/2/3 words or sentences). Long files are done in 10-minute pieces. My build sandbox can't reach Hugging Face, so the full run was only verified up to the model download (which fails cleanly with a clear message). Needs the installed app; the embedded web view can't download the model. |
| 9 | Silence removal | Done | Device | Loudness measured in a background worker at import. Auto threshold per recording, adjustable pause length and padding, live count of what will be cut. Cuts the clip and its detached audio together and closes the gaps; music on other tracks keeps playing. |
| 9 | Filler-word removal | Built, depends on transcription | Device (after model download) | Removes um/uh/erm/er/ah/hmm plus any words you add. Uses the same transcript as captions (saved with the media, reused across splits). |
| 9 | Scene detection | Done | Device | Histogram + pixel difference with an adaptive threshold; sensitivity slider; add markers or split into shots. |
| 9 | Highlight detection | Done (heuristic) | Device | Scores loud, energetic audio and on-screen action to suggest the best 15/30/60 s moments; jump, mark all, or trim to one. Not a neural model. |
| 9 | Auto-reframe | Done | Device | "Follow the action" (motion centroid) or "Follow faces" (bundled MediaPipe face model). Fills the frame and writes smoothed, simplified Position keyframes. |
| 17 | Motion tracking | Done (point/object) | Device | Click the thing to follow; normalised cross-correlation tracker with an adapting template; drives an overlay's Position keyframes (text, images, stickers, colour boxes). Face tracking = click the face. Tracked blur/pixelate (Phase 2b) uses the same tracker to move a mask. |
| 9 | Background removal | Done (people) | Device, bundled MediaPipe model | A clip effect; preview may lag a frame while playing, export is exact. Works on people; general "smart object selection" is not built. |
| 9 | Local image generation | Built, untested (needs your server) | Your own server | Stable Diffusion WebUI (A1111/Forge) or any OpenAI-compatible image endpoint; the result is imported as media. Installed app only. |
| 9 | Local video generation | Architecture only (TODO) | — | `VideoGenProvider` interface in `engine/ai.ts`; no provider yet. |

## Design mode (Canva-style) ✅ (this release)

| Area | Status | Notes |
|---|---|---|
| Animated backgrounds | Done | Speed lines (manga focus lines that flicker), sunburst rays (rotate), comic dots (drift), linear/radial gradients. Full-frame, on their own background layer under everything; colours editable, animation on/off. |
| Design pieces | Done | Glowing rings (any shape can glow), countdown timers (ring / bar / big number — they count down over the clip's length), quiz title, round label, answer buttons, banners. |
| Text for designs | Done | Colour just some words (select them → “Colour selected words”, e.g. a yellow “A)”), box borders, fixed-width boxes for evenly sized buttons. |
| Canvas editing | Done | Corner handles to resize and a knob to rotate (snaps to 0/90/180/270°), smart guides that snap to the frame's edges/centre and to other layers (Alt = free), align left/centre/right/top/middle/bottom, space-evenly for 3+ layers, bring forward / send backward / to front / to back, a “layers at the playhead” list. |
| Silhouette & reveal | Done | Silhouette effect (keyframe its amount to reveal); “Slam in” title animation. |
| Quiz maker | Done | Type the title, answers and pick the pictures; it builds each round: background, slam-in title, round number, glowing ring, hidden picture (silhouette / blur / pixels), 2–4 answer buttons, countdown, reveal with the right answer turning green, and sounds. Every part stays editable. |
| Quiz zoom reveal | Done | New default way to hide the picture: the question shows a close-up of one part (in a round window), then zooms out with a quick blur at the reveal. The app suggests a spot (an extremity like a hand or tail, found from the see-through outline). A close-up editor per round lets you drag the circle onto the exact part, resize it (handle, slider, scroll wheel or pinch — 1.2–12×, per round) and see exactly what viewers will see. |
| Quiz answers | Done | Answer size (70–160%) and layout (2 × 2 grid or one per row); buttons always fit between the picture and the countdown, and long answers shrink a little to stay on one line. The right answer's white button disappears under the green one, so nothing peeks out while it pulses. |
| Quiz intro | Done | Optional opening card: the title slams in over a jagged starburst on a drifting "streaks" background, with a boom (and your own recorded voice or sound if you add one), then crossfades into round 1. The starburst can stay behind the picture in every round. Live preview in the quiz maker shows intro, question and answer. |
| Quiz sounds & playback | Done | Softer synthesised whoosh, wooden tick-tock and two-note chime at sensible levels; exports use constant-bitrate audio. Preview no longer pauses at each tick (short sound effects never drive the playback clock). |
| Sound effects | Done | 7 original, synthesised sounds (tick, ding, buzzer, whoosh, pop, suspense riser, ta-da) in the Audio panel — no samples or licences involved. |

**Not included on purpose:** Framewright doesn't ship any Pokémon (or other brand) artwork, logos or fonts — use your own pictures and text.
**Not built yet:** grouping layers into one object, multi-page still designs exported as PDF, a stock photo/graphics library (it would need internet downloads).

## Stickers, templates and brand kits ✅

| Brief § | Area | Status | Notes |
|---|---|---|---|
| 18 | Stickers | Done | 20 original vector stickers (WOW!, OMG, RARE PULL!, GG, BEFORE/AFTER, FOLLOW FOR MORE, LINK IN BIO, circle-it, look-here arrow…) — no brand logos or anyone else's characters. Search, one tap to add on a layer above the video. |
| 18 | Shapes & emoji | Done | Box, ring, triangle, star, heart, arrow, speech bubble, burst, line: fill, gradient, outline, rounding, points, shadow; 36 emoji (your device's emoji style). Sharp at any export size. |
| 18 | Your own stickers | Done | Import PNG/SVG/GIF/WebP. **Animated GIF/WebP/APNG now play and loop** in preview and export (Chrome, Edge, Firefox, desktop and Android apps; Safari shows the first frame). |
| 18 | Motion presets | Done | Any sticker, shape, photo or video overlay: in (fade, pop, zoom, slides, spin, drop & bounce), out, and loops (pulse, wiggle, bounce, float, spin, shake, swing) with speed. Text gets the loops. |
| 19 | Templates | Done | 8 original starters (pack opening reveal, gaming highlight with blurred-background layout, before & after, room reveal, top 3 countdown, fast montage, YouTube intro 16:9, photo slideshow 1:1). Numbered slots: pick clips once and they fill in order, or fill one slot at a time; footage too short for a slot plays slower to fit. |
| 19 | Your own templates | Done | Save any project as a template (footage → slots; stickers, logos and optionally music kept), reuse, export/import as a file to share. Export warns about empty slots. |
| — | Brand kits | Done | Colours, title/caption fonts (upload your own — kept after reloads), logo with corner/size/opacity, intro and outro clips. One tap: restyle titles, captions and shapes; add the logo for the whole video; add intro/outro. Brand colour chips appear in the text and shape colour controls. Several kits supported. |

Also fixed: fonts you upload are now remembered between sessions.

## Phase 4: native platforms ✅

| Brief § | Platform / area | Status | Notes |
|---|---|---|---|
| 26, 27 | Windows desktop app | Built here (portable) + recipe for installer | Electron (same Chromium engine the tests run on). Portable `.zip` built in this environment; the `.exe` installer is built by the included GitHub Actions recipe (needs Windows tooling). Unsigned, so Windows SmartScreen asks "Run anyway" the first time. |
| 26, 27 | Linux desktop app | Built + tested here | AppImage. Smoke-tested end to end under a virtual display (see below). |
| 26, 27 | macOS desktop app | Recipe only | Needs a Mac to build: `npm run desktop:mac`, or the GitHub Actions recipe. Ad-hoc signed (no paid Apple certificate), so the first launch needs right-click → Open. |
| 26 | Android app | Project + recipe | Capacitor project in `android/`. Build with Android Studio or the recipe (produces an installable `Framewright.apk`). Not built here: this environment can't download Google's Android tools. |
| 26 | iPhone / iPad app | Project + recipe | Capacitor project in `ios/`. Needs a Mac + Xcode, or the recipe's unsigned `.ipa` + Sideloadly/AltStore with your Apple ID (free accounts must re-sign every 7 days). The home-screen web app (PWA) keeps working in the meantime. |
| 3 | Media used in place (desktop) | Done | Files stay where they are and are read with range requests (`fw-media://`), so a 50 GB recording is never copied into the app. Projects re-find them after a restart. |
| 3 | MKV/AVI/WMV/ProRes etc. (desktop) | Done | Converted with FFmpeg — the computer's own, or a one-click optional download. Container-only problems (e.g. H.264 in MKV) are remuxed with no quality loss. |
| 21 | Native saving | Done | Desktop: exports stream to a temp file, then a real "Save as…" moves them (no copy in memory). Phones: share sheet (Save Video / Files / TikTok / etc.). |
| 22 | Screen recording | Done | Desktop app: pick a screen or window; computer sound on Windows (and recent macOS — untested), not Linux, microphone commentary, optional camera bubble as its own movable clip; saved to *Videos/Framewright Recordings*. Chrome/Edge: same, with the browser's picker. Not possible on phones (iOS/Android don't allow it in apps like this). |
| 23 | Camera & voiceover recording | Done | Camera (front/back on phones, resolution and fps), voiceover that plays the timeline while you talk and lands at the playhead. 3-2-1 countdown, pause/resume, level meter. |
| 27 | Second monitor | Done | Pop-out preview window (menu → Pop out preview), mirrors the preview live at higher resolution; double-click for full screen. |
| 27 | Desktop niceties | Done | Native menus with shortcuts, "Open with" for `.framewright` files, single instance, remembers window size, reload offer if the editor crashes, keeps the screen awake while exporting/recording. |

**Tested:** a scripted run of the packaged Linux app (`tests/desktop/smoke.mjs`) imports WebM + H.264 + an AVI (converted by FFmpeg), checks media is used in place, previews H.264, exports H.264/AAC MP4 through the native save dialog, records the screen, opens the pop-out preview, then restarts the app and reopens the project with all media found. Windows and phone builds were not run here.

## Phase 5: performance ✅

Measured with `npm run bench` (Chromium with **software-only graphics** in a cloud container — a real GPU is much faster; compare runs on the same machine only). 1080×1920 project, HD 60 fps footage.

| What | Before Phase 5 | Now | How |
|---|---|---|---|
| Playback with effects (blur, vignette, grain, grade, mask, title) | 35 fps, 27 ms/frame | 56 fps live · 61 fps once background-rendered | Fused colour passes, cheaper blur, reduced-res mask feathering, GPU speed check, background rendering |
| Export with that stack | 1.5 fps (4 min for 12 s) | 5.9 fps (61 s) | Same, plus decoding the next frame while encoding this one |
| Scrubbing (jump to a new time) | 262 ms median | 64 ms (plain) · 119 ms (effects) | GOP-aware proxies (dense keyframes), probe off the main thread |
| Import (4 files) | 8.1 s, UI froze 1.6 s | 11 s, **0 ms** frozen | Probing, thumbnails and waveforms in a background worker; heavy jobs start after the batch |
| 600-clip timeline | 1.2 s to draw, zoom step 1.1 s | 0.24 s, zoom 0.1 s | Only the visible clips are drawn |
| Long exports | Whole file in memory | Streams to disk | Browser's private storage / desktop temp file |

Also: **background rendering** (heavy parts of the timeline pre-render while you're idle; green bar on the timeline = ready), **crash recovery** (reopen offer after an unclean exit, error screen with a project rescue download, named versions), and an optional **sync folder** (pick a OneDrive/Dropbox/Drive/iCloud folder and project edits follow you between computers — only the small project files, never media; no Framewright server).

**Still open:** export in a background worker (the editor is busy while exporting), WebGPU compositing, GPU versions of sharpen/glow/RGB split, true cloud sync of media.

## Post planner (Buffer-style) ✅

| Feature | Status | Notes |
|---|---|---|
| Compose | Done | One video → YouTube, Instagram, TikTok. Shared caption + hashtags, per-platform caption/hashtags/title overrides, hashtag chips + saved sets, live "will be posted as" text, phone-style previews, per-platform limit checks. |
| Platform options | Done | YouTube: title, visibility, made-for-kids, category, #Shorts. Instagram: share to grid, cover frame. TikTok: who can watch, comments/duet/stitch, send to drafts. |
| When | Done | Post now, add to queue (weekly posting times), pick a date/time, drafts. Week calendar with empty slots; Queue / Needs you / Posted / Drafts lists. |
| Post for me (desktop) | Done | YouTube Data API resumable uploads (YouTube schedules it), Instagram Reels resumable upload, TikTok Content Posting API (direct or drafts). Sign-in with your own developer apps via the browser + 127.0.0.1 callback (PKCE); Instagram by pasted token. Tokens encrypted with the system keychain. |
| Remind me (everywhere) | Done | Notification at the time; one tap copies the caption and shares/saves the video; mark done. Phone reminders are system notifications (work with the app closed). |
| Background posting | Done | Desktop keeps running in the tray (optional). Missed posts wait in "Needs you". |

**Platform limits (theirs, not ours):** un-audited YouTube projects upload as private; un-audited TikTok apps post "Only me" (or use drafts); Instagram needs a professional account. See `docs/POSTING.md`.

**Tested:** unit tests against fake platform servers, browser tests (phone + desktop), and a desktop run that connects all three accounts and posts to them (fake servers). **Not yet run against the real platforms.**

## Phone polish ✅

Audited every main screen at iPhone size (390 px wide, touch). Fixed: timeline toolbar made the page wider than the screen, which cut off the right edge of every pop-up and slide-up panel (Export button, post editor, Text/Elements/Templates panels); playback bar now uses a short time (0:03.0) so it fits; finger-sized controls on touch screens (buttons, tabs, chips, tick boxes ≥ 36–40 px); 16 px text in all boxes so iPhones don't zoom in when you tap one.
