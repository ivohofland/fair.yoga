import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'path';

// Files testing a service whose sweep writes rows it was never handed, with
// no scope parameter to pass. One list, spliced into `unit-sweeps`'s
// `include` and `unit`'s `exclude`, so the two cannot drift apart.
const SWEEP_TESTS = [
  'src/lib/auth/magic-link.test.ts',
  'src/services/class-transitions.test.ts',
  'src/services/waitlist-reconciliation.test.ts',
  'src/services/waitlist-retention.test.ts',
  'src/services/auth-cleanup.test.ts',
  'src/services/email-fallback.test.ts',
  'src/services/email-fallback.consent.test.ts',
  'src/services/notifications.test.ts',
  'src/services/payment-reminders.test.ts',
  'src/services/studio-class-generator.test.ts',
] as const;

// Files that hold a real row lock for seconds at a time. They are NOT
// database-wide the way `SWEEP_TESTS` are — each owns the rows it touches —
// so the reason they cannot run in `unit` is a different one: a parallel
// neighbour that asserts on lock TIMING does not survive beside them.
// `template-lock-order.test.ts` asserts its race ends in neither `40P01` nor
// `55P03`, and a concurrent multi-second hold pushes it into the second.
// Measured on issue 272's branch: that file passes alone, passes run beside
// `room-archive-lock-order.test.ts` alone, and fails in the full `unit` tier
// with nothing else changed.
//
// The membership runs BOTH WAYS: a file that CREATES multi-second holds, and a
// file whose assertion is destroyed by them. `template-lock-order.test.ts` is
// the second kind — it asserts its race ends in neither code, so every source
// of lock noise in the tier is a false failure it cannot distinguish from the
// defect it watches for. Measured on issue 272's branch: the tier was green
// 9/9 as the branch stood, and roughly one run in three once the tier's file
// timings shifted, with the failure landing on that file every time and on
// `class-template-lifecycle.test.ts`'s own archive-race case twice. Removing
// this branch's new `setLockTimeout` did not stop it, so the trigger is the
// tier's contention budget rather than any one call site — issue 272's mirror
// foreign keys take row locks no application code asks for, which is the
// budget getting tighter.
const LOCK_CONTENTION_TESTS = [
  'src/services/room-archive-lock-order.test.ts',
  'src/services/template-lock-order.test.ts',
] as const;

// The two lists above have different reasons and are kept apart so neither
// comment has to describe the other's membership. This is what the projects
// below splice, so a file added to either list moves tiers in one edit.
const SERIAL_TESTS = [...SWEEP_TESTS, ...LOCK_CONTENTION_TESTS];

// The projects below have different blast radii (docs/test-database.md):
// - unit: services + lib minus `SERIAL_TESTS`, run in parallel against the
//   dedicated test database. Every file here mutates only rows it owns, and
//   none of them holds a lock long enough to disturb a neighbour
// - unit-sweeps: `SERIAL_TESTS`, serial — the clock-injected, database-wide
//   sweeps, kept off the dev/seed data and away from each other, plus the
//   lock-contention files that cannot share a parallel tier
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
      // `fileParallelism` is per-project below, NOT here. Its reason
      // (docs/test-database.md §2) is shared *database* state, which
      // `components` does not have — it inherited 44s/run of serialization
      // from this line for a constraint that was never about it (#321).
      //
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
      // Set at the root so every project inherits it — a project's own
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
            // `SERIAL_TESTS` (above) is the membership list — edit that, or
            // one of the two lists it joins, not this array, or `unit` and
            // `unit-sweeps` drift apart.
            exclude: ['**/node_modules/**', ...SERIAL_TESTS],
            fileParallelism: true,
            env: { DATABASE_URL: testUrl },
            globalSetup: ['./tests/setup/unit-db.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'unit-sweeps',
            // `SERIAL_TESTS` (above) is the membership list — edit that, or
            // one of the two lists it joins, not this array, or `unit` and
            // `unit-sweeps` drift apart. Each list states its own reason for
            // being here: `SWEEP_TESTS` cannot share a database with a
            // concurrent file, `LOCK_CONTENTION_TESTS` cannot share a tier
            // with one that asserts on lock timing. Both need what this
            // project provides, which is why they share it despite the name.
            //
            // `fileParallelism: false` is the guard here, not the separate
            // `vitest run` invocation this tier also gets: flipping it to
            // `true` reddens the tier while that invocation boundary stays
            // intact. It carries two further preconditions the option's name
            // does not cover, and breaking either re-parallelizes this tier
            // with the flag still reading as set — docs/test-database.md §2.
            include: [...SERIAL_TESTS],
            fileParallelism: false,
            env: { DATABASE_URL: testUrl },
            globalSetup: ['./tests/setup/unit-db.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['tests/integration/**/*.test.ts'],
            // Serial, and load-bearing: this tier drives the one app on :3000
            // over HTTP. #290 measured four parallel runs producing four
            // different victims. Do not flip this to match its siblings.
            fileParallelism: false,
          },
        },
        {
          extends: true,
          test: {
            name: 'components',
            // jsdom, overriding the root's `environment: 'node'`. The `.tsx`
            // glob — covering both src/components and src/app — is what keeps
            // this disjoint from `unit`'s `src/**/*.test.ts`: no file is
            // collected by both.
            environment: 'jsdom',
            include: ['src/components/**/*.test.tsx', 'src/app/**/*.test.tsx'],
            fileParallelism: true,
            setupFiles: ['./tests/setup/components.ts'],
          },
        },
      ],
    },
  };
});
