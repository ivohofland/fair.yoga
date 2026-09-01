import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { classifyApiError, type ApiFailure } from '@/lib/api-errors';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import { cleanupExpiredAuth } from '@/services/auth-cleanup';
import { reapClosedWaitlistEntries } from '@/services/waitlist-retention';
import { auditTeacherTimezones } from '@/services/timezone-audit';

/**
 * One route per JOB, not per sweep — the existing shape, since
 * `/api/cron/transition-classes` already runs three. Renamed from
 * `auth-cleanup` with the scheduler job it mirrors (#238).
 *
 * WHAT IS AND IS NOT COVERED HERE. `route.test.ts` beside this file pins the
 * STATUS CONTRACT below and nothing else; the WIRING is deliberately uncovered.
 * `grep -rn "daily-cleanup\|auth-cleanup" tests/` still returns nothing — the
 * integration and e2e tiers do not touch this route, for the reason two
 * paragraphs down. One of the five `/api/cron/*` routes does have coverage
 * there, though:
 * `tests/e2e/recurring.spec.ts`'s `'the generation cron is idempotent over
 * the already-filled window'` test drives `/api/cron/generate-classes` from
 * a Playwright spec, so a precedent for testing a cron route exists. The
 * services below are each covered (`auth-cleanup.test.ts`,
 * `waitlist-retention.test.ts`) and `requireCronAuth` is covered
 * (`lib/cron-auth.test.ts`); what remains uncovered is the WIRING — that this
 * route calls the sweeps it NAMES. `route.test.ts` mocks all three, so it
 * cannot see that. That is the same exposure `scheduler.test.ts`'s job-to-sweep map
 * was built to close on the scheduler side ("a job could carry the right name
 * and interval while running the wrong sweep"), and the route side still has no
 * equivalent — a decision, not an oversight.
 *
 * AND AN E2E OR INTEGRATION TEST WOULD BE THE WRONG WAY TO CLOSE IT, which is
 * the non-obvious part. Both of those tiers run against the APP's database —
 * dev locally (`docs/test-database.md` §3.4). `reapClosedWaitlistEntries` is
 * deliberately not scoped to any fixture, and `waitlist-retention.test.ts`
 * carries a guard that refuses to run against a database not named `*_test`
 * for exactly that reason. A Playwright spec POSTing this route would drive the
 * unscoped sweep straight through that guard — the guard lives in the suite,
 * not in the service — and permanently delete dev rows. So the precedent above
 * does not transfer to THIS route. A mocked route-handler test is the shape
 * that fits, and `route.test.ts` beside this file is now one — scoped to the
 * STATUS CONTRACT below and deliberately not to the wiring, which is the part
 * review decided not to cover.
 *
 * Recorded here rather than filed, deliberately: the stakes are low, because
 * the in-process scheduler — not this route — is what actually runs these
 * sweeps in production (`scheduler.ts`'s header: the `/api/cron/*` endpoints
 * "remain for manual runs and external schedulers"). If you change WHICH sweeps
 * this route runs, verify it by hand against the running app — a green suite
 * says nothing about that. If you change the status mapping, `route.test.ts`
 * will tell you.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  // Sequential, not `Promise.all`: these share one connection pool of three
  // (one vCPU), and none is urgent.
  //
  // ISOLATED FROM EACH OTHER, matching the scheduler's `daily-cleanup` job,
  // which runs all three through `isolatedSweeps`. An earlier revision awaited
  // both plainly (before this route ran a third sweep), so a thrown
  // `cleanupExpiredAuth` skipped retention entirely.
  // `DEPLOYMENT.md` documents `CRON_SCHEDULER=off` + systemd timers as a
  // supported mode, and in that mode this route is the ONLY trigger for
  // retention — an intermittently failing auth cleanup would silently stop
  // retention every night, and a `curl` without `--fail` exits 0 on the 500.
  //
  // Reported per sweep in the body, so a caller reading the response learns
  // WHICH one ran.
  //
  // THE STATUS IS THE VERDICT, AND A 2xx FROM THIS ROUTE MEANS EVERY SWEEP RAN.
  // If any failed the answer is non-2xx and the body still carries every
  // outcome — read `data.auth.ok`, `data.waitlistRetention.ok`, and
  // `data.timezoneAudit.ok` to see which one did not. Partial failure counts:
  // one sweep succeeding does not make the request as a whole a success,
  // because for an HTTP caller a 2xx means "what you asked for happened", and
  // if a sweep did not run, it did not.
  //
  // An earlier revision answered 200 unconditionally, arguing that this is a
  // report of two independent outcomes rather than one half-succeeded
  // operation (the route ran two sweeps at the time). That is a fair
  // description of the BODY and the wrong one for the STATUS, and it
  // reintroduced on this path exactly the defect
  // `RetentionFailedError` had just fixed on the scheduler path: under
  // `CRON_SCHEDULER=off` this route is the ONLY trigger for retention, so
  // retention could throw every night while the systemd timer recorded success
  // and nobody learned. It also made `curl --fail` useless — the same
  // instrument the paragraph above complains about being useless WITHOUT
  // `--fail`.
  const auth = await settle(() => cleanupExpiredAuth(prisma));
  const waitlistRetention = await settle(() => reapClosedWaitlistEntries(prisma));
  // Third, matching the scheduler job this route mirrors — and reaching this
  // route at all matters: under the `CRON_SCHEDULER=off` + systemd mode
  // `DEPLOYMENT.md` documents, this is the ONLY trigger for these sweeps, so a
  // check wired to the scheduler alone would be dead there.
  const timezoneAudit = await settle(() => auditTeacherTimezones(prisma));

  // The composite body at whichever status the outcomes earn — the shape
  // `/api/health` already uses for an ops endpoint whose body is a report and
  // whose status is the verdict (it answers 503 with a full `degraded` body
  // rather than trading one for the other).
  return respondOk(
    { auth, waitlistRetention, timezoneAudit },
    worstStatus([auth, waitlistRetention, timezoneAudit]),
  );
});

/** One sweep's outcome, so no sweep can prevent another from running. */
type SweepOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; error: string; status: ApiFailure['status'] };

async function settle<T>(run: () => Promise<T>): Promise<SweepOutcome<T>> {
  try {
    return { ok: true, result: await run() };
  } catch (err) {
    // Classified through the house helper rather than hand-rolled, so a lock
    // timeout here reads as 503/`warn` exactly as it does on every other route
    // — `classifyApiError` is where the transient-vs-permanent decision lives,
    // and duplicating that judgement would be a second place to keep in sync.
    const failure = classifyApiError(err);
    // Logged as well as returned: the response body reaches whoever called,
    // which under a systemd timer is a `curl` whose output may go nowhere.
    log[failure.level](
      { err, status: failure.status },
      'daily-cleanup: a sweep failed; the others still ran',
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: failure.status,
    };
  }
}

/**
 * 200 when every sweep ran; otherwise the failures' own classification.
 *
 * 503 only when EVERY failure is transient — a lost lock race is worth a retry
 * and a timer that backs off, and this is how the rest of the codebase answers
 * contention. One permanent failure alongside it makes 500 the run's honest
 * answer: a schema drift does not clear on the next tick, and reporting "try
 * again" for it would be the misleading half of the same trade. A 409 cannot
 * come from these sweeps, and would mean nothing to a timer if it did, so
 * it folds into 500 rather than being forwarded.
 */
function worstStatus(outcomes: ReadonlyArray<SweepOutcome<unknown>>): 200 | 500 | 503 {
  const failures = outcomes.filter((o) => !o.ok);
  if (failures.length === 0) return 200;
  return failures.every((f) => !f.ok && f.status === 503) ? 503 : 500;
}
