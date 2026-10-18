import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerReplace } from '../../../tests/setup/components';
import { EXCLUSION_COPY } from '@/lib/processor-methods';
import type { ConnectionView } from '@/services/processor-connection';
import { MollieConnectionSection } from './mollie-connection-section';

const realLocation = window.location;
const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { value: realLocation, writable: true });
});

const PROFILES = [{ id: 'pfl_one', name: 'Studio Anna' }, { id: 'pfl_two', name: 'Retreats' }];
const CONNECTED: Extract<ConnectionView, { kind: 'connected' }> = {
  kind: 'connected', organizationName: 'Anna Yoga', profileId: 'pfl_one', profileName: 'Studio Anna', testmode: false,
  profiles: [PROFILES[0]!], offered: ['ideal', 'creditcard'], excluded: ['klarna', 'paypal'], missingScopes: [],
};

function show(view: ConnectionView, opts: { status?: Parameters<typeof MollieConnectionSection>[0]['status'] } = {}) {
  vi.stubGlobal('fetch', fetchMock);
  return render(<MollieConnectionSection teacherId="t1" view={view} status={opts.status ?? null} />);
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe('MollieConnectionSection', () => {
  it('offers to connect, POSTs the connect and sends the browser to Mollie', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    fetchMock.mockResolvedValue(ok({ authorizeUrl: 'https://my.mollie.com/oauth2/authorize?state=x' }));
    show({ kind: 'none' });
    expect(screen.getByText(/Let students pay you by iDEAL, card and more through your own Mollie account/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Mollie' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://my.mollie.com/oauth2/authorize?state=x'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/teachers/t1/processor/connect');
    expect(init.method).toBe('POST');
  });

  it('shows a refusal to start beside the button', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Mollie isn’t available right now.', code: 'PROCESSOR_UNAVAILABLE' } }), { status: 503 }));
    show({ kind: 'none' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Mollie' }));
    expect(await screen.findByText('Mollie isn’t available right now.')).toBeInTheDocument();
  });

  it('asks which profile to use and PUTs the choice', async () => {
    fetchMock.mockResolvedValue(ok({ profileId: 'pfl_two' }));
    show({ kind: 'choose_profile', profiles: PROFILES });
    fireEvent.click(screen.getByLabelText('Retreats'));
    fireEvent.click(screen.getByRole('button', { name: 'Use this profile' }));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/settings/profile'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/teachers/t1/processor/profile');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ profileId: 'pfl_two' });
  });

  it('says to create a profile first when Mollie lists none, and offers to connect again', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    fetchMock.mockResolvedValue(ok({ authorizeUrl: 'https://my.mollie.com/again' }));
    show({ kind: 'choose_profile', profiles: [] });
    expect(screen.getByText(/Create a website profile in Mollie first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this profile' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect Mollie' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect again' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://my.mollie.com/again'));
  });

  it('describes a connection: who, the methods students see, the ones left out and why, and the fees', () => {
    show(CONNECTED);
    expect(screen.getByText('Mollie connected — Anna Yoga · Studio Anna')).toBeInTheDocument();
    expect(screen.getByText('iDEAL')).toBeInTheDocument();
    expect(screen.getByText('Card')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Not offered' })).toBeInTheDocument();
    expect(screen.getByText('klarna')).toBeInTheDocument();
    expect(screen.getByText(EXCLUSION_COPY.pay_later)).toBeInTheDocument();
    expect(screen.getByText(EXCLUSION_COPY.not_offered)).toBeInTheDocument();
    expect(screen.getByText('Mollie deducts its fees from each payment; you see the net amount in Mollie.')).toBeInTheDocument();
    expect(screen.queryByText('Test mode')).toBeNull();
    expect(screen.queryByText(/Wero payments can be disputed/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change profile' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect Mollie' })).toBeInTheDocument();
  });

  it('marks test mode and notes Wero’s dispute window when Wero is offered', () => {
    show({ ...CONNECTED, testmode: true, offered: ['ideal', 'wero'] });
    expect(screen.getByText('Test mode')).toBeInTheDocument();
    expect(screen.getByText('Wero payments can be disputed for up to 120 days.')).toBeInTheDocument();
  });

  it('lets a teacher with several profiles switch, saying where payments then go', async () => {
    fetchMock.mockResolvedValue(ok({ profileId: 'pfl_two' }));
    show({ ...CONNECTED, profiles: PROFILES });
    fireEvent.click(screen.getByRole('button', { name: 'Change profile' }));
    expect(screen.getByText(/Payments then go to that profile’s Mollie balance/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Retreats'));
    fireEvent.click(screen.getByRole('button', { name: 'Use this profile' }));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/settings/profile'));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ profileId: 'pfl_two' });
  });

  it('asks a narrower grant to reconnect, and lists no methods', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    fetchMock.mockResolvedValue(ok({ authorizeUrl: 'https://my.mollie.com/x' }));
    show({ ...CONNECTED, offered: [], excluded: [], missingScopes: ['refunds.write'] });
    expect(screen.getByText('Reconnect Mollie to enable payments.')).toBeInTheDocument();
    expect(screen.queryByText('iDEAL')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Mollie' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://my.mollie.com/x'));
  });

  it('disconnects after a confirmation, dropping the return status from the URL', async () => {
    fetchMock.mockResolvedValue(ok({ connected: false }));
    show(CONNECTED, { status: 'connected' });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Mollie' }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/settings/profile'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/teachers/t1/processor');
    expect(init.method).toBe('DELETE');
  });

  it('says when Mollie cannot be reached and offers Reconnect beside Disconnect', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    fetchMock.mockResolvedValue(ok({ authorizeUrl: 'https://my.mollie.com/re' }));
    show({ kind: 'unavailable' });
    expect(screen.getByText('Mollie can’t be reached right now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect Mollie' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://my.mollie.com/re'));
  });

  it('focuses the confirmation’s Disconnect, which the question describes, and Cancel hands focus back', () => {
    show(CONNECTED);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Mollie' }));
    const confirm = screen.getByRole('button', { name: 'Disconnect' });
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAccessibleDescription(/Disconnect Mollie\? Students will see your other payment options/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Disconnect Mollie' })).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('moves focus to the section heading once disconnected', async () => {
    fetchMock.mockResolvedValue(ok({ connected: false }));
    show(CONNECTED);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Mollie' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Mollie' })).toHaveFocus());
  });

  it('focuses the current profile on Change profile, and Cancel hands focus back', () => {
    show({ ...CONNECTED, profiles: PROFILES });
    fireEvent.click(screen.getByRole('button', { name: 'Change profile' }));
    expect(screen.getByLabelText('Studio Anna')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Change profile' })).toHaveFocus();
  });

  it('gives its text triggers a 44px tap height', () => {
    show({ ...CONNECTED, profiles: PROFILES });
    expect(screen.getByRole('button', { name: 'Disconnect Mollie' })).toHaveClass('min-h-11');
  });

  it.each([
    ['connected', 'Mollie is connected.', 'text-teal'],
    ['choose', 'Choose which Mollie profile students’ payments go to.', 'text-teal'],
    ['expired', 'That Mollie sign-in link expired. Connect again.', 'text-brown'],
    ['cancelled', 'Connecting Mollie was cancelled.', 'text-brown'],
    ['unavailable', 'Mollie couldn’t be reached. Try connecting again in a moment.', 'text-brown'],
  ] as const)('shows one status line on return: %s', (status, text, colour) => {
    show({ kind: 'none' }, { status });
    expect(screen.getByText(text)).toHaveClass(colour);
  });
});
