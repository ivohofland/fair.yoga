import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PayoutPauseForm } from './payout-pause-form';

const TOKEN = 'a'.repeat(64);

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('PayoutPauseForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('posts nothing on load, even with a token in the fragment', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    const fetchMock = stubFetch(() => respond(200, { data: { paused: true } }));

    render(<PayoutPauseForm />);
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pause payments' })).toBeEnabled();
  });

  it('posts the fragment\'s token on the button, then confirms and drops it from the address', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    const fetchMock = stubFetch(() => respond(200, { data: { paused: true } }));
    render(<PayoutPauseForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/payout-pause');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ token: TOKEN });
    expect(screen.getByRole('status')).toHaveTextContent('Payments are paused');
    expect(screen.queryByRole('button', { name: 'Pause payments' })).not.toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('says the link no longer works on PAUSE_LINK_INVALID', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    stubFetch(() => respond(404, { error: { code: 'PAUSE_LINK_INVALID', message: 'x' } }));
    render(<PayoutPauseForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('This link no longer works');
    expect(screen.queryByRole('button', { name: 'Pause payments' })).not.toBeInTheDocument();
  });

  it('keeps the button for another try after a server failure, saying nothing was paused', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    stubFetch(() => respond(503, { error: { message: 'busy' } }));
    render(<PayoutPauseForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong, and nothing was paused. Please try again.');
    expect(screen.getByRole('button', { name: 'Pause payments' })).toBeEnabled();
    expect(window.location.hash).toBe(`#t=${TOKEN}`);
  });

  it('says the outcome is unknown, and how to tell, when the response is lost', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<PayoutPauseForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t tell whether payments were paused/);
    expect(screen.getByRole('alert')).toHaveTextContent('no longer works');
    expect(screen.getByRole('alert')).not.toHaveTextContent('nothing was paused');
    expect(screen.getByRole('button', { name: 'Pause payments' })).toBeEnabled();
  });

  it('reads a used link after a lost response as the earlier attempt having paused', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    const fetchMock = stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<PayoutPauseForm />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();
    fetchMock.mockImplementation(async () => respond(404, { error: { code: 'PAUSE_LINK_INVALID', message: 'x' } }));

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('your earlier attempt most likely paused payments');
  });

  it('confirms the pause even when the address cannot be rewritten', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    stubFetch(() => respond(200, { data: { paused: true } }));
    render(<PayoutPauseForm />);
    await settle();
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    expect(screen.getByRole('status')).toHaveTextContent('Payments are paused');
  });

  it.each([400, 403, 404])('asks for the link to be opened again, not retried, on an uncoded %s', async (status) => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    stubFetch(() => respond(status, { error: { message: 'nope' } }));
    render(<PayoutPauseForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was paused. Open the link from the email again');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Please try again');
  });

  it('asks for a wait on 429', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    stubFetch(() => respond(429, { error: { message: 'Too many attempts.' } }));
    render(<PayoutPauseForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Too many attempts from here');
  });

  it('offers no button when the address carries no token', async () => {
    window.history.replaceState(null, '', '/payout-pause');
    const fetchMock = stubFetch(() => respond(200, {}));
    render(<PayoutPauseForm />);
    await settle();

    expect(screen.queryByRole('button', { name: 'Pause payments' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This link is incomplete');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
