import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const startRegistration = vi.hoisted(() => vi.fn());
vi.mock('@simplewebauthn/browser', () => ({ startRegistration }));

const clearOfflinePages = vi.hoisted(() => vi.fn());
vi.mock('@/lib/offline-client', () => ({ clearOfflinePages }));

const disablePush = vi.hoisted(() => vi.fn());
vi.mock('@/lib/push-client', () => ({
  disablePush,
  recordPushDeviceBeforeNavigation: vi.fn(async () => {}),
}));

import { AccountSecurity } from './account-security';

function domError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

interface Row {
  id: string;
  createdAt: string;
  transports: string[];
}

const ROW_A: Row = { id: 'pk-a', createdAt: '2026-10-01T09:00:00.000Z', transports: ['internal'] };
const ROW_B: Row = { id: 'pk-b', createdAt: '2026-09-01T09:00:00.000Z', transports: [] };

function ok(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as Response;
}
function refusal(status: number, code: string, message = 'refused'): Response {
  return { ok: false, status, url: 'x', json: async () => ({ error: { code, message } }) } as Response;
}

// A refusal that names no registered code, as a 401 from the auth gate does.
function bare(status: number): Response {
  return { ok: false, status, url: 'x', json: async () => ({ error: 'Authentication required' }) } as Response;
}

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

const order: string[] = [];

function arrange(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unrouted fetch: ${key}`);
    order.push(key);
    return handler(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const assign = vi.fn();

function renderIt() {
  return render(<AccountSecurity email="ada@example.test" redirectPath="/settings/profile" />);
}

describe('AccountSecurity', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  const realLocation = window.location;

  beforeEach(() => {
    order.length = 0;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    clearOfflinePages.mockImplementation(async () => {
      order.push('clearOfflinePages');
    });
    disablePush.mockImplementation(async () => {
      order.push('disablePush');
      return 'off';
    });
    assign.mockImplementation((url: string) => {
      order.push(`navigate ${url}`);
    });
    Object.defineProperty(window, 'location', { configurable: true, value: { assign } });
  });

  afterEach(() => {
    startRegistration.mockReset();
    clearOfflinePages.mockReset();
    disablePush.mockReset();
    assign.mockReset();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists the account\'s passkeys in the order served, each with Remove', async () => {
    arrange({ 'GET /api/auth/passkey': () => ok([ROW_A, ROW_B]) });
    renderIt();

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Passkey added 1 Oct 2026');
    expect(items[1]).toHaveTextContent('Passkey added 1 Sep 2026');
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
  });

  it('names a failed load in an alert and logs it', async () => {
    arrange({ 'GET /api/auth/passkey': () => refusal(500, 'INTERNAL_ERROR', 'boom') });
    renderIt();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your passkeys.');
    expect(consoleError).toHaveBeenCalled();
  });

  it('removes a passkey only after an inline confirm, then refreshes the list', async () => {
    let rows = [ROW_A, ROW_B];
    const fetchMock = arrange({
      'GET /api/auth/passkey': () => ok(rows),
      'DELETE /api/auth/passkey/pk-a': () => {
        rows = [ROW_B];
        return ok({ removed: true });
      },
    });
    renderIt();
    const [first] = await screen.findAllByRole('listitem');
    if (!first) throw new Error('no row');

    fireEvent.click(within(first).getByRole('button', { name: 'Remove' }));
    expect(fetchMock).not.toHaveBeenCalledWith('/api/auth/passkey/pk-a', expect.anything());
    fireEvent.click(within(first).getByRole('button', { name: 'Yes, remove' }));

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByRole('listitem')).toHaveTextContent('1 Sep 2026');
  });

  it('cancelling the confirm removes nothing', async () => {
    const fetchMock = arrange({ 'GET /api/auth/passkey': () => ok([ROW_A]) });
    renderIt();
    const row = await screen.findByRole('listitem');

    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Keep it' }));

    expect(within(row).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed remove is an alert and is logged', async () => {
    arrange({
      'GET /api/auth/passkey': () => ok([ROW_A]),
      'DELETE /api/auth/passkey/pk-a': () => refusal(500, 'INTERNAL_ERROR', 'nope'),
    });
    renderIt();
    const row = await screen.findByRole('listitem');

    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Yes, remove' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove that passkey.');
    expect(consoleError).toHaveBeenCalled();
  });

  it('a remove answered 404 (already gone in another tab) refreshes the list with no alert', async () => {
    let rows = [ROW_A, ROW_B];
    arrange({
      'GET /api/auth/passkey': () => ok(rows),
      'DELETE /api/auth/passkey/pk-a': () => {
        rows = [ROW_B];
        return refusal(404, 'NOT_FOUND', 'gone');
      },
    });
    renderIt();
    const [first] = await screen.findAllByRole('listitem');
    if (!first) throw new Error('no row');

    fireEvent.click(within(first).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(first).getByRole('button', { name: 'Yes, remove' }));

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a remove answered with a bare 404 (no registered code) is an error, not "already gone"', async () => {
    arrange({
      'GET /api/auth/passkey': () => ok([ROW_A]),
      'DELETE /api/auth/passkey/pk-a': () =>
        bare(404),
    });
    renderIt();
    const row = await screen.findByRole('listitem');

    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Yes, remove' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove that passkey.');
  });

  it('a remove answered 401 tells the person to sign in again', async () => {
    arrange({
      'GET /api/auth/passkey': () => ok([ROW_A]),
      'DELETE /api/auth/passkey/pk-a': () => bare(401),
    });
    renderIt();
    const row = await screen.findByRole('listitem');

    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Yes, remove' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has ended — sign in again.');
  });

  it('adding a passkey sends the attestation, confirms, and refreshes the list', async () => {
    let rows: Row[] = [];
    const fetchMock = arrange({
      'GET /api/auth/passkey': () => ok(rows),
      'POST /api/auth/passkey/register/options': () => ok({ challenge: 'c' }),
      'POST /api/auth/passkey/register/verify': () => {
        rows = [ROW_A];
        return ok({ verified: true });
      },
    });
    startRegistration.mockResolvedValue({ id: 'att' });
    renderIt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }));

    expect(await screen.findByText(/Passkey added — next sign-in is one tap/)).toBeInTheDocument();
    expect(await screen.findByRole('listitem')).toHaveTextContent('1 Oct 2026');
    const verify = fetchMock.mock.calls.find(([u]) => u === '/api/auth/passkey/register/verify');
    expect(JSON.parse(String(verify?.[1]?.body))).toEqual({ response: { id: 'att' } });
  });

  it('logs why when the ceremony fails, and tells the user', async () => {
    arrange({
      'GET /api/auth/passkey': () => ok([]),
      'POST /api/auth/passkey/register/options': () => ok({}),
    });
    const boom = domError('SecurityError');
    startRegistration.mockRejectedValue(boom);
    renderIt();

    fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add a passkey on this device.');
    expect(consoleError).toHaveBeenCalledWith('[account-security] request failed', { step: 'add', err: boom });
  });

  it('does not log when the user dismisses the prompt', async () => {
    arrange({
      'GET /api/auth/passkey': () => ok([]),
      'POST /api/auth/passkey/register/options': () => ok({}),
    });
    startRegistration.mockRejectedValue(domError('NotAllowedError'));
    renderIt();

    fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));

    await waitFor(() => expect(startRegistration).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a passkey' })).toBeEnabled());
    expect(consoleError).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a device that already holds the passkey counts as added', async () => {
    arrange({
      'GET /api/auth/passkey': () => ok([ROW_A]),
      'POST /api/auth/passkey/register/options': () => ok({}),
    });
    startRegistration.mockRejectedValue(domError('InvalidStateError'));
    renderIt();

    fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));

    expect(await screen.findByText(/Passkey added — next sign-in/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('step-up', () => {
    it('RECENT_AUTH_REQUIRED from options explains and offers a sign-in link, sent to the account address and back to this page', async () => {
      const fetchMock = arrange({
        'GET /api/auth/passkey': () => ok([]),
        'POST /api/auth/passkey/register/options': () => refusal(403, 'RECENT_AUTH_REQUIRED'),
        'POST /api/auth/magic-link/send': () => ok({ sent: true }),
      });
      renderIt();

      fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));

      expect(await screen.findByText(/sign in again/i)).toBeInTheDocument();
      expect(startRegistration).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));

      expect(await screen.findByText(/Check ada@example\.test/)).toBeInTheDocument();
      // A link opened on another device shows a code; this is where it is typed.
      expect(screen.getByLabelText('Code')).toBeInTheDocument();
      const send = fetchMock.mock.calls.find(([u]) => u === '/api/auth/magic-link/send');
      expect(send?.[1]?.method).toBe('POST');
      expect(JSON.parse(String(send?.[1]?.body))).toEqual({
        email: 'ada@example.test',
        redirect: '/settings/profile',
      });
    });

    it('RECENT_AUTH_REQUIRED from verify offers the same step-up', async () => {
      arrange({
        'GET /api/auth/passkey': () => ok([]),
        'POST /api/auth/passkey/register/options': () => ok({}),
        'POST /api/auth/passkey/register/verify': () => refusal(403, 'RECENT_AUTH_REQUIRED'),
      });
      startRegistration.mockResolvedValue({ id: 'att' });
      renderIt();

      fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));

      expect(await screen.findByRole('button', { name: 'Email me a sign-in link' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('the send-link button is disabled while the send is in flight', async () => {
      let release: (r: Response) => void = () => {};
      arrange({
        'GET /api/auth/passkey': () => ok([]),
        'POST /api/auth/passkey/register/options': () => refusal(403, 'RECENT_AUTH_REQUIRED'),
        'POST /api/auth/magic-link/send': () => new Promise<Response>((resolve) => (release = resolve)),
      });
      renderIt();
      fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Email me a sign-in link' }));

      expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled();
      release(ok({ sent: true }));
      expect(await screen.findByText(/Check ada@example\.test/)).toBeInTheDocument();
    });

    it('a refused link send is an alert and is logged', async () => {
      arrange({
        'GET /api/auth/passkey': () => ok([]),
        'POST /api/auth/passkey/register/options': () => refusal(403, 'RECENT_AUTH_REQUIRED'),
        'POST /api/auth/magic-link/send': () => refusal(429, 'RATE_LIMITED', 'slow down'),
      });
      renderIt();
      fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Email me a sign-in link' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not send the sign-in link.');
      expect(consoleError).toHaveBeenCalled();
    });

    it('any other refusal from options is the generic alert, not the step-up', async () => {
      arrange({
        'GET /api/auth/passkey': () => ok([]),
        'POST /api/auth/passkey/register/options': () => refusal(500, 'INTERNAL_ERROR'),
      });
      renderIt();

      fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not add a passkey on this device.');
      expect(screen.queryByRole('button', { name: 'Email me a sign-in link' })).not.toBeInTheDocument();
    });
  });

  describe('sign out everywhere', () => {
    it('ends every session, then clears the offline pages, then navigates to /login', async () => {
      arrange({
        'GET /api/auth/passkey': () => ok([]),
        'DELETE /api/auth/session/all': () => ok({ signedOut: true }),
      });
      renderIt();

      fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
      expect(order.slice(-4)).toEqual([
        'disablePush',
        'DELETE /api/auth/session/all',
        'clearOfflinePages',
        'navigate /login',
      ]);
    });

    it('a failed push teardown is logged and the DELETE still goes', async () => {
      disablePush.mockRejectedValue(new Error('sw gone'));
      arrange({
        'GET /api/auth/passkey': () => ok([]),
        'DELETE /api/auth/session/all': () => ok({ signedOut: true }),
      });
      renderIt();

      fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
      expect(order).toContain('DELETE /api/auth/session/all');
      expect(consoleError).toHaveBeenCalled();
    });

    it('a push teardown stuck past 3 seconds does not hold back the DELETE', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        disablePush.mockImplementation(() => new Promise(() => {}));
        arrange({
          'GET /api/auth/passkey': () => ok([]),
          'DELETE /api/auth/session/all': () => ok({ signedOut: true }),
        });
        renderIt();

        fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
        expect(order).not.toContain('DELETE /api/auth/session/all');
        await vi.advanceTimersByTimeAsync(3_100);

        await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
        expect(order).toContain('DELETE /api/auth/session/all');
      } finally {
        vi.useRealTimers();
      }
    });

    it('the DELETE is not sent before a slow push teardown settles', async () => {
      let finishPush: () => void = () => {};
      disablePush.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishPush = () => {
              order.push('disablePush');
              resolve('off');
            };
          }),
      );
      arrange({
        'GET /api/auth/passkey': () => ok([]),
        'DELETE /api/auth/session/all': () => ok({ signedOut: true }),
      });
      renderIt();

      fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
      await waitFor(() => expect(disablePush).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 50));
      expect(order).not.toContain('DELETE /api/auth/session/all');

      finishPush();

      await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
      expect(order.indexOf('disablePush')).toBeLessThan(order.indexOf('DELETE /api/auth/session/all'));
    });

    it('a 401 on the DELETE means the session is already gone: it still clears pages and navigates, with no alert', async () => {
      arrange({
        'GET /api/auth/passkey': () => ok([]),
        'DELETE /api/auth/session/all': () => bare(401),
      });
      renderIt();

      fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
      expect(order.slice(-4)).toEqual([
        'disablePush',
        'DELETE /api/auth/session/all',
        'clearOfflinePages',
        'navigate /login',
      ]);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('navigates even when clearing the offline pages rejects', async () => {
      clearOfflinePages.mockRejectedValue(new Error('cache api gone'));
      arrange({
        'GET /api/auth/passkey': () => ok([]),
        'DELETE /api/auth/session/all': () => ok({ signedOut: true }),
      });
      renderIt();

      fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
      expect(consoleError).toHaveBeenCalled();
    });

    it('a failed DELETE is an alert, leaves the pages alone and does not navigate', async () => {
      arrange({
        'GET /api/auth/passkey': () => ok([]),
        'DELETE /api/auth/session/all': () => refusal(500, 'INTERNAL_ERROR'),
      });
      renderIt();

      fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out everywhere');
      expect(clearOfflinePages).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
    });
  });
});
