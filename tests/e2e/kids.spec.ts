import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const f = (n: string) => path.resolve('tests/fixtures', n);
const state = (page: Page) => page.evaluate(() => {
  const p = (window as any).__fw.app.getState().project;
  if (!p) return null;
  const main = p.tracks.find((t: any) => t.name === 'Main');
  return {
    kids: !!p.kids, strip: main.clips.length, joins: p.kids?.joins ?? null,
    extras: p.tracks.filter((t: any) => t !== main && t.name !== 'Music').flatMap((t: any) => t.clips.map((c: any) => c.kind)),
    music: (p.tracks.find((t: any) => t.name === 'Music')?.clips ?? []).length,
    effects: main.clips.flatMap((c: any) => c.effects.map((e: any) => e.type)),
  };
});

async function enterKids(page: Page, tag: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Kids Studio' }).click();
  await expect(page.getByLabel('Child’s name')).toHaveValue('Molly');
  await expect(page.getByRole('button', { name: 'Start Kids Studio' })).toBeDisabled(); // needs a PIN first
  await page.getByLabel('Grown-up PIN').fill('2580');
  await page.screenshot({ path: `test-results/kids-start-${tag}.png` });
  await page.getByRole('button', { name: 'Start Kids Studio' }).click();
  await expect(page.getByRole('heading', { name: /Hi Molly!/ })).toBeVisible();
}

test('Kids Studio: make a video with stickers, words, music, sounds and colours, then save it', async ({ page, isMobile }) => {
  test.setTimeout(240_000);
  const tag = isMobile ? 'phone' : 'desktop';
  await enterKids(page, tag);
  await page.screenshot({ path: `test-results/kids-home-${tag}.png` });
  await page.getByRole('button', { name: /New tall video/ }).click();
  await expect(page.getByLabel('Video name')).toHaveValue('Molly’s video 1');
  // Add a video and a photo.
  await page.getByLabel('Photos and videos', { exact: true }).setInputFiles([f('vertical.webm'), f('creature.png')]);
  await expect.poll(async () => (await state(page))?.strip, { timeout: 60_000 }).toBe(2);
  await expect(page.locator('.k-clip:not(.add)')).toHaveCount(2);
  // Sticker.
  await page.getByRole('button', { name: 'Stickers' }).click();
  await page.getByRole('button', { name: 'Add 🦄' }).click();
  await expect(page.locator('.k-sel')).toBeVisible(); // it's selected, ready to move
  await page.getByRole('button', { name: 'Bigger' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  // Words.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByLabel('Your text').fill('My best day!');
  await page.getByRole('radio', { name: /Comic/ }).click();
  await page.getByRole('radio', { name: 'Colour #ffd23f' }).click();
  await page.getByRole('radio', { name: 'Type', exact: true }).click();
  await page.screenshot({ path: `test-results/kids-text-${tag}.png` });
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.getByRole('button', { name: 'Motion' }).click();
  await page.getByRole('button', { name: /Wiggle/ }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  // Music.
  await page.getByRole('button', { name: 'Music' }).click();
  await page.getByRole('button', { name: /Happy Hop/ }).first().click();
  await expect.poll(async () => (await state(page))?.music, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: `test-results/kids-music-${tag}.png` });
  await page.getByRole('button', { name: 'Close' }).click();
  // A sound.
  await page.getByRole('button', { name: 'Sounds' }).click();
  await page.getByRole('button', { name: /Boing/ }).click();
  await expect.poll(async () => (await state(page))?.extras.filter((k: string) => k === 'audio').length, { timeout: 20_000 }).toBe(1);
  await page.getByRole('button', { name: 'Close' }).click();
  // Joins + colours on the first clip.
  await page.getByRole('button', { name: 'Transitions' }).click();
  await page.getByRole('button', { name: /Spin/ }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.locator('.k-clip:not(.add)').first().click();
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('button', { name: /Rainbow/ }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Speed' }).click();
  await page.getByRole('button', { name: /Fast/ }).first().click();
  await page.getByRole('button', { name: 'Close' }).click();
  // Split the first clip at the playhead, then copy a piece.
  await page.evaluate(() => (window as any).__fw.app.getState().player?.seek(0.7));
  await page.getByRole('button', { name: 'Split' }).click();
  await expect(page.locator('.k-clip:not(.add)')).toHaveCount(3);
  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.locator('.k-clip:not(.add)')).toHaveCount(4);
  await page.getByRole('button', { name: 'Volume' }).click();
  await page.getByRole('button', { name: /Quiet/ }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.screenshot({ path: `test-results/kids-cliptools-${tag}.png` });
  const s = await state(page);
  expect(s).toMatchObject({ kids: true, strip: 4, joins: 'spin', music: 1 });
  const text = await page.evaluate(() => (window as any).__fw.app.getState().project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.kind === 'text'));
  expect(text.text).toMatchObject({ color: '#ffd23f', animIn: 'typewriter', fontFamily: 'Bangers' });
  expect(text.motion.loop).toBe('wiggle');
  expect(s!.extras.sort()).toEqual(['audio', 'shape', 'text']);
  expect(s!.effects).toContain('adjust');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.evaluate(() => (window as any).__fw.app.getState().player?.seek(1.2));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `test-results/kids-editor-${tag}.png` });
  // Oops undoes the last change.
  await page.getByRole('button', { name: 'Undo' }).click();
  // Save: makes the video and offers it.
  await page.getByRole('button', { name: 'Save video' }).click();
  await expect(page.getByRole('heading', { name: /Your video is ready/ })).toBeVisible({ timeout: 180_000 });
  await page.screenshot({ path: `test-results/kids-saved-${tag}.png` });
  await page.getByRole('button', { name: 'Back to my video' }).click();
  // Home lists it; reload keeps Kids Studio on.
  await page.getByRole('button', { name: 'My videos' }).click();
  await expect(page.locator('.k-video')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Hi Molly!/ })).toBeVisible();
  await expect(page.locator('.k-video')).toHaveCount(1);
});

test('leaving Kids Studio needs the grown-up PIN (or a long sum if it’s forgotten)', async ({ page, isMobile }) => {
  const tag = isMobile ? 'phone' : 'desktop';
  await enterKids(page, tag);
  await page.getByRole('button', { name: 'Grown-ups' }).click();
  await page.getByLabel('PIN').fill('1111');
  await page.getByRole('button', { name: 'Leave Kids Studio' }).click();
  await expect(page.getByText('That’s not the PIN.')).toBeVisible();
  await page.screenshot({ path: `test-results/kids-gate-${tag}.png` });
  // Forgot it: a long multiplication instead.
  await page.getByRole('button', { name: 'Forgot the PIN?' }).click();
  const q = await page.locator('.k-sum').textContent();
  const [a, b] = q!.match(/\d+/g)!.map(Number);
  expect(a).toBeGreaterThanOrEqual(23);
  expect(b).toBeGreaterThanOrEqual(13);
  await page.getByRole('button', { name: 'Use the PIN' }).click();
  await page.getByLabel('PIN').fill('2580');
  await page.getByRole('button', { name: 'Leave Kids Studio' }).click();
  await expect(page.getByRole('button', { name: 'Post planner' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Post planner' })).toBeVisible();
  // Next time the PIN is remembered (blank = keep it).
  await page.getByRole('button', { name: 'Kids Studio' }).click();
  await expect(page.getByRole('button', { name: 'Start Kids Studio' })).toBeEnabled();
});
