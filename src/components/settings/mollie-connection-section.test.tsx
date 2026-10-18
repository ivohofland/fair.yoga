import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
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

function show(view: ConnectionView, opts: { configured?: boolean; status?: Parameters<typeof MollieConnectionSection>[0]['status'] } = {}) {
  vi.stubGlobal('fetch', fetchMock);
  return render(<MollieConnectionSection teacherId="t1" configured={opts.configured ?? true} view={view} status={opts.status ?? null} />);
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe('MollieConnectionSection', () => {
  it('renders nothing when Mollie is not configured', () => {
    const { container } = show({ kind: 'none' }, { configured: false });
    expect(container).toBeEmptyDOMElement();
  });

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
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/teachers/t1/processor/profile');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ profileId: 'pfl_two' });
  });

  it('says to create a profile first when Mollie lists none', () => {
    show({ kind: 'choose_profile', profiles: [] });
    expect(screen.getByText(/Create a website profile in Mollie first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this profile' })).toBeNull();
  });

  it('describes a connection: who, the methods students see, the ones left out and why, and the fees', () => {
    show(CONNECTED);
    expect(screen.getByText('Mollie connected — Anna Yoga · Studio Anna')).toBeInTheDocument();
    expect(screen.getByText('iDEAL')).toBeInTheDocument();
    expect(screen.getByText('Card')).toBeInTheDocument();
    expect(screen.getByText('klarna')).toBeInTheDocument();
    expect(screen.getByText(EXCLUSION_COPY.pay_later)).toBeInTheDocument();
    expect(screen.getByText(EXCLUSION_COPY.not_offered)).toBeInTheDocument();
    expect(screen.getByText('Mollie deducts its fees from each payment; you see the net amount in Mollie.')).toBeInTheDocument();
    expect(screen.queryByText('Test mode')).toBeNull();
    expect(screen.queryByText(/Wero payments can be disputed/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change profile' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
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
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
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

  it('disconnects after a confirmation', async () => {
    fetchMock.mockResolvedValue(ok({ connected: false }));
    show(CONNECTED);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Mollie' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/teachers/t1/processor');
    expect(init.method).toBe('DELETE');
  });

  it('says when Mollie cannot be reached and still offers Disconnect', () => {
    show({ kind: 'unavailable' });
    expect(screen.getByText('Mollie can’t be reached right now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it.each([
    ['connected', 'Mollie is connected.'],
    ['choose', 'Choose which Mollie profile students’ payments go to.'],
    ['expired', 'That Mollie sign-in link expired. Connect again.'],
    ['cancelled', 'Connecting Mollie was cancelled.'],
    ['unavailable', 'Mollie couldn’t be reached. Try connecting again in a moment.'],
  ] as const)('shows one status line on return: %s', (status, text) => {
    show({ kind: 'none' }, { status });
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
