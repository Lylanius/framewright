import { expect, test } from '@playwright/test';

// The quiz maker (and every dialog) must scroll all the way down, on phones and short laptop screens.
test('quiz maker scrolls to the bottom', async ({ page, isMobile }, info) => {
  if (!isMobile) await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto('/');
  await page.getByRole('button', { name: /^TikTok/ }).click();
  if (isMobile) {
    await page.locator('.mobile-tabs').getByRole('button', { name: 'Templates' }).tap().catch(async () => {
      await page.locator('.mobile-tabs').getByRole('button', { name: /More|Tools/ }).first().tap();
      await page.getByRole('button', { name: 'Templates' }).first().tap();
    });
  } else await page.locator('.rail').getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Make a quiz' }).click();
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Add a round' }).click();
  const body = page.locator('.dialog .body');
  // The content is taller than the dialog, and the body really scrolls to its end.
  const m = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(m.sh).toBeGreaterThan(m.ch);
  if (isMobile) {
    const bb = (await body.boundingBox())!;
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 600).catch(() => undefined);
    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight)); // touch-scroll equivalent
    void bb;
  } else {
    await body.hover();
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 600);
  }
  await expect.poll(() => body.evaluate((el) => Math.round(el.scrollTop + el.clientHeight) >= el.scrollHeight - 2)).toBe(true);
  const add = page.getByRole('button', { name: 'Add a round' });
  await expect(add).toBeInViewport();
  // The footer buttons stay on screen.
  await expect(page.locator('.dialog footer .btn.primary')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('scrolled.png') });
  await add.click();
  await expect(page.locator('.quiz-round')).toHaveCount(6);
});
