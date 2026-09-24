import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { RefreshAt } from './refresh-at';
import { routerRefresh } from '../../../tests/setup/components';

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
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE).toISOString();

  it('refreshes when a future instant arrives, and not a millisecond before', () => {
    render(<RefreshAt instants={[at(10)]} />);

    vi.advanceTimersByTime(10 * MINUTE - 1);
    expect(routerRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes once per future instant', () => {
    render(<RefreshAt instants={[at(10), at(40)]} />);

    vi.advanceTimersByTime(10 * MINUTE);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30 * MINUTE - 1);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  it('ignores an instant already past', () => {
    render(<RefreshAt instants={[at(-5)]} />);

    vi.advanceTimersByTime(60 * MINUTE);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('ignores an instant beyond the longest delay setTimeout can hold', () => {
    // Past 2^31 − 1 ms setTimeout overflows and fires at once.
    render(<RefreshAt instants={[new Date(NOW.getTime() + 2 ** 31).toISOString()]} />);

    vi.advanceTimersByTime(1);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('does not refresh after unmount', () => {
    const { unmount } = render(<RefreshAt instants={[at(10)]} />);
    unmount();

    vi.advanceTimersByTime(10 * MINUTE);
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
