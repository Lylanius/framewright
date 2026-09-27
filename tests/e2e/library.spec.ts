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
const at = (page: Page, t: number) => page.locator('.ruler').click({ position: { x: t * 80 + 1, y: 10 }, force: true });

test.describe('stickers, templates, brand', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop only');

  test('stickers, shapes, emoji and animated GIFs', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /^TikTok/ }).click();
    await rail(page, 'Elements');
    await page.getByRole('button', { name: 'Add sticker WOW!' }).click();
    await expect(page.locator('.lane .clip')).toHaveCount(1, { timeout: 20_000 });
    await page.keyboard.press('End');
    await page.getByRole('button', { name: 'Add Star shape' }).click();
    await page.keyboard.press('End');
    await page.getByRole('button', { name: 'Add emoji 🔥' }).click();
    await expect(page.locator('.lane .clip')).toHaveCount(3);
    // Shape inspector: recolour the star with the picker.
    await at(page, 4.5);
    await page.locator('.lane .clip', { hasText: 'Star' }).click();
    await expect(page.locator('.inspector')).toContainText('Shape');
    await page.locator('.inspector input[aria-label="Fill colour"]').fill('#00ff00');
    await expect.poll(async () => { const [r, g, b] = await px(page, 0.5, 0.5); return g > 200 && r < 80 && b < 80; }).toBe(true);
    // Motion presets
    await page.getByRole('tab', { name: 'Animate' }).click();
    await page.getByLabel('Loop animation').selectOption('wiggle');
    // Animated GIF: red for the first half second, blue for the second.
    await page.keyboard.press('End');
    await page.locator('.panel input[type=file]').setInputFiles(f('anim.gif'));
    await expect(page.locator('.lane .clip', { hasText: 'anim.gif' })).toHaveCount(1, { timeout: 20_000 });
    await page.keyboard.press('Escape');
    await page.locator('.stage').click({ position: { x: 5, y: 5 } }); // deselect
    await at(page, 10.1); // the GIF sits at 9–12 s; 1.1 s in = frame 1 (red)
    await expect.poll(async () => { const [r, , b] = await px(page, 0.5, 0.5); return r > 200 && b < 60; }).toBe(true);
    await at(page, 10.6);
    await expect.poll(async () => { const [r, , b] = await px(page, 0.5, 0.5); return b > 200 && r < 60; }).toBe(true);
    await page.screenshot({ path: info.outputPath('stickers.png') });
    expect(errors).toEqual([]);
  });

  test('templates: use, fill slots, export, save your own', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /^TikTok/ }).click();
    await rail(page, 'Templates');
    await expect(page.locator('.tpl-card')).toHaveCount(8);
    await page.getByRole('button', { name: 'Use template Before & after' }).click();
    await expect(page.locator('.toast', { hasText: /Started/ })).toBeVisible();
    await expect(page.locator('.clip.slot')).toHaveCount(2);
    await expect(page.locator('.slot-card')).toContainText('2 left');
    await page.screenshot({ path: info.outputPath('template-empty.png') });
    // Export warns about empty slots.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.locator('.dialog')).toContainText('still empty');
    await page.locator('.dialog footer').getByRole('button', { name: 'Close' }).click();
    // Fill both slots in one go.
    await page.locator('.slot-card input[type=file]').setInputFiles([f('scenes.webm'), f('landscape.mp4')]);
    await expect(page.locator('.clip.slot')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.slot-card')).toHaveCount(0);
    const tc = (await page.locator('.timecode').textContent())!;
    expect(tc).toContain('/ 00:00:08:00');
    // Export and check the length.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'MP4', exact: true }).click();
    await page.locator('.dialog footer .btn.primary').click();
    const save = page.getByRole('button', { name: /Save .*\.mp4/ });
    await expect(save).toBeVisible({ timeout: 150_000 });
    const [d] = await Promise.all([page.waitForEvent('download'), save.click()]);
    const out = info.outputPath('template.mp4');
    await d.saveAs(out);
    const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
    expect(Math.abs(dur - 8)).toBeLessThan(0.3);
    await page.getByRole('button', { name: 'Close' }).click();
    // Save it as my own template; it appears in "Your templates" with 2 slots.
    await page.getByRole('button', { name: 'Save this project as a template' }).click();
    await page.getByLabel('Template name').fill('My reveal');
    await page.getByRole('button', { name: 'Save template' }).click();
    await expect(page.locator('.tpl-card', { hasText: 'My reveal' })).toContainText('2 slots');
    expect(errors).toEqual([]);
  });

  test('brand kit: colours, logo, apply to a project', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /^TikTok/ }).click();
    await rail(page, 'Text');
    await page.locator('.text-preset').first().click();
    await rail(page, 'Brand');
    await page.getByRole('button', { name: 'Create one' }).click();
    await page.getByLabel('Brand colour 1').fill('#ff0066');
    await page.getByLabel('Title font').selectOption('Oswald');
    await page.locator('.brand-editor input[type=file][accept^="image"]').setInputFiles(f('photo.png'));
    await expect(page.getByAltText('Logo preview')).toBeVisible();
    await page.getByRole('button', { name: 'Apply brand style' }).click();
    await expect(page.locator('.toast', { hasText: /Restyled 1 item/ })).toBeVisible();
    await page.getByRole('button', { name: 'Add logo' }).click();
    await expect(page.locator('.lane .clip', { hasText: 'Logo' })).toHaveCount(1, { timeout: 20_000 });
    // The title picked up the brand font and colour.
    await page.locator('.lane .clip', { hasText: 'BIG NEWS' }).click();
    await expect(page.getByLabel('Font', { exact: true })).toHaveValue('Oswald');
    await expect(page.getByLabel('Text colour')).toHaveValue('#ff0066');
    // Brand swatches show up in the text inspector.
    await expect(page.getByRole('button', { name: 'Use brand colour #ff0066' }).first()).toBeVisible();
    // Kit survives a reload.
    await page.reload();
    await page.locator('.project-card').first().getByRole('button').first().click();
    await rail(page, 'Brand');
    await expect(page.getByLabel('Brand colour 1')).toHaveValue('#ff0066');
    await page.screenshot({ path: info.outputPath('brand.png') });
    expect(errors).toEqual([]);
  });
});
