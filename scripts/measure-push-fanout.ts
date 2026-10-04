// scripts/measure-push-fanout.ts
//
// Measures what the push dispatch's post-send writes cost when a full fan-out
// (PUSH_WORKERS notifications, each to MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT
// devices) lands its verdicts together on a small Prisma pool. The result and
// how to read it live in docs/technical-architecture.md (Cron Jobs → Push
// dispatch → Post-send writes).
//
//   pnpm exec tsx --conditions=react-server --env-file=.env scripts/measure-push-fanout.ts
//
// Writes and deletes rows in the database DATABASE_URL names, so it refuses to
// run from the main checkout (whose database is shared); it deletes only the
// rows it created. `--conditions=react-server` makes `server-only`, which
// `src/lib/log.ts` imports, resolve to its empty module outside Next.
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { dispatchPushes, PUSH_WORKERS, type PushSender } from '../src/services/push-dispatch';
import { getWorktreeIdentity } from '../src/lib/worktree/identity';
import { MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT } from '../src/services/push-subscriptions';

const POOL_SIZES = [1, 3, 5];
const REPEATS = 20;
/** Held connection time in the contended scenario: another job's query occupying the pool. */
const CONTENTION_MS = 2_000;

function url(poolSize: number): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set; run with --env-file=.env');
  const parsed = new URL(base);
  parsed.searchParams.set('connection_limit', String(poolSize));
  return parsed.toString();
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

const tag = `fanout-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const setup = new PrismaClient({ datasourceUrl: url(5) });

/** Pushes each id as its row is created, so a throw midway leaves the caller everything to clean up. */
async function seed(accountIds: string[], teacherIds: string[]): Promise<void> {
  for (let i = 0; i < PUSH_WORKERS; i++) {
    const account = await setup.account.create({ data: { email: `${tag}-${i}@test.local` } });
    accountIds.push(account.id);
    const teacher = await setup.teacher.create({
      data: {
        accountId: account.id,
        firstName: 'Fan',
        lastName: 'Out',
        email: `${tag}-${i}@test.local`,
        bio: 'measure-push-fanout',
        pageSlug: `${tag}-${i}`,
      },
    });
    teacherIds.push(teacher.id);
  }
}

async function reset(accountIds: string[], teacherIds: string[]): Promise<string[]> {
  await setup.pushSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
  await setup.pushSubscription.createMany({
    data: accountIds.flatMap((accountId) =>
      Array.from({ length: MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT }, () => ({
        accountId,
        endpoint: `https://push.invalid/${tag}-${crypto.randomUUID()}`,
        p256dh: 'unused',
        auth: 'unused',
      })),
    ),
  });
  const rows = await Promise.all(
    teacherIds.map((recipientId) =>
      setup.notification.create({
        data: { recipientType: 'teacher', recipientId, type: 'class_cancelled', title: 'T', body: 'B' },
      }),
    ),
  );
  return rows.map((r) => r.id);
}

interface Run {
  /** Wall time of the whole tick minus the send latency: the database's share. */
  dbMs: number;
  /** Longest single subscription write, queueing for a connection included. */
  worstWriteMs: number;
}

async function oneTick(
  poolSize: number,
  outcome: 'delivered' | 'gone',
  ids: string[],
  contend: boolean,
): Promise<Run> {
  const client = new PrismaClient({ datasourceUrl: url(poolSize) });
  const writes: number[] = [];
  const timed = client.$extends({
    query: {
      pushSubscription: {
        async updateMany({ args, query }) {
          const t = performance.now();
          const r = await query(args);
          writes.push(performance.now() - t);
          return r;
        },
        async deleteMany({ args, query }) {
          const t = performance.now();
          const r = await query(args);
          writes.push(performance.now() - t);
          return r;
        },
      },
    },
  });
  // The tick must see only this run's notifications.
  const scoped = timed.$extends({
    query: {
      notification: {
        async findMany({ args, query }) {
          return query({ ...args, where: { AND: [args.where ?? {}, { id: { in: ids } }] } });
        },
        // The tick's retire statement is database-wide; keep it to this run's rows.
        async updateMany({ args, query }) {
          return query({ ...args, where: { AND: [args.where ?? {}, { id: { in: ids } }] } });
        },
      },
    },
  });
  await client.$connect();
  // Open every connection the pool will use, so the timings are a warm pool's.
  await Promise.all(Array.from({ length: poolSize }, () => client.$queryRaw`SELECT 1`));
  const SEND_MS = 100;
  const totalSends = PUSH_WORKERS * MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT;
  // Every device answers at the same instant, once all of them have been
  // sent to: the worst case for the writes, and no worker still has a claim
  // or read of its own to run. Another job's slow queries then take the whole
  // pool for CONTENTION_MS, so only the post-send writes can wait on it.
  let held: Array<Promise<void>> = [];
  let entered = 0;
  let allEntered!: () => void;
  const everyDeviceReached = new Promise<void>((resolve) => {
    allEntered = resolve;
  });
  const send: PushSender = async () => {
    await new Promise((resolve) => setTimeout(resolve, SEND_MS));
    entered += 1;
    if (entered === totalSends) {
      if (contend) {
        held = Array.from({ length: poolSize }, () =>
          // A Prisma query is lazy until awaited or `.then`-ed; `.then` starts it now.
          client.$queryRawUnsafe(`SELECT pg_sleep(${CONTENTION_MS / 1000})::text`).then(() => undefined),
        );
      }
      // Let the holders take their connections before any verdict is written.
      setTimeout(allEntered, 20);
    }
    await everyDeviceReached;
    return { outcome, status: outcome === 'delivered' ? 201 : 410 };
  };
  let result: Awaited<ReturnType<typeof dispatchPushes>>;
  let elapsed: number;
  try {
    const start = performance.now();
    result = await dispatchPushes(scoped as unknown as PrismaClient, { send });
    elapsed = performance.now() - start;
    await Promise.all(held);
  } finally {
    await client.$disconnect();
  }
  if (result.claimed !== PUSH_WORKERS) throw new Error(`claimed ${result.claimed}, expected ${PUSH_WORKERS}`);
  if (writes.length !== totalSends) throw new Error(`${writes.length} writes, expected ${totalSends}`);
  return { dbMs: elapsed - SEND_MS - 20, worstWriteMs: Math.max(...writes) };
}

async function main(): Promise<void> {
  if (getWorktreeIdentity().isMainCheckout) {
    throw new Error('run this from a worktree (pnpm run worktree:setup): the main checkout\'s database is shared');
  }
  const accountIds: string[] = [];
  const teacherIds: string[] = [];
  try {
    await seed(accountIds, teacherIds);
    console.log(`fan-out: ${PUSH_WORKERS} notifications x ${MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT} devices, ${REPEATS} ticks per row, times in ms`);
    for (const contend of [false, true]) {
      for (const outcome of ['delivered', 'gone'] as const) {
        for (const poolSize of POOL_SIZES) {
          const runs: Run[] = [];
          for (let i = 0; i < (contend ? 3 : REPEATS); i++) {
            runs.push(await oneTick(poolSize, outcome, await reset(accountIds, teacherIds), contend));
          }
          const db = runs.map((r) => r.dbMs).sort((a, b) => a - b);
          const worst = runs.map((r) => r.worstWriteMs).sort((a, b) => a - b);
          console.log(
            `${contend ? `pool held ${CONTENTION_MS}ms` : 'idle pool'} | ${outcome.padEnd(9)} | pool ${poolSize} | ` +
              `tick-minus-send p50 ${percentile(db, 0.5).toFixed(0)} max ${db[db.length - 1]?.toFixed(0)} | ` +
              `worst single write p50 ${percentile(worst, 0.5).toFixed(0)} max ${worst[worst.length - 1]?.toFixed(0)}`,
          );
        }
      }
    }
  } finally {
    await setup.notification.deleteMany({ where: { recipientId: { in: teacherIds } } });
    await setup.pushSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
    await setup.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    await setup.account.deleteMany({ where: { id: { in: accountIds } } });
    await setup.$disconnect();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
