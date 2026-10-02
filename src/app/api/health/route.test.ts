import { describe, it, expect, vi, afterEach, onTestFinished } from 'vitest';
import { STALLED_AFTER_SKIPPED_TICKS, type JobHealth } from '@/lib/scheduler';
import { log } from '@/lib/log';

const { queryRaw, count } = vi.hoisted(() => ({
  queryRaw: vi.fn(async () => [{ ok: 1 }]),
  count: vi.fn(async (_args: unknown) => 0),
}));
vi.mock('@/lib/db', () => ({
  prisma: { $queryRaw: queryRaw, degradationEvent: { count } },
}));

const { GET } = await import('./route');

interface HealthBody {
  status: string;
  db: string;
  jobs: Record<string, Record<string, unknown>>;
  degradations?: { open: number };
}

function entry(overrides: Partial<JobHealth>): JobHealth {
  return {
    lastRunAt: '2026-09-29T10:00:00.000Z',
    lastSuccessAt: '2026-09-29T10:00:00.000Z',
    lastError: null,
    skippedTicks: 0,
    ...overrides,
  };
}

async function read(): Promise<{ status: number; body: HealthBody }> {
  const res = await GET();
  return { status: res.status, body: (await res.json()) as HealthBody };
}

afterEach(() => {
  globalThis.__fairYogaJobHealth = undefined;
});

describe('GET /api/health', () => {
  it('reports how many degradation events were seen in the last 24 hours, and leaves status alone', async () => {
    count.mockResolvedValueOnce(2);
    const before = Date.now();

    const { status, body } = await read();

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.degradations).toEqual({ open: 2 });
    const where = (count.mock.calls[0]![0] as { where: { lastSeenAt: { gte: Date } } }).where;
    const cutoff = where.lastSeenAt.gte.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(before - cutoff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000);
  });

  it('carries no code, sample or timestamp from the degradation table', async () => {
    count.mockResolvedValueOnce(3);

    const { body } = await read();

    expect(Object.keys(body.degradations ?? {})).toEqual(['open']);
    expect(JSON.stringify(body)).not.toMatch(/INCOME_TIER|TIMEZONE|sample|lastSeen/);
  });

  it('omits the block when the database probe fails', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    queryRaw.mockRejectedValueOnce(new Error('down'));

    const { status, body } = await read();

    expect(status).toBe(503);
    expect(body.degradations).toBeUndefined();
  });

  it('reports a stalled job unhealthy and the service degraded, though its last completed run succeeded', async () => {
    globalThis.__fairYogaJobHealth = {
      stalled: entry({ skippedTicks: STALLED_AFTER_SKIPPED_TICKS }),
      fine: entry({}),
    };

    const { status, body } = await read();

    expect(status).toBe(200);
    expect(body.db).toBe('up');
    expect(body.status).toBe('degraded');
    expect(body.jobs.stalled).toEqual({
      lastRunAt: '2026-09-29T10:00:00.000Z',
      lastSuccessAt: '2026-09-29T10:00:00.000Z',
      healthy: false,
    });
    expect(body.jobs.fine?.healthy).toBe(true);
  });

  it('answers ok while a run has overrun only one tick', async () => {
    globalThis.__fairYogaJobHealth = { busy: entry({ skippedTicks: STALLED_AFTER_SKIPPED_TICKS - 1 }) };

    const { body } = await read();

    expect(body.status).toBe('ok');
    expect(body.jobs.busy?.healthy).toBe(true);
  });

  it('still reports a job that errored unhealthy', async () => {
    globalThis.__fairYogaJobHealth = { failing: entry({ lastError: 'boom' }) };

    const { body } = await read();

    expect(body.status).toBe('degraded');
    expect(body.jobs.failing).toEqual({
      lastRunAt: '2026-09-29T10:00:00.000Z',
      lastSuccessAt: '2026-09-29T10:00:00.000Z',
      healthy: false,
    });
  });

  it('answers 503 with db down and still reports every job verdict', async () => {
    globalThis.__fairYogaJobHealth = {
      stalled: entry({ skippedTicks: STALLED_AFTER_SKIPPED_TICKS }),
      fine: entry({}),
    };
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    queryRaw.mockRejectedValueOnce(new Error('connection refused'));

    const { status, body } = await read();

    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('down');
    expect(body.jobs.stalled).toEqual({
      lastRunAt: '2026-09-29T10:00:00.000Z',
      lastSuccessAt: '2026-09-29T10:00:00.000Z',
      healthy: false,
    });
    expect(body.jobs.fine).toEqual({
      lastRunAt: '2026-09-29T10:00:00.000Z',
      lastSuccessAt: '2026-09-29T10:00:00.000Z',
      healthy: true,
    });
  });
});
