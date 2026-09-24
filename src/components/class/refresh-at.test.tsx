import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { RefreshAt } from './refresh-at';

// One router object for every render, as Next's `useRouter` gives. The shared
// setup's mock builds a new one per call, which re-runs the effect on every
// render whatever its other dependencies — and so could not show that a new
// `serverNow` alone re-arms the timers.
const { routerRefresh, router } = vi.hoisted(() => {
  const refresh = vi.fn();
  return { routerRefresh: refresh, router: { refresh } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/**
 * #234. The class page decides the finish button and the auto-finish from
 * `Date.now()` at render, so a page opened before `finishOpensAt` would never
 * show the button without a reload. This component re-renders the page as
 * each instant arrives.
 */
describe('RefreshAt', () => {
  const NOW = new Date('2026-06-01T17:00:00.000Z');
  const MINUTE = 60_000;

  beforeEach(() => {
    routerRefresh.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE).toISOString();
  // The server's render time. Equal to the client clock unless a test skews it.
  const SERVER_NOW = NOW.getTime();

  it('refreshes when a future instant arrives, and not a millisecond before', () => {
    render(<RefreshAt instants={[at(10)]} serverNow={SERVER_NOW} />);

    vi.advanceTimersByTime(10 * MINUTE - 1);
    expect(routerRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes once per future instant', () => {
    render(<RefreshAt instants={[at(10), at(40)]} serverNow={SERVER_NOW} />);

    vi.advanceTimersByTime(10 * MINUTE);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30 * MINUTE - 1);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  it('ignores an instant already past', () => {
    render(<RefreshAt instants={[at(-5)]} serverNow={SERVER_NOW} />);

    vi.advanceTimersByTime(60 * MINUTE);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('ignores an instant beyond the longest delay setTimeout can hold', () => {
    // Past 2^31 − 1 ms setTimeout overflows and fires at once.
    render(<RefreshAt instants={[new Date(NOW.getTime() + 2 ** 31).toISOString()]} serverNow={SERVER_NOW} />);

    vi.advanceTimersByTime(1);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  /**
   * The instants are the server's, so the wait is counted from the server's
   * render, not from the client's clock. A client clock two minutes ahead
   * would otherwise refresh two minutes early, reach the server before the
   * edge, and render the same page again.
   */
  it('counts the wait from the server render, not the client clock', () => {
    vi.setSystemTime(NOW.getTime() + 2 * MINUTE);
    render(<RefreshAt instants={[at(10)]} serverNow={SERVER_NOW} />);

    vi.advanceTimersByTime(10 * MINUTE - 1);
    expect(routerRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('re-arms on new instants: the old timer is cleared and the new one fires at its own instant', () => {
    const { rerender } = render(<RefreshAt instants={[at(10)]} serverNow={SERVER_NOW} />);

    vi.advanceTimersByTime(5 * MINUTE);
    rerender(<RefreshAt instants={[at(20)]} serverNow={SERVER_NOW + 5 * MINUTE} />);

    vi.advanceTimersByTime(5 * MINUTE);
    expect(routerRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10 * MINUTE - 1);
    expect(routerRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  /**
   * Each render re-arms, even with the same instants: a refresh that reached
   * the server a moment before an edge renders the same instants again, and
   * the page must still wait out the rest.
   */
  it('re-arms on a new render time even when the instants are the same', () => {
    const { rerender } = render(<RefreshAt instants={[at(10)]} serverNow={SERVER_NOW} />);

    vi.advanceTimersByTime(10 * MINUTE);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    rerender(<RefreshAt instants={[at(10)]} serverNow={SERVER_NOW + 10 * MINUTE - 1000} />);
    vi.advanceTimersByTime(999);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  it('does not refresh after unmount', () => {
    const { unmount } = render(<RefreshAt instants={[at(10)]} serverNow={SERVER_NOW} />);
    unmount();

    vi.advanceTimersByTime(10 * MINUTE);
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
