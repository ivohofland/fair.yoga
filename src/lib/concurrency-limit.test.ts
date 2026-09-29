import { describe, it, expect } from 'vitest';
import { createConcurrencyLimit } from './concurrency-limit';

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

describe('createConcurrencyLimit', () => {
  it('runs at most `slots` tasks at once and completes all of them', async () => {
    const run = createConcurrencyLimit(2);
    const latches = Array.from({ length: 5 }, () => latch());
    let live = 0;
    let max = 0;

    const results = latches.map((l, i) =>
      run(async () => {
        live++;
        max = Math.max(max, live);
        await l.promise;
        live--;
        return i;
      }),
    );

    // Release the latches one at a time, giving the queue a chance to admit
    // the next task before the next release.
    for (const l of latches) {
      await new Promise((r) => setTimeout(r, 0));
      l.open();
    }

    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
    expect(max).toBeLessThanOrEqual(2);
    expect(max).toBe(2);
  });

  it('releases a slot when a task rejects, and the rejection reaches its own caller', async () => {
    const run = createConcurrencyLimit(2);
    const blockerA = latch();
    const blockerB = latch();

    const first = run(async () => {
      await blockerA.promise;
      return 'first';
    });
    const second = run(async () => {
      await blockerB.promise;
      throw new Error('second failed');
    });
    let thirdStarted = false;
    const third = run(async () => {
      thirdStarted = true;
      return 'third';
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(thirdStarted).toBe(false); // queued: both slots are held by first and second

    blockerB.open();
    await expect(second).rejects.toThrow('second failed');
    expect(await third).toBe('third'); // third's slot opened up once second released on rejection

    blockerA.open();
    expect(await first).toBe('first');
  });

  it('starts queued tasks in FIFO order', async () => {
    const run = createConcurrencyLimit(1);
    const started: number[] = [];
    const blocker = latch();

    const tasks = [0, 1, 2, 3].map((i) =>
      run(async () => {
        started.push(i);
        if (i === 0) await blocker.promise;
        return i;
      }),
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0]); // only the first has a slot; 1-3 are queued

    blocker.open();
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3]);
    expect(started).toEqual([0, 1, 2, 3]);
  });
});
