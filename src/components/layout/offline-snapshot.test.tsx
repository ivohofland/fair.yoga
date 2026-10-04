import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useState } from 'react';
import { OfflineSnapshot } from './offline-snapshot';
import { Button } from '@/components/ui/button';
import type { ConnectionStatus } from '@/lib/offline-status';

const { status, isOfflineNow, warmOfflinePages, router, pathname } = vi.hoisted(() => ({
  status: { current: { offline: false, serverNow: null } as ConnectionStatus },
  isOfflineNow: vi.fn(() => false),
  warmOfflinePages: vi.fn(async () => {}),
  router: { refresh: vi.fn(), push: vi.fn() },
  pathname: { current: '/schedule' },
}));

vi.mock('@/lib/offline-status', () => ({
  useConnectionStatus: () => status.current,
  isOfflineNow,
}));
vi.mock('@/lib/offline-client', () => ({ warmOfflinePages }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => pathname.current }));

const stamp = {
  ownerId: 'account-1',
  renderedAt: Date.parse('2026-10-04T09:12:00Z'),
  loadedAtClock: '09:12',
  loadedAtDayClock: 'Sat 3 Oct 21:40',
  loadedOn: '2026-10-04',
  timeZone: 'UTC',
};

function ui(props: Partial<Parameters<typeof OfflineSnapshot>[0]> = {}, children: React.ReactNode = <p>body</p>) {
  return (
    <OfflineSnapshot {...stamp} {...props}>
      {children}
    </OfflineSnapshot>
  );
}

beforeEach(() => {
  status.current = { offline: false, serverNow: null };
  isOfflineNow.mockReturnValue(false);
  pathname.current = '/schedule';
  router.refresh.mockClear();
  warmOfflinePages.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T09:30:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OfflineSnapshot', () => {
  it('carries the owner marker, and online its status is empty and screen-reader-only', () => {
    const { container } = render(ui());
    expect(container.querySelector('[data-offline-owner="account-1"]')).not.toBeNull();
    const notice = screen.getByRole('status');
    expect(notice).toBeEmptyDOMElement();
    expect(notice).toHaveClass('sr-only');
    expect(container.querySelector('fieldset')).not.toBeDisabled();
  });

  it('marks its fieldset for the stylesheet rule that dims what it disables', () => {
    const { container } = render(ui());
    expect(container.querySelector('fieldset')).toHaveAttribute('data-offline-fieldset');
  });

  it('says "at HH:MM" offline when loaded today in the stamp zone', () => {
    status.current = { offline: true, serverNow: null };
    render(ui());
    expect(screen.getByRole('status')).toHaveTextContent('Offline — showing what was loaded at 09:12');
  });

  it('gives the day and time when loaded on an earlier day, in the stamp zone rather than the device zone', () => {
    // 2026-10-04T09:30Z is 22:30 on 4 Oct in Auckland (UTC+13); a stamp from
    // the 3rd is an earlier day there, though the device's UTC date is the 4th.
    status.current = { offline: true, serverNow: null };
    render(ui({ timeZone: 'Pacific/Auckland', loadedOn: '2026-10-03' }));
    expect(screen.getByRole('status')).toHaveTextContent('Offline — showing what was loaded Sat 3 Oct 21:40');
  });

  it('uses the clock form when the stamp day is today in Auckland but not on the device', () => {
    status.current = { offline: true, serverNow: null };
    vi.setSystemTime(new Date('2026-10-04T11:30:00Z')); // 5 Oct in Auckland, 4 Oct in UTC
    render(ui({ timeZone: 'Pacific/Auckland', loadedOn: '2026-10-05' }));
    expect(screen.getByRole('status')).toHaveTextContent('Offline — showing what was loaded at 09:12');
  });

  describe('slots', () => {
    const slotted = () =>
      ui(
        { queueable: <Button>Check in</Button>, after: <Button>Cancel class</Button> },
        <Button>Publish</Button>,
      );

    it('offline, disables children and after, leaves queueable enabled, and the look comes from the pseudo-class', () => {
      status.current = { offline: true, serverNow: null };
      const { container } = render(slotted());
      const publish = screen.getByRole('button', { name: 'Publish' });
      expect(publish).toBeDisabled();
      expect(publish).toHaveClass('disabled:opacity-50');
      expect(screen.getByRole('button', { name: 'Cancel class' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Check in' })).toBeEnabled();
      expect(container.querySelectorAll('fieldset[data-offline-fieldset]')).toHaveLength(2);
    });

    it('online, disables none of them', () => {
      render(slotted());
      for (const name of ['Publish', 'Check in', 'Cancel class']) {
        expect(screen.getByRole('button', { name })).toBeEnabled();
      }
    });

    it('renders children, queueable, after in that order', () => {
      render(slotted());
      expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Publish', 'Check in', 'Cancel class']);
    });
  });

  describe('staleness refresh', () => {
    it('refreshes once when a ping lands more than 60 s after the render, and not again on a later stale ping', () => {
      status.current = { offline: false, serverNow: stamp.renderedAt + 60_001 };
      const { rerender } = render(ui());
      expect(router.refresh).toHaveBeenCalledTimes(1);
      status.current = { offline: false, serverNow: stamp.renderedAt + 120_000 };
      rerender(ui());
      expect(router.refresh).toHaveBeenCalledTimes(1);
    });

    it('does not refresh at 60 s or less', () => {
      status.current = { offline: false, serverNow: stamp.renderedAt + 60_000 };
      render(ui());
      expect(router.refresh).not.toHaveBeenCalled();
    });

    it('does not refresh while offline', () => {
      status.current = { offline: true, serverNow: stamp.renderedAt + 600_000 };
      render(ui());
      expect(router.refresh).not.toHaveBeenCalled();
    });
  });

  describe('warming', () => {
    it('warms the current path then the given paths once online', () => {
      pathname.current = '/schedule';
      render(ui({ warmPaths: ['/class/a', '/studio-class/b'] }));
      expect(warmOfflinePages).toHaveBeenCalledTimes(1);
      expect(warmOfflinePages).toHaveBeenCalledWith(['/schedule', '/class/a', '/studio-class/b']);
    });

    it('does not warm while offline', () => {
      status.current = { offline: true, serverNow: null };
      render(ui());
      expect(warmOfflinePages).not.toHaveBeenCalled();
    });

    it('does not warm when the hook still says online but the browser is offline', () => {
      isOfflineNow.mockReturnValue(true);
      render(ui());
      expect(warmOfflinePages).not.toHaveBeenCalled();
    });
  });

  it('keeps a child\'s state across offline then online', () => {
    function Counter() {
      const [n, setN] = useState(0);
      return <button type="button" onClick={() => setN(n + 1)}>count {n}</button>;
    }
    const { rerender } = render(ui({}, <Counter />));
    act(() => screen.getByRole('button').click());
    expect(screen.getByRole('button')).toHaveTextContent('count 1');
    status.current = { offline: true, serverNow: null };
    rerender(ui({}, <Counter />));
    status.current = { offline: false, serverNow: null };
    rerender(ui({}, <Counter />));
    expect(screen.getByRole('button')).toHaveTextContent('count 1');
  });
});
