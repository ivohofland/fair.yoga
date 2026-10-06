import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';
import { log } from '@/lib/log';

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
