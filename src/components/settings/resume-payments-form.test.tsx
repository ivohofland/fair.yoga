import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { RECENT_AUTH_WINDOW_MS } from '@/lib/auth/recent-auth';
import { isLoginRedirectTarget } from '@/lib/schemas';
import { ResumePaymentsForm, PASSKEY_RECENT_AUTH_COPY, RESUME_SIGN_IN_PATH } from './resume-payments-form';

const FINGERPRINT = 'f'.repeat(64);
const props = { teacherId: 't-1', fingerprint: FINGERPRINT, accountId: 'a-1', email: 'anna@test.local' };

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

describe('ResumePaymentsForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the fingerprint it was given and confirms', async () => {
    const fetchMock = stubFetch(() => respond(200, { data: { resumed: true } }));
    render(<ResumePaymentsForm {...props} passkeyRequired={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/teachers/t-1/payments-resume');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ fingerprint: FINGERPRINT });
    expect(screen.getByRole('status')).toHaveTextContent('Payments are running again');
    expect(screen.queryByRole('button', { name: 'Resume payments' })).not.toBeInTheDocument();
  });

  it('reloads the page once resumed, so the schedule no longer shows the pause', async () => {
    stubFetch(() => respond(200, { data: { resumed: true } }));
    render(<ResumePaymentsForm {...props} passkeyRequired={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(routerRefresh).toHaveBeenCalled();
  });

  it('says payments were already running on an unchanged answer, and claims no one was told', async () => {
    stubFetch(() => new Response(JSON.stringify({ data: { resumed: true }, outcome: 'unchanged' }), { status: 200 }));
    render(<ResumePaymentsForm {...props} passkeyRequired={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(screen.getByRole('status')).toHaveTextContent('Payments are already running');
    expect(screen.getByRole('status')).not.toHaveTextContent('told');
    expect(routerRefresh).toHaveBeenCalled();
  });

  it('reloads the details when they changed since the page loaded', async () => {
    stubFetch(() => respond(409, { error: { code: 'PAYOUT_DETAILS_CHANGED', message: 'Your payment details changed.' } }));
    render(<ResumePaymentsForm {...props} passkeyRequired={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Your payment details changed.');
    expect(routerRefresh).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Resume payments' })).toBeEnabled();
  });

  it('offers a teacher with no passkey requirement and a stale session a sign-in link back to this page', async () => {
    const fetchMock = stubFetch(() => respond(403, { error: { code: 'RECENT_AUTH_REQUIRED', message: 'have a sign-in link emailed to you' } }));
    render(<ResumePaymentsForm {...props} passkeyRequired={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();
    fetchMock.mockImplementation(async () => respond(200, { data: { sent: true } }));
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    await settle();

    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe('/api/auth/magic-link/send');
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'anna@test.local', redirect: '/settings/resume-payments' });
    expect(screen.getByText(/Check anna@test\.local for a sign-in link/)).toBeInTheDocument();
  });

  it('says the link could not be sent when sending fails', async () => {
    const fetchMock = stubFetch(() => respond(403, { error: { code: 'RECENT_AUTH_REQUIRED', message: 'x' } }));
    render(<ResumePaymentsForm {...props} passkeyRequired={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();
    fetchMock.mockImplementation(async () => respond(503, { error: { message: 'busy' } }));

    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Could not send the sign-in link');
  });

  it('links a signed-out teacher to sign in and come back here', async () => {
    stubFetch(() => respond(401, { error: { message: 'Authentication required' } }));
    render(<ResumePaymentsForm {...props} passkeyRequired={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('signed out');
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', RESUME_SIGN_IN_PATH);
    expect(RESUME_SIGN_IN_PATH).toBe('/login?redirect=%2Fsettings%2Fresume-payments');
    // The same rule `/login` applies to the redirect it is handed.
    const redirect = new URL(RESUME_SIGN_IN_PATH, 'http://localhost').searchParams.get('redirect');
    expect(redirect).not.toBeNull();
    expect(isLoginRedirectTarget(redirect ?? '')).toBe(true);
    expect(screen.getByRole('alert')).not.toHaveTextContent('still paused');
  });

  // Nothing the app answered says what happened: a gateway, a proxy's own
  // page, an uncoded refusal or no answer at all.
  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 502', () => new Response('<html>Bad Gateway</html>', { status: 502 })],
    ['a 504', () => new Response('<html>Gateway Timeout</html>', { status: 504 })],
    ['a 503 that is not the app\'s', () => new Response('<html>Service Unavailable</html>', { status: 503 })],
    ['a 500', () => respond(500, { error: { message: 'Internal server error' } })],
    ['an uncoded 403', () => respond(403, { error: { message: 'Access denied' } })],
    ['an uncoded 404', () => respond(404, { error: { message: 'Teacher not found' } })],
  ] as const)('says how to check, claiming nothing, after %s', async (_case, answer) => {
    stubFetch(answer);
    render(<ResumePaymentsForm {...props} passkeyRequired={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/couldn.t confirm whether payments were resumed/);
    expect(alert).toHaveTextContent('To check, reload this page');
    expect(alert).not.toHaveTextContent('still paused');
    expect(screen.getByRole('button', { name: 'Resume payments' })).toBeEnabled();
  });

  it('asks for another try after the server says it was busy, which rolled the resume back', async () => {
    stubFetch(() => respond(503, { error: { message: 'The system was busy and could not finish that. Please try again.' } }));
    render(<ResumePaymentsForm {...props} passkeyRequired={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong, and payments are still paused. Please try again.');
    expect(screen.getByRole('button', { name: 'Resume payments' })).toBeEnabled();
  });

  it('sends a passkey-required teacher with a stale session back to their passkey, not to an emailed link', async () => {
    stubFetch(() => respond(403, { error: { code: 'RECENT_AUTH_REQUIRED', message: 'have a sign-in link emailed to you' } }));
    render(<ResumePaymentsForm {...props} passkeyRequired />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent(PASSKEY_RECENT_AUTH_COPY);
    expect(PASSKEY_RECENT_AUTH_COPY).toContain(`within ${RECENT_AUTH_WINDOW_MS / 60_000} minutes`);
    expect(screen.getByRole('alert')).not.toHaveTextContent('emailed');
    expect(screen.queryByRole('button', { name: 'Email me a sign-in link' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume payments' })).toBeEnabled();
  });

  it('offers the sign-out on PASSKEY_REQUIRED, with the server\'s copy', async () => {
    stubFetch(() => respond(403, { error: { code: 'PASSKEY_REQUIRED', message: 'Sign out, then sign in again with your passkey.' } }));
    render(<ResumePaymentsForm {...props} passkeyRequired />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Sign out, then sign in again with your passkey.');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('keeps the server\'s own copy for another refusal while a passkey is required', async () => {
    stubFetch(() => respond(409, { error: { code: 'PAYOUT_DETAILS_CHANGED', message: 'Your payment details changed.' } }));
    render(<ResumePaymentsForm {...props} passkeyRequired />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Your payment details changed.');
  });
});
