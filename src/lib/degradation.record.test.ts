import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

/**
 * The one path no other test walks end to end: `logDegraded` through the real
 * `writeDegradationEvent` into a real `DegradationEvent` row. The unit tiers'
 * setup file stubs the store, and `degradation.test.ts` mocks both the store
 * and `@/lib/db`, so a break between the helper and the table passes them all.
 *
 * Fresh modules, with the store mocked back to the actual module, because the
 * stub is registered for every file in this tier.
 */
const prisma = new PrismaClient();
const zone = `Test/Record-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  await prisma.degradationEvent.deleteMany({ where: { code: 'TIMEZONE_INVALID_FALLBACK_UTC' } });
});

afterAll(async () => {
  await prisma.degradationEvent.deleteMany({ where: { code: 'TIMEZONE_INVALID_FALLBACK_UTC' } });
  await prisma.$disconnect();
});

describe('logDegraded, recorded', () => {
  it('writes a DegradationEvent row carrying only the allowlisted sample', async () => {
    vi.resetModules();
    vi.doMock('@/lib/degradation-store', () => vi.importActual('@/lib/degradation-store'));
    const { log } = await import('@/lib/log');
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { logDegraded } = await import('./degradation');

    try {
      logDegraded(
        'TIMEZONE_INVALID_FALLBACK_UTC',
        // A key off the allowlist, smuggled by a cast, must not reach the row.
        { timeZone: zone, site: 'format', email: 'x@example.test' } as unknown as { timeZone: string; site: string },
        'msg',
      );

      const row = await vi.waitFor(
        async () => {
          const found = await prisma.degradationEvent.findUnique({
            where: { code: 'TIMEZONE_INVALID_FALLBACK_UTC' },
          });
          expect((found?.sample as Record<string, unknown> | undefined)?.timeZone).toBe(zone);
          return found!;
        },
        { timeout: 5_000, interval: 50 },
      );

      expect(row.occurrences).toBeGreaterThanOrEqual(1);
      expect(Object.keys(row.sample as Record<string, unknown>).sort()).toEqual(['site', 'timeZone']);
      expect(row.sample).toEqual({ timeZone: zone, site: 'format' });
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
