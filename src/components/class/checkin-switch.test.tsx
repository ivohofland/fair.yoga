import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
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

  it('keeps one timer when returning to the tab before the instant', () => {
    vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
    render(ui());
    act(() => setVisibility('visible'));
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not switch on a hidden visibility change', () => {
    vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
    render(ui());
    vi.setSystemTime(new Date('2026-10-04T09:50:00Z'));
    act(() => setVisibility('hidden'));
    expect(screen.queryByText('attendance list')).toBeNull();
  });

  it('never switches back once the device clock opened check-in, even if the clock moves earlier', () => {
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
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByText('attendance list')).toBeNull();
    vi.setSystemTime(new Date(Date.parse(farAway)));
    act(() => setVisibility('visible'));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('stays on the before view for an unreadable instant, waiting on nothing', () => {
    const add = vi.spyOn(document, 'addEventListener');
    vi.setSystemTime(new Date('2026-10-04T09:50:00Z'));
    render(ui('before', 'not-a-date'));
    expect(vi.getTimerCount()).toBe(0);
    expect(add.mock.calls.filter(([type]) => type === 'visibilitychange')).toEqual([]);
    act(() => setVisibility('visible'));
    expect(screen.getByText('registered students')).toBeInTheDocument();
    add.mockRestore();
  });

  it('waits again when its timer fires a hair before the instant on the wall clock', () => {
    // The timer runs on a monotonic clock; a coarsened or stepped-back
    // `Date.now()` can still read just short of the instant when it fires.
    vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
    render(ui());
    vi.setSystemTime(new Date(Date.now() - 1));
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(screen.queryByText('attendance list')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('leaves no timer and no listener behind once unmounted', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
    const { unmount } = render(ui());
    const added = add.mock.calls.filter(([type]) => type === 'visibilitychange').map(([, fn]) => fn);
    expect(added).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    const removed = remove.mock.calls.filter(([type]) => type === 'visibilitychange').map(([, fn]) => fn);
    expect(removed).toContain(added[0]);
    add.mockRestore();
    remove.mockRestore();
  });

  describe('when a later server render chooses the before view', () => {
    // The class's start moved later from another device, and a refresh
    // re-renders the page with the new instant.
    const MOVED_CHECKIN_AT = '2026-10-04T10:15:00.000Z';

    it('follows it from a check-in view the server chose', () => {
      vi.setSystemTime(new Date('2026-10-04T09:46:00Z'));
      const { rerender } = render(ui('checkin'));
      expect(screen.getByText('attendance list')).toBeInTheDocument();

      rerender(ui('before', MOVED_CHECKIN_AT));

      expect(screen.getByText('registered students')).toBeInTheDocument();
      expect(screen.queryByText('attendance list')).toBeNull();
    });

    it('does not undo a check-in view the device clock opened', () => {
      vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
      const { rerender } = render(ui('before'));
      act(() => vi.advanceTimersByTime(5 * 60_000));
      expect(screen.getByText('attendance list')).toBeInTheDocument();

      rerender(ui('before', MOVED_CHECKIN_AT));

      expect(screen.getByText('attendance list')).toBeInTheDocument();
      expect(screen.queryByText('registered students')).toBeNull();
    });
  });

  describe('when the server re-renders with check-in chosen', () => {
    function Field() {
      const [value, setValue] = useState('');
      return <input aria-label="walk-in" value={value} onChange={(e) => setValue(e.target.value)} />;
    }
    const withField = (initial: 'before' | 'checkin') => (
      <CheckinSwitch checkinAt={CHECKIN_AT} initial={initial} before={<p>registered students</p>} checkin={<Field />} />
    );

    it('keeps the check-in view the device already opened, state and all', () => {
      vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
      const { rerender } = render(withField('before'));
      act(() => vi.advanceTimersByTime(5 * 60_000));
      const input = screen.getByLabelText('walk-in');
      fireEvent.change(input, { target: { value: 'Sam' } });
      rerender(withField('checkin'));
      expect(screen.getByLabelText('walk-in')).toBe(input);
      expect(screen.getByLabelText('walk-in')).toHaveValue('Sam');
    });

    it('shows check-in on a device whose clock is behind the server', () => {
      vi.setSystemTime(new Date('2026-10-04T09:40:00Z'));
      const { rerender } = render(withField('before'));
      rerender(withField('checkin'));
      expect(screen.getByLabelText('walk-in')).toBeInTheDocument();
      expect(screen.queryByText('registered students')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
