// ONNX Runtime's own copy of its wasm gets emitted by the bundler, but the app
// loads the runtime from dist/vendor/ort instead, so drop the unused duplicate.
import { readdirSync, rmSync } from 'node:fs';
for (const f of readdirSync('dist/assets')) if (/^ort-wasm.*\.wasm$/.test(f)) rmSync(`dist/assets/${f}`);
