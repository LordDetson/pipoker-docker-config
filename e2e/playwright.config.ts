import {defineConfig, devices} from '@playwright/test';

// BASE_URL points at the environment under test, PROD by default.
// Every test cleans up after itself: when the last person leaves a room, the server deletes it.
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: {timeout: 15_000},
  // A real server is shared with real users, so keep the pressure moderate
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {
    baseURL: process.env.BASE_URL ?? 'https://pipoker.duckdns.org',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome']}, testIgnore: /mobile|load/},
    {name: 'firefox', use: {...devices['Desktop Firefox']}, testMatch: /room-flow/},
    {name: 'mobile-safari', use: {...devices['iPhone 13']}, testMatch: /mobile/},
    {name: 'mobile-chrome', use: {...devices['Pixel 7']}, testMatch: /mobile/},
    {name: 'load', testMatch: /load/}
  ]
});
