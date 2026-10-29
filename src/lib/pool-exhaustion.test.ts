import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { createPrismaClient, type PrismaClientFactoryOptions } from '@/lib/prisma-client';
import { withStarvedClient, type StarvedClient } from '../../tests/starved-client';

/**
 * Pool exhaustion recorded through the real `writeDegradationEvent` into a
 * real `DegradationEvent` row, and the health stamp beside it. Fresh modules,
 * with the store mocked back to the actual module, because the unit tier's
 * setup stubs it for every file (the `degradation.record.test.ts` pattern).
 */
const CODE = 'DATABASE_POOL_EXHAUSTED';
const prisma = createPrismaClient();

async function loadFresh(): Promise<{
  error: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  mod: typeof import('./pool-exhaustion');
  degradation: typeof import('./degradation');
  apiUtils: typeof import('./api-utils');
}> {
  vi.doMock('@/lib/degradation-store', () => vi.importActual('@/lib/degradation-store'));
  const { log } = await import('@/lib/log');
  const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const mod = await import('./pool-exhaustion');
  const degradation = await import('./degradation');
  const apiUtils = await import('./api-utils');
  return { error, warn, mod, degradation, apiUtils };
}

async function rowCount(expected: number): Promise<{ occurrences: number; sample: unknown }> {
  return vi.waitFor(
    async () => {
      const found = await prisma.degradationEvent.findUnique({ where: { code: CODE } });
      expect(found?.occurrences).toBe(expected);
      return found!;
    },
    { timeout: 5_000, interval: 50 },
  );
}

beforeAll(async () => {
  await prisma.degradationEvent.deleteMany({ where: { code: CODE } });
});

beforeEach(async () => {
  vi.resetModules();
  globalThis.__fairYogaPoolExhaustion = undefined;
  await prisma.degradationEvent.deleteMany({ where: { code: CODE } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/db');
  vi.doUnmock('@/lib/prisma-client');
  vi.doUnmock('@/lib/degradation-store');
  globalThis.__fairYogaPoolExhaustion = undefined;
});

afterAll(async () => {
  await prisma.degradationEvent.deleteMany({ where: { code: CODE } });
  await prisma.$disconnect();
});

describe('recordPoolExhaustion, end to end', () => {
  it('a request starved of a connection answers the busy 503 and leaves one DegradationEvent row', async () => {
    const { mod, apiUtils } = await loadFresh();
    expect(mod.lastPoolExhaustionAt()).toBeNull();

    await withStarvedClient(mod.recordPoolExhaustion, 5, async (starved) => {
      const handler = apiUtils.withErrorHandler(async () => {
        await starved.$queryRaw`SELECT 1`;
        return NextResponse.json({});
      });
      const response = await handler(new NextRequest('http://localhost:3000/api/x'));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { message: 'The system was busy and could not finish that. Please try again.' },
      });
    });

    const row = await rowCount(1);
    expect(Object.keys(row.sample as Record<string, unknown>).sort()).toEqual(['idle', 'max', 'total', 'waiting']);
    expect(mod.lastPoolExhaustionAt()).not.toBeNull();
  }, 25_000);

  // The coalescer's trailing timer is created at the second occurrence, so the
  // clock is faked before it; the second occurrence is therefore a direct call,
  // because pg-pool's own wait timeout runs on the timers being faked.
  it('a second exhaustion inside the window reaches the row after the window', async () => {
    const { mod, apiUtils, degradation } = await loadFresh();

    await withStarvedClient(mod.recordPoolExhaustion, 5, async (starved) => {
      const handler = apiUtils.withErrorHandler(async () => {
        await starved.$queryRaw`SELECT 1`;
        return NextResponse.json({});
      });
      expect((await handler(new NextRequest('http://localhost:3000/api/x'))).status).toBe(503);
    });
    await rowCount(1);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mod.recordPoolExhaustion({ waiting: 0, total: 1, idle: 0, max: 1 });
    vi.advanceTimersByTime(degradation.COALESCE_WINDOW_MS);
    vi.useRealTimers();

    const row = await rowCount(2);
    expect(row.occurrences).toBe(2);
  }, 25_000);

  // Production-shaped: the shared client is the starved one and carries the
  // hook, so the record's own write meets the same dry pool. The row is
  // reached by a direct record once the pool is free, on a clock moved past
  // the window, because the trailing timer the failed write left is real.
  it('does not throw when the event write itself cannot get a connection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    let shared: StarvedClient | undefined;
    vi.doMock('@/lib/db', () => ({
      get prisma(): StarvedClient | undefined { return shared; },
    }));
    try {
      const { mod, apiUtils, degradation, error } = await loadFresh();
      await withStarvedClient(mod.recordPoolExhaustion, 10, async (starved) => {
        shared = starved;
        const handler = apiUtils.withErrorHandler(async () => {
          await starved.$queryRaw`SELECT 1`;
          return NextResponse.json({});
        });
        expect((await handler(new NextRequest('http://localhost:3000/api/x'))).status).toBe(503);
        expect(error).toHaveBeenCalledWith(expect.anything(), 'transient database failure surfaced to a client');

        await vi.waitFor(
          () => {
            expect(error).toHaveBeenCalledWith(
              expect.objectContaining({ code: CODE }),
              'could not record a degradation event; the log line is all there is',
            );
          },
          { timeout: 8_000, interval: 25 },
        );

        // Wait out the holder: the pool answers again once the sleep ends.
        await vi.waitFor(async () => { await starved.$queryRaw`SELECT 1`; }, { timeout: 15_000, interval: 100 });

        // `record` reads the clock synchronously and its write starts after an
        // await, so the real clock is back before the write touches the pool.
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + degradation.COALESCE_WINDOW_MS });
        mod.recordPoolExhaustion({ waiting: 0, total: 1, idle: 0, max: 1 });
        vi.useRealTimers();

        await vi.waitFor(
          async () => {
            const found = await prisma.degradationEvent.findUnique({ where: { code: CODE } });
            expect(found?.occurrences).toBeGreaterThanOrEqual(1);
          },
          { timeout: 5_000, interval: 50 },
        );
      });
      // Give a stray rejection a turn to surface before the listener goes.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  }, 50_000);
});

describe('poolExhaustedWithin', () => {
  it('poolExhaustedWithin is false before any exhaustion, true inside 15 minutes, false at 15 minutes', async () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const { poolExhaustedWithin, POOL_EXHAUSTION_HEALTH_WINDOW_MS } = await import('./pool-exhaustion');
    expect(POOL_EXHAUSTION_HEALTH_WINDOW_MS).toBe(15 * 60_000);
    expect(poolExhaustedWithin(now)).toBe(false);

    globalThis.__fairYogaPoolExhaustion!.lastAt = new Date(now.getTime() - 60_000);
    expect(poolExhaustedWithin(now)).toBe(true);

    globalThis.__fairYogaPoolExhaustion!.lastAt = new Date(now.getTime() - (POOL_EXHAUSTION_HEALTH_WINDOW_MS - 1));
    expect(poolExhaustedWithin(now)).toBe(true);

    globalThis.__fairYogaPoolExhaustion!.lastAt = new Date(now.getTime() - POOL_EXHAUSTION_HEALTH_WINDOW_MS);
    expect(poolExhaustedWithin(now)).toBe(false);
  });

  it('reads the process-wide holder, so a stamp set before the module loads is seen', async () => {
    const lastAt = new Date('2026-10-29T12:00:00Z');
    globalThis.__fairYogaPoolExhaustion = { lastAt };
    const { lastPoolExhaustionAt, poolExhaustedWithin } = await import('./pool-exhaustion');
    expect(lastPoolExhaustionAt()).toBe(lastAt);
    expect(poolExhaustedWithin(new Date(lastAt.getTime() + 60_000))).toBe(true);
  });
});

describe('db.ts', () => {
  it('db.ts hands recordPoolExhaustion to the factory', async () => {
    const saved = globalThis.__fairYogaPrisma;
    let received: PrismaClientFactoryOptions | undefined;
    vi.doMock('@/lib/prisma-client', async () => ({
      ...(await vi.importActual<typeof import('@/lib/prisma-client')>('@/lib/prisma-client')),
      createPrismaClient: (options: PrismaClientFactoryOptions) => {
        received = options;
        return {};
      },
    }));
    globalThis.__fairYogaPrisma = undefined;
    try {
      await import('@/lib/db');
      const { recordPoolExhaustion } = await import('./pool-exhaustion');
      expect(received).toBeDefined();
      expect(received?.onPoolExhausted).toBe(recordPoolExhaustion);
    } finally {
      globalThis.__fairYogaPrisma = saved;
    }
  });
});
