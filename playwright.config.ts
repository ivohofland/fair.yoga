import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Serialized unconditionally (#290): every extra worker drives another
  // browser against the same single dev server on :3000 this checkout
  // serves, and four parallel full runs during #285's gates produced four
  // different victims, each green alone. CI already ran at 1, so this
  // changes only local behaviour: slower, but a red run means what it says.
  // Unpinned, Playwright defaults to "50%" of cores, so a full local run
  // drove that many browsers at the one server.
  //
  // The fan-out unit is the (spec file × project) pair, not the test: every
  // spec wraps its tests in `test.describe.configure({ mode: 'serial' })`,
  // which pins each spec's suite to a single group and is what makes
  // `fullyParallel` a no-op here. Do NOT read those as redundant now that
  // workers is 1 and delete them — the hooks do not group anything on their
  // own. Playwright chunks hook-bearing *parallel* tests into
  // ceil(tests / workers) groups, re-running `beforeAll` per chunk, so
  // dropping serial mode would duplicate every spec's Teacher/Account
  // fixture the moment anyone raises the worker count.
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    // Not 'on-first-retry' (#290): with `retries: 2` in CI that recorded the
    // *retry*, so a contention failure that passed on attempt 2 uploaded a
    // trace of the healthy run and none of the failing one — the artifact
    // said least about exactly the flake worth diagnosing.
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'Mobile Chrome', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    // CI pre-starts the production build on :3000 before the e2e step;
    // locally this reuses the running dev server.
    reuseExistingServer: true,
  },
});
