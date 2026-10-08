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

  it('keeps the button for another try after the server says it was busy, saying nothing was paused', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    stubFetch(() => respond(503, { error: { message: 'The system was busy and could not finish that. Please try again.' } }));
    render(<PayoutPauseForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong, and nothing was paused. Please try again.');
    expect(screen.getByRole('button', { name: 'Pause payments' })).toBeEnabled();
    expect(window.location.hash).toBe(`#t=${TOKEN}`);
  });

  // Nothing the app answered says what happened: a gateway, a proxy's own
  // page, an uncoded refusal or no answer at all.
  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 502', () => new Response('<html>Bad Gateway</html>', { status: 502 })],
    ['a 504', () => new Response('<html>Gateway Timeout</html>', { status: 504 })],
    ['a 503 that is not the app\'s', () => new Response('<html>Service Unavailable</html>', { status: 503 })],
    ['a 500', () => respond(500, { error: { message: 'Internal server error' } })],
    ['an uncoded 404', () => respond(404, { error: { message: 'nope' } })],
  ] as const)('says how to check, claiming nothing, after %s', async (_case, answer) => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    stubFetch(answer);
    render(<PayoutPauseForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/couldn.t confirm whether payments were paused/);
    expect(alert).toHaveTextContent('To check, press Pause payments again');
    expect(alert).not.toHaveTextContent('nothing was paused');
    expect(alert).not.toHaveTextContent('Nothing was paused');
    expect(alert).not.toHaveTextContent('went through');
    expect(screen.getByRole('button', { name: 'Pause payments' })).toBeEnabled();
  });

  it('after an unconfirmed attempt, reads a used link as something to check, not as a pause', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    const fetchMock = stubFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    render(<PayoutPauseForm />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();
    fetchMock.mockImplementation(async () => respond(404, { error: { code: 'PAUSE_LINK_INVALID', message: 'x' } }));

    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }));
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This link has already been used, perhaps by your earlier attempt.');
    expect(alert).toHaveTextContent('sign in');
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

  it('asks for the link to be opened again, not retried, on a coded refusal', async () => {
    window.history.replaceState(null, '', `/payout-pause#t=${TOKEN}`);
    stubFetch(() => respond(403, { error: { code: 'CROSS_ORIGIN', message: 'nope' } }));
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
