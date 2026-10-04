import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { CheckinSwitch } from './checkin-switch';

const CHECKIN_AT = '2026-10-04T09:45:00.000Z';

function ui(initial: 'before' | 'checkin' = 'before', checkinAt = CHECKIN_AT) {
  return (
    <CheckinSwitch
      checkinAt={checkinAt}
      initial={initial}
      before={<p>registered students</p>}
      checkin={<p>attendance list</p>}
    />
  );
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('CheckinSwitch', () => {
  it('renders the server\'s choice on the server, whatever the clock says', () => {
    vi.setSystemTime(new Date('2026-10-04T10:30:00Z')); // well past check-in
    const html = renderToString(ui('before'));
    expect(html).toContain('registered students');
    expect(html).not.toContain('attendance list');
  });

  it('renders only the check-in node when the server chose it', () => {
    vi.setSystemTime(new Date('2026-10-04T09:00:00Z'));
    render(ui('checkin'));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
    expect(screen.queryByText('registered students')).toBeNull();
  });

  it('stays on the before view before the instant', () => {
    vi.setSystemTime(new Date('2026-10-04T09:44:59Z'));
    render(ui());
    expect(screen.getByText('registered students')).toBeInTheDocument();
    expect(screen.queryByText('attendance list')).toBeNull();
  });

  it('switches after mount when the device clock is already at the instant', () => {
    vi.setSystemTime(new Date(CHECKIN_AT));
    render(ui());
    expect(screen.getByText('attendance list')).toBeInTheDocument();
    expect(screen.queryByText('registered students')).toBeNull();
  });

  it('switches after mount when the device clock is past the instant', () => {
    vi.setSystemTime(new Date('2026-10-04T10:30:00Z'));
    render(ui());
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('switches when the timer reaches the instant', () => {
    vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
    render(ui());
    act(() => vi.advanceTimersByTime(5 * 60_000 - 1));
    expect(screen.queryByText('attendance list')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('switches on returning to the tab past the instant, without the timer', () => {
    // A frozen tab's timer may not fire: move the clock without running timers.
    vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
    render(ui());
    vi.setSystemTime(new Date('2026-10-04T09:50:00Z'));
    act(() => setVisibility('visible'));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('does not switch on a hidden visibility change', () => {
    vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
    render(ui());
    vi.setSystemTime(new Date('2026-10-04T09:50:00Z'));
    act(() => setVisibility('hidden'));
    expect(screen.queryByText('attendance list')).toBeNull();
  });

  it('never switches back once check-in shows, even if the clock moves earlier', () => {
    vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
    const { rerender } = render(ui());
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
    vi.setSystemTime(new Date('2026-10-04T09:00:00Z'));
    act(() => setVisibility('visible'));
    act(() => vi.advanceTimersByTime(60 * 60_000));
    rerender(ui());
    expect(screen.getByText('attendance list')).toBeInTheDocument();
    expect(screen.queryByText('registered students')).toBeNull();
  });

  it('arms no timer that setTimeout would clamp, and the visibility path still opens check-in', () => {
    vi.setSystemTime(new Date('2026-10-04T09:45:00Z'));
    const farAway = new Date(Date.now() + 2 ** 31 + 60_000).toISOString();
    render(ui('before', farAway));
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByText('attendance list')).toBeNull();
    vi.setSystemTime(new Date(Date.parse(farAway)));
    act(() => setVisibility('visible'));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('stays on the before view for an unreadable instant', () => {
    vi.setSystemTime(new Date('2026-10-04T09:50:00Z'));
    render(ui('before', 'not-a-date'));
    act(() => setVisibility('visible'));
    expect(screen.getByText('registered students')).toBeInTheDocument();
  });
});
