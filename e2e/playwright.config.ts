import {defineConfig, devices} from '@playwright/test';

// BASE_URL points at the environment under test, QA by default. PROD is left to its users.
// Every test cleans up after itself: when the last person leaves a room, the server deletes it.
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: {timeout: 15_000},
  // QA runs on the same server as PROD, so keep the pressure moderate
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['line'], ['html', {open: 'never'}], ['json', {outputFile: 'results.json'}]],
  use: {
    baseURL: process.env.BASE_URL ?? 'https://qa.pipoker.app',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    // The full Chromium rather than its headless shell, which closes a browser without letting its pages say goodbye
    {name: 'chromium', use: {...devices['Desktop Chrome'], channel: 'chromium'}, testIgnore: /mobile|load/},
    // Going offline in Firefox and WebKit is not like losing the network, so those tests run in Chromium only.
    // Of the feature tests, the other browsers run the ones that move things on every screen: the round's task and
    // estimate, the role switch and the history with its downloads. The rest is the same page logic in every browser.
    {name: 'firefox', use: {...devices['Desktop Firefox']}, testMatch: /room-flow|resilience|features-(round|roles|history)/, grepInvert: /@network/},
    // WebKit leaves QA's login out of the WebSocket handshake; the cookie QA gives after the login lets it in
    {name: 'webkit', use: {...devices['Desktop Safari']}, testMatch: /resilience|features-(round|roles)/, grepInvert: /@network/},
    {name: 'mobile-safari', use: {...devices['iPhone 13']}, testMatch: /mobile/},
    {name: 'mobile-chrome', use: {...devices['Pixel 7']}, testMatch: /mobile/},
    {name: 'load', testMatch: /load/}
  ]
});
