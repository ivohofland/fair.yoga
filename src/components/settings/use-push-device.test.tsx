import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { InstallSupport } from '@/lib/install-support';
import type { SyncResult } from '@/lib/push-client';

let support: InstallSupport = 'installed';
vi.mock('@/components/layout/install-store', () => ({
  useInstallSupport: () => support,
}));

const currentPushSubscriptionMock = vi.fn<() => Promise<PushSubscription | null>>();
const disablePushMock = vi.fn<() => Promise<'off' | 'failed'>>();
const syncPushSubscriptionMock = vi.fn<(subscription: PushSubscription) => Promise<SyncResult>>();
vi.mock('@/lib/push-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/push-client')>();
  return {
    ...actual,
    currentPushSubscription: () => currentPushSubscriptionMock(),
    disablePush: () => disablePushMock(),
    syncPushSubscription: (subscription: PushSubscription) => syncPushSubscriptionMock(subscription),
  };
});

import { usePushDevice } from './use-push-device';

function keyOf(fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(65).fill(fill))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const CURRENT_KEY = keyOf(4);

function subscriptionWithKey(fill: number): PushSubscription {
  return {
    endpoint: 'https://push.example/x',
    options: { applicationServerKey: new Uint8Array(65).fill(fill).buffer, userVisibleOnly: true },
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription;
}

function setCapabilities(permission: NotificationPermission | null): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register: vi.fn(), getRegistration: vi.fn(async () => null) },
    configurable: true,
  });
  (window as unknown as Record<string, unknown>).PushManager = function PushManager() {};
  if (permission === null) delete (window as unknown as Record<string, unknown>).Notification;
  else (window as unknown as Record<string, unknown>).Notification = { permission };
}

describe('usePushDevice', () => {
  beforeEach(() => {
    support = 'installed';
    currentPushSubscriptionMock.mockReset();
    currentPushSubscriptionMock.mockResolvedValue(null);
    disablePushMock.mockReset();
    disablePushMock.mockResolvedValue('off');
    syncPushSubscriptionMock.mockReset();
    syncPushSubscriptionMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it('starts unresolved, then reports off and the permission it read', async () => {
    setCapabilities('default');
    const { result } = renderHook(() => usePushDevice(CURRENT_KEY, { resync: false }));
    expect(result.current.state).toBeNull();
    await waitFor(() => expect(result.current.state).toBe('off'));
    expect(result.current.permission).toBe('default');
  });

  it('reports a null permission where the browser has no Notification', async () => {
    setCapabilities(null);
    const { result } = renderHook(() => usePushDevice(CURRENT_KEY, { resync: false }));
    await waitFor(() => expect(result.current.state).toBe('unsupported'));
    expect(result.current.permission).toBeNull();
  });

  it('does not re-record an on device when resync is false', async () => {
    setCapabilities('granted');
    currentPushSubscriptionMock.mockResolvedValue(subscriptionWithKey(4));
    const { result } = renderHook(() => usePushDevice(CURRENT_KEY, { resync: false }));
    await waitFor(() => expect(result.current.state).toBe('on'));
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();
  });

  it('re-records an on device when resync is true', async () => {
    setCapabilities('granted');
    currentPushSubscriptionMock.mockResolvedValue(subscriptionWithKey(4));
    const { result } = renderHook(() => usePushDevice(CURRENT_KEY, { resync: true }));
    await waitFor(() => expect(result.current.state).toBe('on'));
    expect(syncPushSubscriptionMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('drops a stale-key subscription and reports off (resync %s)', async (resync) => {
    setCapabilities('granted');
    currentPushSubscriptionMock.mockResolvedValue(subscriptionWithKey(9));
    const { result } = renderHook(() => usePushDevice(CURRENT_KEY, { resync }));
    await waitFor(() => expect(result.current.state).toBe('off'));
    expect(disablePushMock).toHaveBeenCalledTimes(1);
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();
  });
});
