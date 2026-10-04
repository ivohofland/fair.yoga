// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_OUTBOX,
  clearOutbox,
  dismissRefused,
  enqueueAttendance,
  getOutbox,
  resetOutboxForTests,
  settleEntry,
  shownStatus,
  subscribeOutbox,
  withLock,
  type OutboxState,
  type QueuedStatus,
} from '@/lib/attendance-outbox';

const KEY = 'fy-outbox-v1';

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

  it('shownStatus: pending wins, then a confirmation newer than the render, then the rendered status', () => {
    const pendingEntry = { id: 'p', ownerId: 'a', registrationId: 'r1', classId: 'c', studentName: 'n', status: 'no_show' as const, recordedAt: 5 };
    const withPending: OutboxState = { ...EMPTY_OUTBOX, pending: { r1: pendingEntry }, confirmed: { r1: { status: 'attended', confirmedAt: 100 } } };
    expect(shownStatus(withPending, 'r1', 'registered', 50)).toEqual({ status: 'no_show', pending: true });

    const confirmedOnly: OutboxState = { ...EMPTY_OUTBOX, confirmed: { r1: { status: 'attended', confirmedAt: 100 } } };
    expect(shownStatus(confirmedOnly, 'r1', 'registered', 50)).toEqual({ status: 'attended', pending: false });
    expect(shownStatus(confirmedOnly, 'r1', 'no_show', 101)).toEqual({ status: 'no_show', pending: false });

    expect(shownStatus(EMPTY_OUTBOX, 'r1', 'registered', 50)).toEqual({ status: 'registered', pending: false });
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
