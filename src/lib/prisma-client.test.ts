import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createPrismaClient, Prisma, ClassStatus, Currency } from './prisma-client';
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
  it('prisma-client.ts imports only the generated client', () => {
    const specifiers = specifiersOf('prisma-client.ts');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((s) => s === '../generated/prisma/client')).toBe(true);
  });

  it('prisma-enums.ts imports only the generated enums, which import nothing', () => {
    const specifiers = specifiersOf('prisma-enums.ts');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((s) => s === '../generated/prisma/enums')).toBe(true);
  });

  it('both funnels hand back the same enum objects', () => {
    expect(enums.Currency).toBe(Currency);
  });

  it('re-exports the package, so its runtime values come from this module', () => {
    expect(new Prisma.Decimal('1.50').toFixed(2)).toBe('1.50');
    expect(ClassStatus.open).toBe('open');
  });
});
