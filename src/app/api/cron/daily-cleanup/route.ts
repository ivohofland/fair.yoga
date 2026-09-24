import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { classifyApiError, type ApiFailure } from '@/lib/api-errors';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import { cleanupExpiredAuth } from '@/services/auth-cleanup';
import { reapClosedWaitlistEntries } from '@/services/waitlist-retention';
import { reapExpiredNotifications } from '@/services/notification-retention';
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
 * a Playwright spec, so a precedent for testing a cron route exists. Each
 * service below has its own test file beside it, and `requireCronAuth` is
 * covered (`lib/cron-auth.test.ts`); what remains uncovered is the WIRING —
 * that this route calls the sweeps it NAMES.
 * `route.test.ts` mocks every sweep, so it cannot see that. That is the same
 * exposure `scheduler.test.ts`'s job-to-sweep map
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
 * "remain for manual runs"). If you change WHICH sweeps
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
  // which runs every sweep through `isolatedSweeps`: a thrown sweep must not
  // skip the ones after it on this route either — an intermittently failing
  // auth cleanup must not silently stop retention from running on a manual
  // call here.
  //
  // Reported per sweep in the body, so a caller reading the response learns
  // WHICH one ran.
  //
  // THE STATUS IS THE VERDICT, AND A 2xx FROM THIS ROUTE MEANS EVERY SWEEP RAN.
  // If any failed the answer is non-2xx and the body still carries every
  // outcome — read `data.auth.ok`, `data.waitlistRetention.ok`,
  // `data.notificationRetention.ok`, and `data.timezoneAudit.ok` to see which
  // one did not. Partial failure counts:
  // one sweep succeeding does not make the request as a whole a success,
  // because for an HTTP caller a 2xx means "what you asked for happened", and
  // if a sweep did not run, it did not.
  const auth = await settle(() => cleanupExpiredAuth(prisma));
  const waitlistRetention = await settle(() => reapClosedWaitlistEntries(prisma));
  const notificationRetention = await settle(() => reapExpiredNotifications(prisma));
  // Last, matching the scheduler job this route mirrors.
  const timezoneAudit = await settle(() => auditTeacherTimezones(prisma));

  // The composite body at whichever status the outcomes earn — the shape
  // `/api/health` already uses for an ops endpoint whose body is a report and
  // whose status is the verdict (it answers 503 with a full `degraded` body
  // rather than trading one for the other).
  return respondOk(
    { auth, waitlistRetention, notificationRetention, timezoneAudit },
    worstStatus([auth, waitlistRetention, notificationRetention, timezoneAudit]),
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
    // and a scripted `curl`'s output may go nowhere.
    // `...failure.detail` spreads FIRST so the literal keys below always win
    // — the same order `withErrorHandler` uses (`src/lib/api-utils.ts`) — so
    // a transient failure's `transientKind` reaches this line instead of
    // being dropped.
    log[failure.level](
      { ...failure.detail, err, status: failure.status },
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
 * 503 only when EVERY failure is transient — a transient database failure is
 * worth a retry and a timer that backs off, and this is how the rest of the
 * codebase answers contention. One permanent failure alongside it makes 500
 * the run's honest answer: a schema drift does not clear on the next tick,
 * and reporting "try again" for it would be the misleading half of the same
 * trade. A 409 cannot come from these sweeps, and would mean nothing to a
 * timer if it did, so it folds into 500 rather than being forwarded.
 */
function worstStatus(outcomes: ReadonlyArray<SweepOutcome<unknown>>): 200 | 500 | 503 {
  const failures = outcomes.filter((o) => !o.ok);
  if (failures.length === 0) return 200;
  return failures.every((f) => !f.ok && f.status === 503) ? 503 : 500;
}
