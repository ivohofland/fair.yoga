/**
 * `createGuardedPrismaClient` (`tests/e2e/prisma.ts`) carries the
 * undefined-filter guard on its own (#783). Playwright has no module mocking,
 * so the factory's `$extends` is the only thing guarding an e2e client.
 *
 * Under vitest the setup file's `vi.mock('@prisma/client')` would guard the
 * factory's client regardless, so this file unmocks the module first: what is
 * left guarding the client is the factory. It needs a file of its own, since
 * the unmock reaches every client this file builds.
 *
 * The URL points at a port nothing listens on, so a write that gets past the
 * guard fails to connect instead of touching a database.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const UNREACHABLE = 'postgresql://nobody@127.0.0.1:1/none';
const GUARD_PREFIX = /^\[undefined-filter-guard\]/;
// Stands in for a beforeAll-assigned binding that never got its value.
let unassigned: string | undefined;

beforeAll(() => {
  vi.doUnmock('@prisma/client');
  vi.resetModules();
});

async function rejectionOf(client: PrismaClient): Promise<string> {
  try {
    await client.degradationEvent.deleteMany({ where: { code: unassigned } });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    await client.$disconnect();
  }
  throw new Error('deleteMany resolved against an unreachable database');
}

describe('createGuardedPrismaClient', () => {
  it('builds a client that refuses a bulk write whose where holds undefined', async () => {
    const { createGuardedPrismaClient } = await import('../../tests/e2e/prisma');
    const message = await rejectionOf(createGuardedPrismaClient({ datasourceUrl: UNREACHABLE }));
    expect(message).toMatch(/^\[undefined-filter-guard\] DegradationEvent\.deleteMany: where\.code is undefined/);
  });

  it('is the only guard here: a plain client from the unmocked module is refused by the connection, not the guard', async () => {
    const { PrismaClient: Plain } = await import('@prisma/client');
    const message = await rejectionOf(new Plain({ datasourceUrl: UNREACHABLE }));
    expect(message).not.toMatch(GUARD_PREFIX);
  });
});
