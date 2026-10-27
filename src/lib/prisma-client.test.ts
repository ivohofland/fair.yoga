import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { createPrismaClient, poolConfigFor, transactionOptionsFor, DEFAULT_POOL_MAX, MAX_WAIT_MARGIN_MS, Prisma, ClassStatus, Currency } from './prisma-client';
import * as enums from './prisma-enums';

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
  it('prisma-client.ts imports only the generated client, `@prisma/adapter-pg` and `node:os`', () => {
    const specifiers = specifiersOf('prisma-client.ts');
    expect(specifiers.length).toBeGreaterThan(0);
    const ALLOWED = new Set(['../generated/prisma/client', '@prisma/adapter-pg', 'node:os']);
    expect(specifiers.every((s) => ALLOWED.has(s))).toBe(true);
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
