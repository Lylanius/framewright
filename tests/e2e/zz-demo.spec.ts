import { expect, test } from '@playwright/test';
// Makes the demo quiz video (not part of the normal test run: DEMO=1).
test('demo quiz video', async ({ page }, info) => {
  test.skip(!process.env.DEMO || !!test.info().project.use.isMobile);
  test.setTimeout(300_000);
  await page.goto('/');
  await page.getByRole('button', { name: /^TikTok/ }).click();
  await page.locator('.rail').getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Make a quiz' }).click();
  await page.getByLabel('Quiz title').fill("WHO'S THAT\nCREATURE?");
  await page.getByLabel('First round number').fill('8');
  const rounds = [
    ['/tmp/driplet.png', ['Bubblet', 'Driplet', 'Splashy', 'Aquo'], 1],
    ['/tmp/sproutle.png', ['Leafy', 'Mossbit', 'Sproutle', 'Budling'], 2],
    ['/tmp/emberpup.png', ['Sparkit', 'Moltor', 'Flarebit', 'Emberpup'], 3],
  ] as const;
  for (let r = 0; r < rounds.length; r++) {
    if (r) await page.getByRole('button', { name: 'Add a round' }).click();
    await page.locator('.quiz-round input[type=file]').nth(r).setInputFiles(rounds[r][0]);
    for (let i = 0; i < 4; i++) await page.getByLabel(`Round ${r + 1} answer ${'ABCD'[i]}`).fill(rounds[r][1][i]);
    await page.locator('.quiz-round').nth(r).getByLabel(`Answer ${'ABCD'[rounds[r][2]]} is correct`).check();
  }
  await page.getByRole('button', { name: /Add 3 rounds/ }).click();
  await expect(page.locator('.toast', { hasText: /Made 3 quiz rounds with an intro/ })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'MP4', exact: true }).click();
  await page.locator('.dialog footer .btn.primary').click();
  const save = page.getByRole('button', { name: /Save .*\.mp4/ });
  await expect(save).toBeVisible({ timeout: 280_000 });
  const [d] = await Promise.all([page.waitForEvent('download'), save.click()]);
  await d.saveAs('/tmp/quiz-demo-av1.mp4');
  void info;
});
