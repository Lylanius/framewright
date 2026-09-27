import { defineConfig, devices } from '@playwright/test';

/** Benchmarks (not part of the normal test run): `npm run bench`. */
const executablePath = process.env.CHROMIUM_PATH || (process.env.PLAYWRIGHT_BROWSERS_PATH ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: 'tests/perf',
  timeout: 600_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: { executablePath, args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: { command: 'npm run build && npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: false, timeout: 180_000 },
});
