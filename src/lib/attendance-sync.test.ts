// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  enqueueAttendance,
  getOutbox,
  resetOutboxForTests,
  type PendingEntry,
  type QueuedStatus,
} from '@/lib/attendance-outbox';
import {
  flushAttendance,
  resetSyncForTests,
  sendAttendance,
  startAttendanceSync,
  useSyncState,
  type ReplayOutcome,
} from '@/lib/attendance-sync';

const conn = vi.hoisted(() => ({
  offline: false,
  /** Like the real store's first subscribe: the answer changes without a notification. */
  offlineOnSubscribe: false,
  listeners: new Set<() => void>(),
}));

vi.mock('@/lib/offline-status', () => ({
  getConnectionStatus: () => ({ offline: conn.offline, serverNow: null }),
  subscribeConnectionStatus: (listener: () => void) => {
    conn.listeners.add(listener);
    if (conn.offlineOnSubscribe) conn.offline = true;
    return () => {
      conn.listeners.delete(listener);
    };
  },
}));

const SERVER_DATE = 5_000_000;

function ok(data: unknown, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ data, ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json', date: new Date(SERVER_DATE).toUTCString() },
  });
}

function refusal(status: number, code: string | undefined, message: string): Response {
  return new Response(JSON.stringify({ error: { message, code } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bare(status: number): Response {
  return new Response(null, { status });
}

function html(status: number): Response {
  return new Response('<html><body>Blocked</body></html>', { status, headers: { 'content-type': 'text/html' } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setOffline(offline: boolean): void {
  conn.offline = offline;
  conn.listeners.forEach((listener) => listener());
}

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
}

let visibility: DocumentVisibilityState = 'visible';
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function enqueue(status: QueuedStatus, registrationId = 'r1', ownerId = 'acct-1'): Promise<PendingEntry> {
  return enqueueAttendance({ ownerId, registrationId, classId: 'c1', studentName: 'Ada', status });
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** Lets a flush started by a trigger run to its end; every step of it is a microtask here. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('attendance sync', () => {
  beforeEach(() => {
    localStorage.clear();
    resetOutboxForTests();
    resetSyncForTests();
    conn.offline = false;
    conn.offlineOnSubscribe = false;
    conn.listeners.clear();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetSyncForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('classifies every answer', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const entry: PendingEntry = {
      id: 'e1',
      ownerId: 'acct-1',
      registrationId: 'r1',
      classId: 'c1',
      studentName: 'Ada',
      status: 'attended',
      recordedAt: 1,
    };
    const cases: ReadonlyArray<[string, () => Promise<Response>, ReplayOutcome]> = [
      ['applied', async () => ok({ id: 'r1', status: 'attended' }), { kind: 'confirmed', at: SERVER_DATE }],
      [
        'unchanged',
        async () => ok({ id: 'r1', status: 'attended' }, { outcome: 'unchanged' }),
        { kind: 'confirmed', at: SERVER_DATE },
      ],
      ['another registration', async () => ok({ id: 'other', status: 'attended' }), { kind: 'retry' }],
      ['another status', async () => ok({ id: 'r1', status: 'no_show' }), { kind: 'retry' }],
      ['no status', async () => ok({ id: 'r1' }), { kind: 'retry' }],
      ['no id', async () => ok({ status: 'attended' }), { kind: 'retry' }],
      ['not json', async () => new Response('not json', { status: 200 }), { kind: 'retry' }],
      ['401', async () => bare(401), { kind: 'signed_out' }],
      ['403', async () => refusal(403, undefined, 'Not your class'), { kind: 'dropped' }],
      ['403 without a body', async () => bare(403), { kind: 'retry' }],
      ['403 from an intermediary', async () => html(403), { kind: 'retry' }],
      ['407 from a proxy', async () => html(407), { kind: 'retry' }],
      ['404 from an intermediary', async () => html(404), { kind: 'retry' }],
      ['400 with other JSON', async () => json(400, { message: 'Bad request' }), { kind: 'retry' }],
      [
        '409 concurrent',
        async () => refusal(409, 'CONCURRENT_MODIFICATION', 'Someone else changed this.'),
        { kind: 'retry' },
      ],
      [
        '409 cancelled',
        async () => refusal(409, 'REGISTRATION_CANCELLED', 'This booking was cancelled.'),
        { kind: 'refused', message: 'This booking was cancelled.' },
      ],
      [
        '404',
        async () => refusal(404, 'NOT_FOUND', 'This booking no longer exists.'),
        { kind: 'refused', message: 'This booking no longer exists.' },
      ],
      [
        '400',
        async () => refusal(400, undefined, 'Invalid status.'),
        { kind: 'refused', message: 'Invalid status.' },
      ],
      ['408', async () => bare(408), { kind: 'retry' }],
      ['429', async () => bare(429), { kind: 'retry' }],
      ['503', async () => bare(503), { kind: 'retry' }],
      [
        'network',
        async () => {
          throw new TypeError('Failed to fetch');
        },
        { kind: 'retry' },
      ],
    ];
    for (const [name, answer, expected] of cases) {
      fetchMock.mockImplementationOnce(answer);
      expect([name, await sendAttendance(entry)]).toEqual([name, expected]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(cases.length);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/registrations/r1');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe('{"status":"attended"}');
    expect(errors).toHaveBeenCalledWith('[attendance-sync] request failed', {
      registrationId: 'r1',
      status: 'attended',
      err: expect.any(TypeError),
    });
  });

  it('logs an answer that is not the app\'s own, and an app 403 drop, naming no student', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entry: PendingEntry = {
      id: 'e1',
      ownerId: 'acct-1',
      registrationId: 'r1',
      classId: 'c1',
      studentName: 'Ada',
      status: 'attended',
      recordedAt: 1,
    };
    fetchMock.mockResolvedValueOnce(html(403));
    await sendAttendance(entry);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith('[attendance-sync] request failed', {
      registrationId: 'r1',
      status: 'attended',
      httpStatus: 403,
      contentType: 'text/html',
      err: expect.any(Error),
    });
    expect(warn).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(refusal(403, undefined, 'Not your class'));
    await sendAttendance(entry);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[attendance-sync] write dropped: the server refused it to this account', {
      registrationId: 'r1',
      status: 'attended',
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([errors.mock.calls, warn.mock.calls])).not.toContain('Ada');
  });

  it('logs a 2xx it cannot confirm, once per entry per pass, naming no student', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue('attended', 'r1');
    await enqueue('attended', 'r2');
    fetchMock.mockImplementation(async (input) =>
      urlOf(input) === '/api/registrations/r1'
        ? new Response('<html>Welcome to the guest network</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        : ok({ id: 'r2', status: 'no_show' }),
    );
    await flushAttendance('acct-1');
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith('[attendance-sync] request failed', {
      registrationId: 'r1',
      status: 'attended',
      httpStatus: 200,
      contentType: 'text/html',
      err: expect.any(Error),
    });
    expect(errors).toHaveBeenCalledWith('[attendance-sync] request failed', {
      registrationId: 'r2',
      status: 'attended',
      httpStatus: 200,
      contentType: 'application/json',
      err: expect.any(Error),
    });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('Ada');
    expect(Object.keys(getOutbox().pending).sort()).toEqual(['r1', 'r2']);
  });

  it('an intermediary\'s 403 keeps the entry pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue('attended');
    fetchMock.mockResolvedValueOnce(html(403));
    await flushAttendance('acct-1');
    expect(getOutbox().pending.r1?.status).toBe('attended');
    expect(getOutbox().refused).toEqual({});
  });

  it.each([
    ['no Date header', undefined],
    ['an unreadable Date header', 'not a date'],
  ])('a confirmation with %s is stamped with the device clock', async (_name, date) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(7_777_000);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (date !== undefined) headers.date = date;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'r1', status: 'attended' } }), { status: 200, headers }),
    );
    const entry: PendingEntry = {
      id: 'e1',
      ownerId: 'acct-1',
      registrationId: 'r1',
      classId: 'c1',
      studentName: 'Ada',
      status: 'attended',
      recordedAt: 1,
    };
    expect(await sendAttendance(entry)).toEqual({ kind: 'confirmed', at: 7_777_000 });
  });

  it('a pass runs under the cross-tab flush lock', async () => {
    let flushLockHeld = false;
    const request = vi.fn(async (name: string, fn: () => Promise<unknown>) => {
      if (name !== 'fy-outbox-flush') return fn();
      flushLockHeld = true;
      try {
        return await fn();
      } finally {
        flushLockHeld = false;
      }
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    await enqueue('attended');
    const sentUnderLock: boolean[] = [];
    fetchMock.mockImplementationOnce(async () => {
      sentUnderLock.push(flushLockHeld);
      return ok({ id: 'r1', status: 'attended' });
    });
    await flushAttendance('acct-1');
    expect(request).toHaveBeenCalledWith('fy-outbox-flush', expect.any(Function));
    expect(sentUnderLock).toEqual([true]);
    expect(getOutbox().pending).toEqual({});
  });

  it('a pass stops at a network failure, keeping every entry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue('attended', 'r1');
    await enqueue('no_show', 'r2');
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await flushAttendance('acct-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(getOutbox().pending).sort()).toEqual(['r1', 'r2']);
  });

  it('a pass stops at a timeout, and the backoff tries again', async () => {
    vi.useFakeTimers();
    await enqueue('attended', 'r1');
    await enqueue('no_show', 'r2');
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    onTestFinished(startAttendanceSync('acct-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(getOutbox().pending).sort()).toEqual(['r1', 'r2']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a 503', () => bare(503)],
    ['a 429', () => bare(429)],
    ['a 409 CONCURRENT_MODIFICATION', () => refusal(409, 'CONCURRENT_MODIFICATION', 'Someone else changed this.')],
    ['an intermediary\'s 403', () => html(403)],
  ])('a pass carries on past %s', async (_name, answer) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue('attended', 'r1');
    await enqueue('no_show', 'r2');
    fetchMock.mockImplementation(async () => answer());
    await flushAttendance('acct-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('several triggers while a request is in flight still send each entry once', async () => {
    await enqueue('attended');
    let answerFirst: (res: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockImplementation(async () => ok({ id: 'r1', status: 'attended' }));
    onTestFinished(startAttendanceSync('acct-1'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    setOffline(true);
    setOffline(false);
    void flushAttendance('acct-1');
    answerFirst(ok({ id: 'r1', status: 'attended' }));
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getOutbox().pending).toEqual({});
    expect(getOutbox().confirmed.r1?.status).toBe('attended');
  });

  it('confirmed drops the entry and records the confirmation at the server\'s clock', async () => {
    await enqueue('attended');
    fetchMock.mockResolvedValueOnce(ok({ id: 'r1', status: 'attended' }));
    await flushAttendance('acct-1');
    expect(getOutbox().pending).toEqual({});
    expect(getOutbox().confirmed.r1).toEqual({ status: 'attended', confirmedAt: SERVER_DATE });
  });

  it('a flush sends only its owner\'s entries, leaving the others untouched and unlogged', async () => {
    const warn = vi.spyOn(console, 'warn');
    const errors = vi.spyOn(console, 'error');
    await enqueue('attended', 'r1', 'acct-1');
    const theirs = await enqueue('no_show', 'r2', 'acct-2');
    fetchMock.mockResolvedValueOnce(ok({ id: 'r1', status: 'attended' }));
    await flushAttendance('acct-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/registrations/r1');
    expect(getOutbox().pending).toEqual({ r2: theirs });
    expect(getOutbox().refused).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it('a flush sends its owner\'s entries oldest recorded first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Stored newest first, so the send order comes from `recordedAt`, not from storage.
    vi.setSystemTime(2_000);
    await enqueue('attended', 'r1');
    vi.setSystemTime(1_000);
    await enqueue('no_show', 'r2');
    expect(Object.keys(getOutbox().pending)).toEqual(['r1', 'r2']);
    fetchMock.mockImplementation(async (input) =>
      urlOf(input) === '/api/registrations/r2'
        ? ok({ id: 'r2', status: 'no_show' })
        : ok({ id: 'r1', status: 'attended' }),
    );
    await flushAttendance('acct-1');
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).toEqual([
      '/api/registrations/r2',
      '/api/registrations/r1',
    ]);
    expect(getOutbox().pending).toEqual({});
  });

  it('stops the pass at the first 401 and reports needsSignIn', async () => {
    await enqueue('attended', 'r1');
    await enqueue('no_show', 'r2');
    const { result } = renderHook(() => useSyncState());
    expect(result.current.needsSignIn).toBe(false);
    fetchMock.mockResolvedValue(bare(401));
    await act(() => flushAttendance('acct-1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.needsSignIn).toBe(true);
    expect(Object.keys(getOutbox().pending).sort()).toEqual(['r1', 'r2']);

    fetchMock.mockImplementation(async (input) =>
      urlOf(input) === '/api/registrations/r1'
        ? ok({ id: 'r1', status: 'attended' })
        : ok({ id: 'r2', status: 'no_show' }),
    );
    await act(() => flushAttendance('acct-1'));
    expect(result.current.needsSignIn).toBe(false);
    expect(getOutbox().pending).toEqual({});
  });

  it('needsSignIn stays set until a 2xx, not merely until a pass ends', async () => {
    await enqueue('attended');
    const { result } = renderHook(() => useSyncState());
    fetchMock.mockResolvedValueOnce(bare(401)).mockResolvedValueOnce(bare(503));
    await act(() => flushAttendance('acct-1'));
    expect(result.current.needsSignIn).toBe(true);
    await act(() => flushAttendance('acct-1'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.needsSignIn).toBe(true);
  });

  it('needsSignIn clears when a pass finds nothing pending for its owner', async () => {
    await enqueue('attended');
    const { result } = renderHook(() => useSyncState());
    fetchMock.mockResolvedValueOnce(bare(401));
    await act(() => flushAttendance('acct-1'));
    expect(result.current.needsSignIn).toBe(true);
    // Another tab, signed in again, sent everything.
    localStorage.removeItem('fy-outbox-v1');
    await act(() => flushAttendance('acct-1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.needsSignIn).toBe(false);
  });

  it.each([
    ['a refusal', () => refusal(409, 'CLASS_CANCELLED', 'This class was cancelled.')],
    ['a 409 CONCURRENT_MODIFICATION', () => refusal(409, 'CONCURRENT_MODIFICATION', 'Someone else changed this.')],
    ['a 403', () => refusal(403, undefined, 'Not your class')],
  ])('needsSignIn clears on %s from the app, though nothing was applied', async (_name, answer) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue('attended', 'r1');
    await enqueue('no_show', 'r2');
    const { result } = renderHook(() => useSyncState());
    fetchMock.mockResolvedValueOnce(bare(401));
    await act(() => flushAttendance('acct-1'));
    expect(result.current.needsSignIn).toBe(true);
    fetchMock.mockImplementation(async (input) => {
      if (urlOf(input) === '/api/registrations/r1') return answer();
      throw new TypeError('Failed to fetch');
    });
    await act(() => flushAttendance('acct-1'));
    expect(result.current.needsSignIn).toBe(false);
  });

  it.each([
    ['an intermediary\'s 403', () => html(403)],
    ['a portal\'s 200', () => html(200)],
    ['a 200 that does not answer the write', () => ok({ id: 'r1', status: 'no_show' })],
  ])('needsSignIn stays set through %s', async (_name, answer) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue('attended');
    const { result } = renderHook(() => useSyncState());
    fetchMock.mockResolvedValueOnce(bare(401)).mockResolvedValueOnce(answer());
    await act(() => flushAttendance('acct-1'));
    await act(() => flushAttendance('acct-1'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.needsSignIn).toBe(true);
  });

  it('reports retrying once a flush leaves an attempted entry to retry, and not after one that leaves none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue('attended');
    const { result } = renderHook(() => useSyncState());
    expect(result.current.retrying).toBe(false);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(() => flushAttendance('acct-1'));
    expect(result.current.retrying).toBe(true);
    fetchMock.mockResolvedValueOnce(ok({ id: 'r1', status: 'attended' }));
    await act(() => flushAttendance('acct-1'));
    expect(result.current.retrying).toBe(false);
  });

  it('each pass reads the outbox past this tab\'s cache', async () => {
    const stale = await enqueue('attended');
    expect(getOutbox().pending.r1?.status).toBe('attended');
    const newer: PendingEntry = { ...stale, id: 'other-tab', status: 'no_show', recordedAt: stale.recordedAt + 1 };
    localStorage.setItem(
      'fy-outbox-v1',
      JSON.stringify({ pending: { r1: newer }, confirmed: {}, refused: {} }),
    );
    fetchMock.mockResolvedValueOnce(ok({ id: 'r1', status: 'no_show' }));
    await flushAttendance('acct-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"status":"no_show"}');
    expect(getOutbox().pending).toEqual({});
    expect(getOutbox().confirmed.r1?.status).toBe('no_show');
  });

  it('a failed pass is logged, never rejects, and keeps the backoff going', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue('attended');
    const request = vi
      .fn((_name: string, fn: () => Promise<unknown>) => fn())
      .mockImplementationOnce(async () => {
        throw new Error('lock manager failed');
      });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    fetchMock.mockResolvedValue(ok({ id: 'r1', status: 'attended' }));
    onTestFinished(startAttendanceSync('acct-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toBe('[attendance-sync] request failed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getOutbox().pending).toEqual({});
  });

  it('a tap during a flush is sent after it, in order', async () => {
    await enqueue('attended');
    let answerFirst: (res: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(ok({ id: 'r1', status: 'no_show' }));
    const first = flushAttendance('acct-1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await enqueue('no_show');
    const second = flushAttendance('acct-1');
    expect(second).toBe(first);
    answerFirst(ok({ id: 'r1', status: 'attended' }));
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"status":"no_show"}');
    expect(getOutbox().pending).toEqual({});
    expect(getOutbox().confirmed.r1?.status).toBe('no_show');
  });

  it.each([
    ['acct-2 then acct-1', ['acct-2', 'acct-1'], 'acct-1'],
    ['acct-1 then acct-2', ['acct-1', 'acct-2'], 'acct-2'],
  ] as const)('a rerun asked for by %s runs for the owner asked last, and only for them', async (_name, scopes, last) => {
    await enqueue('attended', 'r1', 'acct-1');
    let answerFirst: (res: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockImplementation(async (input) =>
        urlOf(input) === '/api/registrations/r2'
          ? ok({ id: 'r2', status: 'no_show' })
          : ok({ id: 'r3', status: 'attended' }),
      );
    const first = flushAttendance('acct-1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await enqueue('no_show', 'r2', 'acct-2');
    await enqueue('attended', 'r3', 'acct-1');
    for (const scope of scopes) void flushAttendance(scope);
    answerFirst(ok({ id: 'r1', status: 'attended' }));
    await first;
    const sent = last === 'acct-1' ? 'r3' : 'r2';
    const kept = last === 'acct-1' ? 'r2' : 'r3';
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input)).slice(1)).toEqual([`/api/registrations/${sent}`]);
    expect(Object.keys(getOutbox().pending)).toEqual([kept]);
  });

  it('a hung request times out and the entry is retried', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueue('attended');
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    onTestFinished(startAttendanceSync('acct-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await drain();
    expect(getOutbox().pending.r1?.status).toBe('attended');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it('retries on a backoff while retryable entries remain', async () => {
    vi.useFakeTimers();
    await enqueue('attended');
    fetchMock.mockImplementation(async () => bare(503));
    onTestFinished(startAttendanceSync('acct-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    let calls = 1;
    for (const delay of [5_000, 15_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      calls++;
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
  });

  it('startAttendanceSync flushes on start, online, visible, and reconnect', async () => {
    await enqueue('attended');
    fetchMock.mockImplementation(async () => bare(503));
    onTestFinished(startAttendanceSync('acct-1'));
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('online'));
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await drain();
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    setOffline(false);
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    setOffline(true);
    await drain();
    setOffline(false);
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stop removes every trigger', async () => {
    vi.useFakeTimers();
    await enqueue('attended');
    fetchMock.mockImplementation(async () => bare(503));
    const stop = startAttendanceSync('acct-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
    expect(conn.listeners.size).toBe(0);

    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    setOffline(true);
    setOffline(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stop holds against a flush still in flight', async () => {
    vi.useFakeTimers();
    await enqueue('attended');
    let answerFirst: (res: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockImplementation(async () => bare(503));
    const stop = startAttendanceSync('acct-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
    answerFirst(bare(503));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getOutbox().pending.r1?.status).toBe('attended');
  });

  it('a reconnect counts from the status as it stands after subscribing', async () => {
    conn.offlineOnSubscribe = true;
    await enqueue('attended');
    fetchMock.mockImplementation(async () => bare(503));
    onTestFinished(startAttendanceSync('acct-1'));
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setOffline(false);
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
