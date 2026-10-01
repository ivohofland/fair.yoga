import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { LiveUpdates } from './live-updates';

// One router object for every render, as Next's `useRouter` gives. The shared
// setup's mock builds a new one per call, and `router` is this effect's
// dependency, so any re-render there would tear the stream down and reopen it.
const { routerRefresh, router } = vi.hoisted(() => {
  const refresh = vi.fn();
  return { routerRefresh: refresh, router: { refresh } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/**
 * Stands in for the browser's `EventSource`, which jsdom does not implement.
 * The helpers drive the state transitions the component reacts to; nothing
 * here retries on its own, so every reconnect a test sees is the component's.
 */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState: number = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly close = vi.fn(() => {
    this.readyState = FakeEventSource.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    sources.push(this);
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  message(): void {
    this.onmessage?.(new MessageEvent('message', { data: '{}' }));
  }

  /** A transient drop: the browser is already reconnecting on its own. */
  dropAndRetry(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.(new Event('error'));
  }

  /** A non-2xx response (an expired session's 401): closed for good, no retry. */
  failPermanently(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
}

let sources: FakeEventSource[] = [];

function latest(): FakeEventSource {
  const source = sources.at(-1);
  if (!source) throw new Error('no EventSource was constructed');
  return source;
}

/**
 * #731. `LiveUpdates` keeps the inbox, the tab-bar unread dot and open lists
 * current by refreshing the page when the notification stream speaks. A
 * regression here fails silently: the page keeps working, it just stops
 * updating.
 */
describe('LiveUpdates', () => {
  beforeEach(() => {
    sources = [];
    routerRefresh.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens one stream to the notification endpoint on mount', () => {
    render(<LiveUpdates />);

    expect(sources).toHaveLength(1);
    expect(latest().url).toBe('/api/notifications/stream');
  });

  it('collapses a burst into one refresh, 500 ms after the last message', () => {
    render(<LiveUpdates />);
    const source = latest();

    // Five messages, 100 ms apart: the last lands at t = 400.
    source.message();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(100);
      source.message();
    }

    // t = 899: 500 ms after the first message has long passed; after the last, not yet.
    vi.advanceTimersByTime(499);
    expect(routerRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes again for a message after the previous refresh', () => {
    render(<LiveUpdates />);
    const source = latest();

    source.message();
    vi.advanceTimersByTime(500);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    source.message();
    vi.advanceTimersByTime(500);
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  it('closes the stream on unmount and drops a refresh still pending', () => {
    const { unmount } = render(<LiveUpdates />);
    const source = latest();

    source.message();
    unmount();

    expect(source.close).toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
