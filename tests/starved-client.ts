import { createPrismaClient, type PoolCounters } from '@/lib/prisma-client';

export type StarvedClient = ReturnType<typeof createPrismaClient>;

/** How long `withStarvedClient` waits to see the holder's sleep running before it fails. */
const HOLDER_SEEN_TIMEOUT_MS = 5_000;

/**
 * A client whose one connection is held by a `pg_sleep(sleepSeconds)` for the
 * length of `run`. `run` starts only once a separate observer sees that sleep
 * active in `pg_stat_activity` under this client's own `application_name`, so
 * the holder provably has the connection before `run` asks for one. The 2 s
 * pool bound leaves a cold connect on a loaded machine room; the sleep has to
 * outlast the warm-up and every pool wait `run` makes.
 */
export async function withStarvedClient(
  onPoolExhausted: (counters: PoolCounters) => void,
  sleepSeconds: number,
  run: (client: StarvedClient) => Promise<void>,
): Promise<void> {
  const name = `fy_starved_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.set('application_name', name);
  const client = createPrismaClient({ url: url.toString(), poolMax: 1, connectionTimeoutMs: 2_000, onPoolExhausted });
  const observer = createPrismaClient({ poolMax: 1 });
  let sleep: Promise<void> | undefined;
  try {
    // Warm the pool first, so the holder's own connect is not raced against the bound.
    await client.$queryRaw`SELECT 1`;
    // A PrismaPromise runs only once `.then` is called, so this starts the sleep.
    sleep = client.$queryRaw`SELECT pg_sleep(${sleepSeconds})::text`.then(() => undefined);
    await holderSeen(observer, name);
    await run(client);
  } finally {
    await sleep?.catch(() => undefined);
    await Promise.all([client.$disconnect(), observer.$disconnect()]);
  }
}

async function holderSeen(observer: StarvedClient, name: string): Promise<void> {
  const deadline = Date.now() + HOLDER_SEEN_TIMEOUT_MS;
  for (;;) {
    const [row] = await observer.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE application_name = ${name} AND state = 'active' AND query LIKE '%pg_sleep%'`;
    if (Number(row?.n ?? 0) > 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`withStarvedClient: the holder's pg_sleep was not seen active within ${HOLDER_SEEN_TIMEOUT_MS} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
