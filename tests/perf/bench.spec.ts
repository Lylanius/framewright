/**
 * Performance benchmarks. Run with `npm run bench` (BENCH_LABEL=name to tag the results file).
 * Numbers depend heavily on the machine; compare runs on the same machine only.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const f = (n: string) => path.resolve('tests/fixtures', n);
const results: Record<string, unknown> = {};

async function tiktok(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^TikTok/ }).click();
  await expect(page.locator('.editor')).toBeVisible();
}
const addTile = async (page: Page, n: string) => {
  const t = page.locator('.media-tile', { hasText: n });
  await t.hover();
  await t.getByRole('button', { name: /to timeline/ }).click();
};
/** Resolves after the next two painted frames. */
const nextPaint = (page: Page) => page.evaluate(() => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));

async function exportMp4(page: Page): Promise<{ seconds: number; bytes: number }> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'MP4', exact: true }).click();
  await expect(page.locator('.dialog select').nth(2)).not.toHaveText(/Checking/);
  const t0 = Date.now();
  await page.locator('.dialog footer .btn.primary').click();
  const save = page.getByRole('button', { name: /Save .*\.mp4/ });
  await expect(save).toBeVisible({ timeout: 300_000 });
  const seconds = (Date.now() - t0) / 1000;
  const [d] = await Promise.all([page.waitForEvent('download'), save.click()]);
  const p = await d.path();
  const bytes = p ? fs.statSync(p).size : 0;
  await page.getByRole('button', { name: 'Close' }).click();
  return { seconds, bytes };
}

async function playFor(page: Page, ms: number) {
  await page.evaluate(() => {
    const s = (window as any).__fwPlayer.stats;
    Object.assign(s, { seeks: 0, frames: 0, longGaps: 0, maxGap: 0, holds: 0, lastTick: 0, drawMs: 0, syncMs: 0, cachedFrames: 0, cacheMiss: { none: 0, loading: 0, drift: 0 } });
  });
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(ms);
  await page.getByRole('button', { name: 'Pause' }).click();
  const s = await page.evaluate(() => ({ ...(window as any).__fwPlayer.stats }));
  return { fps: +(s.frames / (ms / 1000)).toFixed(1), drawMsAvg: +(s.drawMs / Math.max(1, s.frames)).toFixed(2), longGaps: s.longGaps, maxGapMs: Math.round(s.maxGap), seeks: s.seeks };
}

async function scrub(page: Page, times: number[]) {
  const out: number[] = [];
  for (const t of times) {
    const ms = await page.evaluate(async (tt) => {
      const w = window as any;
      const t0 = performance.now();
      w.__fwPlayer.seek(tt);
      await new Promise<void>((res) => {
        const poll = () => (w.__fwPlayer.settled() ? res() : setTimeout(poll, 4));
        requestAnimationFrame(poll);
      });
      await new Promise((r) => requestAnimationFrame(() => r(0)));
      return performance.now() - t0;
    }, t);
    out.push(ms);
  }
  out.sort((a, b) => a - b);
  return { medianMs: Math.round(out[Math.floor(out.length / 2)]), maxMs: Math.round(out[out.length - 1]) };
}

test.afterAll(() => {
  const label = process.env.BENCH_LABEL || 'latest';
  const dir = path.resolve('tests/perf/results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${label}.json`), JSON.stringify({ when: new Date().toISOString(), ...results }, null, 2));
  console.log('BENCH', label, JSON.stringify(results, null, 2));
});

test('import stays responsive', async ({ page }) => {
  await tiktok(page);
  await page.evaluate(() => {
    const w = window as any;
    w.__long = { total: 0, max: 0, count: 0 };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { w.__long.total += e.duration; w.__long.max = Math.max(w.__long.max, e.duration); w.__long.count++; } }).observe({ type: 'longtask', buffered: false });
  });
  const t0 = Date.now();
  await page.locator('.import-zone input[type=file][multiple]').first().setInputFiles([f('long.webm'), f('heavy4k.webm'), f('talk.webm'), f('scenes.webm')]);
  await expect(page.locator('.media-tile')).toHaveCount(4, { timeout: 120_000 });
  await expect(page.locator('.media-tile .spinner, .media-tile.loading')).toHaveCount(0, { timeout: 120_000 });
  const secs = (Date.now() - t0) / 1000;
  // Keep watching while background work (waveforms, proxies) runs.
  await page.waitForTimeout(8000);
  const lt = await page.evaluate(() => (window as any).__long);
  results.import = { secondsToTiles: +secs.toFixed(1), longTasks: lt.count, longTaskTotalMs: Math.round(lt.total), longestTaskMs: Math.round(lt.max) };
});

test('export, playback and scrubbing', async ({ page }) => {
  await tiktok(page);
  await page.locator('.import-zone input[type=file][multiple]').first().setInputFiles([f('long.webm')]);
  await expect(page.locator('.media-tile')).toHaveCount(1, { timeout: 60_000 });
  await addTile(page, 'long.webm');
  // Let background preparation (waveforms, any preview proxy) finish, as it would while you start editing.
  await expect(page.locator('.media-tile').first()).not.toHaveAttribute('data-proxy', 'pending', { timeout: 180_000 });
  await page.waitForTimeout(1500);
  results.proxy = await page.locator('.media-tile').first().getAttribute('data-proxy');

  results.playbackPlain = await playFor(page, 4000);
  results.scrubPlain = await scrub(page, [6.3, 1.2, 9.8, 3.4, 7.7, 0.5, 11.1, 4.9, 2.2, 8.6]);
  results.exportPlain = await exportMp4(page).then((r) => ({ ...r, fps: +((12 * 30) / r.seconds).toFixed(1) }));

  // A typical "styled" edit: effects, a grade, a mask and a title.
  await page.locator('.lane .clip', { hasText: 'long.webm' }).click();
  await page.locator('.rail').getByRole('button', { name: 'Effects', exact: true }).click();
  await page.getByRole('button', { name: /^Blur/ }).first().click();
  await page.getByRole('button', { name: /^Vignette/ }).first().click();
  await page.getByRole('button', { name: /^Film grain/ }).first().click();
  await page.getByRole('tab', { name: 'Colour' }).click();
  const setNum = async (label: string, v: number) => { const i = page.locator('.inspector').getByRole('spinbutton', { name: `${label} value` }); await i.fill(String(v)); await i.press('Enter'); };
  await setNum('Contrast', 20);
  await setNum('Shadows', 30);
  await page.getByRole('tab', { name: 'Cutout' }).click();
  await page.getByRole('button', { name: 'Add ellipse mask' }).click();
  await page.locator('.rail').getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.text-preset').first().click();
  await page.keyboard.press('Home');
  await page.waitForTimeout(1000);

  results.playbackFx = await playFor(page, 4000);
  // Background rendering: leave it idle, then play the heavy section from the render.
  await page.mouse.move(5, 5);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.render-bar i.ready').length > 0 && document.querySelectorAll('.render-bar i.pending, .render-bar i.rendering').length === 0), { timeout: 300_000, intervals: [2000] }).toBe(true);
  await page.keyboard.press('Home');
  await page.waitForTimeout(500);
  results.playbackFxRendered = await playFor(page, 4000).then(async (r) => ({ ...r, cachedFrames: await page.evaluate(() => (window as any).__fwPlayer.stats.cachedFrames), miss: await page.evaluate(() => (window as any).__fwPlayer.stats.cacheMiss) }));
  results.scrubFx = await scrub(page, [6.3, 1.2, 9.8, 3.4, 7.7, 0.5, 11.1, 4.9, 2.2, 8.6]);
  results.exportFx = await exportMp4(page).then((r) => ({ ...r, fps: +((12 * 30) / r.seconds).toFixed(1) }));
});

test('big timelines stay snappy', async ({ page }) => {
  await tiktok(page);
  await page.locator('.import-zone input[type=file][multiple]').first().setInputFiles([f('talk.webm')]);
  await expect(page.locator('.media-tile')).toHaveCount(1, { timeout: 60_000 });
  await addTile(page, 'talk.webm');
  // 600 short clips (a long, heavily cut gaming video).
  const t0 = await page.evaluate(() => performance.now());
  await page.evaluate(() => {
    const { app } = (window as any).__fw;
    app.getState().apply('bench', (p: any) => {
      const main = p.tracks.findIndex((t: any) => t.clips.length);
      const src = p.tracks[main].clips[0];
      const clips = Array.from({ length: 600 }, (_, i) => ({ ...src, id: `bench_${i}`, start: i * 0.5, duration: 0.5, sourceIn: (i % 15) * 0.5 }));
      return { ...p, tracks: p.tracks.map((t: any, i: number) => (i === main ? { ...t, clips } : t)) };
    });
  });
  const t1 = await nextPaint(page);
  const domClips = await page.locator('.clip').count();
  // One edit on a big timeline (select, delete, undo), each timed to the next paint.
  const edit = await page.evaluate(async () => {
    const { app } = (window as any).__fw;
    const paint = () => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))));
    const a = performance.now();
    app.getState().select(['bench_3']);
    const b = await paint();
    app.getState().apply('bench delete', (p: any) => ({ ...p, tracks: p.tracks.map((t: any) => ({ ...t, clips: t.clips.filter((c: any) => c.id !== 'bench_3') })) }));
    const c = await paint();
    app.getState().undo();
    const d = await paint();
    return { selectMs: b - a, deleteMs: c - b, undoMs: d - c };
  });
  // Zoom the timeline all the way out and back.
  const zoom = await page.evaluate(async () => {
    const paint = () => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))));
    const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Zoom out') as HTMLButtonElement | undefined;
    const a = performance.now();
    for (let i = 0; i < 6; i++) { btn?.click(); await paint(); }
    return (performance.now() - a) / 6;
  });
  results.timeline600 = { buildToPaintMs: Math.round(t1 - t0), selectMs: Math.round(edit.selectMs), deleteMs: Math.round(edit.deleteMs), undoMs: Math.round(edit.undoMs), zoomStepMs: Math.round(zoom), clipsInDom: domClips };
});
