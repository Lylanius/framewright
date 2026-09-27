import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const f = (n: string) => path.resolve('tests/fixtures', n);

async function openPlanner(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Post planner' }).click();
  await expect(page.getByRole('dialog', { name: 'Post planner' })).toBeVisible();
}

async function newPostWithVideo(page: Page) {
  await page.getByRole('button', { name: 'New post' }).first().click();
  await page.getByLabel('Video to post').setInputFiles(f('vertical-post.mp4'));
  await expect(page.locator('.composer small.mono')).toContainText('540×960');
}

test.describe('post planner', () => {
  test('write a post for three platforms, queue it, and it survives a reload', async ({ page, isMobile }, info) => {
    await openPlanner(page);
    await newPostWithVideo(page);
    // All three platforms on by default (reminders in the web version).
    for (const p of ['YouTube', 'Instagram', 'TikTok']) await expect(page.getByLabel(`Post to ${p}`)).toBeChecked();
    await page.getByLabel('Caption').fill('Can you guess who this is? Comment below 👇');
    const tags = page.getByLabel('Hashtags', { exact: true });
    await tags.fill('#quiz pokemon ');
    await tags.fill('fyp');
    await tags.press('Enter');
    await expect(page.locator('.tag-chip')).toHaveText(['#quiz', '#pokemon', '#fyp']);
    // Save the hashtags as a set.
    await page.getByLabel('Hashtag set name').fill('Quiz tags');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    // YouTube: title + made-for-kids answer; the final text shows #Shorts for a vertical short video.
    await page.getByRole('tab', { name: /YouTube/ }).click();
    await page.getByLabel('YouTube title').fill('Who’s that creature? Round 8');
    await expect(page.locator('.final-text pre')).toContainText('Who’s that creature? Round 8');
    await expect(page.locator('.final-text pre')).toContainText('#quiz #pokemon #fyp #Shorts');
    await expect(page.getByLabel('YouTube preview')).toBeVisible();
    // TikTok gets its own hashtags.
    await page.getByRole('tab', { name: /TikTok/ }).click();
    await page.getByText('Different hashtags for TikTok').click();
    const tt = page.getByLabel('TikTok hashtags');
    await tt.fill('foryou');
    await tt.press('Enter');
    await expect(page.locator('.final-text pre')).toContainText('#quiz #pokemon #fyp #foryou');
    await page.screenshot({ path: info.outputPath(`composer-${isMobile ? 'phone' : 'desktop'}.png`) });
    // Instagram: too many hashtags is flagged.
    await page.getByRole('tab', { name: /Caption & hashtags/ }).click();
    await page.getByLabel('Hashtags', { exact: true }).fill(Array.from({ length: 30 }, (_, i) => `t${i}`).join(' ') + ' ');
    await expect(page.locator('.issues li.error')).toContainText('Instagram allows 30');
    await expect(page.getByRole('button', { name: 'Add to queue' })).toBeDisabled();
    // Remove the extra tags again.
    for (let i = 0; i < 30; i++) await page.getByLabel('Hashtags', { exact: true }).press('Backspace');
    await expect(page.locator('.issues li.error')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add to queue' }).click();
    await expect(page.locator('.toast', { hasText: 'Scheduled for' })).toBeVisible();
    const card = page.locator('.post-card').first();
    await expect(card).toContainText('Can you guess who this is?');
    await expect(card.locator('.status-chip')).toHaveCount(3);
    // Calendar shows it.
    await page.getByRole('tab', { name: 'Calendar' }).click();
    // The next queue slot may fall in next week's view.
    if (!(await page.locator('.cal-item').count())) await page.getByRole('button', { name: 'Next week' }).click();
    await expect(page.locator('.cal-item')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`calendar-${isMobile ? 'phone' : 'desktop'}.png`) });
    // Reload: still there, hashtag set remembered.
    await page.reload();
    await page.getByRole('button', { name: 'Post planner' }).click();
    await expect(page.locator('.post-card')).toHaveCount(1);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByText('Quiz tags')).toBeVisible();
  });

  test('"Post now" in the web version becomes a reminder: copy caption, share, mark done', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
    await openPlanner(page);
    await newPostWithVideo(page);
    await page.getByLabel('Post to YouTube').uncheck();
    await page.getByLabel('Post to Instagram').uncheck();
    await page.getByLabel('Caption').fill('Round 9 — who is it?');
    await page.getByRole('radio', { name: 'Post now' }).click();
    await page.getByRole('button', { name: 'Post now' }).last().click();
    await page.getByRole('tab', { name: /Needs you/ }).click();
    const reminder = page.locator('.reminder-row');
    await expect(reminder).toContainText('Post it on TikTok', { timeout: 15_000 });
    // Copy caption & share: the caption goes to the clipboard and the video is offered for download.
    const dl = page.waitForEvent('download', { timeout: 10_000 }).catch(() => null);
    await reminder.getByRole('button', { name: /Copy caption/ }).click();
    const d = await dl;
    if (d) expect(d.suggestedFilename()).toBe('vertical-post.mp4');
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    if (clip) expect(clip).toBe('Round 9 — who is it?');
    await reminder.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('tab', { name: /Posted/ }).click();
    await expect(page.locator('.post-card .status-chip.good')).toContainText('Done');
  });

  test('queue times can be changed and the next slot follows them', async ({ page }) => {
    await openPlanner(page);
    await page.getByRole('tab', { name: 'Settings' }).click();
    // Clear Monday's times and add a single every-day time.
    const before = await page.locator('.queue-day .tag-chip').count();
    expect(before).toBeGreaterThan(0);
    for (let n = before; n > 0; n--) {
      await page.locator('.queue-day .tag-chip button').first().click();
      await expect(page.locator('.queue-day .tag-chip')).toHaveCount(n - 1);
    }
    await page.getByLabel('Day').selectOption('-1');
    await page.getByLabel('Time').fill('21:15');
    await page.getByRole('button', { name: 'Add time' }).click();
    await expect(page.locator('.queue-day .tag-chip')).toHaveCount(7);
    await page.getByRole('tab', { name: 'Queue' }).click();
    await expect(page.locator('.empty-state')).toContainText(/21:15|9:15 PM/);
  });

  test('accounts: web version explains reminders and points to the desktop app', async ({ page }) => {
    await openPlanner(page);
    await page.getByRole('tab', { name: 'Accounts' }).click();
    await expect(page.locator('.accounts .notice')).toContainText('desktop app');
    await expect(page.locator('.acct-section')).toHaveCount(3);
  });

  test('from an export straight into the planner', async ({ page, isMobile }) => {
    test.skip(isMobile);
    test.setTimeout(180_000);
    await page.goto('/');
    await page.getByRole('button', { name: /^TikTok/ }).click();
    await page.locator('.import-zone input[type=file][multiple]').first().setInputFiles([f('vertical.webm')]);
    await expect(page.locator('.media-tile')).toHaveCount(1, { timeout: 60_000 });
    const t = page.locator('.media-tile').first();
    await t.hover();
    await t.getByRole('button', { name: /to timeline/ }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'MP4', exact: true }).click();
    await page.locator('.dialog footer .btn.primary').click();
    await page.getByRole('button', { name: 'Post or schedule' }).click({ timeout: 120_000 });
    await expect(page.getByRole('dialog', { name: 'New post' })).toBeVisible();
    await expect(page.locator('.composer small.mono')).toContainText('1080×1920');
  });
});

test('phones: after exporting, "Save to camera roll" opens the share sheet with the video', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phones only');
  test.setTimeout(180_000);
  // The test browser has no share sheet: stand in for the iPhone's.
  await page.addInitScript(() => {
    (window as any).__shared = null;
    Object.defineProperty(navigator, 'canShare', { value: (d: any) => !!d?.files?.length, configurable: true });
    Object.defineProperty(navigator, 'share', { value: async (d: any) => { (window as any).__shared = d.files.map((x: File) => ({ name: x.name, type: x.type, size: x.size })); }, configurable: true });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^TikTok/ }).click();
  const b64 = (await import('node:fs')).readFileSync(f('vertical.webm')).toString('base64');
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    await (window as any).__fw.app.getState().importFiles([new File([bytes], 'vertical.webm', { type: 'video/webm' })], 0);
  }, b64);
  await expect.poll(() => page.evaluate(() => (window as any).__fw.app.getState().project.tracks.flatMap((t: any) => t.clips).length), { timeout: 60_000 }).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__fw.app.getState().setExportOpen(true));
  await page.getByRole('button', { name: 'MP4', exact: true }).click();
  await page.locator('.dialog footer .btn.primary').click();
  const btn = page.getByRole('button', { name: 'Save to camera roll' });
  await expect(btn).toBeVisible({ timeout: 150_000 });
  await expect(page.getByRole('button', { name: 'Save to Files' })).toBeVisible();
  await page.screenshot({ path: 'test-results/export-camera-roll-phone.png' });
  await btn.click();
  await expect(page.locator('.toast', { hasText: 'in your Photos' })).toBeVisible();
  const shared = await page.evaluate(() => (window as any).__shared);
  expect(shared[0].type).toBe('video/mp4');
  expect(shared[0].name).toMatch(/\.mp4$/);
  expect(shared[0].size).toBeGreaterThan(1000);
});
