import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

/** The admin host for whatever origin the app under test answers on: admin.<host>:<port>. */
function adminBaseUrl(): string {
  const url = new URL(process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000');
  url.hostname = `admin.${url.hostname}`;
  return url.origin;
}

export default defineConfig({
  testDir: './tests/e2e',
  // Every module an e2e spec imports resolves `server-only` through
  // tests/e2e/tsconfig.json instead of the per-file tsconfig lookup this
  // option replaces — see that file's comment for why.
  tsconfig: './tests/e2e/tsconfig.json',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // A fail-then-pass exits 0 by default, which is the last place a red can
  // become green without anyone deciding to (#293). Retries stay: with this
  // on they are purely diagnostic — the run fails either way, but the report
  // still says "flaky" rather than "failed", which is the difference between
  // an intermittent fault and a deterministic one. Unconditional, not
  // `!!process.env.CI`: locally `retries` is 0, so nothing can ever be
  // classified flaky and a ternary would be decoration.
  failOnFlakyTests: true,
  expect: {
    // 10s budget for element visibility during concurrent client-side RSC
    // transitions on 2 vCPU runners.
    timeout: 10_000,
  },
  // Serialized locally (#290): every extra worker drives another browser
  // against the single dev server on :3000, where lazy recompilation caused
  // flakes. In CI (which runs against the pre-built standalone production
  // server and isolated DB container), 2 workers match the 2 vCPU runner,
  // reducing the test step from ~85s to ~60s (#325).
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
  workers: process.env.CI ? 2 : 1,
  reporter: 'html',
  use: {
    // Shares one override with the integration suite (`tests/helpers.ts`),
    // which mints its session cookie for the same origin — pointing only one
    // of them elsewhere leaves every spec unauthenticated against a host it
    // holds no cookie for. Unset in CI and locally by default, so both sides
    // fall back to :3000 byte-identically; it exists for a worktree dev server
    // on another port.
    baseURL: process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000',
    // Not 'on-first-retry' (#290): with `retries: 2` in CI that recorded the
    // *retry*, so a contention failure that passed on attempt 2 uploaded a
    // trace of the healthy run and none of the failing one — the artifact
    // said least about exactly the flake worth diagnosing.
    trace: 'retain-on-failure',
    // Blocked by default so the offline worker (#725) answers no navigation or
    // static file; a spec that needs it opts in with
    // `test.use({ serviceWorkers: 'allow' })`. Why, and what `setOffline`
    // needs: docs/technical-architecture.md (Offline (service worker)).
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', testIgnore: /admin\//, use: { ...devices['Desktop Chrome'] } },
    { name: 'Mobile Chrome', testIgnore: /admin\//, use: { ...devices['Pixel 5'] } },
    {
      name: 'admin',
      testMatch: /admin\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: adminBaseUrl() },
    },
  ],
  webServer: {
    // In a worktree (INTEGRATION_BASE_URL set), the dev server is expected
    // to already be running — `pnpm run worktree:up` starts it. This command
    // only runs when `reuseExistingServer`'s health check against `url`
    // fails, i.e. it was NOT started: fail fast with an actionable message
    // instead of silently booting an unparameterized `next dev` on :3000,
    // using the worktree's isolated database on the wrong port.
    command: process.env.INTEGRATION_BASE_URL
      ? `node -e "console.error('INTEGRATION_BASE_URL is set to ${process.env.INTEGRATION_BASE_URL} but nothing is listening there. Run: pnpm run worktree:up'); process.exit(1)"`
      : 'pnpm run dev',
    url: process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000',
    // CI pre-starts the production build on :3000 before the e2e step;
    // locally this reuses the running dev server.
    reuseExistingServer: true,
  },
});
