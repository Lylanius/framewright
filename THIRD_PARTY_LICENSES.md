# Third-party licences

Framewright ships (bundles) the following open-source components. All are used unmodified. Full licence texts are in each package under `node_modules/<package>/LICENSE`.

| Component | Version | Licence | Used for | Source |
|---|---|---|---|---|
| React, React DOM, scheduler | 19.3 | MIT | User interface | https://github.com/facebook/react |
| Zustand | 5.0 | MIT | App state | https://github.com/pmndrs/zustand |
| Mediabunny | 1.60 | MPL-2.0 | Reading/demuxing media, WebCodecs decode/encode, MP4/MOV/WebM/WAV/MP3 muxing | https://github.com/Vanilagy/mediabunny |
| @mediabunny/aac-encoder | 1.60 | MPL-2.0 (wraps FFmpeg's AAC encoder, LGPL-2.1+) | AAC audio when the browser has no native AAC encoder | https://github.com/Vanilagy/mediabunny, https://ffmpeg.org |
| @mediabunny/mp3-encoder | 1.60 | MPL-2.0 (wraps the LAME MP3 encoder, LGPL) | MP3 export | https://github.com/Vanilagy/mediabunny, https://lame.sourceforge.io |
| gifenc | 1.0.3 | MIT | Animated GIF export | https://github.com/mattdesl/gifenc |
| Transformers.js (@huggingface/transformers) | 4.3 | Apache-2.0 | Running the Whisper speech model | https://github.com/huggingface/transformers.js |
| ONNX Runtime Web | 1.31 (dev) | MIT | Model runtime (WebAssembly/WebGPU), shipped in `vendor/ort/` | https://github.com/microsoft/onnxruntime |
| MediaPipe Selfie Segmentation | 0.1 | Apache-2.0 | Background removal (model + runtime in `vendor/mediapipe/`) | https://github.com/google/mediapipe |
| MediaPipe Face Detection | 0.4 | Apache-2.0 | Face finding for auto-reframe (model + runtime in `vendor/mediapipe/`) | https://github.com/google/mediapipe |
| Fontsource font packages | 5.3 | see below | Bundled fonts (work offline) | https://github.com/fontsource/font-files |

## Desktop and phone apps (Phase 4)

| Component | Version | Licence | Used for | Source |
|---|---|---|---|---|
| Electron (includes Chromium, Node.js, FFmpeg's *decoders* inside Chromium) | 44 | MIT (Chromium: BSD-3 and others — the full list ships as `LICENSES.chromium.html` next to the app) | Desktop app for Windows, macOS, Linux | https://github.com/electron/electron |
| Capacitor core, App, Filesystem, Share, Local Notifications | 8 | MIT | Phone apps (iOS, Android) | https://github.com/ionic-team/capacitor |
| @capacitor-community/keep-awake | 8 | MIT | Keeps the phone screen on during exports/recordings | https://github.com/capacitor-community/keep-awake |

**FFmpeg converter (optional, not shipped):** the desktop app can use an FFmpeg already on your computer, or download one when you click "Download" (static builds from the ffmpeg-static project, GPL-3.0; https://github.com/eugeneware/ffmpeg-static, https://ffmpeg.org). It runs as a separate program only to convert formats the editor can't read.

## Fonts

All bundled fonts are under the SIL Open Font License 1.1 except Permanent Marker (Apache-2.0):
Archivo Black, Figtree, Bangers, Monoton, Permanent Marker, DM Serif Display, Anton, Bebas Neue, Poppins, Montserrat, Oswald, Lobster, Press Start 2P, Rubik Mono One, JetBrains Mono.

## Models downloaded at run time (not shipped)

Auto-captions download OpenAI Whisper weights converted to ONNX (e.g. `Xenova/whisper-tiny.en`) from Hugging Face the first time you use them. Whisper is MIT-licensed. The files are cached by your browser; no audio is sent anywhere.

## Notes on LGPL components

The AAC and MP3 encoders are compiled to WebAssembly and loaded as separate chunks (`mediabunny-aac-encoder-*.js`, `mediabunny-mp3-encoder-*.js`) only when needed. They are unmodified; their sources are linked above. LAME asks for credit: MP3 encoding uses the LAME MP3 Encoder — https://lame.sourceforge.io.

## Development-only tools (not shipped)

Vite, Vitest, Playwright, TypeScript, jsdom, vite-plugin-singlefile, esbuild, electron-builder, resedit, png2icons, Capacitor CLI — all MIT, BSD or Apache-2.0.

## Assets

Framewright contains no third-party music, sound effects, stock footage, stickers or logos. Its sound effects are synthesised by its own code, and its stickers, backgrounds and templates are original designs. The name, logo and icons were made for this project.
