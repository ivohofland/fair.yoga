/**
 * Produces the shapes a connection dropped mid-query throws, against the real
 * database: a `net` relay sits between a throwaway client and Postgres and is
 * cut while a statement is in flight, just before a `COMMIT` is written, or
 * during one, either ending the sockets or resetting them. Postgres sees one client go away; nothing else on the
 * shared database is disturbed. The shapes are listed in
 * `docs/technical-architecture.md`, "Database errors".
 */
import { describe, it, expect, afterAll } from 'vitest';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Prisma, createPrismaClient } from '@/lib/prisma-client';
import { classifyApiError, transientDbFailure } from './api-errors';
import { adapterKindOf, pgErrorOf } from './pg-error';
import { driverAdapterError, socketCause } from '../../tests/adapter-errors';

type Db = ReturnType<typeof createPrismaClient>;
type Cut = 'end' | 'reset';

interface Relay {
  readonly url: string;
  cut(how: Cut): void;
  close(): void;
}

/** Cut this far into a statement that runs for seconds. */
const CUT_AFTER_MS = 300;

/** Long enough for pg to handle a cut before the test's next write. */
const PG_SEES_CUT_MS = 200;

/** How long the deferred trigger makes a `COMMIT` run. */
const COMMIT_SLEEP_MS = 3_000;

/** Cut this far into the callback's return, so the `COMMIT` is in flight under load too. */
const COMMIT_CUT_MS = 1_000;

function databaseUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (raw === undefined) throw new Error('DATABASE_URL is not set');
  return new URL(raw);
}

/** A relay to the database on an ephemeral local port; `cut` destroys every socket it has piped. */
async function openRelay(): Promise<Relay> {
  const target = databaseUrl();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || '5432'), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as net.AddressInfo).port);
  return {
    url: url.toString(),
    cut(how) {
      for (const socket of sockets) {
        if (how === 'reset') socket.resetAndDestroy();
        else socket.destroy();
      }
      sockets.clear();
    },
    close() {
      server.close();
    },
  };
}

async function rejectionOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject');
}

function expectConnection(err: unknown): void {
  expect(transientDbFailure(err)).toEqual({ kind: 'connection', level: 'error' });
  expect(classifyApiError(err)).toMatchObject({
    status: 503,
    level: 'error',
    detail: { transientKind: 'connection' },
    code: 'DATABASE_CONNECTION_FAILED',
  });
}

/**
 * pg's own error for a socket the server ended: nothing on it but the text,
 * plus Prisma's `clientVersion` where the call went through the client's
 * request path (`enumerableKeys`).
 */
function expectBareTermination(err: unknown, enumerableKeys: readonly string[]): void {
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect((err as Error).message).toBe('Connection terminated unexpectedly');
  expect(Object.keys(err as object).sort()).toEqual(enumerableKeys);
  expect(Object.prototype.hasOwnProperty.call(err, 'code')).toBe(false);
  expect((err as Error).cause).toBeUndefined();
  expectConnection(err);
}

/**
 * pg refusing a query on a client whose connection already failed: a plain
 * `Error` with nothing but its text, which nothing classifies, so a 500.
 */
function expectNotQueryable(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe('Client has encountered a connection error and is not queryable');
  expect(Object.keys(err as object)).toEqual([]);
  expect((err as Error).cause).toBeUndefined();
  expect(transientDbFailure(err)).toBeNull();
  expect(classifyApiError(err).status).toBe(500);
}

/** The adapter's cause object, from the bare error or the Known error's `meta`. */
function adapterCauseKeysOf(err: unknown): object {
  const meta = err instanceof Prisma.PrismaClientKnownRequestError ? (err.meta as { driverAdapterError?: { cause?: unknown } } | undefined) : undefined;
  const cause: unknown = meta === undefined ? (err as Error).cause : meta.driverAdapterError?.cause;
  expect(cause).toBeTypeOf('object');
  return cause as object;
}

/** The adapter's `ConnectionClosed` thrown bare, as the transaction's `COMMIT` throws it. */
function expectBareConnectionClosed(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  expect(Object.prototype.hasOwnProperty.call(err, 'name')).toBe(true);
  expect((err as Error).name).toBe('DriverAdapterError');
  expect(err).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect(adapterKindOf(err)).toBe('ConnectionClosed');
  expect(Object.keys(adapterCauseKeysOf(err))).toEqual(['kind']);
  expect(pgErrorOf(err)).toBeNull();
  expectConnection(err);
  const fixture = driverAdapterError(socketCause('ConnectionClosed'));
  expect(Object.keys(err as object)).toEqual(Object.keys(fixture));
  expect((err as Error).message).toBe(fixture.message);
  expect((err as Error).cause).toEqual(fixture.cause);
}

/** The adapter's `ConnectionClosed`, on a Known error carrying `code`. */
function expectKnownConnectionClosed(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect((err as Prisma.PrismaClientKnownRequestError).code).toBe(code);
  expect(adapterKindOf(err)).toBe('ConnectionClosed');
  expect(Object.keys(adapterCauseKeysOf(err))).toEqual(['kind']);
  expect(pgErrorOf(err)).toBeNull();
  expectConnection(err);
}

describe('a connection dropped mid-query, through a relay', () => {
  const direct = createPrismaClient();
  const emails: string[] = [];

  afterAll(async () => {
    await direct.account.deleteMany({ where: { email: { in: emails } } });
    await direct.$disconnect();
  });

  function newEmail(): string {
    const email = `connection-drop-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  }

  async function landed(email: string): Promise<boolean> {
    return (await direct.account.count({ where: { email } })) === 1;
  }

  /** Runs `work` on a warmed one-connection client behind a fresh relay; the client and relay are torn down after. */
  async function throughRelay(work: (db: Db, relay: Relay) => Promise<unknown>): Promise<unknown> {
    const relay = await openRelay();
    const db = createPrismaClient({ url: relay.url, poolMax: 1 });
    try {
      await db.$queryRaw`SELECT 1`;
      return await rejectionOf(() => work(db, relay));
    } finally {
      await db.$disconnect().catch(() => {});
      relay.close();
    }
  }

  /** Cuts `CUT_AFTER_MS` into `work`. */
  function cutDuring(how: Cut, work: (db: Db) => Promise<unknown>): Promise<unknown> {
    return throughRelay((db, relay) => {
      setTimeout(() => relay.cut(how), CUT_AFTER_MS);
      return work(db);
    });
  }

  /** A model update on a row the direct client holds `FOR UPDATE`, so the call is in flight when the cut lands. */
  async function blockedModelCall(how: Cut): Promise<unknown> {
    const row = await direct.account.create({ data: { email: newEmail() } });
    let release = (): void => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked = (): void => {};
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const holder = direct.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${row.id} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 10_000 },
    );
    try {
      // A holder that fails before locking would otherwise leave this waiting out the test's timeout.
      await Promise.race([isLocked, holder.then(() => { throw new Error('the holder ended before it locked'); })]);
      return await cutDuring(how, (db) => db.account.update({ where: { id: row.id }, data: { email: newEmail() } }));
    } finally {
      release();
      await holder;
    }
  }

  /**
   * Writes a row in an interactive transaction, cuts, and waits for pg to
   * handle the cut before the callback returns, so the `COMMIT` meets a
   * client pg already knows is dead. Without the wait the `COMMIT` races pg's
   * handling of the end or reset, and the shape depends on the platform.
   */
  function cutBeforeCommit(how: Cut, email: string): Promise<unknown> {
    return throughRelay((db, relay) =>
      db.$transaction(
        async (tx) => {
          await tx.account.create({ data: { email } });
          relay.cut(how);
          await new Promise((resolve) => setTimeout(resolve, PG_SEES_CUT_MS));
        },
        { timeout: 10_000 },
      ),
    );
  }

  /**
   * Writes a row in an interactive transaction whose `COMMIT` runs a deferred
   * trigger sleeping `COMMIT_SLEEP_MS` on a temporary table, and cuts
   * `COMMIT_CUT_MS` after the callback returns.
   */
  function cutDuringCommit(how: Cut, email: string): Promise<unknown> {
    return throughRelay((db, relay) =>
      db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('CREATE TEMP TABLE connection_drop (x int) ON COMMIT DROP');
          await tx.$executeRawUnsafe(
            `CREATE FUNCTION pg_temp.connection_drop_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(${COMMIT_SLEEP_MS / 1000}); RETURN NULL; END $$`,
          );
          await tx.$executeRawUnsafe(
            'CREATE CONSTRAINT TRIGGER connection_drop_slow AFTER INSERT ON connection_drop DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.connection_drop_slow()',
          );
          await tx.$executeRawUnsafe('INSERT INTO connection_drop VALUES (1)');
          await tx.account.create({ data: { email } });
          setTimeout(() => relay.cut(how), COMMIT_CUT_MS);
        },
        { timeout: 10_000 },
      ),
    );
  }

  /** Past the trigger's sleep, so a `COMMIT` that was going to land has. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, COMMIT_SLEEP_MS + 500));

  describe('the server ends the socket', () => {
    it('$queryRaw: pg\'s bare termination error, as connection', async () => {
      expectBareTermination(await cutDuring('end', (db) => db.$queryRaw`SELECT pg_sleep(3)`), ['clientVersion']);
    }, 20_000);

    it('a model call: the same bare error', async () => {
      expectBareTermination(await blockedModelCall('end'), ['clientVersion']);
    }, 20_000);

    it('a statement inside an interactive transaction: the same bare error', async () => {
      const err = await cutDuring('end', (db) =>
        db.$transaction(async (tx) => { await tx.$queryRaw`SELECT pg_sleep(3)`; }, { timeout: 10_000 }),
      );
      expectBareTermination(err, ['clientVersion']);
    }, 20_000);

    it('COMMIT after pg saw the end: pg\'s not-queryable error, a 500, and nothing written', async () => {
      const email = newEmail();
      expectNotQueryable(await cutBeforeCommit('end', email));
      await settle();
      expect(await landed(email)).toBe(false);
    }, 20_000);

    it('COMMIT in flight: the bare error, and the write landed', async () => {
      const email = newEmail();
      expectBareTermination(await cutDuringCommit('end', email), []);
      await settle();
      expect(await landed(email)).toBe(true);
    }, 20_000);
  });

  describe('the socket is reset', () => {
    it('$queryRaw: P2010, ConnectionClosed', async () => {
      expectKnownConnectionClosed(await cutDuring('reset', (db) => db.$queryRaw`SELECT pg_sleep(3)`), 'P2010');
    }, 20_000);

    it('a model call: P1017, ConnectionClosed', async () => {
      expectKnownConnectionClosed(await blockedModelCall('reset'), 'P1017');
    }, 20_000);

    it('a statement inside an interactive transaction: P2010, ConnectionClosed', async () => {
      const err = await cutDuring('reset', (db) =>
        db.$transaction(async (tx) => { await tx.$queryRaw`SELECT pg_sleep(3)`; }, { timeout: 10_000 }),
      );
      expectKnownConnectionClosed(err, 'P2010');
    }, 20_000);

    it('COMMIT after pg saw the reset: the same not-queryable error, a 500, and nothing written', async () => {
      const email = newEmail();
      expectNotQueryable(await cutBeforeCommit('reset', email));
      await settle();
      expect(await landed(email)).toBe(false);
    }, 20_000);

    it('COMMIT in flight: a bare DriverAdapterError, ConnectionClosed, and the write landed', async () => {
      const email = newEmail();
      expectBareConnectionClosed(await cutDuringCommit('reset', email));
      await settle();
      expect(await landed(email)).toBe(true);
    }, 20_000);
  });
});
