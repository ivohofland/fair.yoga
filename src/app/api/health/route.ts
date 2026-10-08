import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getJobHealth, isJobHealthy } from '@/lib/scheduler';
import { log } from '@/lib/log';
import { hasCronSecret } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/** A degradation event is "open" while it has fired within this window. */
const OPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Health check for the reverse proxy / uptime monitor.
 * Public: liveness and DB reachability, `{ status, db }`, where `status`
 * already rolls up every job's health. With the cron secret (`hasCronSecret`,
 * never `requireCronAuth`, whose 401/500 would fail the monitor): per-job
 * scheduler state (timestamps + `isJobHealthy`'s verdict — error text stays in
 * the server log) and how many degradation events fired in the last day, as a
 * bare number. Which ones, and what they carried, appear only in the
 * operator's digest email and the server log (`docs/technical-architecture.md`,
 * Cron Jobs → Degradation events). When that number cannot be read, the
 * `degradations` key is omitted and the database still reports up. The public
 * answer never queries the degradation table, so a failure to read it is
 * logged only when a request carrying the secret asks.
 *
 * An `Authorization` header that is not the secret still gets the public
 * answer, and is logged at `warn` with why — never with its value.
 */
export async function GET(request: NextRequest) {
  const detailed = hasCronSecret(request);
  if (!detailed && request.headers.has('authorization')) {
    log.warn(
      { reason: process.env.CRON_SECRET ? 'mismatch' : 'secret_unset' },
      'health: authorization presented but not accepted',
    );
  }
  const jobs = Object.fromEntries(
    Object.entries(getJobHealth()).map(([name, j]) => [
      name,
      {
        lastRunAt: j.lastRunAt,
        lastSuccessAt: j.lastSuccessAt,
        healthy: isJobHealthy(j),
      },
    ]),
  );
  const jobsUnhealthy = Object.values(jobs).some((j) => !j.healthy);
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    // `db: 'down'` is the whole of what a response without the secret may
    // say. WHY it is down must still reach the log: auth rejection,
    // pool exhaustion, TLS failure and "the database is gone" are four
    // different pages for whoever is woken up, and an empty catch here
    // destroys the distinction on the one endpoint an uptime monitor polls.
    log.error({ err }, 'health check: database probe failed');
    return Response.json(
      detailed ? { status: 'degraded', db: 'down', jobs } : { status: 'degraded', db: 'down' },
      { status: 503 },
    );
  }
  const status = jobsUnhealthy ? 'degraded' : 'ok';
  if (!detailed) return Response.json({ status, db: 'up' });
  try {
    const open = await prisma.degradationEvent.count({
      where: { lastSeenAt: { gte: new Date(Date.now() - OPEN_WINDOW_MS) } },
    });
    return Response.json({ status, db: 'up', jobs, degradations: { open } });
  } catch (err) {
    // The database answered the probe, so this is not an outage: a missing
    // table, a permission or a timeout on the count alone. Report what is
    // known and leave the count out rather than invent one.
    log.error({ err }, 'health check: degradation count failed');
    return Response.json({ status, db: 'up', jobs });
  }
}
