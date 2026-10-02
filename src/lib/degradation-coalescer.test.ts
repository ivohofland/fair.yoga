import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCoalescer, type PendingDegradation } from './degradation-coalescer';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function make() {
  const write = vi.fn(async (_code: string, _pending: PendingDegradation) => undefined);
  const onWriteError = vi.fn();
  const coalescer = createCoalescer({
    write,
    windowMs: 60_000,
    now: () => new Date(),
    onWriteError,
  });
  return { coalescer, write, onWriteError };
}

describe('createCoalescer', () => {
  it('writes the first occurrence of a code at once', () => {
    const { coalescer, write } = make();
    coalescer.record('A', { n: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('A', {
      count: 1,
      at: new Date('2026-10-02T10:00:00.000Z'),
      sample: { n: 1 },
    });
  });

  it('holds later occurrences in the window and flushes them, batched, when it ends', async () => {
    const { coalescer, write } = make();
    coalescer.record('A', { n: 1 });
    coalescer.record('A', { n: 2 });
    coalescer.record('A', { n: 3 });
    expect(write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('A', {
      count: 2,
      at: new Date('2026-10-02T10:00:00.000Z'),
      sample: { n: 3 },
    });
  });

  it('still writes a single occurrence that lands just after a flush and is followed by nothing', async () => {
    const { coalescer, write } = make();
    coalescer.record('A', { n: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    coalescer.record('A', { n: 2 });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('A', expect.objectContaining({ count: 1, sample: { n: 2 } }));
  });

  it('writes again at once for an occurrence after a quiet window', async () => {
    const { coalescer, write } = make();
    coalescer.record('A', { n: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    coalescer.record('A', { n: 2 });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('sets no timer and writes nothing more when nothing is pending', async () => {
    const { coalescer, write } = make();
    coalescer.record('A', { n: 1 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps codes independent', () => {
    const { coalescer, write } = make();
    coalescer.record('A', {});
    coalescer.record('B', {});
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected write to onWriteError and never throws from record', async () => {
    const { coalescer, write, onWriteError } = make();
    const boom = new Error('db down');
    write.mockRejectedValueOnce(boom);

    expect(() => coalescer.record('A', {})).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(onWriteError).toHaveBeenCalledWith(boom, 'A');
  });

  it('reports a write that throws synchronously the same way', () => {
    const { coalescer, write, onWriteError } = make();
    const boom = new Error('sync');
    write.mockImplementationOnce(() => {
      throw boom;
    });

    expect(() => coalescer.record('A', {})).not.toThrow();
    expect(onWriteError).toHaveBeenCalledWith(boom, 'A');
  });
});
