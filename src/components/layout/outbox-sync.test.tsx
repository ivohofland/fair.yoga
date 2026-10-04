import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { OutboxSync } from './outbox-sync';
import type { ConnectionStatus } from '@/lib/offline-status';

const { status, isOfflineNow, flushOutbox, purgeOtherOwners } = vi.hoisted(() => ({
  status: { current: { offline: false, serverNow: null } as ConnectionStatus },
  isOfflineNow: vi.fn(() => false),
  flushOutbox: vi.fn(async (_owner: string) => ({ applied: 0 })),
  purgeOtherOwners: vi.fn((_owner: string) => {}),
}));

vi.mock('@/lib/offline-status', () => ({
  useConnectionStatus: () => status.current,
  isOfflineNow,
}));
vi.mock('@/lib/attendance-outbox', () => ({ flushOutbox, purgeOtherOwners }));

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

/** Lets the `.then` on a resolved flush run. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  status.current = { offline: false, serverNow: null };
  isOfflineNow.mockReset().mockReturnValue(false);
  flushOutbox.mockReset().mockResolvedValue({ applied: 0 });
  purgeOtherOwners.mockReset();
  setVisibility('visible');
});

describe('OutboxSync', () => {
  it('renders nothing', () => {
    const { container } = render(<OutboxSync owner="account-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('on mount purges other owners and then flushes, once each', async () => {
    render(<OutboxSync owner="account-1" />);
    await settle();
    expect(purgeOtherOwners).toHaveBeenCalledTimes(1);
    expect(purgeOtherOwners).toHaveBeenCalledWith('account-1');
    expect(flushOutbox).toHaveBeenCalledTimes(1);
    expect(flushOutbox).toHaveBeenCalledWith('account-1');
    expect(purgeOtherOwners.mock.invocationCallOrder[0]).toBeLessThan(flushOutbox.mock.invocationCallOrder[0] ?? 0);
  });

  it('flushes once per online event', async () => {
    render(<OutboxSync owner="account-1" />);
    await settle();
    flushOutbox.mockClear();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(flushOutbox).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(flushOutbox).toHaveBeenCalledTimes(2);
  });

  it('flushes once when the page becomes visible, and not when it is hidden', async () => {
    render(<OutboxSync owner="account-1" />);
    await settle();
    flushOutbox.mockClear();
    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(flushOutbox).not.toHaveBeenCalled();
    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(flushOutbox).toHaveBeenCalledTimes(1);
  });

  it('flushes once when the connection store goes from offline to online, and not when it goes offline', async () => {
    const { rerender } = render(<OutboxSync owner="account-1" />);
    await settle();
    flushOutbox.mockClear();
    status.current = { offline: true, serverNow: null };
    rerender(<OutboxSync owner="account-1" />);
    expect(flushOutbox).not.toHaveBeenCalled();
    status.current = { offline: false, serverNow: Date.now() };
    rerender(<OutboxSync owner="account-1" />);
    expect(flushOutbox).toHaveBeenCalledTimes(1);
    // A re-render with the store still online is not another reconnect.
    status.current = { offline: false, serverNow: Date.now() + 1 };
    rerender(<OutboxSync owner="account-1" />);
    expect(flushOutbox).toHaveBeenCalledTimes(1);
  });

  it('stops listening once unmounted', async () => {
    const { unmount } = render(<OutboxSync owner="account-1" />);
    await settle();
    unmount();
    flushOutbox.mockClear();
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(flushOutbox).not.toHaveBeenCalled();
  });

  it('refreshes once after a flush that applied something while online', async () => {
    flushOutbox.mockResolvedValue({ applied: 2 });
    render(<OutboxSync owner="account-1" />);
    await settle();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh after a flush that applied nothing', async () => {
    flushOutbox.mockResolvedValue({ applied: 0 });
    render(<OutboxSync owner="account-1" />);
    await settle();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('does not refresh after an applied flush when the connection store says offline', async () => {
    flushOutbox.mockResolvedValue({ applied: 1 });
    isOfflineNow.mockReturnValue(true);
    render(<OutboxSync owner="account-1" />);
    await settle();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('refreshes once when two triggers join the same running flush', async () => {
    let finish: (value: { applied: number }) => void = () => {};
    const running = new Promise<{ applied: number }>((resolve) => {
      finish = resolve;
    });
    flushOutbox.mockReturnValue(running);
    render(<OutboxSync owner="account-1" />);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(flushOutbox).toHaveBeenCalledTimes(2);
    finish({ applied: 1 });
    await settle();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });
});
