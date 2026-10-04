// scripts/measure-push-fanout.ts
//
// Measures what the push dispatch's post-send writes cost when a full fan-out
// (PUSH_WORKERS notifications, each to MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT
// devices) lands its verdicts together on a small Prisma pool. The result and
// how to read it live in docs/technical-architecture.md (Cron Jobs → Push
// dispatch tick bound).
//
//   pnpm exec tsx --conditions=react-server --env-file=.env scripts/measure-push-fanout.ts
//
// Runs against DATABASE_URL (a worktree's own database, never the shared one) and cleans up its own rows.
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { dispatchPushes, PUSH_WORKERS, type PushSender } from '../src/services/push-dispatch';
import { MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT } from '../src/services/push-subscriptions';

const POOL_SIZES = [1, 3, 5];
const REPEATS = 20;
/** Held connection time in the contended scenario: another job's query occupying the pool. */
const CONTENTION_MS = 2_000;

function url(poolSize: number): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set; run with --env-file=.env');
  return `${base}${base.includes('?') ? '&' : '?'}connection_limit=${poolSize}`;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

const tag = `fanout-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const setup = new PrismaClient({ datasourceUrl: url(5) });

async function seed(): Promise<{ accountIds: string[]; teacherIds: string[] }> {
  const accountIds: string[] = [];
  const teacherIds: string[] = [];
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
  return { accountIds, teacherIds };
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
          return query({ ...args, where: { ...args.where, id: { in: ids } } });
        },
      },
    },
  });
  await client.$connect();
  // Every device answers at the same instant: the worst case for the writes.
  const SEND_MS = 100;
  // Another job's slow queries take the whole pool for CONTENTION_MS, started
  // just before the first verdict lands so the claims have already run and
  // only the post-send writes can wait on it.
  let held: Array<Promise<void>> = [];
  const send: PushSender = async () => {
    await new Promise((resolve) => setTimeout(resolve, SEND_MS - 20));
    if (contend && held.length === 0) {
      held = Array.from({ length: poolSize }, () =>
        // A Prisma query is lazy until awaited or `.then`-ed; `.then` starts it now.
        client.$queryRawUnsafe(`SELECT pg_sleep(${CONTENTION_MS / 1000})::text`).then(() => undefined),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { outcome, status: outcome === 'delivered' ? 201 : 410 };
  };
  const start = performance.now();
  const result = await dispatchPushes(scoped as unknown as PrismaClient, { send });
  const elapsed = performance.now() - start;
  await Promise.all(held);
  await client.$disconnect();
  if (result.claimed !== PUSH_WORKERS) throw new Error(`claimed ${result.claimed}, expected ${PUSH_WORKERS}`);
  const expected = PUSH_WORKERS * MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT;
  if (writes.length !== expected) throw new Error(`${writes.length} writes, expected ${expected}`);
  return { dbMs: elapsed - SEND_MS, worstWriteMs: Math.max(...writes) };
}

async function main(): Promise<void> {
  const { accountIds, teacherIds } = await seed();
  try {
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
