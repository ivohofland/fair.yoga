import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InstallSupport } from '@/lib/install-support';

let support: InstallSupport = 'installed';
vi.mock('@/components/layout/install-store', () => ({
  useInstallSupport: () => support,
}));

const currentPushSubscriptionMock = vi.fn<() => Promise<{ endpoint: string } | null>>();
const enablePushMock = vi.fn<(vapidPublicKey: string) => Promise<'on' | 'blocked' | 'failed'>>();
const disablePushMock = vi.fn<() => Promise<void>>();
vi.mock('@/lib/push-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/push-client')>();
  return {
    ...actual,
    currentPushSubscription: (...args: Parameters<typeof actual.currentPushSubscription>) =>
      currentPushSubscriptionMock(...args),
    enablePush: (...args: Parameters<typeof actual.enablePush>) => enablePushMock(...args),
    disablePush: (...args: Parameters<typeof actual.disablePush>) => disablePushMock(...args),
  };
});

import { PushDeviceControl } from './push-device-control';

/** Removes/sets the three capability globals the control's effect reads
 *  straight off `navigator`/`window`, independent of the mocked install store. */
function setBrowserCapabilities(opts: {
  serviceWorker?: boolean;
  pushManager?: boolean;
  notification?: boolean;
  permission?: NotificationPermission;
}): { register: ReturnType<typeof vi.fn> } {
  const { serviceWorker = true, pushManager = true, notification = true, permission = 'default' } = opts;
  const register = vi.fn();
  if (serviceWorker) {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register, getRegistration: vi.fn(async () => null) },
      configurable: true,
    });
  } else {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  }
  if (pushManager) {
    (window as unknown as Record<string, unknown>).PushManager = function PushManager() {};
  } else {
    delete (window as unknown as Record<string, unknown>).PushManager;
  }
  if (notification) {
    (window as unknown as Record<string, unknown>).Notification = { permission };
  } else {
    delete (window as unknown as Record<string, unknown>).Notification;
  }
  return { register };
}

async function renderResolved(
  vapidPublicKey: string | null = 'KEY',
  installHref: '/account' | '/settings' = '/account',
) {
  const utils = render(<PushDeviceControl vapidPublicKey={vapidPublicKey} installHref={installHref} />);
  // Classification runs in an effect; give it a tick to settle before assertions.
  await waitFor(() => expect(screen.queryByTestId('push-device-control-pending')).not.toBeInTheDocument());
  return utils;
}

describe('PushDeviceControl', () => {
  beforeEach(() => {
    support = 'installed';
    currentPushSubscriptionMock.mockReset();
    currentPushSubscriptionMock.mockResolvedValue(null);
    enablePushMock.mockReset();
    disablePushMock.mockReset();
    disablePushMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it('says push is unavailable and offers no button when there is no VAPID key', async () => {
    setBrowserCapabilities({});
    await renderResolved(null);
    expect(screen.getByText("Push notifications aren't available on this server yet.")).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each(['ios-safari', 'prompt'] as const)(
    'shows needs-install copy and a link to the install steps, no button, for install=%s',
    async (installSupport) => {
      support = installSupport;
      const { register } = setBrowserCapabilities({});
      await renderResolved('KEY', '/settings');
      expect(
        screen.getByText('Notifications arrive in the fair.yoga app. Add it to your home screen to turn them on.'),
      ).toBeInTheDocument();
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', '/settings');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(register).not.toHaveBeenCalled();
      expect(enablePushMock).not.toHaveBeenCalled();
    },
  );

  it.each(['/account', '/settings'] as const)(
    'links the install steps to the installHref prop (%s)',
    async (installHref) => {
      support = 'prompt';
      setBrowserCapabilities({});
      await renderResolved('KEY', installHref);
      expect(screen.getByRole('link')).toHaveAttribute('href', installHref);
    },
  );

  it('shows the needs-install copy with no link when the browser offers no install route', async () => {
    support = 'unsupported';
    setBrowserCapabilities({});
    await renderResolved();
    expect(
      screen.getByText('Notifications arrive in the fair.yoga app. Add it to your home screen to turn them on.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers Turn on for this phone when capable and not subscribed, and does not call enablePush on render', async () => {
    setBrowserCapabilities({ permission: 'default' });
    await renderResolved();
    expect(enablePushMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Turn on for this phone' })).toBeInTheDocument();
  });

  it('turns on: clicking calls enablePush(key) once and shows the on state', async () => {
    setBrowserCapabilities({ permission: 'default' });
    enablePushMock.mockResolvedValue('on');
    await renderResolved('KEY');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for this phone' }));
    await waitFor(() => expect(enablePushMock).toHaveBeenCalledTimes(1));
    expect(enablePushMock).toHaveBeenCalledWith('KEY');
    await screen.findByText('On for this phone');
    expect(screen.getByRole('button', { name: 'Turn off for this phone' })).toBeInTheDocument();
  });

  it('shows the blocked copy and no button when enablePush resolves blocked', async () => {
    setBrowserCapabilities({ permission: 'default' });
    enablePushMock.mockResolvedValue('blocked');
    await renderResolved();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for this phone' }));
    await screen.findByText(
      "Notifications for fair.yoga are blocked in this phone's settings. Allow them there to turn this on.",
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the off state and the button, shows the failure line, and retries on the next click', async () => {
    setBrowserCapabilities({ permission: 'default' });
    enablePushMock.mockResolvedValue('failed');
    await renderResolved();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for this phone' }));
    await screen.findByText("Notifications weren't turned on. Try again.");
    const button = screen.getByRole('button', { name: 'Turn on for this phone' });
    expect(button).toBeInTheDocument();
    expect(screen.getByText("Notifications weren't turned on. Try again.")).toHaveAttribute('role', 'alert');

    fireEvent.click(button);
    await waitFor(() => expect(enablePushMock).toHaveBeenCalledTimes(2));
  });

  it('turns off: clicking Turn off for this phone calls disablePush and returns to off', async () => {
    setBrowserCapabilities({ permission: 'granted' });
    currentPushSubscriptionMock.mockResolvedValue({ endpoint: 'https://push.example/x' });
    await renderResolved();
    await screen.findByText('On for this phone');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off for this phone' }));
    await waitFor(() => expect(disablePushMock).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Turn on for this phone' });
  });

  it('resolves past a rejected currentPushSubscription instead of staying on the placeholder', async () => {
    setBrowserCapabilities({ permission: 'default' });
    currentPushSubscriptionMock.mockRejectedValue(new Error('getRegistration failed'));
    await renderResolved();
    // Falls back to `subscribed: false`; capable + unsubscribed + default
    // permission classifies to the off state, proving the effect finished
    // rather than hanging on the placeholder forever.
    expect(screen.getByRole('button', { name: 'Turn on for this phone' })).toBeInTheDocument();
  });
});
