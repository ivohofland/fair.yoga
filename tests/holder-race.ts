/**
 * Races a request against a twin that a second connection holds uncommitted,
 * and reports whether the request parked behind it (`pg_blocking_pids`). A
 * caller asserts `parked`, so a run where the request never reached the held
 * key fails instead of passing on a path it did not exercise.
 */
import { createPrismaClient, type Prisma, type PrismaClient } from '@/lib/prisma-client';

const WAIT_MS = 3_000;

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/** The pid of a backend waiting on `holderPid`'s locks, polled until `stop()` or `WAIT_MS`. */
async function waiterOf(db: PrismaClient, holderPid: number, stop: () => boolean): Promise<number | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !stop()) {
    const [row] = await db.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/**
 * Sends `request` while a second connection holds `hold`'s writes
 * uncommitted, and commits them only once `request` is parked behind them.
 */
export async function raceBehindHolder<T>(
  hold: (tx: Prisma.TransactionClient) => Promise<void>,
  request: () => Promise<T>,
): Promise<{ result: T; parked: boolean }> {
  const holder = createPrismaClient();
  const held = latch();
  const release = latch();
  let holderPid = 0;
  const holding = holder.$transaction(async (tx) => {
    holderPid = await ownPid(tx);
    await hold(tx);
    held.open();
    await release.promise;
  }, { timeout: 20_000 });
  try {
    await Promise.race([held.promise, holding]);
    let settled = false;
    const pending = request().finally(() => { settled = true; });
    void pending.catch(() => undefined);
    const parked = (await waiterOf(holder, holderPid, () => settled)) !== null;
    release.open();
    await holding;
    return { result: await pending, parked };
  } finally {
    release.open();
    await holding.catch(() => undefined);
    await holder.$disconnect();
  }
}
