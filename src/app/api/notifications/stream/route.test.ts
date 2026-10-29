import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';
import { log } from '@/lib/log';
import { notificationBus } from '@/lib/event-bus';
import { beginShutdown } from '@/lib/shutdown';

const { validateSession } = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  validateSession,
}));

const { GET } = await import('./route');

const TICK_MS = 30_000;

const SESSION: SessionUser = {
  sessionId: 's1',
  accountId: 'acct-stream-test',
  teacherId: null,
  studentId: 'stu-1',
};

function connectRequest(): NextRequest {
  return new NextRequest('http://localhost/api/notifications/stream', {
    headers: { Cookie: 'fair_yoga_session=tok' },
  });
}

/** Opens the stream and drains it in the background; reads never block. */
async function open() {
  const res = await GET(connectRequest());
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let done = false;
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        return;
      }
      text += decoder.decode(chunk.value);
    }
  })();
  return {
    text: () => text,
    isDone: () => done,
    close: () => reader.cancel(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  validateSession.mockReset();
  globalThis.__fairYogaSseCounts?.clear();
  delete globalThis.__fairYogaShutdown;
});

describe('GET /api/notifications/stream keepalive tick', () => {
  it('keeps the stream open while the connect-time token still validates', async () => {
    vi.useFakeTimers();
    validateSession.mockResolvedValue(SESSION);
    const stream = await open();

    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(validateSession).toHaveBeenCalledTimes(2);
    expect(validateSession).toHaveBeenLastCalledWith(expect.anything(), 'tok');
    expect(stream.text()).toContain(': keepalive');
    expect(stream.isDone()).toBe(false);
    await stream.close();
  });

  it('closes the stream when the token no longer validates', async () => {
    vi.useFakeTimers();
    validateSession.mockResolvedValueOnce(SESSION).mockResolvedValue(null);
    const stream = await open();

    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(stream.isDone()).toBe(true);
    expect(globalThis.__fairYogaSseCounts?.get(SESSION.accountId)).toBeUndefined();
  });

  it('stops revalidating once the stream has closed', async () => {
    vi.useFakeTimers();
    validateSession.mockResolvedValueOnce(SESSION).mockResolvedValue(null);
    const stream = await open();

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(stream.isDone()).toBe(true);
    const callsAtClose = validateSession.mock.calls.length;

    await vi.advanceTimersByTimeAsync(TICK_MS * 5);

    expect(validateSession).toHaveBeenCalledTimes(callsAtClose);
  });

  it('keeps the stream and logs when revalidation throws, then revalidates again on the next tick', async () => {
    vi.useFakeTimers();
    const logError = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const boom = new Error('connection lost');
    validateSession
      .mockResolvedValueOnce(SESSION)
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce(null);
    const stream = await open();

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(stream.isDone()).toBe(false);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, accountId: SESSION.accountId }),
      expect.any(String),
    );

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(stream.isDone()).toBe(true);
  });
});

describe('GET /api/notifications/stream shutdown', () => {
  it('ends every open stream and releases its listener and count when shutdown begins', async () => {
    validateSession.mockResolvedValue(SESSION);
    const listenersBefore = notificationBus.listenerCount();
    const a = await open();
    const b = await open();
    expect(notificationBus.listenerCount()).toBe(listenersBefore + 2);

    beginShutdown();
    await vi.waitFor(() => {
      expect(a.isDone()).toBe(true);
      expect(b.isDone()).toBe(true);
    });

    expect(notificationBus.listenerCount()).toBe(listenersBefore);
    expect(globalThis.__fairYogaSseCounts?.has(SESSION.accountId)).toBe(false);
  });

  it('refuses a request that arrives after shutdown began, subscribing and counting nothing', async () => {
    validateSession.mockResolvedValue(SESSION);
    const listenersBefore = notificationBus.listenerCount();
    beginShutdown();

    const res = await GET(connectRequest());

    expect(res.status).toBe(503);
    expect(notificationBus.listenerCount()).toBe(listenersBefore);
    expect(globalThis.__fairYogaSseCounts?.has(SESSION.accountId)).toBe(false);
  });

  it('refuses a request whose session check was still pending when shutdown began', async () => {
    let resolveSession: (s: SessionUser) => void = () => undefined;
    validateSession.mockReturnValue(
      new Promise<SessionUser>((resolve) => {
        resolveSession = resolve;
      }),
    );
    const listenersBefore = notificationBus.listenerCount();

    const pending = GET(connectRequest());
    beginShutdown();
    resolveSession(SESSION);
    const res = await pending;

    expect(res.status).toBe(503);
    expect(notificationBus.listenerCount()).toBe(listenersBefore);
    expect(globalThis.__fairYogaSseCounts?.has(SESSION.accountId)).toBe(false);
  });

  it('runs each stream cleanup exactly once across abort and shutdown', async () => {
    validateSession.mockResolvedValue(SESSION);
    const off = vi.spyOn(notificationBus, 'offNotification');
    const abortA = new AbortController();
    const resA = await GET(
      new NextRequest('http://localhost/api/notifications/stream', {
        headers: { Cookie: 'fair_yoga_session=tok' },
        signal: abortA.signal,
      }),
    );
    const readerA = resA.body!.getReader();
    const b = await open();
    expect(globalThis.__fairYogaSseCounts?.get(SESSION.accountId)).toBe(2);

    abortA.abort();
    expect(globalThis.__fairYogaSseCounts?.get(SESSION.accountId)).toBe(1);

    beginShutdown();
    await vi.waitFor(() => expect(b.isDone()).toBe(true));

    expect(globalThis.__fairYogaSseCounts?.has(SESSION.accountId)).toBe(false);
    expect(off).toHaveBeenCalledTimes(2);
    await readerA.cancel();
  });

  it('unsubscribes from shutdown when the client aborts', async () => {
    validateSession.mockResolvedValue(SESSION);
    const abort = new AbortController();
    const res = await GET(
      new NextRequest('http://localhost/api/notifications/stream', {
        headers: { Cookie: 'fair_yoga_session=tok' },
        signal: abort.signal,
      }),
    );
    expect(globalThis.__fairYogaShutdown?.subscribers.size).toBe(1);

    abort.abort();

    expect(globalThis.__fairYogaShutdown?.subscribers.size).toBe(0);
    await res.body!.cancel();
  });
});

describe('GET /api/notifications/stream client gone during the session check', () => {
  it('ends the stream and leaves no count, bus listener or shutdown subscriber', async () => {
    let resolveSession: (s: SessionUser) => void = () => undefined;
    validateSession.mockReturnValue(
      new Promise<SessionUser>((resolve) => {
        resolveSession = resolve;
      }),
    );
    const listenersBefore = notificationBus.listenerCount();
    const abort = new AbortController();

    const pending = GET(
      new NextRequest('http://localhost/api/notifications/stream', {
        headers: { Cookie: 'fair_yoga_session=tok' },
        signal: abort.signal,
      }),
    );
    abort.abort();
    resolveSession(SESSION);
    const res = await pending;
    const reader = res.body!.getReader();
    while (!(await reader.read()).done);

    expect(globalThis.__fairYogaSseCounts?.has(SESSION.accountId)).toBe(false);
    expect(notificationBus.listenerCount()).toBe(listenersBefore);
    expect(globalThis.__fairYogaShutdown?.subscribers.size ?? 0).toBe(0);
  });
});
