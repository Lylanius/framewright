import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const f = (n: string) => path.resolve('tests/fixtures', n);

async function openQuizMaker(page: Page, isMobile: boolean) {
  await page.getByRole('button', { name: /^TikTok/ }).click();
  if (isMobile) {
    await page.locator('.mobile-tabs').getByRole('button', { name: 'Templates' }).tap().catch(async () => {
      await page.locator('.mobile-tabs').getByRole('button', { name: /More|Tools/ }).first().tap();
      await page.getByRole('button', { name: 'Templates' }).first().tap();
    });
  } else await page.locator('.rail').getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Make a quiz' }).click();
}

// A quiz is pictures, shapes and short sound effects (a tick every second).
// Playback must run at real speed, not stop at every tick.
test('quiz preview plays smoothly through the ticking', async ({ page, isMobile }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await openQuizMaker(page, isMobile);
  await page.locator('.quiz-round input[type=file]').first().setInputFiles(f('creature.png'));
  await page.getByLabel('Round 1 answer A').fill('Alpha');
  await page.getByLabel('Round 1 answer B').fill('Beta');
  await page.getByRole('button', { name: /Add 1 round/ }).click();
  await expect(page.locator('.toast', { hasText: /Made 1 quiz round/ })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1000);
  const t0 = await page.evaluate(() => (window as any).__fw.time.getState().time);
  const wall0 = Date.now();
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(5000);
  const t1 = await page.evaluate(() => (window as any).__fw.time.getState().time);
  const wall = (Date.now() - wall0) / 1000;
  const stats = await page.evaluate(() => ({ ...(window as any).__fwPlayer.stats }));
  console.log('quiz playback', { advanced: t1 - t0, wall, holds: stats.holds });
  // Within ~10% of real time (the old behaviour lost about a second at every tick).
  expect(t1 - t0).toBeGreaterThan(wall * 0.85);
});

test('quiz maker shows a live preview of the chosen options', async ({ page, isMobile }) => {
  await page.goto('/');
  await openQuizMaker(page, isMobile);
  const canvas = page.getByRole('img', { name: 'Quiz preview' });
  await expect(canvas).toBeVisible();
  const colourAt = () => canvas.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(8, 8, 1, 1).data.slice(0, 3)));
  await page.waitForTimeout(400);
  const red = await colourAt();
  expect(red[0]).toBeGreaterThan(150); // default red background
  // Changing the background colour shows up in the preview.
  await page.getByLabel('Background colour').fill('#1060e0');
  await page.waitForTimeout(400);
  const blue = await colourAt();
  expect(blue[2]).toBeGreaterThan(blue[0]);
  await page.locator('.quiz-round input[type=file]').first().setInputFiles(path.resolve('tests/fixtures/creature.png'));
  await page.getByLabel('Round 1 answer A').fill('Alpha');
  await page.getByRole('button', { name: 'Answer', exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `test-results/quiz-preview-${isMobile ? 'phone' : 'desktop'}.png` });
});

test('zoomed-in question: choose the exact close-up in the editor, then it zooms out at the reveal', async ({ page, isMobile }, info) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await openQuizMaker(page, isMobile);
  await page.getByLabel('Start with an intro').uncheck();
  await page.locator('.quiz-round input[type=file]').first().setInputFiles(f('creature.png'));
  // Open the close-up editor for round 1.
  await page.getByRole('button', { name: 'Choose close-up for round 1' }).click();
  const stage = page.getByRole('slider', { name: 'Close-up position' });
  await expect(stage).toBeVisible();
  const before = await stage.getAttribute('aria-valuetext');
  console.log('suggested', before);
  // Set this round's zoom to 5×, then drag the circle to the lower-left of the picture.
  const zoomInput = page.locator('.zoom-side input[type=number]');
  await zoomInput.fill('5');
  await zoomInput.press('Enter');
  await expect(stage).toHaveAttribute('aria-valuetext', /5\.0 times zoom/);
  const win = page.locator('.zoom-window');
  const w = (await win.boundingBox())!, s = (await stage.boundingBox())!;
  const tx = s.x + s.width * 0.3, ty = s.y + s.height * 0.72;
  if (isMobile) {
    // Tapping outside the circle moves it there.
    await page.mouse.click(tx, ty);
  } else {
    await page.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 8 });
    await page.mouse.up();
  }
  const after = (await stage.getAttribute('aria-valuetext'))!;
  expect(after).not.toBe(before);
  const [ax, ay] = after.match(/(\d+)% across, (\d+)% down/)!.slice(1).map(Number);
  expect(ax).toBeLessThan(45);
  expect(ay).toBeGreaterThan(55);
  await expect(page.getByRole('img', { name: 'Close-up preview' })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`zoom-editor-${isMobile ? 'phone' : 'desktop'}.png`) });
  await page.getByRole('button', { name: 'Use this close-up' }).click();
  await expect(stage).toHaveCount(0);
  // The quiz maker is still open (Escape/closing the editor must not close it), badge shows 5×.
  await expect(page.locator('.zoom-badge')).toHaveText('5.0×');
  await page.getByLabel('Round 1 answer A').fill('Alpha');
  await page.getByLabel('Round 1 answer B').fill('Beta');
  await page.getByRole('button', { name: /Add 1 round/ }).click();
  await expect(page.locator('.toast', { hasText: /Made 1 quiz round/ })).toBeVisible({ timeout: 60_000 });
  const clip = await page.evaluate(() => {
    const p = (window as any).__fw.app.getState().project;
    const c = p.tracks.flatMap((t: any) => t.clips).find((x: any) => x.kind === 'image');
    return { crop: c.transform.crop, masks: c.masks.length, keys: Object.keys(c.keyframes) };
  });
  expect(clip.masks).toBe(1);
  // creature.png is square: a 5× close-up is a fifth of the picture, centred where we dragged it.
  expect(1 - clip.crop.left - clip.crop.right).toBeCloseTo(0.2, 2);
  expect(clip.crop.left + 0.1).toBeCloseTo(ax / 100, 1);
  expect(clip.crop.top + 0.1).toBeCloseTo(ay / 100, 1);
  expect(clip.keys).toEqual(expect.arrayContaining(['scale', 'crop.left', 'crop.top']));
});

test('Escape closes only the close-up editor, not the quiz maker', async ({ page, isMobile }) => {
  test.skip(isMobile);
  await page.goto('/');
  await openQuizMaker(page, isMobile);
  await page.locator('.quiz-round input[type=file]').first().setInputFiles(f('creature.png'));
  await page.getByRole('button', { name: 'Choose close-up for round 1' }).click();
  await expect(page.getByRole('dialog', { name: /Close-up for round 1/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /Close-up for round 1/ })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Quiz maker' })).toBeVisible();
});

test('record your own intro shout and add the sting', async ({ page, isMobile }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await openQuizMaker(page, isMobile);
  await expect(page.getByLabel('Quiz title')).toHaveValue("WHO'S THAT\nPOKÉMON?");
  await expect(page.getByRole('radio', { name: 'Boom' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Sting' }).click();
  // The test browser's fake microphone plays a beep.
  await page.getByRole('button', { name: 'Record your voice' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByText('Intro voice (recorded).wav')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Hear your intro voice' })).toBeVisible();
  await page.locator('.quiz-round input[type=file]').first().setInputFiles(f('creature.png'));
  await page.getByLabel('Round 1 answer A').fill('Alpha');
  await page.getByLabel('Round 1 answer B').fill('Beta');
  await page.getByRole('button', { name: 'Hear your intro voice' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/quiz-voice-${isMobile ? 'phone' : 'desktop'}.png` });
  await page.getByRole('button', { name: /Add 1 round/ }).click();
  await expect(page.locator('.toast', { hasText: /Made 1 quiz round/ })).toBeVisible({ timeout: 60_000 });
  const names = await page.evaluate(() => (window as any).__fw.app.getState().project.tracks.flatMap((t: any) => t.clips.map((c: any) => c.name)));
  expect(names.some((n: string) => /Mystery sting/.test(n))).toBe(true);
  expect(names.some((n: string) => /Intro voice/.test(n))).toBe(true);
  expect(names.some((n: string) => /Boom/.test(n))).toBe(false);
});

test('the first round number can be cleared and retyped', async ({ page, isMobile }) => {
  await page.goto('/');
  await openQuizMaker(page, isMobile);
  const box = page.getByLabel('First round number');
  await box.click();
  await box.press('End');
  await box.press('Backspace');
  await expect(box).toHaveValue('');
  await box.pressSequentially('27');
  await expect(box).toHaveValue('27');
  await box.fill('');
  await box.blur();
  await expect(box).toHaveValue('27'); // left empty: keeps the last number
});

test('a quiz video opens on the title card, so that is its cover', async ({ page, isMobile }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await openQuizMaker(page, isMobile);
  await page.locator('.quiz-round input[type=file]').first().setInputFiles(f('creature.png'));
  await page.getByLabel('Round 1 answer A').fill('Alpha');
  await page.getByLabel('Round 1 answer B').fill('Beta');
  await page.getByRole('button', { name: /Add 1 round/ }).click();
  await expect(page.locator('.toast', { hasText: /Made 1 quiz round/ })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => { (window as any).__fw.time.getState().setTime(0); (window as any).__fw.app.getState().player?.seek(0); });
  await page.waitForTimeout(1200);
  const canvas = page.locator('.preview canvas, canvas.preview-canvas, .stage canvas').first();
  await canvas.screenshot({ path: `test-results/quiz-cover-${isMobile ? 'phone' : 'desktop'}.png` });
  // Title letters are yellow: plenty of yellow in the middle of the very first frame.
  const yellow = await canvas.evaluate((c: HTMLCanvasElement) => {
    const t = document.createElement('canvas'); t.width = 90; t.height = 160;
    const x = t.getContext('2d')!; x.drawImage(c, 0, 0, 90, 160);
    const d = x.getImageData(0, 48, 90, 64).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 170 && d[i + 2] < 120) n++;
    return n;
  });
  expect(yellow).toBeGreaterThan(150);
});
