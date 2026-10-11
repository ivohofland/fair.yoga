import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PushDeviceState } from '@/lib/push-client';
import { routerRefresh } from '../../../tests/setup/components';

let coarse = true;
vi.mock('@/components/layout/install-store', () => ({
  useCoarsePointer: () => coarse,
}));

let device: { state: PushDeviceState | null; permission: NotificationPermission | null } = { state: 'off', permission: 'default' };
let hookArgs: unknown[] = [];
vi.mock('@/components/settings/use-push-device', () => ({
  usePushDevice: (...args: unknown[]) => {
    hookArgs = args;
    return { ...device, notice: null, setState: vi.fn(), setNotice: vi.fn() };
  },
}));

const enablePushMock = vi.fn<(vapidPublicKey: string) => Promise<'on' | 'blocked' | 'failed'>>();
vi.mock('@/lib/push-client', () => ({
  enablePush: (key: string) => enablePushMock(key),
}));

import { StudentPushCard } from './push-card';

/** Every `PushDeviceState`, tethered so a new member must be added here. */
const STATES = Object.keys({
  unsupported: true,
  'needs-install': true,
  off: true,
  on: true,
  blocked: true,
  unavailable: true,
} satisfies Record<PushDeviceState, true>) as PushDeviceState[];
const PERMISSIONS: (NotificationPermission | null)[] = ['default', 'granted', 'denied', null];

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<{ ok: boolean }>>();

describe('StudentPushCard', () => {
  beforeEach(() => {
    coarse = true;
    device = { state: 'off', permission: 'default' };
    hookArgs = [];
    enablePushMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('renders only for an off, never-asked phone that has not dismissed it', () => {
    const cases = [null, ...STATES].flatMap((state) =>
      PERMISSIONS.flatMap((permission) =>
        [true, false].flatMap((isCoarse) => [true, false].map((dismissed) => ({ state, permission, isCoarse, dismissed }))),
      ),
    );
    it.each(cases)('state=$state permission=$permission coarse=$isCoarse dismissed=$dismissed', ({ state, permission, isCoarse, dismissed }) => {
      device = { state, permission };
      coarse = isCoarse;
      const { container } = render(<StudentPushCard dismissed={dismissed} vapidPublicKey="KEY" />);
      const shown = state === 'off' && permission === 'default' && isCoarse && !dismissed;
      if (shown) expect(screen.getByRole('heading', { name: 'Get notifications on this phone' })).toBeInTheDocument();
      else expect(container).toBeEmptyDOMElement();
    });
  });

  it('resolves the device with the page\'s key and never re-records it', () => {
    render(<StudentPushCard dismissed={false} vapidPublicKey="KEY" />);
    expect(hookArgs).toEqual(['KEY', { resync: false }]);
  });

  it('renders nothing without a VAPID key, even for a device reported off and never asked', () => {
    const { container } = render(<StudentPushCard dismissed={false} vapidPublicKey={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links the message choice to the notification settings', () => {
    render(<StudentPushCard dismissed={false} vapidPublicKey="KEY" />);
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/account/notifications');
  });

  it.each(['on', 'blocked'] as const)('disappears once turning on answers %s', async (outcome) => {
    enablePushMock.mockResolvedValue(outcome);
    const { container } = render(<StudentPushCard dismissed={false} vapidPublicKey="KEY" />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(enablePushMock).toHaveBeenCalledWith('KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays, with a retry line, when turning on fails', async () => {
    enablePushMock.mockResolvedValue('failed');
    render(<StudentPushCard dismissed={false} vapidPublicKey="KEY" />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Notifications weren't turned on. Try again.");
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeEnabled();
  });

  it('asks once on a double tap', async () => {
    let finish: (value: 'on') => void = () => {};
    enablePushMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<StudentPushCard dismissed={false} vapidPublicKey="KEY" />);
    const button = screen.getByRole('button', { name: 'Turn on' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(enablePushMock).toHaveBeenCalledTimes(1);
    finish('on');
    await waitFor(() => expect(enablePushMock).toHaveBeenCalledTimes(1));
  });

  it('says what the student will be told, exactly', () => {
    const { container } = render(<StudentPushCard dismissed={false} vapidPublicKey="KEY" />);
    expect(container).toHaveTextContent(
      'A heads-up when a waitlist spot opens for you or a class you booked is cancelled. Booking emails still come as they do now \u2014 you choose which messages in Settings.',
    );
  });

  it('records the card as dismissed and refreshes on Dismiss', async () => {
    render(<StudentPushCard dismissed={false} vapidPublicKey="KEY" />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the notifications card' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/account/student-push-card', expect.objectContaining({ method: 'POST' }));
  });

  it('keeps Dismiss enabled and does not refresh when the request throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('offline'));
    render(<StudentPushCard dismissed={false} vapidPublicKey="KEY" />);
    const button = screen.getByRole('button', { name: 'Dismiss the notifications card' });
    fireEvent.click(button);
    await waitFor(() => expect(error).toHaveBeenCalled());
    await waitFor(() => expect(button).toBeEnabled());
    expect(routerRefresh).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('keeps Dismiss enabled and does not refresh when the server refuses', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as never);
    render(<StudentPushCard dismissed={false} vapidPublicKey="KEY" />);
    const button = screen.getByRole('button', { name: 'Dismiss the notifications card' });
    fireEvent.click(button);
    await waitFor(() => expect(error).toHaveBeenCalledWith('[student-push-card] refused', { status: 500 }));
    await waitFor(() => expect(button).toBeEnabled());
    expect(routerRefresh).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
