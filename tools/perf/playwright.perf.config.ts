import { defineConfig, devices } from '@playwright/test';

// Standalone on purpose. Viewers/playwright.config.ts spins up a DEV server
// (APP_CONFIG=config/e2e.js yarn start) against e2e fixtures; the soak must
// exercise the DEPLOYED docker stack instead.
export default defineConfig({
  testDir: '.',
  testMatch: /soak\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 4 * 60 * 60 * 1000,
  globalTimeout: 5 * 60 * 60 * 1000,
  reporter: [['list']],
  use: {
    baseURL: process.env.PERF_VIEWER_URL || 'http://localhost:1030',
    // Video recording leaks memory in the harness and would poison heapMB.
    video: 'off',
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 120_000,
  },
  projects: [
    {
      name: 'perf-chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use the SYSTEM Chrome rather than Playwright's downloaded Chromium: this host
        // has /usr/bin/google-chrome and no ms-playwright browser cache, so `channel`
        // avoids a ~300MB `npx playwright install`. Verified by tools/perf/preflight.js,
        // which confirms both flags below actually reach the renderer (window.gc exists).
        channel: 'chrome',
        launchOptions: {
          args: [
            '--enable-precise-memory-info', // unquantized performance.memory
            '--js-flags=--expose-gc', // lets us force GC before every sample
          ],
        },
      },
    },
  ],
});
