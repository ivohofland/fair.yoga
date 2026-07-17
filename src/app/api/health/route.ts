import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Health check for the reverse proxy / uptime monitor.
 * Public by design; reveals liveness and DB reachability, nothing else.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: 'ok', db: 'up' });
  } catch {
    return Response.json({ status: 'degraded', db: 'down' }, { status: 503 });
  }
}
