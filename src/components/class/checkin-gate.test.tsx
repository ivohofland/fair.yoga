import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { CheckinGate } from './checkin-gate';

const NOW = Date.parse('2026-10-04T17:30:00Z');
const MINUTE = 60_000;

function gate(serverShowCheckin: boolean, checkinAt: number) {
  return (
    <CheckinGate
      serverShowCheckin={serverShowCheckin}
      checkinAt={checkinAt}
      attendance={<p>attendance list</p>}
      registered={<p>registered list</p>}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CheckinGate', () => {
  it('shows attendance when the server showed check-in', () => {
    render(gate(true, NOW + 10 * MINUTE));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
    expect(screen.queryByText('registered list')).not.toBeInTheDocument();
  });

  it('shows registered before the check-in instant, and attendance once the device clock passes it', () => {
    render(gate(false, NOW + 10 * MINUTE));
    expect(screen.getByText('registered list')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10 * MINUTE - 1));
    expect(screen.getByText('registered list')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('shows attendance when the check-in instant is already past at mount', () => {
    render(gate(false, NOW - MINUTE));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('keeps attendance the server showed when the device clock is behind', () => {
    render(gate(true, NOW + 30 * MINUTE));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('shows attendance when a re-render brings the server answer true', () => {
    const { rerender } = render(gate(false, NOW + 30 * MINUTE));
    expect(screen.getByText('registered list')).toBeInTheDocument();
    rerender(gate(true, NOW + 30 * MINUTE));
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('re-reads the clock on visibilitychange, for a timer the OS suspended', () => {
    const checkinAt = NOW + 10 * MINUTE;
    render(gate(false, checkinAt));
    vi.setSystemTime(checkinAt + 1);
    expect(screen.getByText('registered list')).toBeInTheDocument();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByText('attendance list')).toBeInTheDocument();
  });

  it('paints the registered list on the server even with the check-in instant past, and hydrates without a mismatch', async () => {
    const html = renderToString(gate(false, NOW - MINUTE));
    expect(html).toContain('registered list');
    expect(html).not.toContain('attendance list');

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, gate(false, NOW - MINUTE), { onRecoverableError });
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container).toHaveTextContent('attendance list');
    act(() => root?.unmount());
    container.remove();
  });

  it('shows registered and arms no timer for an unreadable check-in instant', () => {
    render(gate(false, Number.NaN));
    expect(screen.getByText('registered list')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});
