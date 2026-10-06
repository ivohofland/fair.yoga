// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  EMPTY_OUTBOX,
  clearOutbox,
  dismissRefused,
  enqueueAttendance,
  getOutbox,
  ownedOutbox,
  readOutbox,
  resetOutboxForTests,
  settleEntry,
  shownStatus,
  subscribeOutbox,
  useOutboxVolatile,
  withLock,
  type OutboxState,
  type QueuedStatus,
} from '@/lib/attendance-outbox';

const KEY = 'fy-outbox-v1';

function VolatileProbe() {
  return String(useOutboxVolatile());
}

function input(status: QueuedStatus, registrationId = 'r1') {
  return { ownerId: 'a', registrationId, classId: 'c', studentName: 'Ada', status };
}

describe('attendance outbox', () => {
  beforeEach(() => {
    localStorage.clear();
    resetOutboxForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('enqueue replaces the pending entry for the same registration', async () => {
    const a = await enqueueAttendance(input('attended'));
    const b = await enqueueAttendance(input('no_show'));
    expect(Object.keys(getOutbox().pending)).toEqual(['r1']);
    expect(getOutbox().pending.r1?.status).toBe('no_show');
    expect(a.id).not.toBe(b.id);
  });

  it('settle drops the entry only when it is still the one that was sent', async () => {
    const a = await enqueueAttendance(input('attended'));
    const b = await enqueueAttendance(input('no_show'));
    await settleEntry(a, { kind: 'confirmed', at: 1000 });
    expect(getOutbox().pending.r1).toEqual(b);
    await settleEntry(b, { kind: 'confirmed', at: 2000 });
    expect(getOutbox().pending).toEqual({});
    expect(getOutbox().confirmed.r1?.status).toBe('no_show');
  });

  it('a refusal moves the entry to refused with the server message', async () => {
    const a = await enqueueAttendance(input('attended'));
    await settleEntry(a, { kind: 'refused', message: 'This booking was cancelled.' });
    expect(getOutbox().pending).toEqual({});
    expect(getOutbox().refused.r1?.message).toBe('This booking was cancelled.');
    expect(getOutbox().refused.r1?.studentName).toBe('Ada');
  });

  it('a later confirmed write for the same registration clears its refusal', async () => {
    const a = await enqueueAttendance(input('attended', 'r1'));
    const other = await enqueueAttendance(input('attended', 'r2'));
    await settleEntry(a, { kind: 'refused', message: 'Record it once the class has started.' });
    await settleEntry(other, { kind: 'refused', message: 'y' });
    const retry = await enqueueAttendance(input('attended', 'r1'));
    // A retap alone proves nothing yet: the refusal stays until the retry is confirmed.
    expect(getOutbox().refused.r1?.message).toBe('Record it once the class has started.');
    await settleEntry(retry, { kind: 'confirmed', at: 3000 });
    expect(Object.keys(getOutbox().refused)).toEqual(['r2']);
    expect(getOutbox().confirmed.r1?.status).toBe('attended');
  });

  it('ownedOutbox keeps only the owner’s pending and refused entries, and every confirmation', async () => {
    const mine = await enqueueAttendance(input('attended', 'r1'));
    await enqueueAttendance({ ...input('attended', 'r2'), ownerId: 'b' });
    const theirs = await enqueueAttendance({ ...input('no_show', 'r3'), ownerId: 'b' });
    await enqueueAttendance(input('no_show', 'r4'));
    await settleEntry(theirs, { kind: 'refused', message: 'x' });
    await settleEntry(mine, { kind: 'refused', message: 'y' });
    const r5 = await enqueueAttendance({ ...input('attended', 'r5'), ownerId: 'b' });
    await settleEntry(r5, { kind: 'confirmed', at: 1000 });

    const owned = ownedOutbox(getOutbox(), 'a');
    expect(Object.keys(owned.pending)).toEqual(['r4']);
    expect(Object.keys(owned.refused)).toEqual(['r1']);
    expect(Object.keys(owned.confirmed)).toEqual(['r5']);
    expect(ownedOutbox(getOutbox(), null)).toEqual({ ...getOutbox(), pending: {}, refused: {} });
  });

  it('dropped removes without recording', async () => {
    const a = await enqueueAttendance(input('attended'));
    await settleEntry(a, { kind: 'dropped' });
    expect(getOutbox().pending).toEqual({});
    expect(getOutbox().confirmed).toEqual({});
    expect(getOutbox().refused).toEqual({});
  });

  it('dismissRefused removes one refusal', async () => {
    const a = await enqueueAttendance(input('attended', 'r1'));
    const b = await enqueueAttendance(input('attended', 'r2'));
    await settleEntry(a, { kind: 'refused', message: 'x' });
    await settleEntry(b, { kind: 'refused', message: 'y' });
    await dismissRefused('r1');
    expect(Object.keys(getOutbox().refused)).toEqual(['r2']);
  });

  it('clearOutbox empties everything and storage', async () => {
    await enqueueAttendance(input('attended'));
    await clearOutbox();
    expect(getOutbox()).toEqual(EMPTY_OUTBOX);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('readOutbox sees a write the cache missed, and keeps the cache when nothing changed', async () => {
    await enqueueAttendance(input('attended'));
    const primed = getOutbox();
    const listener = vi.fn();
    const unsubscribe = subscribeOutbox(listener);
    expect(readOutbox()).toBe(primed);
    expect(listener).not.toHaveBeenCalled();

    const pending = primed.pending.r1;
    if (pending === undefined) throw new Error('expected a pending entry');
    const newer = { ...pending, id: 'other-tab', status: 'no_show' };
    localStorage.setItem(KEY, JSON.stringify({ ...primed, pending: { r1: newer } }));
    expect(getOutbox().pending.r1?.status).toBe('attended');
    expect(readOutbox().pending.r1).toEqual(newer);
    expect(getOutbox().pending.r1?.status).toBe('no_show');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('state persists through storage and is re-read after a reset', async () => {
    await enqueueAttendance(input('attended'));
    resetOutboxForTests();
    expect(getOutbox().pending.r1).toBeDefined();
  });

  it('getOutbox returns the same object until a write', async () => {
    const first = getOutbox();
    expect(getOutbox()).toBe(first);
    await enqueueAttendance(input('attended'));
    expect(getOutbox()).not.toBe(first);
  });

  it('a storage event for the key refreshes the snapshot and notifies', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOutbox(listener);
    const doc: OutboxState = {
      pending: {
        r9: { id: 'x', ownerId: 'a', registrationId: 'r9', classId: 'c', studentName: 'n', status: 'attended', recordedAt: 1 },
      },
      confirmed: {},
      refused: {},
    };
    localStorage.setItem(KEY, JSON.stringify(doc));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(listener).toHaveBeenCalled();
    expect(getOutbox().pending.r9?.id).toBe('x');
    unsubscribe();
  });

  it('malformed stored JSON reads as empty', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(KEY, '{not json');
    expect(getOutbox()).toEqual(EMPTY_OUTBOX);

    const good = { id: 'x', ownerId: 'a', registrationId: 'r1', classId: 'c', studentName: 'n', recordedAt: 1 };
    resetOutboxForTests();
    localStorage.setItem(KEY, JSON.stringify({ pending: { r1: { ...good, status: 'bogus' } }, confirmed: {}, refused: {} }));
    expect(getOutbox().pending).toEqual({});

    resetOutboxForTests();
    localStorage.setItem(KEY, JSON.stringify({ pending: { other: { ...good, status: 'attended' } }, confirmed: {}, refused: {} }));
    expect(getOutbox().pending).toEqual({});
  });

  it('confirmed older than 24 h and refused older than 7 days are pruned on read', () => {
    vi.useFakeTimers();
    const now = new Date('2026-10-04T12:00:00Z').getTime();
    vi.setSystemTime(now);
    const hour = 60 * 60 * 1000;
    const base = { id: 'x', ownerId: 'a', classId: 'c', studentName: 'n', status: 'attended', recordedAt: 1 };
    localStorage.setItem(
      KEY,
      JSON.stringify({
        pending: {},
        confirmed: {
          old: { status: 'attended', confirmedAt: now - 25 * hour },
          fresh: { status: 'attended', confirmedAt: now - 23 * hour },
        },
        refused: {
          stale: { ...base, registrationId: 'stale', message: 'm', refusedAt: now - 8 * 24 * hour },
          recent: { ...base, registrationId: 'recent', message: 'm', refusedAt: now - 6 * 24 * hour },
        },
      }),
    );
    expect(Object.keys(getOutbox().confirmed)).toEqual(['fresh']);
    expect(Object.keys(getOutbox().refused)).toEqual(['recent']);
  });

  it('storage that throws falls back to memory', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    await expect(enqueueAttendance(input('attended'))).resolves.toBeDefined();
    expect(getOutbox().pending.r1).toBeDefined();
  });

  it('storage that throws is reported as volatile; working storage is not', async () => {
    const { result } = renderHook(() => useOutboxVolatile());
    expect(result.current).toBe(false);
    await act(() => enqueueAttendance(input('attended')));
    expect(result.current).toBe(false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    await act(() => enqueueAttendance(input('no_show')));
    expect(result.current).toBe(true);
  });

  it('after a failed write, neither a reload nor a clear brings back a superseded stored tap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realSetItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      writes++;
      if (writes > 1) throw new DOMException('quota', 'QuotaExceededError');
      realSetItem.call(this, key, value);
    });
    const first = await enqueueAttendance(input('attended'));
    expect(localStorage.getItem(KEY)).toContain('Ada');
    await settleEntry(first, { kind: 'confirmed', at: 1000 });
    const second = await enqueueAttendance(input('no_show'));
    await settleEntry(second, { kind: 'confirmed', at: 2000 });

    // The switch to memory leaves no stored copy older than memory behind.
    resetOutboxForTests();
    expect(getOutbox().pending.r1).toBeUndefined();

    await enqueueAttendance(input('attended'));
    await clearOutbox();
    expect(localStorage.getItem(KEY)).toBeNull();
    resetOutboxForTests();
    expect(getOutbox()).toEqual(EMPTY_OUTBOX);

    expect(warn).toHaveBeenCalledWith('[attendance-outbox] storage failed; the outbox is in memory for this tab', {
      error: 'QuotaExceededError',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Ada');
  });

  it('logs the switch to memory once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await enqueueAttendance(input('attended', 'r1'));
    await enqueueAttendance(input('attended', 'r2'));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('clearOutbox in memory mode removes what another tab stored since', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await enqueueAttendance(input('attended'));
    setItem.mockRestore();
    localStorage.setItem(
      KEY,
      JSON.stringify({
        pending: { r2: { id: 'x', ownerId: 'b', registrationId: 'r2', classId: 'c', studentName: 'Bo', status: 'attended', recordedAt: 1 } },
        confirmed: {},
        refused: {},
      }),
    );
    await clearOutbox();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('volatile storage reads false on the server', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    getOutbox();
    const html = renderToString(createElement(VolatileProbe));
    expect(html).toBe('false');
  });

  it('a stored __proto__ key alters no map’s prototype', () => {
    const now = Date.now();
    const entry = { id: 'x', ownerId: 'a', registrationId: '__proto__', classId: 'c', studentName: 'n', status: 'attended', recordedAt: 1 };
    localStorage.setItem(
      KEY,
      `{"pending":{"__proto__":${JSON.stringify(entry)}},"confirmed":{"__proto__":{"status":"attended","confirmedAt":${now}}},"refused":{}}`,
    );
    const { pending, confirmed } = getOutbox();
    expect('status' in pending).toBe(false);
    expect('confirmedAt' in confirmed).toBe(false);
    expect(Object.getPrototypeOf(pending)).not.toEqual(entry);
  });

  it('prunes a confirmation stamped more than 5 minutes in the future', () => {
    vi.useFakeTimers();
    const now = new Date('2026-10-04T12:00:00Z').getTime();
    vi.setSystemTime(now);
    const minute = 60_000;
    localStorage.setItem(
      KEY,
      JSON.stringify({
        pending: {},
        confirmed: {
          far: { status: 'attended', confirmedAt: now + 5 * minute + 1 },
          near: { status: 'attended', confirmedAt: now + 5 * minute },
        },
        refused: {},
      }),
    );
    expect(Object.keys(getOutbox().confirmed)).toEqual(['near']);
  });

  it('warns once with how many stored entries failed validation, naming none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = { id: 'x', ownerId: 'a', registrationId: 'r1', classId: 'c', studentName: 'Secret Name', status: 'attended', recordedAt: 1 };
    localStorage.setItem(
      KEY,
      JSON.stringify({
        pending: { r1: good, r2: { ...good, registrationId: 'r2', status: 'bogus' }, r3: { ...good } },
        confirmed: { r4: { status: 'attended' } },
        refused: {},
      }),
    );
    expect(Object.keys(getOutbox().pending)).toEqual(['r1']);
    // A storage event drops the cache, so the same stored text is parsed again.
    const unsubscribe = subscribeOutbox(() => {});
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(Object.keys(getOutbox().pending)).toEqual(['r1']);
    unsubscribe();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[attendance-outbox] stored entries discarded', { dropped: 3 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Secret Name');
  });

  it('warns once when the stored document cannot be read, and not for expired entries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(KEY, '{not json');
    getOutbox();
    readOutbox();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[attendance-outbox] stored entries discarded', { unreadable: true });

    warn.mockClear();
    resetOutboxForTests();
    localStorage.setItem(
      KEY,
      JSON.stringify({ pending: {}, confirmed: { old: { status: 'attended', confirmedAt: 1 } }, refused: {} }),
    );
    expect(getOutbox().confirmed).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('enqueue works where crypto.randomUUID is missing', async () => {
    vi.stubGlobal('crypto', {});
    try {
      const a = await enqueueAttendance(input('attended', 'r1'));
      const b = await enqueueAttendance(input('attended', 'r2'));
      expect(a.id).toEqual(expect.any(String));
      expect(a.id).not.toBe('');
      expect(a.id).not.toBe(b.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shownStatus: pending wins, then a confirmation newer than the render, then the rendered status', () => {
    const pendingEntry = { id: 'p', ownerId: 'a', registrationId: 'r1', classId: 'c', studentName: 'n', status: 'no_show' as const, recordedAt: 5 };
    const withPending: OutboxState = { ...EMPTY_OUTBOX, pending: { r1: pendingEntry }, confirmed: { r1: { status: 'attended', confirmedAt: 100 } } };
    expect(shownStatus(withPending, 'r1', 'registered', 50)).toEqual({ status: 'no_show', pending: true });

    const confirmedOnly: OutboxState = { ...EMPTY_OUTBOX, confirmed: { r1: { status: 'attended', confirmedAt: 100 } } };
    expect(shownStatus(confirmedOnly, 'r1', 'registered', 50)).toEqual({ status: 'attended', pending: false });
    expect(shownStatus(confirmedOnly, 'r1', 'no_show', 1_100)).toEqual({ status: 'no_show', pending: false });

    expect(shownStatus(EMPTY_OUTBOX, 'r1', 'registered', 50)).toEqual({ status: 'registered', pending: false });
  });

  it('shownStatus: a confirmation stamped in the render’s own second wins, one a full second older loses', () => {
    const at = (confirmedAt: number): OutboxState => ({
      ...EMPTY_OUTBOX,
      confirmed: { r1: { status: 'attended', confirmedAt } },
    });
    // The `Date` header truncates to the second, so 1_000 may stand for any instant up to 1_999.
    expect(shownStatus(at(1_000), 'r1', 'registered', 1_700)).toEqual({ status: 'attended', pending: false });
    expect(shownStatus(at(500), 'r1', 'registered', 1_700)).toEqual({ status: 'registered', pending: false });
  });

  it('withLock runs the function when navigator.locks is absent', async () => {
    await expect(withLock('n', async () => 7)).resolves.toBe(7);
  });

  it('withLock uses navigator.locks.request when present', async () => {
    const request = vi.fn((name: string, fn: () => unknown) => fn());
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    await expect(withLock('fy-x', async () => 3)).resolves.toBe(3);
    expect(request).toHaveBeenCalledWith('fy-x', expect.any(Function));
  });
});
