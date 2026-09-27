import { expect, test } from '@playwright/test';

// Home-screen app on iPhone: the status bar covers the top ~47 px of the page.
// Everything tappable must sit below it. (Chromium has no notch, so the inset is simulated.)
test('nothing is hidden under the iPhone status bar', async ({ page, isMobile }, info) => {
  test.skip(!isMobile);
  await page.goto('/');
  await page.addStyleTag({ content: ':root { --safe-t: 47px !important; }' });
  const below = async (name: string, loc: ReturnType<typeof page.locator>) => {
    const b = (await loc.boundingBox())!;
    expect(b.y, name).toBeGreaterThanOrEqual(47);
  };
  await below('home: Post planner', page.getByRole('button', { name: 'Post planner' }));
  await page.getByRole('button', { name: /^TikTok/ }).click();
  await page.locator('.editor').waitFor();
  await below('editor: Export', page.getByRole('button', { name: 'Export', exact: true }));
  await below('editor: back', page.locator('.topbar button').first());
  await page.screenshot({ path: info.outputPath('editor-safe-top.png') });
  await page.getByRole('button', { name: 'Export', exact: true }).tap();
  await below('export dialog: close', page.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Close' }).first());
  await page.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Close' }).first().tap();
  await page.getByRole('button', { name: 'Post planner' }).tap();
  await below('planner: close', page.getByRole('button', { name: 'Close planner' }));
  // Home-screen mode: the app fills the whole screen (no empty band at the bottom).
  await page.getByRole('button', { name: 'Close planner' }).tap();
  await page.evaluate(() => document.documentElement.classList.add('ios-standalone'));
  const fill = await page.evaluate(() => ({ root: document.getElementById('root')!.getBoundingClientRect().height, editor: document.querySelector('.editor')!.getBoundingClientRect().bottom, vh: innerHeight }));
  expect(Math.abs(fill.root - fill.vh)).toBeLessThan(2);
  expect(Math.abs(fill.editor - fill.vh)).toBeLessThan(2);
});
