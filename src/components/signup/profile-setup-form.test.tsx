import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProfileSetupForm } from './profile-setup-form';

const DRAFT_KEY = 'fair_yoga_profile_draft';

/**
 * The success and session-mode-401 paths leave via `window.location.assign`
 * (a hard navigation, not the router — the response set a session cookie).
 * jsdom's `location` is replaced wholesale for each such test and restored
 * in `afterEach`, matching the pattern in
 * `delete-studio-class-button.test.tsx`.
 */
const realLocation = window.location;
const stubLocation = () => {
  const assign = vi.fn();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
  return assign;
};

/**
 * Branches on URL so `PageAddressField`'s own debounced (400ms) live-check
 * request — fired whenever the pageSlug input changes — never collides with
 * the profile-submit assertions these tests actually care about. None of
 * these tests assert on the live-check verdict, so it always answers
 * `available: true`.
 */
function stubFetch(profileResponse: () => Promise<unknown> | unknown) {
  const mock = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.startsWith('/api/teachers/slug-available')) {
      return Promise.resolve({ ok: true, json: async () => ({ data: { available: true } }) });
    }
    return Promise.resolve(profileResponse());
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function fillForm() {
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Anna' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'de Vries' } });
}

describe('ProfileSetupForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    Object.defineProperty(window, 'location', { value: realLocation, writable: true });
  });

  it('names the address it will create in ticket mode', () => {
    render(<ProfileSetupForm email="anna@example.com" mode="ticket" />);
    expect(screen.getByText(/You're signing up as/)).toBeInTheDocument();
    expect(screen.getByText('anna@example.com')).toBeInTheDocument();
  });

  it('names the address it will attach the hat to in session mode', () => {
    render(<ProfileSetupForm email="anna@example.com" mode="session" />);
    expect(screen.getByText(/Adding a teacher page to/)).toBeInTheDocument();
  });

  it('creates the profile and hard-navigates to /schedule on success, clearing any draft', async () => {
    const assign = stubLocation();
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ email: 'anna@example.com', firstName: 'Old', lastName: 'Draft', bio: '', pageSlug: 'old-draft', slugEdited: true }),
    );
    stubFetch(() => ({ ok: true, status: 201, json: async () => ({ data: { teacherId: 't-1' } }) }));
    render(<ProfileSetupForm email="anna@example.com" mode="ticket" />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create my page' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/schedule'));
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('restores a draft left for the same address, and discards one left for a different address', async () => {
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ email: 'anna@example.com', firstName: 'Anna', lastName: 'Draft', bio: 'In progress', pageSlug: 'anna-draft', slugEdited: true }),
    );
    render(<ProfileSetupForm email="anna@example.com" mode="ticket" />);

    await waitFor(() => expect(screen.getByLabelText('First name')).toHaveValue('Anna'));
    expect(screen.getByLabelText('Bio')).toHaveValue('In progress');

    // A second signup on the same browser, a different address: the first
    // teacher's abandoned draft must never be shown to the second.
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ email: 'anna@example.com', firstName: 'Anna', lastName: 'Draft', bio: 'In progress', pageSlug: 'anna-draft', slugEdited: true }),
    );
    render(<ProfileSetupForm email="someone-else@example.com" mode="ticket" />);

    await waitFor(() => expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull());
    const firstNameInputs = screen.getAllByLabelText('First name');
    expect(firstNameInputs[firstNameInputs.length - 1]).toHaveValue('');
  });

  it('shows the terminal ALREADY_TEACHER state and clears the draft', async () => {
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ email: 'anna@example.com', firstName: 'Anna', lastName: 'X', bio: '', pageSlug: 'anna-x', slugEdited: true }),
    );
    stubFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'ALREADY_TEACHER', message: 'Account already has a teacher profile' } }),
    }));
    render(<ProfileSetupForm email="anna@example.com" mode="ticket" />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create my page' }));

    expect(await screen.findByText('You already teach here')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('shows the ALREADY_TEACHER state with a schedule link in session mode', async () => {
    stubFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'ALREADY_TEACHER', message: 'Account already has a teacher profile' } }),
    }));
    render(<ProfileSetupForm email="anna@example.com" mode="session" />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create my page' }));

    expect(await screen.findByText('You already teach here')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your schedule' })).toBeInTheDocument();
  });

  it('shows a SLUG_TAKEN rejection keyed to the address it was about, and drops it once the address changes', async () => {
    stubFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'SLUG_TAKEN', message: 'Page address already in use' } }),
    }));
    render(<ProfileSetupForm email="anna@example.com" mode="ticket" />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create my page' }));

    expect(await screen.findByText('That address is taken — please pick another.')).toBeInTheDocument();

    // Editing the address away from the rejected one retires the rejection —
    // it was keyed to the exact slug the server refused.
    fireEvent.change(screen.getByLabelText('Page address'), { target: { value: 'anna-devries-2' } });
    expect(screen.queryByText('That address is taken — please pick another.')).not.toBeInTheDocument();
  });

  it('session mode: a 401 at submit is a dead session, and hard-navigates to /login', async () => {
    const assign = stubLocation();
    stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
    render(<ProfileSetupForm email="anna@example.com" mode="session" />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create my page' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
  });

  it('ticket mode: a 401 at submit resends a link and reports the recoverable "expired" state, keeping the typed values', async () => {
    const calls: string[] = [];
    const mock = vi.fn((input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/teachers/slug-available')) {
        return Promise.resolve({ ok: true, json: async () => ({ data: { available: true } }) });
      }
      if (url === '/api/account/teacher-profile') {
        return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
      }
      if (url === '/api/auth/teacher-signup') {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', mock);
    render(<ProfileSetupForm email="anna@example.com" mode="ticket" />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create my page' }));

    expect(await screen.findByText(/we've emailed you a fresh link/i)).toBeInTheDocument();
    expect(calls).toContain('/api/auth/teacher-signup');
    // Nothing is lost: the fields are still populated for a retry.
    expect(screen.getByLabelText('First name')).toHaveValue('Anna');
  });

  it('ticket mode: a 401 whose resend itself fails reports the stuck state, not a false promise of a fresh link', async () => {
    const mock = vi.fn((input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/teachers/slug-available')) {
        return Promise.resolve({ ok: true, json: async () => ({ data: { available: true } }) });
      }
      if (url === '/api/account/teacher-profile') {
        return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
      }
      if (url === '/api/auth/teacher-signup') {
        return Promise.resolve({ ok: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', mock);
    render(<ProfileSetupForm email="anna@example.com" mode="ticket" />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create my page' }));

    expect(await screen.findByText(/couldn't send a fresh one/i)).toBeInTheDocument();
  });

  it('shows a network-error message and does not lose the draft', async () => {
    const mock = vi.fn((input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/teachers/slug-available')) {
        return Promise.resolve({ ok: true, json: async () => ({ data: { available: true } }) });
      }
      return Promise.reject(new Error('offline'));
    });
    vi.stubGlobal('fetch', mock);
    render(<ProfileSetupForm email="anna@example.com" mode="ticket" />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create my page' }));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Anna');
  });
});
