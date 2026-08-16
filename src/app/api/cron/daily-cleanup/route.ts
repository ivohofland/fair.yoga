import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import { cleanupExpiredAuth } from '@/services/auth-cleanup';
import { reapClosedWaitlistEntries } from '@/services/waitlist-retention';

/**
 * One route per JOB, not per sweep — the existing shape, since
 * `/api/cron/transition-classes` already runs three. Renamed from
 * `auth-cleanup` with the scheduler job it mirrors (#238).
 *
 * NOTHING TESTS THIS ROUTE. `grep -rn "daily-cleanup\|auth-cleanup" tests/`
 * returns nothing — no test touches this route or its predecessor. One of the
 * five `/api/cron/*` routes does have coverage, though:
 * `tests/e2e/recurring.spec.ts:126` drives `/api/cron/generate-classes` from
 * a Playwright spec, so a precedent for testing a cron route exists. The
 * services below are each covered (`auth-cleanup.test.ts`,
 * `waitlist-retention.test.ts`) and `requireCronAuth` is covered
 * (`lib/cron-auth.test.ts`); what is uncovered is the WIRING — that this route
 * calls the sweeps it names and returns their results. That is the same
 * exposure `scheduler.test.ts`'s job-to-sweep map was built to close on the
 * scheduler side ("a job could carry the right name and interval while running
 * the wrong sweep"), and the route side has no equivalent.
 *
 * AND AN E2E OR INTEGRATION TEST WOULD BE THE WRONG WAY TO CLOSE IT, which is
 * the non-obvious part. Both of those tiers run against the APP's database —
 * dev locally (`docs/test-database.md` §3.4). `reapClosedWaitlistEntries` is
 * deliberately not scoped to any fixture, and `waitlist-retention.test.ts`
 * carries a guard that refuses to run against a database not named `*_test`
 * for exactly that reason. A Playwright spec POSTing this route would drive the
 * unscoped sweep straight through that guard — the guard lives in the suite,
 * not in the service — and permanently delete dev rows. So the precedent above
 * does not transfer to THIS route. A mocked route-handler test would be the
 * shape that fits, and no precedent for one exists under `src/app/api`.
 *
 * Recorded here rather than filed, deliberately: the stakes are low, because
 * the in-process scheduler — not this route — is what actually runs these
 * sweeps in production (`scheduler.ts`'s header: the `/api/cron/*` endpoints
 * "remain for manual runs and external schedulers"). If you edit this file,
 * verify it by hand against the running app; a green suite says nothing about
 * it.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  // Sequential, not `Promise.all`: these share one connection pool of three
  // (one vCPU), and neither is urgent.
  //
  // ISOLATED FROM EACH OTHER, matching the scheduler's `daily-cleanup` job,
  // which runs both through `isolatedSweeps`. An earlier revision awaited both
  // plainly, so a thrown `cleanupExpiredAuth` skipped retention entirely.
  // `DEPLOYMENT.md` documents `CRON_SCHEDULER=off` + systemd timers as a
  // supported mode, and in that mode this route is the ONLY trigger for
  // retention — an intermittently failing auth cleanup would silently stop
  // retention every night, and a `curl` without `--fail` exits 0 on the 500.
  //
  // Reported per sweep in the body rather than collapsed into one status, so a
  // caller reading the response learns WHICH ran. `respondOk` either way: this
  // is a report of two independent outcomes, not one operation that half
  // succeeded, and a non-2xx here would be as misleading in the other
  // direction.
  const auth = await settle(() => cleanupExpiredAuth(prisma));
  const waitlistRetention = await settle(() => reapClosedWaitlistEntries(prisma));

  return respondOk({ auth, waitlistRetention });
});

/** One sweep's outcome, so neither can prevent the other from running. */
async function settle<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    return { ok: true, result: await run() };
  } catch (err) {
    // Logged as well as returned: the response body reaches whoever called,
    // which under a systemd timer is a `curl` whose output may go nowhere.
    log.error({ err }, 'daily-cleanup: a sweep failed; the other still ran');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
