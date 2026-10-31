import { describe, it, expect, vi } from 'vitest';
import { getCachedSchedule, PUBLIC_SCHEDULE_CACHE_CAPACITY } from './public-schedule-cache';

let n = 0;
const key = () => `test-${n++}`;

describe('getCachedSchedule', () => {
  it('loads once within 60 s and again after', async () => {
    const k = key();
    const load = vi.fn(async () => ['x']);
    await getCachedSchedule(k, 1000, load);
    await getCachedSchedule(k, 1000 + 60_000, load);
    expect(load).toHaveBeenCalledTimes(1);
    await getCachedSchedule(k, 1000 + 60_001, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps keys apart', async () => {
    const load = vi.fn(async () => 1);
    await getCachedSchedule(key(), 1000, load);
    await getCachedSchedule(key(), 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used entry at capacity', async () => {
    const t = 5_000_000;
    const first = key();
    const second = key();
    const loadFirst = vi.fn(async () => 'a');
    const loadSecond = vi.fn(async () => 'b');
    await getCachedSchedule(first, t, loadFirst);
    await getCachedSchedule(second, t, loadSecond);
    for (let i = 0; i < PUBLIC_SCHEDULE_CACHE_CAPACITY - 3; i++) await getCachedSchedule(key(), t, async () => 0);
    await getCachedSchedule(first, t, loadFirst); // touch: first is now newest
    await getCachedSchedule(key(), t, async () => 0);
    await getCachedSchedule(key(), t, async () => 0); // pushes the oldest (second) out
    await getCachedSchedule(first, t, loadFirst);
    await getCachedSchedule(second, t, loadSecond);
    expect(loadFirst).toHaveBeenCalledTimes(1);
    expect(loadSecond).toHaveBeenCalledTimes(2);
  });
});
