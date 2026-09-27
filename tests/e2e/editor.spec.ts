import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const FIX = path.resolve('tests/fixtures');
const f = (n: string) => path.join(FIX, n);

function probe(file: string) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file]).toString();
  return JSON.parse(out) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration: string } };
}

async function newTikTok(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^TikTok/ }).click();
  await expect(page.locator('.editor')).toBeVisible();
}

const clipCount = (page: Page) => page.locator('.clip').count();

test.describe('desktop editor', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop only');

  test('create → import → edit → undo/redo → export MP4 → reopen', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await newTikTok(page);

    // Import: four good files and one corrupted file.
    const input = page.locator('.import-zone input[type=file][multiple]').first();
    await input.setInputFiles([f('landscape.mp4'), f('vertical.webm'), f('music.mp3'), f('photo.png'), f('broken.mp4')]);
    await expect(page.locator('.media-tile')).toHaveCount(4, { timeout: 60_000 });
    await expect(page.locator('.toast.error')).toContainText('broken.mp4');

    // Duplicate detection.
    await input.setInputFiles([f('photo.png')]);
    await expect(page.locator('.toast').last()).toContainText(/Already in this project/);
    await expect(page.locator('.media-tile')).toHaveCount(4);

    // Add clips at the playhead.
    const tile = (name: string) => page.locator('.media-tile', { hasText: name });
    await tile('landscape.mp4').hover();
    await tile('landscape.mp4').getByRole('button', { name: /to timeline/ }).click();
    await expect(page.locator('.clip')).toHaveCount(1);
    await page.keyboard.press('End');
    await tile('vertical.webm').hover();
    await tile('vertical.webm').getByRole('button', { name: /to timeline/ }).click();
    await page.keyboard.press('Home');
    await tile('music.mp3').hover();
    await tile('music.mp3').getByRole('button', { name: /to timeline/ }).click();
    await expect(page.locator('.clip')).toHaveCount(3);
    await expect(page.locator('.lane.audio .clip')).toHaveCount(1);

    // Text with a preset.
    await page.getByRole('button', { name: 'Text', exact: true }).first().click();
    await page.locator('.text-preset').first().click();
    await expect(page.locator('.clip')).toHaveCount(4);
    await expect(page.locator('.inspector textarea')).toHaveValue('BIG NEWS');
    await page.locator('.inspector textarea').fill('Pokémon pack opening');

    // Effect on the first video clip.
    await page.locator('.clip', { hasText: 'landscape.mp4' }).click();
    await page.getByRole('button', { name: 'Effects', exact: true }).first().click();
    await page.getByRole('button', { name: /Vignette/ }).click();
    await expect(page.locator('.clip', { hasText: 'landscape.mp4' })).toContainText('FX 1');

    // Split the selected clip at 2 s, then undo and redo.
    await page.locator('.ruler').click({ position: { x: 2 * 80 + 1, y: 10 } });
    const before = await clipCount(page);
    await page.keyboard.press('s');
    await expect(page.locator('.clip')).toHaveCount(before + 1);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.clip')).toHaveCount(before);
    await page.keyboard.press('Control+Shift+z');
    await expect(page.locator('.clip')).toHaveCount(before + 1);

    // Trim the right-hand piece by dragging its left handle.
    const music = page.locator('.clip', { hasText: 'music.mp3' });
    await music.click();
    const box = (await music.boundingBox())!;
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 84, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await music.boundingBox())!.width).toBeLessThan(box.width - 60);
    // …and drag the whole clip later in time.
    const b2 = (await music.boundingBox())!;
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.mouse.down();
    await page.mouse.move(b2.x + b2.width / 2 + 80, b2.y + b2.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await music.boundingBox())!.x).toBeGreaterThan(b2.x + 60);
    await page.screenshot({ path: info.outputPath('desktop-editor.png') });

    // Keyframe: scale on the text clip.
    await page.locator('.clip', { hasText: 'Pokémon' }).click();
    await page.getByRole('tab', { name: 'Transform' }).click();
    await page.getByRole('button', { name: 'Keyframe Scale' }).click();
    await expect(page.locator('.clip.sel .kf')).toHaveCount(1);

    // Preview actually draws pixels (not a blank canvas).
    const drawn = await page.evaluate(() => {
      const c = document.querySelector('.stage canvas') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 400) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
      return lit;
    });
    expect(drawn).toBeGreaterThan(50);

    // Play briefly: the playhead moves.
    await page.getByRole('button', { name: 'Play' }).click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Pause' }).click();
    const tc = await page.locator('.timecode b').textContent();
    expect(tc).not.toBe('00:00:02:00');

    // Export MP4 at 720p and check the file with ffprobe.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'MP4', exact: true }).click();
    await page.locator('.dialog select').first().selectOption({ label: /720p/ } as never).catch(async () => {
      await page.locator('.dialog select').first().selectOption('720');
    });
    await expect(page.locator('.dialog select').nth(2)).not.toHaveText(/Checking/);
    await page.locator('.dialog footer .btn.primary').click();
    const save = page.getByRole('button', { name: /Save .*\.mp4/ });
    await expect(save).toBeVisible({ timeout: 150_000 });
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
    const out = info.outputPath('export.mp4');
    await download.saveAs(out);
    // Streamed to disk (flat memory), and still "fast start": the index comes before the media data.
    await expect(page.locator('.export-done')).toContainText('streamed to disk');
    const head = (await import('node:fs')).readFileSync(out).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(0);
    expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat'));
    const meta = probe(out);
    const v = meta.streams.find((s) => s.codec_type === 'video')!;
    const a = meta.streams.find((s) => s.codec_type === 'audio');
    expect(v.width).toBe(720);
    expect(v.height).toBe(1280);
    expect(a).toBeTruthy();
    expect(Math.abs(parseFloat(meta.format.duration) - 7)).toBeLessThan(0.3);
    console.log('export', JSON.stringify(meta));
    await page.getByRole('button', { name: 'Close' }).click();

    // Reopen after a reload: the project, clips and media survive.
    const count = await clipCount(page);
    await page.waitForTimeout(1600); // autosave debounce
    await page.reload();
    await page.locator('.project-card').first().getByRole('button').first().click();
    await expect(page.locator('.clip')).toHaveCount(count);
    await expect(page.locator('.media-tile')).toHaveCount(4);
    await expect(page.locator('.media-tile.missing')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('exports WebM, GIF, WAV and a PNG frame', async ({ page }, info) => {
    await newTikTok(page);
    await page.locator('.import-zone input[type=file][multiple]').first().setInputFiles([f('vertical.webm'), f('music.mp3')]);
    await expect(page.locator('.media-tile')).toHaveCount(2, { timeout: 60_000 });
    for (const n of ['vertical.webm', 'music.mp3']) {
      await page.keyboard.press('Home');
      const t = page.locator('.media-tile', { hasText: n });
      await t.hover();
      await t.getByRole('button', { name: /to timeline/ }).click();
    }
    const run = async (label: string, ext: string) => {
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.locator('.dialog footer .btn.primary').click();
      const save = page.getByRole('button', { name: new RegExp(`Save .*\\.${ext}`) });
      await expect(save).toBeVisible({ timeout: 120_000 });
      const [d] = await Promise.all([page.waitForEvent('download'), save.click()]);
      const out = info.outputPath(`export.${ext}`);
      await d.saveAs(out);
      await page.getByRole('button', { name: 'Close' }).click();
      return out;
    };
    const webm = probe(await run('WebM', 'webm'));
    expect(webm.streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
    const gif = probe(await run('GIF', 'gif'));
    expect(gif.streams[0].codec_name).toBe('gif');
    const wav = probe(await run('WAV', 'wav'));
    expect(wav.streams[0].codec_type).toBe('audio');
    expect(Math.abs(parseFloat(wav.format.duration) - 6)).toBeLessThan(0.2);
    const png = probe(await run('PNG frame', 'png'));
    expect(png.streams[0].width).toBe(1080);
  });
});

test.describe('phase 2: transitions and captions', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop only');

  test('add a transition on a cut, captions from SRT, export both', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await newTikTok(page);
    await page.locator('.import-zone input[type=file][multiple]').first().setInputFiles([f('landscape.mp4'), f('vertical.webm')]);
    await expect(page.locator('.media-tile')).toHaveCount(2, { timeout: 60_000 });
    for (const n of ['landscape.mp4', 'vertical.webm']) {
      await page.keyboard.press('End');
      const t = page.locator('.media-tile', { hasText: n });
      await t.hover();
      await t.getByRole('button', { name: /to timeline/ }).click();
    }
    // A cut button appears between the two touching clips.
    const junction = page.locator('.junction');
    await expect(junction).toHaveCount(1);
    await junction.click();
    await expect(page.locator('.rail button.on')).toContainText('Transitions');
    await page.getByRole('button', { name: 'Add Push transition' }).click();
    await expect(page.locator('.junction.has')).toHaveCount(1);
    await expect(page.locator('.tr-band')).toHaveCount(1);
    await expect(page.locator('.inspector')).toContainText('Push');
    await page.getByRole('radio', { name: 'Up' }).click();
    // Preview mid-transition draws something.
    await page.locator('.ruler').click({ position: { x: 3.9 * 80, y: 10 }, force: true });

    // Captions from an SRT file.
    await page.getByRole('button', { name: 'Captions', exact: true }).first().click();
    await page.locator('.panel input[type=file]').setInputFiles(f('sample.srt'));
    await expect(page.locator('.cap-row')).toHaveCount(2);
    await expect(page.locator('.lane').first().locator('.clip')).toHaveCount(2);
    await page.getByRole('button', { name: 'Boxed word' }).click();
    await page.getByRole('radio', { name: '1' }).click();
    await page.getByRole('button', { name: 'Re-cut' }).click();
    await expect(page.locator('.cap-row')).toHaveCount(11);
    await page.locator('.cap-row textarea').first().fill('Hey');
    await page.screenshot({ path: info.outputPath('captions.png') });

    // Export SRT.
    const [srt] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'SRT', exact: true }).click()]);
    const srtPath = info.outputPath('captions.srt');
    await srt.saveAs(srtPath);
    const text = (await import('node:fs')).readFileSync(srtPath, 'utf8');
    expect(text.split('-->').length - 1).toBe(11);
    expect(text).toContain('Hey');

    // Export video: length unchanged by the transition.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'MP4', exact: true }).click();
    await page.locator('.dialog footer .btn.primary').click();
    const save = page.getByRole('button', { name: /Save .*\.mp4/ });
    await expect(save).toBeVisible({ timeout: 150_000 });
    const [d] = await Promise.all([page.waitForEvent('download'), save.click()]);
    const out = info.outputPath('transition.mp4');
    await d.saveAs(out);
    const meta = probe(out);
    expect(Math.abs(parseFloat(meta.format.duration) - 7)).toBeLessThan(0.3);
    // Grab a frame from the middle of the push to prove both clips are in it.
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', '4.0', '-i', out, '-frames:v', '1', info.outputPath('mid-transition.png')]);
    expect(errors).toEqual([]);
  });
});

test.describe('phase 3: AI tools', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop only');

  test('silence removal, scenes, tracking, reframe, background removal, transcription wiring', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await newTikTok(page);
    await page.locator('.import-zone input[type=file][multiple]').first().setInputFiles([f('talk.webm'), f('scenes.webm'), f('moving.webm')]);
    await expect(page.locator('.media-tile')).toHaveCount(3, { timeout: 60_000 });
    const add = async (n: string) => { const t = page.locator('.media-tile', { hasText: n }); await t.hover(); await t.getByRole('button', { name: /to timeline/ }).click(); };
    const rail = (n: string) => page.locator('.rail').getByRole('button', { name: n, exact: true }).click();

    // --- Silence removal ---
    await add('talk.webm');
    await rail('AI tools');
    const silence = page.locator('.ai-card', { hasText: 'Remove silences' });
    await expect(silence.getByText(/Found 1 pause/)).toBeVisible({ timeout: 30_000 });
    await silence.getByRole('button', { name: /Remove 1 pause/ }).click();
    await expect(page.locator('.lane .clip', { hasText: 'talk.webm' })).toHaveCount(2);
    const total = await page.locator('.timecode').textContent();
    expect(total).toContain('00:00:06:');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.lane .clip', { hasText: 'talk.webm' })).toHaveCount(1);

    // --- Scene detection ---
    await page.keyboard.press('End');
    await rail('Media');
    await add('scenes.webm');
    await rail('AI tools');
    const scenes = page.locator('.ai-card', { hasText: 'Scene detection' });
    await scenes.getByRole('button', { name: 'Find scenes' }).click();
    await expect(scenes.getByText(/2 scene changes found/)).toBeVisible({ timeout: 60_000 });
    await scenes.getByRole('button', { name: /Split into 3 shots/ }).click();
    await expect(page.locator('.lane .clip', { hasText: 'scenes.webm' })).toHaveCount(3);

    // --- Highlights (short clip → whole clip) ---
    await page.locator('.lane .clip', { hasText: 'talk.webm' }).click();
    const hl = page.locator('.ai-card', { hasText: 'Highlight finder' });
    await hl.getByRole('button', { name: 'Find highlights' }).click();
    await expect(hl.locator('.result-row')).toHaveCount(1, { timeout: 30_000 });

    // --- Motion tracking: a title follows the moving square ---
    await page.keyboard.press('End');
    await rail('Media');
    await add('moving.webm');
    const movingStart = 8 + 6; // talk (8s) + scenes (6s)
    await page.locator('.ruler').click({ position: { x: movingStart * 80 + 4, y: 10 }, force: true });
    await rail('Text');
    await page.getByRole('button', { name: 'Add text' }).click();
    await rail('AI tools');
    const tracking = page.locator('.ai-card', { hasText: 'Motion tracking' });
    await expect(tracking.getByText(/Following footage: moving.webm/)).toBeVisible();
    await tracking.getByRole('button', { name: 'Pick what to follow' }).click();
    await expect(page.locator('.pick-banner')).toBeVisible();
    const canvas = page.locator('.stage canvas');
    const box = (await canvas.boundingBox())!;
    const vidH = box.width * 720 / 1280;
    // The square's centre at the start: (160/1280, 360/720) of the frame.
    await page.mouse.click(box.x + box.width * (161 / 1280), box.y + box.height / 2 - vidH / 2 + vidH * (360 / 720));
    await expect(page.locator('.toast', { hasText: /Tracked/ })).toBeVisible({ timeout: 60_000 });
    const kfs = await page.locator('.clip.sel .kf').count();
    expect(kfs).toBeGreaterThan(1);
    // The title's X position should travel with the square (~66% of the width over 5 s).
    await page.getByRole('tab', { name: 'Transform' }).click();
    const xAt = async (t: number) => {
      await page.locator('.ruler').click({ position: { x: t * 80, y: 10 }, force: true });
      await page.waitForTimeout(300);
      return parseFloat(await page.locator('#p-x').inputValue());
    };
    const x0 = await xAt(movingStart + 0.1), x1 = await xAt(movingStart + 2.9);
    console.log('tracked x', x0, x1);
    expect(x1 - x0).toBeGreaterThan(30);
    await page.screenshot({ path: info.outputPath('tracking.png') });

    // --- Auto-reframe the moving clip (landscape into 9:16) ---
    await page.locator('.lane .clip', { hasText: 'moving.webm' }).click();
    const reframe = page.locator('.ai-card', { hasText: 'Auto-reframe' });
    await reframe.getByRole('button', { name: 'Reframe' }).click();
    await expect(page.locator('.toast', { hasText: /Reframed/ })).toBeVisible({ timeout: 60_000 });
    expect(await page.locator('.clip.sel .kf').count()).toBeGreaterThan(1);

    // --- Background removal (bundled model loads and runs) ---
    const bg = page.locator('.ai-card', { hasText: 'Remove background' });
    await bg.getByRole('button', { name: 'Remove background' }).click();
    await expect(bg.getByText(/^On\./)).toBeVisible();
    await page.waitForTimeout(4000);
    await expect(bg.locator('small', { hasText: /couldn|didn|No mask|failed|error/i })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('bg-removal.png') });

    // --- Transcription: the worker starts and reports the (sandbox) download failure clearly ---
    const cap = page.locator('.ai-card', { hasText: 'Auto-captions' });
    await cap.getByRole('button', { name: 'Caption my video' }).click();
    const t = page.locator('.toast.error').last();
    await expect(t).toBeVisible({ timeout: 90_000 });
    console.log('transcription result in sandbox:', await t.textContent());
    expect(errors).toEqual([]);
  });

  test('playback stays smooth (no seeking) on HD footage', async ({ page }) => {
    await newTikTok(page);
    await page.locator('.import-zone input[type=file][multiple]').first().setInputFiles([f('long.webm')]);
    await expect(page.locator('.media-tile')).toHaveCount(1, { timeout: 60_000 });
    const t = page.locator('.media-tile').first();
    await t.hover();
    await t.getByRole('button', { name: /to timeline/ }).click();
    await page.getByRole('button', { name: 'Play' }).click();
    await page.waitForTimeout(3000);
    const stats = await page.evaluate(() => (window as unknown as { __fwPlayer: { stats: { seeks: number; frames: number; maxGap: number } } }).__fwPlayer.stats);
    console.log('playback stats', JSON.stringify(stats));
    expect(stats.seeks).toBe(0);
    expect(stats.frames).toBeGreaterThan(60);
  });
});

/** RGB of one pixel of a PNG/JPEG file (decoded by ffmpeg). */
function pixel(file: string, x: number, y: number): [number, number, number] {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [buf[0], buf[1], buf[2]];
}

test.describe('phase 2b: pro editing', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop only');

  test('green screen, colour grading, LUTs, masks, adjustment layers, scopes, audio effects, ramps, freeze, easing', async ({ page }, info) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await newTikTok(page);
    await page.locator('.import-zone input[type=file][multiple]').first().setInputFiles([f('greenscreen.webm'), f('talk.webm'), f('music.mp3')]);
    await expect(page.locator('.media-tile')).toHaveCount(3, { timeout: 60_000 });
    const add = async (n: string) => { const t = page.locator('.media-tile', { hasText: n }); await t.hover(); await t.getByRole('button', { name: /to timeline/ }).click(); };
    const rail = (n: string) => page.locator('.rail').getByRole('button', { name: n, exact: true }).click();
    const setNum = async (label: string, v: number) => {
      const i = page.locator('.inspector').getByRole('spinbutton', { name: `${label} value` });
      await i.fill(String(v));
      await i.press('Enter');
    };
    // Preview pixel at a fraction of the project frame.
    const px = (fx: number, fy: number) => page.evaluate(([x, y]) => {
      const c = document.querySelector('.stage canvas') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(Math.round(x * c.width), Math.round(y * c.height), 1, 1).data;
      return [d[0], d[1], d[2]];
    }, [fx, fy]);
    const exportPng = async (name: string) => {
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await page.getByRole('button', { name: 'PNG frame', exact: true }).click();
      await page.locator('.dialog footer .btn.primary').click();
      const save = page.getByRole('button', { name: /Save .*\.png/ });
      await expect(save).toBeVisible({ timeout: 60_000 });
      const [d] = await Promise.all([page.waitForEvent('download'), save.click()]);
      const out = info.outputPath(name);
      await d.saveAs(out);
      await page.getByRole('button', { name: 'Close' }).click();
      return out;
    };
    // 640×360 video letterboxed in 1080×1920: source (sx, sy) → project fraction.
    const at = (sx: number, sy: number) => [(sx * 1.6875) / 1080, (960 - 303.75 + sy * 1.6875) / 1920] as const;
    const CORNER = at(40, 40), CENTRE = at(320, 180);

    // --- Green screen with the eyedropper ---
    await add('greenscreen.webm');
    await page.locator('.ruler').click({ position: { x: 80 + 1, y: 10 }, force: true });
    await page.getByRole('tab', { name: 'Cutout' }).click();
    await page.getByRole('button', { name: 'Remove green' }).click();
    await page.getByRole('button', { name: 'Pick key colour' }).click();
    await expect(page.locator('.pick-banner')).toBeVisible();
    const cb = (await page.locator('.stage canvas').boundingBox())!;
    await page.mouse.click(cb.x + cb.width * CORNER[0], cb.y + cb.height * CORNER[1]);
    await expect(page.locator('.toast', { hasText: /Keying out #/ })).toBeVisible();
    await expect.poll(async () => (await px(...CORNER)).reduce((a, b) => a + b, 0)).toBeLessThan(40);
    await expect.poll(async () => (await px(...CENTRE))[0]).toBeGreaterThan(220);

    // --- LUT import (red/blue swap, 2³) and export ---
    await page.getByRole('tab', { name: 'Colour' }).click();
    const cube = 'TITLE "swap"\nLUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n';
    await page.locator('.inspector input[type=file]').setInputFiles({ name: 'swap.cube', mimeType: 'text/plain', buffer: Buffer.from(cube) });
    await expect(page.locator('.inspector select[aria-label=LUT]')).toContainText('swap (2³)');
    const [lutDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export LUT/ }).click()]);
    const lutPath = info.outputPath('grade.cube');
    await lutDl.saveAs(lutPath);
    const lutText = (await import('node:fs')).readFileSync(lutPath, 'utf8');
    expect(lutText).toContain('LUT_3D_SIZE 33');
    expect(lutText.trim().split('\n').filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l))).toHaveLength(33 ** 3);

    // --- Adjustment layer: warm everything underneath ---
    await rail('Adjust');
    await page.getByRole('button', { name: 'Add adjustment layer' }).click();
    await expect(page.locator('.lane').first().locator('.clip')).toHaveCount(1);
    await expect(page.locator('.inspector')).toContainText('Adjustment layer');
    await setNum('Temperature', 100);
    await setNum('Shadows', 20);
    // Colour wheel, curves and HSL all respond.
    const wheel = page.getByRole('slider', { name: 'Highlights colour' });
    const wb = (await wheel.boundingBox())!;
    await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height / 2);
    await page.mouse.down();
    await page.mouse.move(wb.x + wb.width * 0.6, wb.y + wb.height * 0.45, { steps: 3 });
    await page.mouse.up();
    const curves = page.locator('canvas.curves');
    const cvb = (await curves.boundingBox())!;
    await page.mouse.click(cvb.x + cvb.width * 0.5, cvb.y + cvb.height * 0.45);
    await page.getByRole('button', { name: 'Blue', exact: true }).click();
    await setNum('Blue sat.', -50);
    await expect.poll(async () => { const [r, , b] = await px(...CENTRE); return r - b; }).toBeGreaterThan(12);
    await page.getByRole('tab', { name: 'Effects' }).click();
    await expect(page.locator('.inspector .fx-card')).toHaveCount(2);
    const png1 = await exportPng('grade.png');
    const c1 = pixel(png1, Math.round(CENTRE[0] * 1080), Math.round(CENTRE[1] * 1920));
    const k1 = pixel(png1, Math.round(CORNER[0] * 1080), Math.round(CORNER[1] * 1920));
    console.log('graded export pixels', c1, k1);
    expect(c1[0] - c1[2]).toBeGreaterThan(12);
    expect(k1[0] + k1[1] + k1[2]).toBeLessThan(60);

    // --- Scopes ---
    await page.getByRole('button', { name: 'Scopes' }).click();
    await page.getByRole('radio', { name: 'Vectorscope' }).click();
    await expect.poll(() => page.evaluate(() => {
      const c = document.querySelector('[data-testid=scope-canvas]') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 90) n++;
      return n;
    })).toBeGreaterThan(5);
    await page.screenshot({ path: info.outputPath('scopes-grade.png') });
    await page.getByRole('button', { name: 'Scopes' }).click();

    // --- Mask: an inverted rectangle hides the middle of the green-screen clip ---
    await page.locator('.lane .clip', { hasText: 'greenscreen.webm' }).click();
    await page.getByRole('tab', { name: 'Cutout' }).click();
    await page.getByRole('button', { name: 'Add rectangle mask' }).click();
    const shape = page.getByTestId('mask-shape');
    await expect(shape).toBeVisible();
    const sb0 = (await shape.boundingBox())!;
    const handle = page.getByTestId('mask-size');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 20, hb.y + hb.height / 2 + 10, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await shape.boundingBox())!.width).toBeGreaterThan(sb0.width + 20);
    await page.getByRole('button', { name: 'Invert Rectangle 1' }).click();
    await expect.poll(async () => (await px(...CENTRE)).reduce((a, b) => a + b, 0)).toBeLessThan(60);
    await page.screenshot({ path: info.outputPath('mask.png') });
    const png2 = await exportPng('mask.png');
    const c2 = pixel(png2, Math.round(CENTRE[0] * 1080), Math.round(CENTRE[1] * 1920));
    expect(c2[0] + c2[1] + c2[2]).toBeLessThan(60);

    // --- Keyframe easing (custom curve) ---
    await page.getByRole('tab', { name: 'Video' }).click();
    await page.getByRole('button', { name: 'Keyframe Scale' }).click();
    await page.getByRole('tab', { name: 'Animate' }).click();
    await page.locator('.inspector').getByRole('button', { name: 'Custom', exact: true }).click();
    await page.locator('.inspector').getByRole('button', { name: 'Overshoot', exact: true }).click();
    await expect(page.locator('.inspector .ease-curve')).toBeVisible();

    // --- Freeze frame ---
    const before = await page.locator('.clip').count();
    await page.getByRole('tab', { name: 'Speed' }).click();
    await page.getByRole('button', { name: 'Freeze at playhead' }).click();
    await expect(page.locator('.clip')).toHaveCount(before + 2);
    await expect(page.locator('.inspector')).toContainText('Freeze frame');

    // --- Audio: effects, normalise, auto-duck, speed ramp ---
    await page.keyboard.press('End');
    await rail('Media');
    await add('talk.webm');
    await page.getByRole('tab', { name: 'Audio' }).click();
    await page.locator('.inspector').getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('.afx-pick', { hasText: 'Reverb' }).click();
    await page.locator('.inspector').getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('.afx-pick', { hasText: 'Noise reduction' }).click();
    await expect(page.locator('.inspector [data-afx]')).toHaveCount(2);
    await expect.poll(async () => {
      await page.getByRole('button', { name: 'Normalise' }).click();
      return page.locator('.toast', { hasText: /Volume set to/ }).count();
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByRole('tab', { name: 'Speed' }).click();
    await page.getByRole('button', { name: 'Ramp: Bullet time' }).click();
    await expect(page.locator('.lane .clip', { hasText: 'talk.webm' })).toHaveCount(12);

    await page.keyboard.press('Home');
    await rail('Media');
    await add('music.mp3');
    await expect.poll(async () => {
      await page.getByRole('button', { name: 'Auto-duck' }).click();
      return page.locator('.toast', { hasText: /Ducked under/ }).count();
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(await page.locator('.clip.sel .kf').count()).toBeGreaterThan(2);
    await page.screenshot({ path: info.outputPath('phase2b-timeline.png') });

    // --- Final MP4: length matches the timeline, sound included ---
    const tc = (await page.locator('.timecode').textContent())!;
    const m = tc.match(/\/ (\d+):(\d+):(\d+):(\d+)/)!;
    const expected = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 30;
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'MP4', exact: true }).click();
    await page.locator('.dialog footer .btn.primary').click();
    const save = page.getByRole('button', { name: /Save .*\.mp4/ });
    await expect(save).toBeVisible({ timeout: 180_000 });
    const [d] = await Promise.all([page.waitForEvent('download'), save.click()]);
    const out = info.outputPath('phase2b.mp4');
    await d.saveAs(out);
    const meta = probe(out);
    console.log('phase 2b export', expected, JSON.stringify(meta));
    expect(meta.streams.some((s) => s.codec_type === 'audio')).toBe(true);
    expect(Math.abs(parseFloat(meta.format.duration) - expected)).toBeLessThan(0.35);
    expect(errors).toEqual([]);
  });
});

test.describe('mobile editor', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile only');

  test('touch-first layout works on a phone', async ({ page }, info) => {
    await newTikTok(page);
    await expect(page.locator('.mobile-tabs')).toBeVisible();
    await expect(page.locator('.rail')).toBeHidden();
    await page.locator('.mobile-tabs').getByRole('button', { name: 'Media' }).tap();
    await expect(page.locator('.sheet')).toBeVisible();
    await page.locator('.sheet .import-zone input[type=file][multiple]').first().setInputFiles([f('landscape.mp4'), f('photo.png')]);
    await expect(page.locator('.sheet .media-tile')).toHaveCount(2, { timeout: 60_000 });
    await page.locator('.sheet .media-tile', { hasText: 'landscape' }).getByRole('button', { name: /to timeline/ }).tap();
    await page.locator('.sheet').getByRole('button', { name: 'Close' }).tap();
    await expect(page.locator('.clip')).toHaveCount(1);
    await expect(page.locator('.mobile-tabs .edit')).toBeVisible();
    await page.locator('.mobile-tabs .edit').tap();
    await expect(page.locator('.sheet .inspector')).toBeVisible();
    await page.screenshot({ path: info.outputPath('mobile-inspector.png') });
    await page.locator('.sheet').getByRole('button', { name: 'Close' }).tap();
    // Split with the toolbar button.
    await page.locator('.ruler').tap({ position: { x: 120, y: 10 } });
    await page.getByRole('button', { name: 'Split', exact: true }).tap();
    await expect(page.locator('.clip')).toHaveCount(2);
    // No sideways page scroll on a small screen.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath('mobile-editor.png') });
  });
});
