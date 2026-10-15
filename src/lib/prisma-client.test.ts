import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createPrismaClient } from './prisma-client';

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

describe('prisma-client.ts imports', () => {
  it('imports only @prisma/client, which is all the migrate image carries', () => {
    const source = readFileSync(path.join(__dirname, 'prisma-client.ts'), 'utf8');
    const specifiers = [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g)].map((m) => m[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((s) => s === '@prisma/client')).toBe(true);
  });
});
