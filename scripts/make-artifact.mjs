// Turns the single-file build into a page body for hosts that supply their own
// <html>/<head>/<body> skeleton (e.g. a claude.ai artifact).
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('dist-single/index.html', 'utf8');
const out = src
  .replace(/<!doctype html>/i, '')
  .replace(/<!--pwa-->[\s\S]*?<!--\/pwa-->/, '')
  .replace(/<\/?html[^>]*>/gi, '')
  .replace(/<\/?head>/gi, '')
  .replace(/<\/?body>/gi, '')
  .replace(/<meta charset="UTF-8" \/>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '')
  .trim();
writeFileSync('dist-single/framewright.html', out);
console.log('wrote dist-single/framewright.html', (out.length / 1e6).toFixed(2), 'MB');
