import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const f = (n: string) => path.resolve('tests/fixtures', n);
const rail = (page: Page, n: string) => page.locator('.rail').getByRole('button', { name: n, exact: true }).click();
const px = (page: Page, fx: number, fy: number) => page.evaluate(([x, y]) => {
  const c = document.querySelector('.stage canvas') as HTMLCanvasElement;
  const d = c.getContext('2d')!.getImageData(Math.round(x * c.width), Math.round(y * c.height), 1, 1).data;
  return [d[0], d[1], d[2]];
}, [fx, fy]);
const seekTo = (page: Page, t: number) => page.evaluate((tt) => { (window as any).__fwPlayer.seek(tt); }, t);
const frameAt = (file: string, t: number, x: number, y: number) => {
  const png = `${file}.${t}.png`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', png]);
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [buf[0], buf[1], buf[2]];
};

test.describe('design mode', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop only');

  test('quiz maker builds a full round; export shows the silhouette then the reveal', async ({ page }, info) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /^TikTok/ }).click();
    await rail(page, 'Templates');
    await page.getByRole('button', { name: 'Make a quiz' }).click();
    await page.getByLabel('Quiz title').fill("WHO'S THAT\nCREATURE?");
    await page.getByRole('radio', { name: 'Silhouette' }).click();
    await page.locator('.quiz-round input[type=file]').setInputFiles(f('creature.png'));
    for (const [i, a] of ['Sparkit', 'Moltor', 'Flarebit', 'Emberpup'].entries()) await page.getByLabel(`Round 1 answer ${'ABCD'[i]}`).fill(a);
    await page.getByLabel('Answer D is correct').check();
    await page.getByRole('button', { name: /Add 1 round/ }).click();
    await expect(page.locator('.toast', { hasText: /Made 1 quiz round/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.timecode')).toContainText('/ 00:00:11:15'); // 2.5 s intro + 9 s round
    // Deselect so motion presets play, then check the picture is a silhouette before the reveal…
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as any).__fw.app.getState().select([]));
    // The intro: title over the starburst (white centre).
    await seekTo(page, 1.2);
    await expect.poll(async () => { const [r, g, b] = await px(page, 0.5, 0.56); return r > 200 && g > 200 && b > 200; }).toBe(true);
    await seekTo(page, 5.5);
    await page.waitForTimeout(600);
    await page.screenshot({ path: info.outputPath('quiz-hidden.png') });
    await expect.poll(async () => { const [r, g, b] = await px(page, 0.5, 0.49); return r < 60 && g < 60 && b < 90; }).toBe(true);
    // …and the real colours after it.
    await seekTo(page, 10);
    await expect.poll(async () => { const [r, g] = await px(page, 0.5, 0.49); return r > 200 && g > 100; }, { timeout: 10_000 }).toBe(true);
    await page.screenshot({ path: info.outputPath('quiz-reveal.png') });
    // Export and check the same thing in the file.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'MP4', exact: true }).click();
    await page.locator('.dialog footer .btn.primary').click();
    const save = page.getByRole('button', { name: /Save .*\.mp4/ });
    await expect(save).toBeVisible({ timeout: 180_000 });
    const [d] = await Promise.all([page.waitForEvent('download'), save.click()]);
    const out = info.outputPath('quiz.mp4');
    await d.saveAs(out);
    const hidden = frameAt(out, 5.5, 540, 940), shown = frameAt(out, 10, 540, 940);
    console.log('export pixels hidden/shown', hidden, shown);
    expect(hidden[0]).toBeLessThan(60);
    expect(shown[0]).toBeGreaterThan(200);
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).toString();
    expect(streams).toContain('audio');
    expect(errors).toEqual([]);
  });

  test('canvas editing: handles, smart guides, align, layer order, backgrounds', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /^TikTok/ }).click();
    await rail(page, 'Elements');
    await page.getByRole('button', { name: 'Add Speed lines background' }).click();
    await expect(page.locator('.lane .clip', { hasText: 'Speed lines' })).toHaveCount(1);
    await page.keyboard.press('Home');
    await page.getByRole('button', { name: 'Add Star shape' }).click();
    const star = page.locator('.lane .clip', { hasText: 'Star' });
    await expect(star).toHaveCount(1);
    // Resize with a corner handle.
    const scale0 = await page.evaluate(() => { const s = (window as any).__fw.app.getState(); return s.project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.kind === 'shape' && c.shape.type === 'star').transform.scale; });
    const h = (await page.getByTestId('xf-corner-2').boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 60, h.y + 60, { steps: 5 });
    await page.mouse.up();
    const scale1 = await page.evaluate(() => { const s = (window as any).__fw.app.getState(); return s.project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.kind === 'shape' && c.shape.type === 'star').transform.scale; });
    expect(scale1).toBeGreaterThan(scale0 * 1.2);
    // Align to the left edge of the frame.
    await page.getByRole('tab', { name: 'Transform' }).click();
    await page.getByRole('button', { name: 'Align left' }).click();
    const bounds = await page.evaluate(() => { const p = (window as any).__fwPlayer; const b = p.lastBounds.find((x: any) => x.w < p.canvas.width * 0.9); return { left: b.cx - b.w / 2 }; });
    expect(Math.abs(bounds.left)).toBeLessThan(3);
    // Drag near the centre: a pink guide appears and it snaps to the middle.
    const cv = (await page.locator('.stage canvas').boundingBox())!;
    const b = await page.evaluate(() => { const p = (window as any).__fwPlayer; const r = document.querySelector('.stage canvas')!.getBoundingClientRect(); const k = r.width / p.canvas.width; const b = p.lastBounds.find((x: any) => x.w < p.canvas.width * 0.9); return { x: r.left + b.cx * k, y: r.top + b.cy * k }; });
    await page.mouse.move(b.x, b.y);
    await page.mouse.down();
    await page.mouse.move(cv.x + cv.width / 2 + 3, b.y + 1, { steps: 8 });
    await expect(page.locator('.snap-guide')).not.toHaveCount(0);
    await page.mouse.up();
    const x = await page.evaluate(() => { const s = (window as any).__fw.app.getState(); return s.project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.shape?.type === 'star').transform.x; });
    expect(Math.abs(x)).toBeLessThan(0.002);
    // Layer order: a heart on top, then send it backward under the star.
    await page.getByRole('button', { name: 'Add Heart shape' }).click();
    await page.getByRole('tab', { name: 'Transform' }).click();
    await page.getByRole('button', { name: 'Send backward' }).click();
    const order = await page.evaluate(() => { const s = (window as any).__fw.app.getState(); const idx = (type: string) => s.project.tracks.findIndex((t: any) => t.clips.some((c: any) => c.shape?.type === type)); return { heart: idx('heart'), star: idx('star') }; });
    expect(order.heart).toBeGreaterThan(order.star);
    // Colour part of a text.
    await rail(page, 'Elements');
    await page.getByRole('button', { name: 'Add Answer button' }).click();
    await expect(page.locator('.inspector textarea')).toHaveValue('{#e8a200|A)} Answer');
    await page.screenshot({ path: info.outputPath('design.png') });
    expect(errors).toEqual([]);
  });
});
