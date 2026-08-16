import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { cleanupExpiredAuth } from '@/services/auth-cleanup';
import { reapClosedWaitlistEntries } from '@/services/waitlist-retention';

/**
 * One route per JOB, not per sweep — the existing shape, since
 * `/api/cron/transition-classes` already runs three. Renamed from
 * `auth-cleanup` with the scheduler job it mirrors (#238).
 *
 * NOTHING TESTS THIS ROUTE, OR ANY `/api/cron/*` ROUTE. `grep -rn 'api/cron'
 * tests/` returns nothing. The services below are each covered
 * (`auth-cleanup.test.ts`, `waitlist-retention.test.ts`) and `requireCronAuth`
 * is covered (`lib/cron-auth.test.ts`); what is uncovered is the WIRING — that
 * this route calls the sweeps it names and returns their results. That is the
 * same exposure `scheduler.test.ts`'s job-to-sweep map was built to close on
 * the scheduler side ("a job could carry the right name and interval while
 * running the wrong sweep"), and the route side has no equivalent.
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
  const auth = await cleanupExpiredAuth(prisma);
  const waitlistRetention = await reapClosedWaitlistEntries(prisma);

  return respondOk({ auth, waitlistRetention });
});
