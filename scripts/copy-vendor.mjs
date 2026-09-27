// Copies runtime files that are loaded at run time (not bundled) into public/vendor:
//  - ONNX Runtime Web (for on-device transcription)
//  - MediaPipe selfie segmentation + face detection (bundled models)
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const out = 'public/vendor';
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'ort'), { recursive: true });
const ort = 'node_modules/onnxruntime-web/dist';
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  if (existsSync(join(ort, f))) cpSync(join(ort, f), join(out, 'ort', f));
}
for (const [pkg, dir] of [['@mediapipe/selfie_segmentation', 'selfie_segmentation'], ['@mediapipe/face_detection', 'face_detection']]) {
  const src = join('node_modules', pkg);
  const dst = join(out, 'mediapipe', dir);
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) if (!/\.(md|json|ts)$/.test(f)) cpSync(join(src, f), join(dst, f));
}
console.log('vendor files copied to', out);
