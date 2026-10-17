import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { createPrismaClient, poolConfigFor, DEFAULT_POOL_MAX, Prisma, ClassStatus, Currency } from './prisma-client';
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

  it('connects to the url it is given', async () => {
    const client = createPrismaClient({ url: UNREACHABLE });
    try {
      await expect(client.$queryRaw`SELECT 1`).rejects.toThrow(/127\.0\.0\.1:1/);
    } finally {
      await client.$disconnect();
    }
  });

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

  it('both funnels hand back the same enum objects', () => {
    expect(enums.Currency).toBe(Currency);
  });

  it('re-exports the generated client, so its runtime values come from this module', () => {
    expect(new Prisma.Decimal('1.50').toFixed(2)).toBe('1.50');
    expect(ClassStatus.open).toBe('open');
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
