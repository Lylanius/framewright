import { expect, test } from '@playwright/test';

test.describe('phase 5: sync folder', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop only');

  test('project edits go to the chosen folder and come back on another device', async ({ page }) => {
    // Stand-in for the folder picker: a private on-disk folder the test can inspect.
    await page.addInitScript(() => {
      (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
        async () => (await navigator.storage.getDirectory()).getDirectoryHandle('sync-test', { create: true });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(page.locator('.sync-card')).toContainText('Syncing edits to');
    await page.getByRole('button', { name: /^TikTok/ }).click();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Pack opening');
    await page.waitForTimeout(6500); // autosave + sync delay
    const files = await page.evaluate(async () => {
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('sync-test');
      const names: string[] = [];
      for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(k);
      return names;
    });
    expect(files.some((n) => n.startsWith('Pack opening (') && n.endsWith('.framewright.json'))).toBe(true);

    // "Another device": the project isn't here yet, but it's in the folder.
    await page.getByRole('button', { name: 'Back to projects' }).click();
    await page.getByRole('button', { name: 'Delete' }).first().click();
    await page.locator('.project-card').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.project-card')).toHaveCount(0);
    await page.reload();
    const incoming = page.locator('.sync-list').getByRole('button', { name: /Pack opening/ });
    await expect(incoming).toBeVisible();
    await incoming.click();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Pack opening');
  });
});
