import { prisma } from '@/lib/db';
import { getJobHealth } from '@/lib/scheduler';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

/**
 * Health check for the reverse proxy / uptime monitor.
 * Public by design; reveals liveness, DB reachability, and per-job
 * scheduler state (timestamps + healthy flag — error text stays in the
 * server log), nothing else.
 */
export async function GET() {
  const jobs = Object.fromEntries(
    Object.entries(getJobHealth()).map(([name, j]) => [
      name,
      {
        lastRunAt: j.lastRunAt,
        lastSuccessAt: j.lastSuccessAt,
        healthy: j.lastError === null,
      },
    ]),
  );
  const jobsStalled = Object.values(jobs).some((j) => !j.healthy);
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({
      status: jobsStalled ? 'degraded' : 'ok',
      db: 'up',
      jobs,
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
