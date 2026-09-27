// Bundles the desktop shell (main + preload) for Electron.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: false, logLevel: 'warning' };
await build({ ...common, entryPoints: ['desktop/main.ts'], outfile: 'desktop/out/main.cjs' });
await build({ ...common, entryPoints: ['desktop/preload.ts'], outfile: 'desktop/out/preload.cjs' });
console.log('desktop shell built → desktop/out');
