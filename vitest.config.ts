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

// Files that cannot run in `unit`'s parallel tier because of LOCK TIMING —
// either they create it or they measure it. Two kinds, one list, because both
// need the same thing:
//
//   - files that hold a real row lock for seconds at a time
//     (`room-archive-lock-order.test.ts`), and
//   - files whose assertion is destroyed by that noise
//     (`template-lock-order.test.ts`, which asserts its race ends in neither
//     `40P01` nor `55P03` — so any lock noise in the tier is a false failure
//     it cannot tell from the defect it watches for).
//
// The trigger is the tier's contention budget rather than any one call site:
// removing issue 272's new `setLockTimeout` and skipping the new cases still
// left the tier failing intermittently, while the branch before them did not.
// Issue 272's mirror foreign keys take row locks no application code asks for,
// which is that budget getting tighter.
//
// NOT a complete census of files that hold locks. `room-archive.test.ts` still
// holds one in `unit` — a `ClassTemplate` `FOR UPDATE` kept until the resume
// answers, under a 6s ceiling, not the flat 2.5s this note used to claim.
// What makes that tolerable is that no file left in the tier reads lock timing
// to assert on, and the sweep above is what re-established it: this note
// previously said the holder was safe "because the assertion-side file left
// the tier" while THREE assertion-side files were still in it. The claim was
// true of `template-lock-order.test.ts` alone and was read as true of the
// tier. Adding a case that reads lock timing to a parallel file is what this
// list exists to catch — re-derive the census with:
//
//   grep -rln 'not.toMatch(/[^/]*\(40P01\|55P03\)' src --include='*.test.ts'
//
// Every hit belongs on this list.
const LOCK_CONTENTION_TESTS = [
  'src/services/room-archive-lock-order.test.ts',
  'src/services/template-lock-order.test.ts',
  // The third kind: a file whose DDL takes ACCESS EXCLUSIVE on a table the
  // rest of the tier reads. `class-lifecycle-tier-guard.test.ts` drops and
  // re-adds a CHECK on `Registration`, so it queues behind every concurrent
  // user of that table and blocks them in turn. Its own header carries the
  // measurement.
  'src/services/class-lifecycle-tier-guard.test.ts',
  // Added by the preventive sweep the paragraph below asks for, and all three
  // are the SECOND kind: each asserts a staged race ends in neither `40P01`
  // nor `55P03`, so tier noise is a false failure none of them can tell from
  // the defect it watches for — `template-lock-order.test.ts`'s exact shape.
  // Found by looking, not by failing.
  'src/lib/db-locks-lock-order.test.ts',
  'src/services/invitations-lock-order.test.ts',
  // Split out of `gdpr.test.ts` rather than moving it: that file is 26 tests
  // and ~26s and exactly one reads lock timing, so moving all of it cost the
  // serial tier +92% (37.8s -> 72.6s) against +2.5s extracted. Same move
  // `class-lifecycle-tier-guard.test.ts` made, for the same kind of reason.
  'src/services/gdpr-lock-order.test.ts',
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
            // Serial locally: this tier shares the dev server on :3000 with
            // whatever the person running it has open. #290's own design
            // spec is explicit that integration files do NOT contend with
            // EACH OTHER even so ("vitest.config.ts sets
            // fileParallelism: false, so integration tests never contend
            // with each other") — its local flakiness came from `next dev`'s
            // lazy recompilation during mutation testing, not fan-out. See
            // docs/superpowers/specs/2026-08-21-local-gate-reliability-design.md.
            // (The "four different victims" finding in that same issue is
            // Playwright's, not this tier's — `playwright.config.ts`.)
            //
            // CI does not inherit this default, though: its own invocation
            // overrides it with the `--file-parallelism` CLI flag (#325),
            // which wins over a project's setting — see
            // docs/test-database.md §2 for the mechanism.
            fileParallelism: false,
            env: { DATABASE_URL: devUrl },
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
