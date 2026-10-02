import { prisma } from '@/lib/db';
import { getJobHealth, isJobHealthy } from '@/lib/scheduler';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

/** A degradation event is "open" while it has fired within this window. */
const OPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Health check for the reverse proxy / uptime monitor.
 * Public by design; reveals liveness, DB reachability, per-job scheduler state
 * (timestamps + `isJobHealthy`'s verdict — error text stays in the server log),
 * and how many degradation events fired in the last day, as a bare number. Which
 * ones, and what they carried, appear only in the operator's digest email and
 * the server log (`docs/technical-architecture.md`, Cron Jobs → Degradation
 * events). Nothing else.
 */
export async function GET() {
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
    const open = await prisma.degradationEvent.count({
      where: { lastSeenAt: { gte: new Date(Date.now() - OPEN_WINDOW_MS) } },
    });
    return Response.json({
      status: jobsUnhealthy ? 'degraded' : 'ok',
      db: 'up',
      jobs,
      degradations: { open },
    });
  } catch (err) {
    // `db: 'down'` is the whole of what the RESPONSE may say — this endpoint
    // is public. WHY it is down must still reach the log: auth rejection,
    // pool exhaustion, TLS failure and "the database is gone" are four
    // different pages for whoever is woken up, and an empty catch here
    // destroys the distinction on the one endpoint an uptime monitor polls.
    log.error({ err }, 'health check: database probe failed');
    return Response.json({ status: 'degraded', db: 'down', jobs }, { status: 503 });
  }
}
