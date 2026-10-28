/**
 * @serial-tier lock-contention — produces every transient kind against the
 * real database by holding row locks and pool connections, and asserts on
 * outcomes bounded by `lock_timeout`, `statement_timeout`, a transaction's
 * `timeout` / `maxWait` and the pool's `connectionTimeoutMs`, which a
 * neighbour's lock noise can stretch past the bound under test.
 *
 * The produced half of the transient matrix: each case asserts
 * `transientDbFailure`, `classifyApiError`'s 503 and `transientKind`, and the
 * SQLSTATE `pgErrorOf` reads where Postgres raised one. The shapes are listed
 * in `docs/technical-architecture.md`, "Database errors".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma, createPrismaClient } from '@/lib/prisma-client';
import { classifyApiError, transientDbFailure, type TransientKind } from './api-errors';
import { serializeErr } from './log-serializers';
import { isPgPoolTimeout, pgErrorOf } from './pg-error';
import { knownWithAdapterCause, pgCause, pgPoolTimeout } from '../../tests/adapter-errors';

type Db = ReturnType<typeof createPrismaClient>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function rejectionOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject');
}

function ownKeys(value: unknown): string[] {
  return Object.keys(value as object).sort();
}

function expectKind(err: unknown, kind: TransientKind, level: 'warn' | 'error'): void {
  expect(transientDbFailure(err)).toEqual({ kind, level });
  expect(classifyApiError(err)).toMatchObject({ status: 503, level, detail: { transientKind: kind } });
}

describe('transient kinds produced against the real database', () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  let rowA: string;
  let rowB: string;

  beforeAll(async () => {
    rowA = (await db.account.create({ data: { email: `transient-a-${tag}@example.test` } })).id;
    rowB = (await db.account.create({ data: { email: `transient-b-${tag}@example.test` } })).id;
  });

  afterAll(async () => {
    await db.account.deleteMany({ where: { id: { in: [rowA, rowB] } } });
    await db.$disconnect();
  });

  function newEmail(): string {
    return `transient-${randomUUID()}@example.test`;
  }

  /** Runs `victim` while another transaction holds `FOR UPDATE` on `rowA`. */
  async function behindRowLock(victim: () => Promise<unknown>): Promise<unknown> {
    const locked = deferred();
    const release = deferred();
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${rowA} FOR UPDATE`;
        locked.resolve();
        await release.promise;
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
    try {
      await locked.promise;
      return await rejectionOf(victim);
    } finally {
      release.resolve();
      await holder;
    }
  }

  describe('lock_timeout', () => {
    it('typed: a Known P2039 with 55P03, at warn', async () => {
      const err = await behindRowLock(() =>
        db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
          await tx.account.update({ where: { id: rowA }, data: { email: newEmail() } });
        }),
      );
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2039');
      expect(pgErrorOf(err)?.sqlState).toBe('55P03');
      expectKind(err, 'lock_timeout', 'warn');
      // The helper's fabrication of the same case reads identically.
      const pg = pgErrorOf(err);
      if (pg === null) throw new Error('no Postgres error on the produced value');
      const fake = knownWithAdapterCause('P2039', pgCause('55P03', pg.message), { modelName: 'Account' });
      expect(pgErrorOf(fake)).toEqual(pg);
      expect(ownKeys(fake)).toEqual(ownKeys(err));
      expect(ownKeys(fake.meta as object)).toEqual(ownKeys((err as Prisma.PrismaClientKnownRequestError).meta as object));
    });

    it('raw: a P2010 with 55P03, at warn', async () => {
      const err = await behindRowLock(() =>
        db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
          await tx.$executeRaw`UPDATE "Account" SET email = ${newEmail()} WHERE id = ${rowA}`;
        }),
      );
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2010');
      expect(pgErrorOf(err)?.sqlState).toBe('55P03');
      expectKind(err, 'lock_timeout', 'warn');
    });
  });

  describe('deadlock (run twice: typed, then raw)', () => {
    type Locker = (tx: Prisma.TransactionClient, id: string) => Promise<unknown>;

    /** Two transactions lock `rowA` and `rowB` in opposite order behind a barrier; Postgres kills one. */
    async function deadlock(lock: Locker): Promise<unknown[]> {
      const aHolds = deferred();
      const bHolds = deferred();
      const side = (first: string, second: string, mine: () => void, theirs: Promise<void>) =>
        db.$transaction(
          async (tx) => {
            await lock(tx, first);
            mine();
            await theirs;
            await lock(tx, second);
          },
          { timeout: 10_000, maxWait: 5_000 },
        );
      const results = await Promise.allSettled([
        side(rowA, rowB, aHolds.resolve, bHolds.promise),
        side(rowB, rowA, bHolds.resolve, aHolds.promise),
      ]);
      return results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    }

    it('typed: the killed transaction throws a Known P2034 with 40P01, read as a deadlock, at error', async () => {
      const killed = await deadlock((tx, id) => tx.account.update({ where: { id }, data: { email: newEmail() } }));
      expect(killed).toHaveLength(1);
      const [err] = killed;
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2034');
      expect(pgErrorOf(err)?.sqlState).toBe('40P01');
      expectKind(err, 'deadlock', 'error');
    });

    it('raw: the killed transaction throws a P2010 with 40P01, at error', async () => {
      const killed = await deadlock((tx, id) => tx.$executeRaw`UPDATE "Account" SET email = ${newEmail()} WHERE id = ${id}`);
      expect(killed).toHaveLength(1);
      const [err] = killed;
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2010');
      expect(pgErrorOf(err)?.sqlState).toBe('40P01');
      expectKind(err, 'deadlock', 'error');
    });
  });

  describe('serialization', () => {
    /** A REPEATABLE READ snapshot of `rowB`, a concurrent committed update, then `write` in the snapshot. */
    async function serializationFailure(write: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<unknown> {
      return rejectionOf(() =>
        db.$transaction(
          async (tx) => {
            await tx.account.findUniqueOrThrow({ where: { id: rowB } });
            await db.account.update({ where: { id: rowB }, data: { email: newEmail() } });
            await write(tx);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10_000 },
        ),
      );
    }

    it('typed: a P2034 whose cause carries 40001, at warn', async () => {
      const err = await serializationFailure((tx) => tx.account.update({ where: { id: rowB }, data: { email: newEmail() } }));
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2034');
      expect(pgErrorOf(err)?.sqlState).toBe('40001');
      expectKind(err, 'serialization', 'warn');
      const pg = pgErrorOf(err);
      if (pg === null) throw new Error('no Postgres error on the produced value');
      const fake = knownWithAdapterCause('P2034', pgCause('40001', pg.message));
      expect(pgErrorOf(fake)).toEqual(pg);
    });

    it('raw: a P2010 with 40001, the same kind', async () => {
      const err = await serializationFailure((tx) => tx.$executeRaw`UPDATE "Account" SET email = ${newEmail()} WHERE id = ${rowB}`);
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2010');
      expect(pgErrorOf(err)?.sqlState).toBe('40001');
      expectKind(err, 'serialization', 'warn');
    });
  });

  /** Runs `work` on a one-connection client while an interactive transaction holds that connection. */
  async function behindHeldConnection<T>(
    connectionTimeoutMs: number,
    work: (single: Db, release: () => void) => Promise<T>,
  ): Promise<T> {
    const single = createPrismaClient({ poolMax: 1, connectionTimeoutMs });
    const holding = deferred();
    const release = deferred();
    const holder = single.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        holding.resolve();
        await release.promise;
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
    try {
      await holding.promise;
      return await work(single, release.resolve);
    } finally {
      release.resolve();
      await holder;
      await single.$disconnect();
    }
  }

  it('pool_exhausted: typed, raw and batch calls behind a held connection', async () => {
    const [typed, raw, batch] = await behindHeldConnection(200, async (single) => [
      await rejectionOf(() => single.account.count()),
      await rejectionOf(() => single.$queryRaw`SELECT 1`),
      await rejectionOf(() => single.$transaction([single.account.count()])),
    ]);
    for (const err of [typed, raw, batch]) {
      expect(isPgPoolTimeout(err)).toBe(true);
      expect(pgErrorOf(err)).toBeNull();
      expectKind(err, 'pool_exhausted', 'error');
    }
    // The helper's fabrication has the produced error's own keys.
    expect(ownKeys(pgPoolTimeout())).toEqual(ownKeys(typed));
  });

  describe('tx_budget', () => {
    it('an expired budget: P2028 with timeout and timeTaken, at warn', async () => {
      const err = await rejectionOf(() =>
        db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_sleep(0.5)`;
            await tx.account.count();
          },
          { timeout: 100 },
        ),
      );
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2028');
      expect((err as Prisma.PrismaClientKnownRequestError).meta).toMatchObject({ timeout: 100 });
      expect((err as Prisma.PrismaClientKnownRequestError).meta).toHaveProperty('timeTaken');
      expect(pgErrorOf(err)).toBeNull();
      expectKind(err, 'tx_budget', 'warn');
      expect(serializeErr(err)).toMatchObject({ code: 'P2028', txError: 'expired' });
    });

    it('an explicit maxWait below the pool bound: P2028 with meta {} at its own deadline, at warn', async () => {
      let waited = 0;
      const err = await behindHeldConnection(5_000, async (single, release) => {
        const started = Date.now();
        setTimeout(release, 1_500);
        const refusal = await rejectionOf(() => single.$transaction(async (tx) => tx.$queryRaw`SELECT 1`, { maxWait: 300 }));
        waited = Date.now() - started;
        return refusal;
      });
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2028');
      expect((err as Prisma.PrismaClientKnownRequestError).meta).toEqual({});
      expect(isPgPoolTimeout(err)).toBe(false);
      expectKind(err, 'tx_budget', 'warn');
      expect(serializeErr(err)).toMatchObject({ code: 'P2028', txError: 'other' });
      // `maxWait` fires at its own deadline, not once the pool hands over a connection.
      expect(waited).toBeGreaterThanOrEqual(300);
      expect(waited).toBeLessThan(1_500);
    });
  });

  it('pool_exhausted: an interactive transaction whose wait outlives the pool bound', async () => {
    // The client's own default `maxWait`: a margin past the pool bound, so pg-pool's timeout fires first.
    const err = await behindHeldConnection(200, (single) =>
      rejectionOf(() => single.$transaction(async (tx) => tx.$queryRaw`SELECT 1`)),
    );
    expect(isPgPoolTimeout(err)).toBe(true);
    expectKind(err, 'pool_exhausted', 'error');
  });

  it('not transient: a statement_timeout (57014) is a 500', async () => {
    const err = await rejectionOf(() =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '50ms'`;
        await tx.$executeRaw`SELECT pg_sleep(1)`;
      }),
    );
    expect(pgErrorOf(err)?.sqlState).toBe('57014');
    expect(transientDbFailure(err)).toBeNull();
    expect(classifyApiError(err)).toMatchObject({ status: 500 });
  });
});
