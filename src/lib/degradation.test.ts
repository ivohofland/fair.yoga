import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DegradationContext } from './degradation-codes';

vi.mock('@/lib/db', () => ({ prisma: { marker: 'db' } }));

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A fresh module graph per test, so the helper's coalescer state starts empty.
 * `log` and the store are re-imported with it, so the test spies on the very
 * instances the helper holds, and each load gets a store mock of its own.
 */
async function load() {
  vi.resetModules();
  vi.doMock('@/lib/degradation-store', () => ({
    writeDegradationEvent: vi.fn(async () => undefined),
  }));
  const { log } = await import('@/lib/log');
  const { logDegraded } = await import('./degradation');
  const store = await import('@/lib/degradation-store');
  return { log, logDegraded, write: vi.mocked(store.writeDegradationEvent) };
}

describe('logDegraded', () => {
  it('emits the code\'s log line at the code\'s level, with the code and the allowlisted context', async () => {
    const { log, logDegraded } = await load();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    logDegraded('INCOME_TIER_OUT_OF_RANGE', { tier: 9, studentId: 's1' }, 'tier outside 1-5');

    expect(warn).toHaveBeenCalledWith(
      { tier: 9, studentId: 's1', code: 'INCOME_TIER_OUT_OF_RANGE' },
      'tier outside 1-5',
    );
  });

  it('logs at error for a code whose level is error, with the err it was given', async () => {
    const { log, logDegraded } = await load();
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const err = new RangeError('bad zone');

    logDegraded('TIMEZONE_INVALID_FALLBACK_UTC', { timeZone: 'Not/AZone', site: 'format' }, 'falling back', err);

    expect(error).toHaveBeenCalledWith(
      { timeZone: 'Not/AZone', site: 'format', code: 'TIMEZONE_INVALID_FALLBACK_UTC', err },
      'falling back',
    );
  });

  it('records the event through the store with only the allowlisted sample', async () => {
    const { log, logDegraded, write } = await load();
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    logDegraded('INCOME_TIER_OUT_OF_RANGE', { tier: 9, studentId: 's1' }, 'm');

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledWith(
      { marker: 'db' },
      {
        code: 'INCOME_TIER_OUT_OF_RANGE',
        count: 1,
        at: expect.any(Date),
        sample: { tier: 9, studentId: 's1' },
      },
    );
  });

  it('drops a key that is not on the code\'s allowlist, from the log line and the sample, even when a cast smuggles it in', async () => {
    const { log, logDegraded, write } = await load();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const smuggled = {
      tier: 9,
      email: 'maria@example.com',
      studentName: 'Maria',
    } as unknown as DegradationContext<'INCOME_TIER_OUT_OF_RANGE'>;

    logDegraded('INCOME_TIER_OUT_OF_RANGE', smuggled, 'm');

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write.mock.calls[0]![1].sample).toEqual({ tier: 9 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('maria');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Maria');
  });

  it('truncates a long string value and drops a value that is neither a string nor a finite number', async () => {
    const { log, logDegraded, write } = await load();
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const odd = {
      timeZone: 'x'.repeat(5_000),
      site: { nested: true },
    } as unknown as DegradationContext<'TIMEZONE_INVALID_FALLBACK_UTC'>;

    logDegraded('TIMEZONE_INVALID_FALLBACK_UTC', odd, 'm');

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const { sample } = write.mock.calls[0]![1];
    expect(sample.timeZone).toBe('x'.repeat(200));
    expect(sample).not.toHaveProperty('site');
  });

  it('returns nothing, and logs once, when the store rejects', async () => {
    const { log, logDegraded, write } = await load();
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    write.mockRejectedValueOnce(new Error('db down'));

    const returned = logDegraded('INCOME_TIER_OUT_OF_RANGE', { tier: 9 }, 'm');

    expect(returned).toBeUndefined();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INCOME_TIER_OUT_OF_RANGE', err: expect.any(Error) }),
      expect.stringContaining('could not record'),
    );
  });

  it('refuses a context key that is not on the allowlist at compile time', async () => {
    const { log, logDegraded } = await load();
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    // @ts-expect-error — `email` is not a context key of this code
    logDegraded('INCOME_TIER_OUT_OF_RANGE', { email: 'x' }, 'm');
  });

  it('does not throw when a cast smuggles in a null context', async () => {
    const { log, logDegraded } = await load();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    expect(() =>
      logDegraded(
        'INCOME_TIER_OUT_OF_RANGE',
        null as unknown as DegradationContext<'INCOME_TIER_OUT_OF_RANGE'>,
        'm',
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith({ code: 'INCOME_TIER_OUT_OF_RANGE' }, 'm');
  });
});
