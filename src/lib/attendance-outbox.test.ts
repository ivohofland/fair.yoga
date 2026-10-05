import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EMPTY_OUTBOX,
  clearAllOutboxes,
  dismissNote,
  dismissRefused,
  enqueueAttendance,
  flushOutbox,
  getOutboxSnapshot,
  pendingCount,
  purgeOtherOwners,
  resetOutboxForTests,
  subscribeOutbox,
  type AttendanceTarget,
  type FlushResult,
} from './attendance-outbox';

const OWNER = 'acc1';
const NOW = 1_780_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** An in-memory `Storage`, so the node environment has a `localStorage`. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  clear(): void {
    this.items.clear();
  }
  keys(): string[] {
    return [...this.items.keys()].sort();
  }
}

/** A storage that refuses every write, as Safari's private mode and a full quota do. */
class FullStorage extends MemoryStorage {
  override setItem(): void {
    throw new DOMException('quota', 'QuotaExceededError');
  }
}

function entry(registrationId: string, target: AttendanceTarget = 'attended', knownCompleted = false) {
  return {
    registrationId,
    classId: `class-${registrationId}`,
    classLabel: `Hatha ${registrationId}`,
    studentName: `Student ${registrationId}`,
    target,
    knownCompleted,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function applied(id: string, status: AttendanceTarget, classCompleted = false): Response {
  return json(200, { data: { id, status, classCompleted } });
}

/** A stored confirmation as the snapshot reports it; answers without a `Date` header take the device clock. */
function confirmedAs(target: AttendanceTarget, confirmedAt = NOW) {
  return { target, confirmedAt };
}

function unchanged(id: string, status: AttendanceTarget): Response {
  return json(200, { data: { id, status }, outcome: 'unchanged' });
}

function refusal(status: number, code: string | undefined, message: string): Response {
  return json(status, { error: { message, code } });
}

/** Answers each PUT with the server's echo of what it was sent. */
function echoServer(classCompleted = false) {
  return (url: string, init: RequestInit): Promise<Response> => {
    const id = url.split('/').pop() ?? '';
    const { status } = JSON.parse(String(init.body)) as { status: AttendanceTarget };
    return Promise.resolve(applied(id, status, classCompleted));
  };
}

function sentBodies(fetchMock: ReturnType<typeof vi.fn>): Array<{ url: string; status: string }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    status: (JSON.parse(String((init as RequestInit).body)) as { status: string }).status,
  }));
}

describe('attendance outbox', () => {
  let storage: MemoryStorage;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    storage = new MemoryStorage();
    fetchMock = vi.fn();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetOutboxForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('storage', () => {
    it('stores one key per registration under the owner, as versioned JSON', () => {
      expect(enqueueAttendance(OWNER, entry('r1'))).toBe('queued');
      expect(storage.keys()).toEqual(['fy-outbox:acc1:r1']);
      const stored = JSON.parse(storage.getItem('fy-outbox:acc1:r1') ?? 'null') as Record<string, unknown>;
      expect(stored).toMatchObject({
        v: 1,
        registrationId: 'r1',
        target: 'attended',
        attempts: 0,
        recordedAt: NOW,
        knownCompleted: false,
      });
      expect(typeof stored.nonce).toBe('string');
    });

    it('keeps only the latest mark per registration, with a fresh nonce', () => {
      enqueueAttendance(OWNER, entry('r1', 'attended'));
      const first = getOutboxSnapshot(OWNER).queued[0];
      vi.setSystemTime(NOW + 1000);
      enqueueAttendance(OWNER, entry('r1', 'no_show'));
      const { queued } = getOutboxSnapshot(OWNER);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ target: 'no_show', attempts: 0, recordedAt: NOW + 1000 });
      expect(queued[0]?.nonce).not.toBe(first?.nonce);
    });

    it('a new mark removes a refused entry for the same registration', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      fetchMock.mockResolvedValueOnce(refusal(404, 'NOT_FOUND', 'This booking no longer exists.'));
      await flushOutbox(OWNER);
      expect(getOutboxSnapshot(OWNER).refused).toHaveLength(1);
      enqueueAttendance(OWNER, entry('r1', 'no_show'));
      expect(getOutboxSnapshot(OWNER).refused).toEqual([]);
      expect(getOutboxSnapshot(OWNER).queued).toHaveLength(1);
    });

    it("answers 'unavailable' when storage refuses the write", () => {
      vi.stubGlobal('localStorage', new FullStorage());
      expect(enqueueAttendance(OWNER, entry('r1'))).toBe('unavailable');
    });

    it("drops an older queued mark for the row when a newer one answers 'unavailable'", () => {
      const store = new MemoryStorage();
      vi.stubGlobal('localStorage', store);
      expect(enqueueAttendance(OWNER, entry('r1', 'attended'))).toBe('queued');
      vi.spyOn(store, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
      expect(enqueueAttendance(OWNER, entry('r1', 'no_show'))).toBe('unavailable');
      expect(getOutboxSnapshot(OWNER).queued).toEqual([]);
    });

    it("drops the row's confirmation when a newer mark answers 'unavailable'", async () => {
      const store = new MemoryStorage();
      vi.stubGlobal('localStorage', store);
      enqueueAttendance(OWNER, entry('r1', 'attended'));
      enqueueAttendance(OWNER, entry('r2', 'attended'));
      fetchMock.mockImplementation(echoServer());
      await flushOutbox(OWNER);
      expect(Object.keys(getOutboxSnapshot(OWNER).confirmed)).toEqual(['r1', 'r2']);
      vi.spyOn(store, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
      expect(enqueueAttendance(OWNER, entry('r1', 'no_show'))).toBe('unavailable');
      expect(getOutboxSnapshot(OWNER).confirmed).toEqual({ r2: confirmedAs('attended') });
    });

    it("answers 'unavailable' when storage itself cannot be reached", () => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
      expect(enqueueAttendance(OWNER, entry('r1'))).toBe('unavailable');
      expect(getOutboxSnapshot(OWNER)).toBe(EMPTY_OUTBOX);
    });

    it('deletes a stored value that is not JSON or has the wrong shape', () => {
      storage.setItem('fy-outbox:acc1:r1', '{not json');
      storage.setItem('fy-outbox:acc1:r2', JSON.stringify({ v: 1, registrationId: 'r2', target: 'toggle' }));
      storage.setItem('fy-outbox-refused:acc1:r3', JSON.stringify({ v: 1 }));
      storage.setItem('fy-outbox-note:acc1:c1', JSON.stringify({ v: 1, classId: 7 }));
      enqueueAttendance(OWNER, entry('r4'));
      // Stored under the wrong registration's key.
      storage.setItem('fy-outbox:acc1:r5', storage.getItem('fy-outbox:acc1:r4') ?? '');
      const snapshot = getOutboxSnapshot(OWNER);
      expect(snapshot.queued.map((e) => e.registrationId)).toEqual(['r4']);
      expect(snapshot.refused).toEqual([]);
      expect(snapshot.notes).toEqual([]);
      expect(storage.keys()).toEqual(['fy-outbox:acc1:r4']);
    });

    it.each([
      ['without a kind', {}],
      ['with a kind it does not know', { kind: 'gave-up' }],
    ])('deletes a stored refusal %s', (_name, kind) => {
      const refused = { v: 1, ...entry('r1'), nonce: 'n', recordedAt: NOW, attempts: 0, message: 'Gone', refusedAt: NOW };
      storage.setItem('fy-outbox-refused:acc1:r1', JSON.stringify({ ...refused, ...kind }));
      storage.setItem('fy-outbox-refused:acc1:r2', JSON.stringify({ ...refused, ...entry('r2'), kind: 'verdict' }));
      expect(getOutboxSnapshot(OWNER).refused.map((e) => [e.registrationId, e.kind])).toEqual([['r2', 'verdict']]);
      expect(storage.keys()).toEqual(['fy-outbox-refused:acc1:r2']);
    });

    it('keeps, and skips, a value written in a newer format', () => {
      const newer = JSON.stringify({ v: 2, ...entry('r1'), nonce: 'n', recordedAt: NOW, attempts: 0 });
      storage.setItem('fy-outbox:acc1:r1', newer);
      storage.setItem('fy-outbox-confirmed:acc1:r2', JSON.stringify({ v: 2, target: 'attended', confirmedAt: NOW }));
      expect(getOutboxSnapshot(OWNER)).toBe(EMPTY_OUTBOX);
      expect(pendingCount(OWNER)).toBe(0);
      expect(storage.keys()).toEqual(['fy-outbox-confirmed:acc1:r2', 'fy-outbox:acc1:r1']);
      expect(storage.getItem('fy-outbox:acc1:r1')).toBe(newer);
    });

    it('deletes nothing when reading a value throws', () => {
      enqueueAttendance(OWNER, entry('r1'));
      vi.spyOn(storage, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      expect(getOutboxSnapshot(OWNER).queued).toEqual([]);
      vi.mocked(storage.getItem).mockRestore();
      expect(storage.keys()).toEqual(['fy-outbox:acc1:r1']);
      expect(getOutboxSnapshot(OWNER).queued.map((e) => e.registrationId)).toEqual(['r1']);
    });

    it('purging other owners leaves the current owner and unrelated keys', () => {
      enqueueAttendance(OWNER, entry('r1'));
      enqueueAttendance('acc2', entry('r2'));
      storage.setItem('fy-outbox-refused:acc2:r3', '{}');
      storage.setItem('fy-outbox-note:acc2:c1', '{}');
      storage.setItem('fy-outbox-note:acc1:c1', JSON.stringify({ v: 1, classId: 'c1', classLabel: 'Hatha' }));
      storage.setItem('fy-outbox-confirmed:acc2:r4', JSON.stringify({ v: 1, target: 'attended', confirmedAt: NOW }));
      storage.setItem('fy-outbox-confirmed:acc1:r5', JSON.stringify({ v: 1, target: 'no_show', confirmedAt: NOW }));
      storage.setItem('fy-theme', 'dark');
      purgeOtherOwners(OWNER);
      expect(storage.keys()).toEqual([
        'fy-outbox-confirmed:acc1:r5',
        'fy-outbox-note:acc1:c1',
        'fy-outbox:acc1:r1',
        'fy-theme',
      ]);
    });

    it('clearing removes every outbox key for every owner, and nothing else', () => {
      enqueueAttendance(OWNER, entry('r1'));
      enqueueAttendance('acc2', entry('r2'));
      storage.setItem('fy-outbox-refused:acc2:r3', '{}');
      storage.setItem('fy-outbox-note:acc1:c1', '{}');
      storage.setItem('fy-outbox-confirmed:acc1:r4', JSON.stringify({ v: 1, target: 'attended', confirmedAt: NOW }));
      storage.setItem('fy-outbox-confirmed:acc2:r5', '{}');
      storage.setItem('fy-theme', 'dark');
      storage.setItem('fy-offline-page:x', '1');
      clearAllOutboxes();
      expect(storage.keys()).toEqual(['fy-offline-page:x', 'fy-theme']);
    });

    it('counts queued and refused entries for the owner only', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      enqueueAttendance(OWNER, entry('r2'));
      enqueueAttendance('acc2', entry('r3'));
      fetchMock.mockResolvedValueOnce(refusal(404, 'NOT_FOUND', 'Gone'));
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await flushOutbox(OWNER);
      expect(pendingCount(OWNER)).toBe(2);
      expect(pendingCount('acc2')).toBe(1);
    });

    it('does not count a refused entry past its seven-day expiry', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      fetchMock.mockResolvedValueOnce(refusal(404, 'NOT_FOUND', 'Gone'));
      await flushOutbox(OWNER);
      vi.setSystemTime(NOW + 7 * DAY_MS);
      expect(pendingCount(OWNER)).toBe(1);
      vi.setSystemTime(NOW + 7 * DAY_MS + 1);
      expect(pendingCount(OWNER)).toBe(0);
    });
  });

  describe('snapshot', () => {
    it('is the same object until something changes', () => {
      expect(getOutboxSnapshot(OWNER)).toBe(EMPTY_OUTBOX);
      enqueueAttendance(OWNER, entry('r1'));
      const first = getOutboxSnapshot(OWNER);
      expect(getOutboxSnapshot(OWNER)).toBe(first);
      enqueueAttendance(OWNER, entry('r2'));
      expect(getOutboxSnapshot(OWNER)).not.toBe(first);
    });

    it('shows only the owner’s entries, oldest first', () => {
      enqueueAttendance(OWNER, entry('r2'));
      vi.setSystemTime(NOW + 1);
      enqueueAttendance('acc2', entry('r3'));
      enqueueAttendance(OWNER, entry('r1'));
      expect(getOutboxSnapshot(OWNER).queued.map((e) => e.registrationId)).toEqual(['r2', 'r1']);
    });

    it('drops refused entries older than seven days', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      fetchMock.mockResolvedValueOnce(refusal(404, 'NOT_FOUND', 'Gone'));
      await flushOutbox(OWNER);
      vi.setSystemTime(NOW + 7 * DAY_MS);
      expect(getOutboxSnapshot(OWNER).refused).toHaveLength(1);
      vi.setSystemTime(NOW + 7 * DAY_MS + 1);
      enqueueAttendance(OWNER, entry('r2'));
      expect(getOutboxSnapshot(OWNER).refused).toEqual([]);
      expect(storage.keys()).toEqual(['fy-outbox:acc1:r2']);
    });

    it('notifies listeners in this tab on a change, and on another tab’s outbox write only', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeOutbox(listener);
      enqueueAttendance(OWNER, entry('r1'));
      expect(listener).toHaveBeenCalledTimes(1);
      window.dispatchEvent(Object.assign(new Event('storage'), { key: 'fy-theme' }));
      expect(listener).toHaveBeenCalledTimes(1);
      window.dispatchEvent(Object.assign(new Event('storage'), { key: 'fy-outbox-refused:acc1:r9' }));
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
      enqueueAttendance(OWNER, entry('r2'));
      window.dispatchEvent(Object.assign(new Event('storage'), { key: 'fy-outbox:acc1:r9' }));
      expect(listener).toHaveBeenCalledTimes(2);
    });

    /** What another tab's change to `key` looks like here. */
    function storageEvent(key: string | null, oldValue: string | null, newValue: string | null): Event {
      return Object.assign(new Event('storage'), { key, oldValue, newValue });
    }

    it('shows a confirmation another tab wrote, and tells listeners', () => {
      enqueueAttendance(OWNER, entry('r1', 'no_show'));
      const old = storage.getItem('fy-outbox:acc1:r1');
      const listener = vi.fn();
      subscribeOutbox(listener);
      // The other tab's flush, in the order it writes the shared storage.
      const value = JSON.stringify({ v: 1, target: 'no_show', confirmedAt: NOW });
      storage.setItem('fy-outbox-confirmed:acc1:r1', value);
      window.dispatchEvent(storageEvent('fy-outbox-confirmed:acc1:r1', null, value));
      storage.removeItem('fy-outbox:acc1:r1');
      window.dispatchEvent(storageEvent('fy-outbox:acc1:r1', old, null));
      expect(listener).toHaveBeenCalledTimes(2);
      expect(getOutboxSnapshot(OWNER)).toMatchObject({ queued: [], confirmed: { r1: confirmedAs('no_show') } });
    });

    it('confirms nothing for a queued key another tab removed without confirming it', () => {
      enqueueAttendance(OWNER, entry('r1', 'no_show'));
      const old = storage.getItem('fy-outbox:acc1:r1');
      subscribeOutbox(() => {});
      storage.removeItem('fy-outbox:acc1:r1');
      window.dispatchEvent(storageEvent('fy-outbox:acc1:r1', old, null));
      window.dispatchEvent(storageEvent(null, null, null));
      expect(getOutboxSnapshot(OWNER).confirmed).toEqual({});
    });

    it('a flush writes the confirmation before it removes the queued key, so no read finds neither', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      const seen: string[] = [];
      const setItem = storage.setItem.bind(storage);
      const removeItem = storage.removeItem.bind(storage);
      vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
        seen.push(`set ${key}`);
        setItem(key, value);
      });
      vi.spyOn(storage, 'removeItem').mockImplementation((key) => {
        seen.push(`remove ${key}`);
        removeItem(key);
      });
      fetchMock.mockImplementation(echoServer());
      await flushOutbox(OWNER);
      expect(seen).toEqual(['set fy-outbox-confirmed:acc1:r1', 'remove fy-outbox:acc1:r1']);
    });

    it('dismissing removes a refused entry and a note', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      enqueueAttendance(OWNER, entry('r2'));
      fetchMock.mockResolvedValueOnce(refusal(403, undefined, 'Not your class'));
      fetchMock.mockResolvedValueOnce(applied('r2', 'attended', true));
      await flushOutbox(OWNER);
      expect(getOutboxSnapshot(OWNER).refused).toHaveLength(1);
      expect(getOutboxSnapshot(OWNER).notes).toEqual([{ classId: 'class-r2', classLabel: 'Hatha r2' }]);
      dismissRefused(OWNER, 'r1');
      dismissNote(OWNER, 'class-r2');
      expect(getOutboxSnapshot(OWNER)).toMatchObject({ refused: [], notes: [] });
    });
  });

  describe('flush', () => {
    it('sends the absolute target, PUT with no redirects and a timeout', async () => {
      enqueueAttendance(OWNER, entry('r1', 'no_show'));
      fetchMock.mockResolvedValueOnce(applied('r1', 'no_show'));
      await flushOutbox(OWNER);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/registrations/r1');
      expect(init).toMatchObject({ method: 'PUT', redirect: 'error' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init.body))).toEqual({ status: 'no_show' });
    });

    it('times the request out after 10 s', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      enqueueAttendance(OWNER, entry('r1'));
      fetchMock.mockResolvedValueOnce(applied('r1', 'attended'));
      await flushOutbox(OWNER);
      expect(timeout).toHaveBeenCalledWith(10_000);
    });

    it('without AbortSignal.timeout, still sends the request and aborts it after 10 s', async () => {
      const original = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
      Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
      try {
        enqueueAttendance(OWNER, entry('r1'));
        let signal: AbortSignal | undefined;
        fetchMock.mockImplementationOnce(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              signal = init.signal ?? undefined;
              signal?.addEventListener('abort', () => reject(signal?.reason));
            }),
        );
        const flushing = flushOutbox(OWNER);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal?.aborted).toBe(true);
        await expect(flushing).resolves.toEqual({ applied: 0, replayed: 0 });
        expect(getOutboxSnapshot(OWNER).queued.map((e) => e.registrationId)).toEqual(['r1']);
      } finally {
        if (original !== undefined) Object.defineProperty(AbortSignal, 'timeout', original);
      }
    });

    it('two taps on one row replay as the latest target, and a second flush answers unchanged', async () => {
      enqueueAttendance(OWNER, entry('r1', 'attended'));
      enqueueAttendance(OWNER, entry('r1', 'no_show'));
      fetchMock.mockImplementation(echoServer());
      await flushOutbox(OWNER);
      expect(sentBodies(fetchMock)).toEqual([{ url: '/api/registrations/r1', status: 'no_show' }]);
      // The same mark queued again (a replay) still names the target, never a flip.
      enqueueAttendance(OWNER, entry('r1', 'no_show'));
      fetchMock.mockResolvedValueOnce(unchanged('r1', 'no_show'));
      const second = await flushOutbox(OWNER);
      expect(sentBodies(fetchMock).map((b) => b.status)).toEqual(['no_show', 'no_show']);
      expect(second.applied).toBe(0);
      expect(getOutboxSnapshot(OWNER).confirmed).toEqual({ r1: confirmedAs('no_show') });
    });

    it('the same mark queued twice is sent as that mark, not flipped', async () => {
      enqueueAttendance(OWNER, entry('r1', 'attended'));
      enqueueAttendance(OWNER, entry('r1', 'attended'));
      fetchMock.mockImplementation(echoServer());
      await flushOutbox(OWNER);
      expect(sentBodies(fetchMock).map((b) => b.status)).toEqual(['attended']);
    });

    it('sends entries oldest first', async () => {
      enqueueAttendance(OWNER, entry('r2'));
      vi.setSystemTime(NOW + 1);
      enqueueAttendance(OWNER, entry('r1'));
      fetchMock.mockImplementation(echoServer());
      await flushOutbox(OWNER);
      expect(sentBodies(fetchMock).map((b) => b.url)).toEqual(['/api/registrations/r2', '/api/registrations/r1']);
    });

    it('uses the cross-tab lock when the browser has one', async () => {
      const request = vi.fn((_name: string, _options: LockOptions, callback: () => Promise<FlushResult>) => callback());
      vi.stubGlobal('navigator', { onLine: true, locks: { request } });
      enqueueAttendance(OWNER, entry('r1'));
      fetchMock.mockImplementation(echoServer());
      await flushOutbox(OWNER);
      expect(request).toHaveBeenCalledWith(
        'fy-outbox',
        { signal: expect.any(AbortSignal) as unknown },
        expect.any(Function),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a lock that is never granted ends the flush after a minute, leaving entries queued', async () => {
      // A holder suspended mid-pass: the request settles only when its signal aborts.
      const request = vi.fn(
        (_name: string, options: LockOptions) =>
          new Promise<FlushResult>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason));
          }),
      );
      vi.stubGlobal('navigator', { onLine: true, locks: { request } });
      enqueueAttendance(OWNER, entry('r1'));
      fetchMock.mockImplementation(echoServer());
      let settled = false;
      const flushing = flushOutbox(OWNER).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(flushing).resolves.toEqual({ applied: 0, replayed: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getOutboxSnapshot(OWNER).queued.map((e) => e.registrationId)).toEqual(['r1']);
      // The tab is not wedged: the next flush runs.
      request.mockImplementation((_name: string, _options: LockOptions, callback?: () => Promise<FlushResult>) =>
        callback === undefined ? Promise.resolve({ applied: 0, replayed: 0 }) : callback(),
      );
      await expect(flushOutbox(OWNER)).resolves.toEqual({ applied: 1, replayed: 0 });
      expect(getOutboxSnapshot(OWNER).queued).toEqual([]);
    });

    describe('one row per response (D5)', () => {
      it('200 with the matching body: removes the entry and records the confirmed status', async () => {
        enqueueAttendance(OWNER, entry('r1', 'attended'));
        fetchMock.mockResolvedValueOnce(applied('r1', 'attended'));
        const result = await flushOutbox(OWNER);
        expect(result).toEqual({ applied: 1, replayed: 0 });
        expect(getOutboxSnapshot(OWNER)).toMatchObject({ queued: [], confirmed: { r1: confirmedAs('attended') }, notes: [] });
        expect(storage.keys()).toEqual(['fy-outbox-confirmed:acc1:r1']);
        expect(JSON.parse(storage.getItem('fy-outbox-confirmed:acc1:r1') ?? 'null')).toEqual({
          v: 1,
          target: 'attended',
          confirmedAt: NOW,
        });
      });

      it("200: the confirmation carries the server's Date header, to the second", async () => {
        enqueueAttendance(OWNER, entry('r1'));
        const response = applied('r1', 'attended');
        response.headers.set('Date', 'Sun, 04 Oct 2026 08:15:42 GMT');
        fetchMock.mockResolvedValueOnce(response);
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).confirmed).toEqual({
          r1: confirmedAs('attended', Date.parse('2026-10-04T08:15:42Z')),
        });
      });

      it('200: an unreadable Date header falls back to the device clock', async () => {
        enqueueAttendance(OWNER, entry('r1'));
        const response = applied('r1', 'attended');
        response.headers.set('Date', 'not a date');
        fetchMock.mockResolvedValueOnce(response);
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).confirmed).toEqual({ r1: confirmedAs('attended', NOW) });
      });

      it('200 after the outbox was cleared meanwhile: keeps no confirmation', async () => {
        enqueueAttendance(OWNER, entry('r1'));
        let release: (res: Response) => void = () => {};
        fetchMock.mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              release = resolve;
            }),
        );
        const flushing = flushOutbox(OWNER);
        await vi.advanceTimersByTimeAsync(0);
        clearAllOutboxes();
        release(applied('r1', 'attended'));
        await flushing;
        expect(storage.keys()).toEqual([]);
      });

      it('200 on a completed class after the outbox was cleared meanwhile: writes no note', async () => {
        enqueueAttendance(OWNER, entry('r1'));
        let release: (res: Response) => void = () => {};
        fetchMock.mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              release = resolve;
            }),
        );
        const flushing = flushOutbox(OWNER);
        await vi.advanceTimersByTimeAsync(0);
        clearAllOutboxes();
        release(applied('r1', 'attended', true));
        await flushing;
        expect(storage.keys()).toEqual([]);
      });

      it('200 into a full store: the confirmation is written once the queued key frees room', async () => {
        enqueueAttendance(OWNER, entry('r1'));
        const setItem = storage.setItem.bind(storage);
        vi.spyOn(storage, 'setItem')
          .mockImplementationOnce(() => {
            throw new DOMException('quota', 'QuotaExceededError');
          })
          .mockImplementation(setItem);
        fetchMock.mockResolvedValueOnce(applied('r1', 'attended'));
        await flushOutbox(OWNER);
        expect(storage.keys()).toEqual(['fy-outbox-confirmed:acc1:r1']);
      });

      it('a confirmation is kept for a day, then dropped from storage on read', async () => {
        enqueueAttendance(OWNER, entry('r1'));
        fetchMock.mockResolvedValueOnce(applied('r1', 'attended'));
        await flushOutbox(OWNER);
        vi.setSystemTime(NOW + DAY_MS);
        expect(getOutboxSnapshot(OWNER).confirmed).toEqual({ r1: confirmedAs('attended') });
        vi.setSystemTime(NOW + DAY_MS + 1);
        expect(getOutboxSnapshot(OWNER)).toBe(EMPTY_OUTBOX);
        expect(storage.keys()).toEqual([]);
      });

      it('200 on a mark this document queued: applied, not a replay', async () => {
        enqueueAttendance(OWNER, entry('r1', 'attended'));
        fetchMock.mockResolvedValueOnce(applied('r1', 'attended'));
        await expect(flushOutbox(OWNER)).resolves.toEqual({ applied: 1, replayed: 0 });
      });

      it('200 on a mark an earlier document queued: applied and replayed', async () => {
        storage.setItem(
          'fy-outbox:acc1:r1',
          JSON.stringify({
            v: 1,
            ...entry('r1', 'attended'),
            nonce: 'earlier-document',
            recordedAt: NOW - 1,
            attempts: 0,
          }),
        );
        fetchMock.mockResolvedValueOnce(applied('r1', 'attended'));
        await expect(flushOutbox(OWNER)).resolves.toEqual({ applied: 1, replayed: 1 });
        expect(getOutboxSnapshot(OWNER).queued).toEqual([]);
      });

      it('200 with the matching body on a class that had completed: writes one note for its class', async () => {
        enqueueAttendance(OWNER, entry('r1'));
        enqueueAttendance(OWNER, { ...entry('r2'), classId: 'class-r1', classLabel: 'Hatha r1' });
        fetchMock.mockImplementation(echoServer(true));
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).notes).toEqual([{ classId: 'class-r1', classLabel: 'Hatha r1' }]);
      });

      it('200 on a completed class the teacher already saw completed: no note', async () => {
        enqueueAttendance(OWNER, entry('r1', 'attended', true));
        fetchMock.mockResolvedValueOnce(applied('r1', 'attended', true));
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).notes).toEqual([]);
      });

      it('200 unchanged: removes the entry, confirms it, writes no note and counts nothing applied', async () => {
        enqueueAttendance(OWNER, entry('r1'));
        fetchMock.mockResolvedValueOnce(
          json(200, { data: { id: 'r1', status: 'attended', classCompleted: true }, outcome: 'unchanged' }),
        );
        const result = await flushOutbox(OWNER);
        expect(result).toEqual({ applied: 0, replayed: 0 });
        expect(getOutboxSnapshot(OWNER)).toMatchObject({ queued: [], notes: [], confirmed: { r1: confirmedAs('attended') } });
        expect(storage.keys()).toEqual(['fy-outbox-confirmed:acc1:r1']);
      });

      it.each([
        ['an HTML page (a captive portal)', () => new Response('<html>Hotel wifi</html>', { status: 200 })],
        ['JSON naming another registration', () => applied('r9', 'attended')],
        ['JSON naming another status', () => applied('r1', 'no_show')],
        ['JSON without data', () => json(200, { ok: true })],
        ['a 204', () => new Response(null, { status: 204 })],
      ])('200 without the matching body — %s: keeps everything and stops', async (_name, answer) => {
        enqueueAttendance(OWNER, entry('r1'));
        vi.setSystemTime(NOW + 1);
        enqueueAttendance(OWNER, entry('r2'));
        fetchMock.mockResolvedValueOnce(answer());
        const result = await flushOutbox(OWNER);
        expect(result).toEqual({ applied: 0, replayed: 0 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getOutboxSnapshot(OWNER).queued.map((e) => [e.registrationId, e.attempts])).toEqual([
          ['r1', 0],
          ['r2', 0],
        ]);
        expect(getOutboxSnapshot(OWNER).confirmed).toEqual({});
      });

      it.each([
        ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
        ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
        ['a redirect', () => Promise.reject(new TypeError('unexpected redirect'))],
        ['429', () => Promise.resolve(refusal(429, undefined, 'Slow down'))],
        ['502', () => Promise.resolve(new Response('Bad gateway', { status: 502 }))],
        ['503', () => Promise.resolve(refusal(503, undefined, 'Down'))],
        ['504', () => Promise.resolve(new Response('', { status: 504 }))],
      ])('%s: keeps everything and stops', async (_name, answer) => {
        enqueueAttendance(OWNER, entry('r1'));
        vi.setSystemTime(NOW + 1);
        enqueueAttendance(OWNER, entry('r2'));
        fetchMock.mockImplementationOnce(answer);
        await expect(flushOutbox(OWNER)).resolves.toEqual({ applied: 0, replayed: 0 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getOutboxSnapshot(OWNER)).toMatchObject({ refused: [], needsSignIn: false });
        expect(getOutboxSnapshot(OWNER).queued.map((e) => [e.registrationId, e.attempts])).toEqual([
          ['r1', 0],
          ['r2', 0],
        ]);
      });

      it.each([
        ['409 CONCURRENT_MODIFICATION', () => refusal(409, 'CONCURRENT_MODIFICATION', 'Changed meanwhile')],
        ['500', () => new Response('<html>Internal error</html>', { status: 500 })],
        ['a 403 that is not JSON', () => new Response('<html>Forbidden</html>', { status: 403 })],
        ['a 409 that is not JSON', () => new Response('<html>Conflict</html>', { status: 409 })],
      ])('%s: counts an attempt, refuses on the third, and carries on to the next entry', async (_name, answer) => {
        enqueueAttendance(OWNER, entry('r1'));
        vi.setSystemTime(NOW + 1);
        enqueueAttendance(OWNER, entry('r2'));
        fetchMock.mockImplementation((url: string, init: RequestInit) =>
          url.endsWith('/r1') ? Promise.resolve(answer()) : echoServer()(url, init),
        );
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).queued.map((e) => [e.registrationId, e.attempts])).toEqual([['r1', 1]]);
        expect(getOutboxSnapshot(OWNER).confirmed).toEqual({ r2: confirmedAs('attended', NOW + 1) });
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).queued.map((e) => e.attempts)).toEqual([2]);
        await flushOutbox(OWNER);
        const snapshot = getOutboxSnapshot(OWNER);
        expect(snapshot.queued).toEqual([]);
        expect(snapshot.refused.map((e) => [e.registrationId, e.attempts, e.refusedAt])).toEqual([['r1', 3, NOW + 1]]);
        expect(snapshot.refused[0]?.message).toBe("This change couldn't be saved after several tries.");
        // The server never refused it, so Finish still counts it as unsynced.
        expect(snapshot.refused[0]?.kind).toBe('retries-exhausted');
      });

      it.each([
        ['409 CONCURRENT_MODIFICATION', () => refusal(409, 'CONCURRENT_MODIFICATION', 'Refresh and try again.')],
        ['500', () => refusal(500, undefined, 'Refresh and try again.')],
      ])('%s on the third attempt is refused with the outbox’s own words, not the server’s', async (_name, answer) => {
        enqueueAttendance(OWNER, entry('r1'));
        fetchMock.mockImplementation(() => Promise.resolve(answer()));
        await flushOutbox(OWNER);
        await flushOutbox(OWNER);
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).refused.map((e) => e.message)).toEqual([
          "This change couldn't be saved after several tries.",
        ]);
      });

      it.each([
        ['409 with another code', () => refusal(409, 'CLASS_NOT_STARTED', 'The class has not started.'), 'The class has not started.'],
        ['404', () => refusal(404, 'NOT_FOUND', 'This booking no longer exists.'), 'This booking no longer exists.'],
        ['403', () => refusal(403, undefined, 'Not your class'), 'Not your class'],
        ['400', () => refusal(400, undefined, 'Invalid status'), 'Invalid status'],
      ])('%s: refused with the server’s message, and the flush carries on', async (_name, answer, message) => {
        enqueueAttendance(OWNER, entry('r1'));
        vi.setSystemTime(NOW + 1);
        enqueueAttendance(OWNER, entry('r2'));
        fetchMock.mockImplementation((url: string, init: RequestInit) =>
          url.endsWith('/r1') ? Promise.resolve(answer()) : echoServer()(url, init),
        );
        await flushOutbox(OWNER);
        const snapshot = getOutboxSnapshot(OWNER);
        expect(snapshot.queued).toEqual([]);
        expect(snapshot.refused).toEqual([
          expect.objectContaining({
            registrationId: 'r1',
            studentName: 'Student r1',
            classLabel: 'Hatha r1',
            message,
            refusedAt: NOW + 1,
            kind: 'verdict',
          }),
        ]);
        expect(snapshot.confirmed).toEqual({ r2: confirmedAs('attended', NOW + 1) });
        expect(storage.keys()).toEqual(['fy-outbox-confirmed:acc1:r2', 'fy-outbox-refused:acc1:r1']);
      });

      describe('a flush that stops while the device says online leaves a trace', () => {
        it.each([
          ['a thrown fetch', () => Promise.reject(new TypeError('Failed to fetch')), { reason: 'thrown' }],
          [
            'a 200 without the matching body',
            () => Promise.resolve(new Response('<html>Hotel wifi</html>', { status: 200 })),
            { reason: 'non-matching-body', status: 200 },
          ],
          ['a 503', () => Promise.resolve(refusal(503, undefined, 'Down')), { reason: 'status', status: 503 }],
          ['a 429', () => Promise.resolve(refusal(429, undefined, 'Slow down')), { reason: 'status', status: 429 }],
          [
            'a 401',
            () => Promise.resolve(refusal(401, undefined, 'Session expired')),
            { reason: 'status', status: 401 },
          ],
        ])('%s', async (_name, answer, context) => {
          enqueueAttendance(OWNER, entry('r1'));
          fetchMock.mockImplementationOnce(answer);
          await flushOutbox(OWNER);
          expect(outboxErrors()).toEqual([
            [
              '[attendance-outbox] request failed',
              expect.objectContaining({ stage: 'send', registrationId: 'r1', ...context }),
            ],
          ]);
        });

        it('but not while the device says offline', async () => {
          vi.stubGlobal('navigator', { onLine: false });
          enqueueAttendance(OWNER, entry('r1'));
          fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
          await flushOutbox(OWNER);
          expect(outboxErrors()).toEqual([]);
        });
      });

      it('401: sets needsSignIn, keeps everything and stops; a later answered flush clears it', async () => {
        enqueueAttendance(OWNER, entry('r1'));
        vi.setSystemTime(NOW + 1);
        enqueueAttendance(OWNER, entry('r2'));
        fetchMock.mockResolvedValueOnce(refusal(401, undefined, 'Session expired'));
        await flushOutbox(OWNER);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getOutboxSnapshot(OWNER)).toMatchObject({ needsSignIn: true, refused: [] });
        expect(getOutboxSnapshot(OWNER).queued.map((e) => [e.registrationId, e.attempts])).toEqual([
          ['r1', 0],
          ['r2', 0],
        ]);
        fetchMock.mockImplementation(echoServer());
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER)).toMatchObject({ needsSignIn: false, queued: [] });
      });

      it('a flush over a queue another tab emptied after a 401 clears needsSignIn', async () => {
        enqueueAttendance(OWNER, entry('r1'));
        fetchMock.mockResolvedValueOnce(refusal(401, undefined, 'Session expired'));
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).needsSignIn).toBe(true);
        // Signed in elsewhere, that tab's flush sent the mark and removed it.
        storage.removeItem('fy-outbox:acc1:r1');
        await flushOutbox(OWNER);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getOutboxSnapshot(OWNER).needsSignIn).toBe(false);
      });

      it("the app's own refusal after a 401 clears needsSignIn, even when the flush then stops", async () => {
        enqueueAttendance(OWNER, entry('r1'));
        vi.setSystemTime(NOW + 1);
        enqueueAttendance(OWNER, entry('r2'));
        fetchMock.mockResolvedValueOnce(refusal(401, undefined, 'Session expired'));
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).needsSignIn).toBe(true);
        // Signed in elsewhere: the app answers r1, then the network drops before r2.
        fetchMock.mockResolvedValueOnce(refusal(404, 'NOT_FOUND', 'This booking no longer exists.'));
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER)).toMatchObject({
          needsSignIn: false,
          queued: [expect.objectContaining({ registrationId: 'r2' })],
        });
      });

      it('a portal 200 after a 401 does not clear needsSignIn', async () => {
        enqueueAttendance(OWNER, entry('r1'));
        fetchMock.mockResolvedValueOnce(refusal(401, undefined, 'Session expired'));
        await flushOutbox(OWNER);
        fetchMock.mockResolvedValueOnce(new Response('<html>Hotel wifi</html>', { status: 200 }));
        await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).needsSignIn).toBe(true);
      });
    });

    it('a tap while its PUT is in flight keeps the new entry and sends it in the same flush', async () => {
      enqueueAttendance(OWNER, entry('r1', 'attended'));
      let release: (res: Response) => void = () => {};
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
      fetchMock.mockImplementation(echoServer());
      const flushing = flushOutbox(OWNER);
      await vi.advanceTimersByTimeAsync(0);
      enqueueAttendance(OWNER, entry('r1', 'no_show'));
      release(applied('r1', 'attended'));
      await flushing;
      expect(sentBodies(fetchMock).map((b) => b.status)).toEqual(['attended', 'no_show']);
      expect(getOutboxSnapshot(OWNER)).toMatchObject({ queued: [], confirmed: { r1: confirmedAs('no_show') } });
    });

    it('a tap while a failing PUT is in flight keeps the new entry untouched', async () => {
      enqueueAttendance(OWNER, entry('r1', 'attended'));
      let release: (res: Response) => void = () => {};
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
      fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
      const flushing = flushOutbox(OWNER);
      await vi.advanceTimersByTimeAsync(0);
      enqueueAttendance(OWNER, entry('r1', 'no_show'));
      release(refusal(404, 'NOT_FOUND', 'Gone'));
      await flushing;
      const snapshot = getOutboxSnapshot(OWNER);
      expect(snapshot.refused).toEqual([]);
      expect(snapshot.queued.map((e) => [e.target, e.attempts])).toEqual([['no_show', 0]]);
    });

    describe.each([
      ['409 CONCURRENT_MODIFICATION', () => refusal(409, 'CONCURRENT_MODIFICATION', 'Changed meanwhile')],
      ['500', () => refusal(500, undefined, 'Internal error')],
    ])('a tap while a %s is in flight', (_name, failure) => {
      it.each([
        ['on the first attempt', 0],
        ['on the third attempt, which would refuse it', 2],
      ])('%s: the new entry survives untouched and is sent next', async (_when, priorFailures) => {
        enqueueAttendance(OWNER, entry('r1', 'attended'));
        fetchMock.mockImplementation(() => Promise.resolve(failure()));
        for (let i = 0; i < priorFailures; i++) await flushOutbox(OWNER);
        expect(getOutboxSnapshot(OWNER).queued.map((e) => e.attempts)).toEqual([priorFailures]);
        fetchMock.mockReset();
        let release: (res: Response) => void = () => {};
        fetchMock.mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              release = resolve;
            }),
        );
        // The re-send of the new tap finds the network gone, so the entry is left as the tap wrote it.
        fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
        const flushing = flushOutbox(OWNER);
        await vi.advanceTimersByTimeAsync(0);
        enqueueAttendance(OWNER, entry('r1', 'no_show'));
        release(failure());
        await flushing;
        const snapshot = getOutboxSnapshot(OWNER);
        expect(snapshot.refused).toEqual([]);
        expect(snapshot.queued.map((e) => [e.target, e.attempts])).toEqual([['no_show', 0]]);
        expect(sentBodies(fetchMock).map((b) => b.status)).toEqual(['attended', 'no_show']);
      });
    });

    it('a flush called during a flush shares it: one PUT per entry', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      enqueueAttendance(OWNER, entry('r2'));
      fetchMock.mockImplementation(echoServer());
      const first = flushOutbox(OWNER);
      const second = flushOutbox(OWNER);
      expect(second).toBe(first);
      await Promise.all([first, second]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a flush called during a flush runs one more pass for an entry queued meanwhile', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      let release: (res: Response) => void = () => {};
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
      fetchMock.mockImplementation(echoServer());
      const first = flushOutbox(OWNER);
      await vi.advanceTimersByTimeAsync(0);
      enqueueAttendance(OWNER, entry('r2'));
      void flushOutbox(OWNER);
      release(applied('r1', 'attended'));
      await expect(first).resolves.toEqual({ applied: 2, replayed: 0 });
      expect(sentBodies(fetchMock).map((b) => b.url)).toEqual(['/api/registrations/r1', '/api/registrations/r2']);
    });

    function outboxErrors(): unknown[][] {
      return vi.mocked(console.error).mock.calls.filter(([first]) => String(first).includes('[attendance-outbox]'));
    }

    it('a write that fails mid-flush leaves the entry as it was and the flush carries on', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      vi.setSystemTime(NOW + 1);
      enqueueAttendance(OWNER, entry('r2'));
      fetchMock.mockImplementation((url: string, init: RequestInit) => {
        vi.spyOn(storage, 'setItem').mockImplementation(() => {
          throw new DOMException('quota', 'QuotaExceededError');
        });
        return url.endsWith('/r1') ? Promise.resolve(refusal(500, undefined, 'boom')) : echoServer()(url, init);
      });
      await expect(flushOutbox(OWNER)).resolves.toEqual({ applied: 1, replayed: 0 });
      expect(sentBodies(fetchMock).map((b) => b.url)).toEqual(['/api/registrations/r1', '/api/registrations/r2']);
      expect(getOutboxSnapshot(OWNER).queued.map((e) => [e.registrationId, e.attempts])).toEqual([['r1', 0]]);
      // A full store leaves a trace, or the attempt that never counts repeats unseen.
      expect(outboxErrors()).toEqual([
        [
          '[attendance-outbox] request failed',
          expect.objectContaining({ stage: 'store', registrationId: 'r1', write: 'attempts', err: expect.any(DOMException) }),
        ],
      ]);
    });

    it('a refusal the store cannot hold leaves the entry queued, and says so', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      const setItem = storage.setItem.bind(storage);
      vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
        if (key.startsWith('fy-outbox-refused:')) throw new DOMException('quota', 'QuotaExceededError');
        setItem(key, value);
      });
      fetchMock.mockResolvedValueOnce(refusal(404, 'NOT_FOUND', 'This booking no longer exists.'));
      await flushOutbox(OWNER);
      expect(getOutboxSnapshot(OWNER)).toMatchObject({
        queued: [expect.objectContaining({ registrationId: 'r1', attempts: 0 })],
        refused: [],
      });
      expect(outboxErrors()).toEqual([
        [
          '[attendance-outbox] request failed',
          expect.objectContaining({ stage: 'store', registrationId: 'r1', write: 'refused', err: expect.any(DOMException) }),
        ],
      ]);
    });

    it('a removal that fails on an applied answer leaves the entry queued for a later flush', async () => {
      enqueueAttendance(OWNER, entry('r1'));
      const removeSpy = vi.spyOn(storage, 'removeItem');
      fetchMock.mockImplementationOnce((url: string, init: RequestInit) => {
        removeSpy.mockImplementation(() => {
          throw new DOMException('denied', 'SecurityError');
        });
        return echoServer()(url, init);
      });
      await expect(flushOutbox(OWNER)).resolves.toEqual({ applied: 1, replayed: 0 });
      expect(outboxErrors()).toEqual([]);
      expect(getOutboxSnapshot(OWNER).queued.map((e) => e.registrationId)).toEqual(['r1']);
      removeSpy.mockRestore();
      fetchMock.mockResolvedValueOnce(unchanged('r1', 'attended'));
      await expect(flushOutbox(OWNER)).resolves.toEqual({ applied: 0, replayed: 0 });
      expect(getOutboxSnapshot(OWNER).queued).toEqual([]);
      expect(storage.keys()).toEqual(['fy-outbox-confirmed:acc1:r1']);
    });
  });
});
