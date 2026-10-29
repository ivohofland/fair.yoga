import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { createPrismaClient, poolConfigFor, transactionOptionsFor, DEFAULT_POOL_MAX, MAX_WAIT_MARGIN_MS, Prisma, ClassStatus, Currency, type PoolCounters } from './prisma-client';
import * as enums from './prisma-enums';
import { transientDbFailure } from '@/lib/api-errors';
import { withErrorHandler } from '@/lib/api-utils';
import { PG_POOL_TIMEOUT_MESSAGE } from '@/lib/pg-error';
import { pgConnectTimeout } from '../../tests/adapter-errors';

const UNREACHABLE = 'postgresql://nobody@127.0.0.1:1/none';

describe('createPrismaClient', () => {
  const a = createPrismaClient();
  const b = createPrismaClient();
  afterAll(async () => {
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });

  it('returns a new client on every call, so each has its own pool', () => {
    expect(a).not.toBe(b);
  });

  it('reports a refused port as the adapter\'s DatabaseNotReachable', async () => {
    const client = createPrismaClient({ url: UNREACHABLE });
    try {
      const err: unknown = await client.$queryRaw`SELECT 1`.then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const meta = (err as Prisma.PrismaClientKnownRequestError).meta as { driverAdapterError?: { cause?: { kind?: unknown } } };
      expect(meta.driverAdapterError?.cause?.kind).toBe('DatabaseNotReachable');
      expect(transientDbFailure(err)).toEqual({ kind: 'connection', level: 'error' });
    } finally {
      await client.$disconnect();
    }
  });

  it('a refused port on a model call and inside an interactive transaction is P1001, kind connection', async () => {
    const client = createPrismaClient({ url: UNREACHABLE });
    try {
      const typed: unknown = await client.teacher.findFirst().then(() => null, (e: unknown) => e);
      const inTx: unknown = await client.$transaction(async (tx) => tx.teacher.findFirst()).then(() => null, (e: unknown) => e);
      for (const err of [typed, inTx]) {
        expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P1001');
        const meta = (err as Prisma.PrismaClientKnownRequestError).meta as { driverAdapterError?: { cause?: { kind?: unknown } } };
        expect(meta.driverAdapterError?.cause?.kind).toBe('DatabaseNotReachable');
        expect(transientDbFailure(err)).toEqual({ kind: 'connection', level: 'error' });
      }
    } finally {
      await client.$disconnect();
    }
  });

  it('poolMax reaches pg: one connection serialises two sleeps on one backend', async () => {
    const client = createPrismaClient({ poolMax: 1 });
    try {
      const t0 = Date.now();
      const rows = await Promise.all([
        client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid, pg_sleep(0.3)::text`,
        client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid, pg_sleep(0.3)::text`,
      ]);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
      expect(new Set(rows.map((r) => r[0]?.pid)).size).toBe(1);
    } finally {
      await client.$disconnect();
    }
  });

  it('connectionTimeoutMs bounds a connect to a silent host', async () => {
    const client = createPrismaClient({ url: 'postgresql://u:p@203.0.113.1:5432/none', connectionTimeoutMs: 500 });
    try {
      const t0 = Date.now();
      const err: unknown = await client.$queryRaw`SELECT 1`.then(() => null, (e: unknown) => e);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Connection terminated due to connection timeout');
      expect(Object.keys(err as object).sort()).toEqual(Object.keys(pgConnectTimeout()).sort());
      expect(Object.getOwnPropertyNames(err as object).sort()).toEqual(Object.getOwnPropertyNames(pgConnectTimeout()).sort());
      expect(String((err as Error).cause)).toBe(String(pgConnectTimeout().cause));
      expect(transientDbFailure(err)).toEqual({ kind: 'connection', level: 'error' });
    } finally {
      await client.$disconnect();
    }
  });

  // Prisma's own default maxWait is 2 s; the freed connection arrives after it.
  it('an interactive transaction waits for a connection as long as the pool bound', async () => {
    const client = createPrismaClient({ poolMax: 1, connectionTimeoutMs: 4_000 });
    let release = (): void => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let holding = (): void => {};
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const holder = client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        holding();
        await released;
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
    try {
      await held;
      const timer = setTimeout(release, 2_500);
      const started = Date.now();
      const outcome = await client.$transaction(async (tx) => tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one`)
        .then((rows) => rows[0]?.one, (e: unknown) => e);
      const waited = Date.now() - started;
      clearTimeout(timer);
      expect(outcome).toBe(1);
      expect(waited).toBeGreaterThanOrEqual(2_400);
    } finally {
      release();
      await holder;
      await client.$disconnect();
    }
  }, 15_000);

  // A process that skips $disconnect() still exits promptly.
  it('a client left connected does not hold a finished process open', async () => {
    const script = "const { createPrismaClient } = require('./src/lib/prisma-client'); const c = createPrismaClient(); c.$queryRaw`SELECT 1`.then(() => console.log('done'));";
    const outcome = await new Promise<number | null | 'killed'>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('killed'); }, 10_000);
      child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(outcome).toBe(0);
  }, 15_000);

  it('passes errorFormat through, so a model-query error drops its source excerpt', async () => {
    const messageOf = async (errorFormat?: 'minimal'): Promise<string> => {
      const client = createPrismaClient({ url: UNREACHABLE, errorFormat });
      try {
        await client.teacher.findFirst();
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        await client.$disconnect();
      }
    };
    const minimal = await messageOf('minimal');
    const standard = await messageOf();
    expect(minimal).toContain('`prisma.teacher.findFirst()` invocation:');
    expect(minimal).not.toContain('→');
    expect(standard).toContain('→');
  });
});

const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g;

function specifiersOf(file: string): string[] {
  const source = readFileSync(path.join(__dirname, file), 'utf8');
  return [...source.matchAll(IMPORT_SPECIFIER)].map((m) => m[2] ?? '');
}

describe('prisma funnel imports', () => {
  it('prisma-client.ts imports only the generated client, @prisma/adapter-pg, pg, ./pg-messages and node:os', () => {
    const specifiers = specifiersOf('prisma-client.ts');
    expect(specifiers.length).toBeGreaterThan(0);
    const ALLOWED = new Set(['../generated/prisma/client', '@prisma/adapter-pg', 'pg', './pg-messages', 'node:os']);
    expect(specifiers.every((s) => ALLOWED.has(s))).toBe(true);
  });

  // The migration image runs scripts that import this module from a stage that
  // copies files one by one, so a relative import it lacks fails to load there.
  it('the Dockerfile migrate stage carries every file prisma-client.ts imports relatively', () => {
    const dockerfile = readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
    const stage = /^FROM\s+\S+\s+AS\s+migrate\s*$([\s\S]*?)(?=^FROM\s)/m.exec(dockerfile)?.[1] ?? '';
    expect(stage).toContain('COPY src/lib/prisma-client.ts ./src/lib/prisma-client.ts');
    const relative = specifiersOf('prisma-client.ts').filter((s) => s.startsWith('.'));
    expect(relative.length).toBeGreaterThan(0);
    const missing = relative.filter((s) => {
      // The generated client is not copied: the stage generates it.
      if (s.startsWith('../generated/prisma/')) return !/^RUN pnpm exec prisma generate\s*$/m.test(stage);
      const file = `src/lib/${path.posix.normalize(s)}.ts`;
      return !stage.split('\n').some((line) => line.trim() === `COPY ${file} ./${file}`);
    });
    expect(missing).toEqual([]);
  });

  it('prisma-enums.ts imports only the generated enums, which import nothing', () => {
    const specifiers = specifiersOf('prisma-enums.ts');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((s) => s === '../generated/prisma/enums')).toBe(true);
  });

  it('generates CommonJS: the ESM output writes a process-wide __dirname global', () => {
    const client = readFileSync(path.join(__dirname, '..', 'generated', 'prisma', 'client.ts'), 'utf8');
    expect(client.length).toBeGreaterThan(0);
    expect(client).not.toContain("globalThis['__dirname']");
  });

  it('declares the cjs module format in the schema the output is generated from', () => {
    const schema = readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(/moduleFormat\s*=\s*"cjs"/);
  });

  it('declares engineType = "client" in the schema', () => {
    const schema = readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(/engineType\s*=\s*"client"/);
  });

  it('generates no native engine library', () => {
    const dir = path.join(__dirname, '..', 'generated', 'prisma');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]));
    const files = walk(dir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => f.endsWith('.node'))).toEqual([]);
  });

  it('both funnels hand back the same enum objects', () => {
    expect(enums.Currency).toBe(Currency);
  });

  it('re-exports the generated client, so its runtime values come from this module', () => {
    expect(new Prisma.Decimal('1.50').toFixed(2)).toBe('1.50');
    expect(ClassStatus.open).toBe('open');
  });
});

describe('transactionOptionsFor', () => {
  it.each([undefined, 200, 4_000])('sets maxWait a margin past the pool bound (connectionTimeoutMs %s)', (connectionTimeoutMs) => {
    const pool = poolConfigFor({ connectionTimeoutMs });
    expect(transactionOptionsFor(pool)).toEqual({ maxWait: pool.connectionTimeoutMillis + MAX_WAIT_MARGIN_MS });
  });
  it.each([undefined, 200, 4_000])('keeps maxWait strictly past the pool bound (connectionTimeoutMs %s)', (connectionTimeoutMs) => {
    const pool = poolConfigFor({ connectionTimeoutMs });
    expect(transactionOptionsFor(pool).maxWait).toBeGreaterThan(pool.connectionTimeoutMillis);
  });
});

describe('createPrismaClient pool error hooks', () => {
  it('onPoolError hears an idle pooled connection the server terminated', async () => {
    const heard: Error[] = [];
    const client = createPrismaClient({ poolMax: 1, onPoolError: (err) => { heard.push(err); } });
    const killer = createPrismaClient({ poolMax: 1 });
    try {
      const [{ pid } = { pid: 0 }] = await client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await killer.$queryRaw`SELECT pg_terminate_backend(${pid})`;
      const deadline = Date.now() + 3_000;
      while (heard.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(heard).toHaveLength(1);
      expect(heard[0]).toBeInstanceOf(Error);
      // The pool dropped the dead client, so the next query connects afresh.
      const [{ pid: next } = { pid: 0 }] = await client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(next).not.toBe(pid);
    } finally {
      await Promise.all([client.$disconnect(), killer.$disconnect()]);
    }
  });

  it('onConnectionError hears a transaction-held connection the server terminated', async () => {
    const heard: Error[] = [];
    const client = createPrismaClient({ poolMax: 1, onConnectionError: (err) => { heard.push(err); } });
    const killer = createPrismaClient({ poolMax: 1 });
    try {
      const outcome = await client
        .$transaction(async (tx) => {
          const [{ pid } = { pid: 0 }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await killer.$queryRaw`SELECT pg_terminate_backend(${pid})`;
          const deadline = Date.now() + 3_000;
          while (heard.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
        }, { timeout: 10_000 })
        .then(() => 'committed', (e: unknown) => e);
      // At least once: the dead socket can error again before the transaction's cleanup detaches the hook.
      expect(heard.length).toBeGreaterThanOrEqual(1);
      expect(heard.every((err) => err instanceof Error)).toBe(true);
      // The hook only reports; the transaction on the dead connection still fails.
      expect(outcome).not.toBe('committed');
    } finally {
      await Promise.all([client.$disconnect(), killer.$disconnect()]);
    }
  });
});

/** True when `err` or an `Error` on its `cause` chain carries pg-pool's wait-timeout text. */
function carriesPoolTimeout(err: unknown): boolean {
  for (let at: unknown = err, depth = 0; at instanceof Error && depth < 10; at = at.cause, depth += 1) {
    if (at.message === PG_POOL_TIMEOUT_MESSAGE) return true;
  }
  return false;
}

describe('createPrismaClient onPoolExhausted', () => {
  /**
   * A client whose one connection is held by a 5 s sleep; `run` meets the
   * starved pool. The 2 s pool bound leaves a cold connect on a loaded machine
   * room, and the sleep outlasts the warm-up and one full pool wait.
   */
  async function withStarvedClient(
    onPoolExhausted: (counters: PoolCounters) => void,
    run: (client: ReturnType<typeof createPrismaClient>) => Promise<void>,
  ): Promise<void> {
    const client = createPrismaClient({ poolMax: 1, connectionTimeoutMs: 2_000, onPoolExhausted });
    // Warm the pool first, so the holder's own connect is not raced against the bound.
    await client.$queryRaw`SELECT 1`;
    // A PrismaPromise runs only once `.then` is called, so this starts the sleep.
    const sleep = client.$queryRaw`SELECT pg_sleep(5)::text`.then(() => undefined);
    try {
      // Let the sleep take the pool's only connection before `run` asks for one.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await run(client);
    } finally {
      await sleep.catch(() => undefined);
      await client.$disconnect();
    }
  }

  it('hears a plain query that times out waiting for the pool, with the pool counters', async () => {
    const heard: PoolCounters[] = [];
    await withStarvedClient((counters) => { heard.push(counters); }, async (client) => {
      const err: unknown = await client.$queryRaw`SELECT 1`.then(() => null, (e: unknown) => e);
      expect(err).not.toBeNull();
      expect(carriesPoolTimeout(err) || transientDbFailure(err)?.kind === 'pool_exhausted').toBe(true);
    });
    expect(heard).toEqual([{ waiting: expect.any(Number), total: 1, idle: 0, max: 1 }]);
  }, 20_000);

  it('hears an interactive transaction whose start times out', async () => {
    const heard: PoolCounters[] = [];
    await withStarvedClient((counters) => { heard.push(counters); }, async (client) => {
      const err: unknown = await client.$transaction(async (tx) => tx.$queryRaw`SELECT 1`).then(() => null, (e: unknown) => e);
      expect(err).not.toBeNull();
    });
    expect(heard).toHaveLength(1);
  }, 20_000);

  it('a throwing hook does not replace the error the caller sees', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await withStarvedClient(() => { throw new Error('hook boom'); }, async (client) => {
        const err: unknown = await client.$queryRaw`SELECT 1`.then(() => null, (e: unknown) => e);
        expect(err).not.toBeNull();
        expect(carriesPoolTimeout(err)).toBe(true);
        expect(transientDbFailure(err)?.kind).toBe('pool_exhausted');
        expect(err instanceof Error ? err.message : String(err)).not.toContain('hook boom');
      });
      // Give a stray rejection a turn to surface before the listener goes.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  }, 20_000);

  it('connect errors that are not the wait timeout do not fire the hook', async () => {
    const heard: PoolCounters[] = [];
    const client = createPrismaClient({
      url: 'postgresql://u:p@203.0.113.1:5432/none',
      connectionTimeoutMs: 300,
      onPoolExhausted: (counters) => { heard.push(counters); },
    });
    try {
      const err: unknown = await client.$queryRaw`SELECT 1`.then(() => null, (e: unknown) => e);
      expect(err).not.toBeNull();
      expect(heard).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  it('disconnect ends the pool it was handed', async () => {
    const name = `fy_dispose_${process.pid}_${Date.now()}`;
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.searchParams.set('application_name', name);
    const client = createPrismaClient({ url: url.toString(), onPoolExhausted: () => {} });
    const observer = createPrismaClient({ poolMax: 1 });
    try {
      await client.$queryRaw`SELECT 1`;
      const countOf = async (): Promise<number> => {
        const [row] = await observer.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = ${name}`;
        return Number(row?.n ?? -1);
      };
      expect(await countOf()).toBe(1);
      await client.$disconnect();
      const deadline = Date.now() + 2_000;
      let open = await countOf();
      while (open !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        open = await countOf();
      }
      expect(open).toBe(0);
    } finally {
      await Promise.all([client.$disconnect(), observer.$disconnect()]);
    }
  });

  it('answers a withErrorHandler route 503 with the busy copy and no code', async () => {
    await withStarvedClient(() => {}, async (starved) => {
      const handler = withErrorHandler(async () => {
        await starved.$queryRaw`SELECT 1`;
        return NextResponse.json({});
      });
      const response = await handler(new NextRequest('http://localhost:3000/api/x'));
      expect(response.status).toBe(503);
      const body: unknown = await response.json();
      expect(body).toEqual({ error: { message: 'The system was busy and could not finish that. Please try again.' } });
      expect(Object.keys((body as { error: object }).error)).not.toContain('code');
    });
  }, 20_000);
});

describe('poolConfigFor', () => {
  it('fills every default from DATABASE_URL and the fixed policy', () => {
    expect(poolConfigFor({})).toEqual({
      connectionString: process.env.DATABASE_URL,
      max: availableParallelism() * 2 + 1,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 300000,
      allowExitOnIdle: true,
    });
    expect(DEFAULT_POOL_MAX).toBe(availableParallelism() * 2 + 1);
  });
  it('passes url, poolMax and connectionTimeoutMs through', () => {
    expect(poolConfigFor({ url: 'postgresql://a@b/c', poolMax: 1, connectionTimeoutMs: 200 }))
      .toMatchObject({ connectionString: 'postgresql://a@b/c', max: 1, connectionTimeoutMillis: 200 });
  });
  it('throws for an empty url, like a missing one', () => {
    expect(() => poolConfigFor({ url: '' })).toThrow('createPrismaClient: no url given and DATABASE_URL is not set');
  });
  it('throws for a missing url when DATABASE_URL is unset', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => poolConfigFor({})).toThrow('createPrismaClient: no url given and DATABASE_URL is not set');
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
  it.each([0, -1, 1.5, Number.NaN])('refuses poolMax %s with a RangeError', (poolMax) => {
    expect(() => poolConfigFor({ poolMax })).toThrow(RangeError);
  });
  it.each([0, -1, 1.5, Number.NaN])('refuses connectionTimeoutMs %s with a RangeError', (connectionTimeoutMs) => {
    expect(() => poolConfigFor({ connectionTimeoutMs })).toThrow(RangeError);
    expect(() => poolConfigFor({ connectionTimeoutMs })).toThrow(
      `createPrismaClient: connectionTimeoutMs must be a positive integer, got ${String(connectionTimeoutMs)}`,
    );
  });
});

describe('adapter version tether', () => {
  it('pins @prisma/adapter-pg to the generated client\'s version', () => {
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    let dir = path.dirname(req.resolve('@prisma/adapter-pg'));
    let version: unknown;
    for (;;) {
      const candidate = path.join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: unknown };
        if (pkg.name === '@prisma/adapter-pg') { version = pkg.version; break; }
      }
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('no package.json for @prisma/adapter-pg above its main entry');
      dir = parent;
    }
    expect(version).toBe(Prisma.prismaVersion.client);
  });
});
