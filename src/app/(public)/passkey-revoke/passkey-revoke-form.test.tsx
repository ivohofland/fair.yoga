import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PasskeyRevokeForm } from './passkey-revoke-form';

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

describe('PasskeyRevokeForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('posts nothing on load, even with a token in the fragment', async () => {
    window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
    const fetchMock = stubFetch(() => respond(200, { data: { revoked: true } }));

    render(<PasskeyRevokeForm />);
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: "This wasn't me" })).toBeEnabled();
  });

  it('posts the fragment\'s token on the button, confirms and drops it from the address', async () => {
    window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
    const fetchMock = stubFetch(() => respond(200, { data: { revoked: true } }));
    render(<PasskeyRevokeForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/passkey-revoke');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ token: TOKEN });
    expect(screen.getByRole('status')).toHaveTextContent('Every device has been signed out');
    expect(screen.queryByRole('button', { name: "This wasn't me" })).not.toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('says the link no longer works on REVOKE_LINK_INVALID', async () => {
    window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
    stubFetch(() => respond(404, { error: { code: 'REVOKE_LINK_INVALID', message: 'x' } }));
    render(<PasskeyRevokeForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('This link no longer works');
    expect(screen.queryByRole('button', { name: "This wasn't me" })).not.toBeInTheDocument();
  });

  it('keeps the button for another try after the server says it was busy, saying you were not signed out', async () => {
    window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
    stubFetch(() => respond(503, { error: { message: 'The system was busy and could not finish that. Please try again.' } }));
    render(<PasskeyRevokeForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong, and you were not signed out. Please try again.');
    expect(screen.getByRole('button', { name: "This wasn't me" })).toBeEnabled();
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
    window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
    stubFetch(answer);
    render(<PasskeyRevokeForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/couldn.t confirm that you were signed out/);
    expect(alert).toHaveTextContent("To check, press This wasn't me again");
    expect(alert).not.toHaveTextContent('not signed out');
    expect(alert).not.toHaveTextContent('Nothing was signed out');
    expect(alert).not.toHaveTextContent('went through');
    expect(screen.getByRole('button', { name: "This wasn't me" })).toBeEnabled();
  });

  it('after an unconfirmed attempt, reads a used link as something to check, not as a sign-out', async () => {
    window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
    const fetchMock = stubFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    render(<PasskeyRevokeForm />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
    await settle();
    fetchMock.mockImplementation(async () => respond(404, { error: { code: 'REVOKE_LINK_INVALID', message: 'x' } }));

    fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This link has already been used, perhaps by your earlier attempt.');
    expect(alert).toHaveTextContent('sign in');
  });

  it('confirms the sign-out even when the address cannot be rewritten', async () => {
    window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
    stubFetch(() => respond(200, { data: { revoked: true } }));
    render(<PasskeyRevokeForm />);
    await settle();
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
    await settle();

    expect(screen.getByRole('status')).toHaveTextContent('Every device has been signed out');
  });

  it('asks for the link to be opened again, not retried, on a coded refusal', async () => {
    window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
    stubFetch(() => respond(403, { error: { code: 'CROSS_ORIGIN', message: 'nope' } }));
    render(<PasskeyRevokeForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was signed out. Open the link from the email again');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Please try again');
  });

  it('asks for a wait on 429', async () => {
    window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
    stubFetch(() => respond(429, { error: { message: 'Too many attempts.' } }));
    render(<PasskeyRevokeForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Too many attempts from here');
  });

  it('while the request is out, disables the button, says so and sends one request however often it is pressed', async () => {
    window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
    const fetchMock = stubFetch(() => new Promise<Response>(() => undefined));
    render(<PasskeyRevokeForm />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Signing you out…' }));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Signing you out…' })).toBeDisabled();
  });

  it.each([
    ['a fragment with an empty token', '#t='],
    ['a fragment without a token', '#x=1'],
  ])('shows the incomplete-link alert and no button for %s', async (_case, hash) => {
    window.history.replaceState(null, '', `/passkey-revoke${hash}`);
    const fetchMock = stubFetch(() => respond(200, {}));
    render(<PasskeyRevokeForm />);
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('This link is incomplete');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers no button when the address carries no token', async () => {
    window.history.replaceState(null, '', '/passkey-revoke');
    const fetchMock = stubFetch(() => respond(200, {}));
    render(<PasskeyRevokeForm />);
    await settle();

    expect(screen.queryByRole('button', { name: "This wasn't me" })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This link is incomplete');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
