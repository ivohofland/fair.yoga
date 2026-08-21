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
  // Note the fan-out granularity: every spec carries beforeAll/afterAll,
  // and tests sharing worker-scoped setup are scheduled as one group, so
  // fullyParallel splits nothing here — a full local run reported
  // "using 5 workers": five spec files' suites at once against one server.
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
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
