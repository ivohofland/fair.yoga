import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'path';

// Three projects with different blast radii (docs/test-database.md):
// - unit: services + lib, runs against the dedicated test database so
//   clock-injected sweeps can never touch dev/seed data
// - integration: talks to the HTTP app on :3000, so its fixtures must
//   live in the same database that app reads (dev locally, CI's in CI)
// - components: jsdom rendering with `next/navigation` mocked
//   (tests/setup/components.ts) — touches no database at all. `fetch` is NOT
//   mocked there: each test that clicks stubs it itself via
//   `vi.stubGlobal('fetch', …)`. A test that renders fetch-calling code and
//   never clicks needs no stub; one that clicks and forgets gets a real
//   relative-URL request, which the components swallow into "Network error"
//   rather than failing visibly.
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const devUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL ?? '';
  const testUrl = process.env.DATABASE_URL_TEST ?? fileEnv.DATABASE_URL_TEST ?? devUrl;

  return {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    test: {
      globals: true,
      environment: 'node',
      fileParallelism: false,
      // Pinned, not inherited from whatever machine happens to run the suite.
      //
      // The date formatters in `src/lib/format.ts` read their argument with
      // `getUTC*` accessors, and every test that names that guarantee can
      // only observe it in a zone where the local and the UTC
      // accessors disagree. CI is `ubuntu-latest` — UTC — where `getDate()` and
      // `getUTCDate()` return the same number for every input. Unpinned, those
      // tests therefore pass against a local-time implementation on the one
      // machine whose verdict gates a merge. Swapping every accessor in
      // `format.ts` to its local-time twin leaves that whole file green under
      // TZ=UTC — and green under Europe/Amsterdam, the zone it was written in —
      // while failing most of it under this pin.
      //
      // West of UTC specifically. Each of these formatters is handed values
      // already pinned to midnight UTC (`@db.Date` columns, `startOfLocalDay`
      // output), and for those a local read moves the calendar day back
      // exactly one day west of UTC while moving nothing at or east of it.
      // A zone east of UTC would leave the same assertions vacuous.
      //
      // Deleting this line fails nothing. It silently makes those assertions
      // tautological again, which is why it is a comment and not a bare option.
      //
      // Set at the root so all three projects inherit it — a project's own
      // `env` (unit's `DATABASE_URL`) merges with this rather than replacing
      // it. The integration project's app process on :3000 keeps its own zone,
      // so that suite now runs cross-zone against the app; it was verified
      // green under this pin, and the mismatch is the realistic case anyway
      // (a UTC server, a client somewhere else).
      env: { TZ: 'America/New_York' },
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
      },
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts'],
            env: { DATABASE_URL: testUrl },
            globalSetup: ['./tests/setup/unit-db.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['tests/integration/**/*.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'components',
            // jsdom, overriding the root's `environment: 'node'`. The `.tsx`
            // glob is what keeps this disjoint from `unit`'s `src/**/*.test.ts`
            // — no file is collected by both.
            environment: 'jsdom',
            include: ['src/components/**/*.test.tsx'],
            setupFiles: ['./tests/setup/components.ts'],
          },
        },
      ],
    },
  };
});
