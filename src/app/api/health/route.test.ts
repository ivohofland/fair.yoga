import { describe, it, expect, vi, afterEach, onTestFinished } from 'vitest';
import { STALLED_AFTER_SKIPPED_TICKS, type JobHealth } from '@/lib/scheduler';
import { log } from '@/lib/log';

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn(async () => [{ ok: 1 }]) }));
vi.mock('@/lib/db', () => ({ prisma: { $queryRaw: queryRaw } }));

const { GET } = await import('./route');

interface HealthBody {
  status: string;
  db: string;
  jobs: Record<string, Record<string, unknown>>;
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
