import { prisma } from '@/lib/db';
import { getJobHealth } from '@/lib/scheduler';

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
  } catch {
    return Response.json({ status: 'degraded', db: 'down', jobs }, { status: 503 });
  }
}
