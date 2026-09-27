import { expect, test } from '@playwright/test';

test.describe('phase 4: recording', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop only');

  test('record camera and a voiceover into the project', async ({ page, context }, info) => {
    await context.grantPermissions(['camera', 'microphone']);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /^TikTok/ }).click();
    await expect(page.locator('.editor')).toBeVisible();

    // Camera
    await page.locator('.import-zone').getByRole('button', { name: 'Record', exact: true }).click();
    await page.getByRole('radio', { name: 'Camera' }).click();
    await expect.poll(() => page.locator('.rec-preview').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.locator('.rec-time')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.locator('.media-tile')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.lane .clip')).toHaveCount(1);
    const dur = await page.locator('.timecode').textContent();
    console.log('camera recording timeline', dur);
    expect(dur).toMatch(/\/ 00:00:0[2-3]:/);
    await page.screenshot({ path: info.outputPath('after-camera.png') });

    // Voiceover at 1 s
    await page.locator('.ruler').click({ position: { x: 81, y: 10 }, force: true });
    await page.locator('.rail').getByRole('button', { name: 'Audio', exact: true }).click();
    await page.locator('.import-zone').getByRole('button', { name: 'Voiceover' }).click();
    await expect(page.getByRole('radio', { name: 'Voiceover' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.locator('.rec-time')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1800);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.locator('.lane.audio .clip')).toHaveCount(1, { timeout: 30_000 });
    const left = await page.locator('.lane.audio .clip').evaluate((el) => parseFloat(getComputedStyle(el).left));
    console.log('voiceover left px', left);
    expect(Math.abs(left - 80)).toBeLessThan(6);
    expect(errors).toEqual([]);
  });
});
