import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  checkConnection,
  getConnectionStatus,
  isOfflineNow,
  resetConnectionStatus,
  subscribeConnectionStatus,
  useConnectionStatus,
} from './offline-status';

const NOW = 1_780_000_000_000;

function answer(status: number, body: unknown = { now: NOW }): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Lets a pending ping settle: its promise chain needs a few microtask turns. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('connection status', () => {
  let win: EventTarget;
  let doc: EventTarget & { visibilityState: string };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    win = new EventTarget();
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    fetchMock = vi.fn();
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetConnectionStatus();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function Probe() {
    return createElement('span', null, String(useConnectionStatus().offline));
  }

  it('renders online on the server', () => {
    expect(renderToString(createElement(Probe))).toContain('false');
  });

  it('pings once on first subscribe and keeps the server clock from the answer', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer(200)));
    const unsubscribe = subscribeConnectionStatus(() => {});
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/ping');
    expect(getConnectionStatus()).toEqual({ offline: false, serverNow: NOW });
    unsubscribe();
  });

  it('counts a rejected ping as offline', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const unsubscribe = subscribeConnectionStatus(() => {});
    await settle();
    expect(getConnectionStatus().offline).toBe(true);
    unsubscribe();
  });

  it('counts a 503 ping as offline', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer(503, { error: 'offline' })));
    const unsubscribe = subscribeConnectionStatus(() => {});
    await settle();
    expect(getConnectionStatus().offline).toBe(true);
    unsubscribe();
  });

  it('goes offline on the offline event without a request, and pings again on online', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer(200)));
    const unsubscribe = subscribeConnectionStatus(() => {});
    await settle();
    fetchMock.mockClear();

    vi.stubGlobal('navigator', { onLine: false });
    win.dispatchEvent(new Event('offline'));
    expect(getConnectionStatus().offline).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal('navigator', { onLine: true });
    win.dispatchEvent(new Event('online'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getConnectionStatus().offline).toBe(false);
    unsubscribe();
  });

  it('pings again when the page becomes visible', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer(200)));
    const unsubscribe = subscribeConnectionStatus(() => {});
    await settle();
    fetchMock.mockClear();

    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('isOfflineNow follows navigator.onLine and the last ping, without a subscription', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(isOfflineNow()).toBe(true);
    vi.stubGlobal('navigator', { onLine: true });
    expect(isOfflineNow()).toBe(false);

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await checkConnection();
    expect(isOfflineNow()).toBe(true);

    fetchMock.mockResolvedValueOnce(answer(200));
    await checkConnection();
    expect(isOfflineNow()).toBe(false);
  });

  it('forgets a failed ping when the last subscriber leaves', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const unsubscribe = subscribeConnectionStatus(() => {});
    await settle();
    expect(isOfflineNow()).toBe(true);
    unsubscribe();
    expect(isOfflineNow()).toBe(false);
    expect(getConnectionStatus().offline).toBe(false);
  });

  it('sends the ping with an abort signal and no cache', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer(200)));
    await checkConnection();
    const init: unknown = fetchMock.mock.calls[0]?.[1];
    expect(init).toEqual(expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
  });

  it('retries every 15 s while offline and a subscriber remains, and stops once none does', async () => {
    fetchMock.mockResolvedValueOnce(answer(503, {}));
    fetchMock.mockResolvedValueOnce(answer(200));
    const unsubscribe = subscribeConnectionStatus(() => {});
    await settle();
    expect(getConnectionStatus().offline).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getConnectionStatus()).toEqual({ offline: false, serverNow: NOW });

    fetchMock.mockClear();
    fetchMock.mockImplementation(() => Promise.resolve(answer(503, {})));
    win.dispatchEvent(new Event('online'));
    await settle();
    expect(getConnectionStatus().offline).toBe(true);
    unsubscribe();
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the latest ping: an older ping failing late does not flip the status', async () => {
    let rejectA: (reason: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((_, reject) => { rejectA = reject; }));
    fetchMock.mockResolvedValueOnce(answer(200));
    const unsubscribe = subscribeConnectionStatus(() => {});
    win.dispatchEvent(new Event('online'));
    await settle();
    expect(getConnectionStatus()).toEqual({ offline: false, serverNow: NOW });

    rejectA(new TypeError('Failed to fetch'));
    await settle();
    expect(getConnectionStatus().offline).toBe(false);
    unsubscribe();
  });
});
