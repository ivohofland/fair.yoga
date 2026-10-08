import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
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

const SECRET = 'health-test-secret';

async function read(
  authorization: string | null = `Bearer ${SECRET}`,
): Promise<{ status: number; body: HealthBody }> {
  const res = await GET(
    new NextRequest('http://localhost:3000/api/health', authorization ? { headers: { authorization } } : {}),
  );
  return { status: res.status, body: (await res.json()) as HealthBody };
}

const originalSecret = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  globalThis.__fairYogaJobHealth = undefined;
  vi.useRealTimers();
});

describe('GET /api/health', () => {
  it('reports how many degradation events were seen in the last 24 hours, and leaves status alone', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-09-29T12:00:00.000Z');
    vi.setSystemTime(now);
    count.mockResolvedValueOnce(2);

    const { status, body } = await read();

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.degradations).toEqual({ open: 2 });
    const where = (count.mock.lastCall![0] as { where: { lastSeenAt: { gte: Date } } }).where;
    expect(where.lastSeenAt.gte.getTime()).toBe(now.getTime() - 24 * 60 * 60 * 1000);
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

  it('keeps db up and omits the block when only the degradation count fails', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    const cause = new Error('relation "DegradationEvent" does not exist');
    count.mockRejectedValueOnce(cause);

    const { status, body } = await read();

    expect(status).toBe(200);
    expect(body.db).toBe('up');
    expect(body.status).toBe('ok');
    expect('degradations' in body).toBe(false);
    expect(error).toHaveBeenCalledWith({ err: cause }, 'health check: degradation count failed');
    expect(error).not.toHaveBeenCalledWith(expect.anything(), 'health check: database probe failed');
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

describe('GET /api/health without the secret', () => {
  it('answers only status and db, without running the degradation query', async () => {
    count.mockClear();
    const { status, body } = await read(null);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', db: 'up' });
    expect(count).not.toHaveBeenCalled();
  });

  it('a wrong secret gets the same summary', async () => {
    count.mockClear();
    const { status, body } = await read('Bearer wrong');
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['db', 'status']);
    expect(count).not.toHaveBeenCalled();
  });

  it('still rolls an unhealthy job into status', async () => {
    globalThis.__fairYogaJobHealth = { failing: entry({ lastError: 'boom' }) };
    const { body } = await read(null);
    expect(body).toEqual({ status: 'degraded', db: 'up' });
  });

  it('a database outage is still a 503, summary only', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    queryRaw.mockRejectedValueOnce(new Error('down'));
    const { status, body } = await read(null);
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'degraded', db: 'down' });
  });

  it('with no CRON_SECRET configured, answers the summary rather than failing', async () => {
    delete process.env.CRON_SECRET;
    const { status, body } = await read(`Bearer ${SECRET}`);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', db: 'up' });
  });
});
