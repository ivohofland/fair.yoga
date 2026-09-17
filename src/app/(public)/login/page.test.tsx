import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

let searchParams = new URLSearchParams();
let suspendSearchParams = false;

vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    if (suspendSearchParams) throw new Promise<void>(() => {});
    return searchParams;
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const passkeySignInMock = vi.fn();
vi.mock('@/components/booking/passkey-sign-in', () => ({
  PasskeySignIn: (props: { redirect?: string }) => {
    passkeySignInMock(props);
    return <div data-testid="passkey-sign-in" data-redirect={props.redirect ?? ''} />;
  },
}));

import LoginPage from './page';

function submit(email = 'anna@example.com') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: /Send me the link/i }));
}

describe('LoginPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    passkeySignInMock.mockClear();
    searchParams = new URLSearchParams();
    suspendSearchParams = false;
  });

  it('swaps itself for the sent-message panel, with the handoff code entry rendered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<LoginPage />);

    submit();

    expect(await screen.findByText('Check your inbox for the link.')).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });

  it('omits redirect from POST body and passes undefined to PasskeySignIn when redirect param is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginPage />);

    expect(passkeySignInMock).toHaveBeenCalledWith({ redirect: undefined });

    submit();

    expect(await screen.findByText('Check your inbox for the link.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/magic-link/send');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ email: 'anna@example.com' });
    expect(body).not.toHaveProperty('redirect');
  });

  it('sends valid redirect in POST body to /api/auth/magic-link/send and passes to PasskeySignIn', async () => {
    searchParams = new URLSearchParams({ redirect: '/account/privacy' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginPage />);

    expect(passkeySignInMock).toHaveBeenCalledWith({ redirect: '/account/privacy' });

    submit();

    expect(await screen.findByText('Check your inbox for the link.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/magic-link/send');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ email: 'anna@example.com', redirect: '/account/privacy' });
  });

  it('passes valid redirect to PasskeySignIn for protected routes like /students/s-1', () => {
    searchParams = new URLSearchParams({ redirect: '/students/s-1' });
    render(<LoginPage />);
    expect(passkeySignInMock).toHaveBeenCalledWith({ redirect: '/students/s-1' });
  });

  it('accepts valid redirect of exactly 200 characters', () => {
    const exact200 = '/' + 'a'.repeat(199);
    searchParams = new URLSearchParams({ redirect: exact200 });
    render(<LoginPage />);
    expect(passkeySignInMock).toHaveBeenCalledWith({ redirect: exact200 });
  });

  it('preserves query parameters in valid redirect destination', async () => {
    searchParams = new URLSearchParams({ redirect: '/account/privacy?tab=invitations' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginPage />);
    expect(passkeySignInMock).toHaveBeenCalledWith({ redirect: '/account/privacy?tab=invitations' });

    submit();
    expect(await screen.findByText('Check your inbox for the link.')).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ email: 'anna@example.com', redirect: '/account/privacy?tab=invitations' });
  });

  it.each([
    ['protocol-relative URL', '//evil.com'],
    ['backslash path', '/\\evil.com'],
    ['absolute URL', 'https://evil.com'],
    ['control-whitespace tab', '/\t/evil.com'],
    ['string of 201 chars', '/' + 'a'.repeat(200)],
    ['auth loop /login', '/login'],
    ['auth loop /verify', '/verify'],
  ])('omits unsafe or looping redirect (%s: %s) from POST body and PasskeySignIn', async (_, unsafeRedirect) => {
    searchParams = new URLSearchParams({ redirect: unsafeRedirect });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginPage />);

    expect(passkeySignInMock).toHaveBeenCalledWith({ redirect: undefined });

    submit();

    expect(await screen.findByText('Check your inbox for the link.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/magic-link/send');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ email: 'anna@example.com' });
    expect(body).not.toHaveProperty('redirect');
  });

  it('renders fallback when search params suspend', () => {
    suspendSearchParams = true;
    const { container } = render(<LoginPage />);
    expect(container).toBeEmptyDOMElement();
  });
});
