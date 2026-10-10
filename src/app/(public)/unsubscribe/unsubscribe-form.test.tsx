import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { UnsubscribeForm } from './unsubscribe-form';
import { UNSUBSCRIBE_KINDS, type UnsubscribeKind } from '@/lib/unsubscribe-kind';

function tokenFor(kind: string): string {
  const payload = btoa(`v1.${kind}.subject`).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${payload}.mac`;
}

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

async function open(kind: string): Promise<string> {
  const token = tokenFor(kind);
  window.history.replaceState(null, '', `/unsubscribe#t=${token}`);
  render(<UnsubscribeForm />);
  await settle();
  return token;
}

const BUTTON = { name: 'Unsubscribe' };

describe('UnsubscribeForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  const REMINDERS = 'Class reminders stop coming by email. If email was the only way you got them, reminders turn off.';
  const EXPECTED = {
    student_notifications: {
      what: "You'll stop getting an email when a message in the app goes unread. Messages about your own bookings, cancellations and payments still come by email.",
      settings: '/account/notifications',
    },
    teacher_bookings: {
      what: "You'll stop getting booking emails. New bookings still show in your inbox.",
      settings: '/settings/notifications',
    },
    teacher_class_completed: {
      what: "You'll stop getting an email when a class completes.",
      settings: '/settings/notifications',
    },
    teacher_invitations: {
      what: "You'll stop getting an email when someone invites you to connect.",
      settings: '/settings/notifications',
    },
    student_reminders: { what: REMINDERS, settings: '/account/notifications' },
    teacher_reminders: { what: REMINDERS, settings: '/settings/notifications' },
    invitation: {
      what: "This declines the invitation, and that teacher can't add your address again.",
      settings: null,
    },
  } as const satisfies Record<UnsubscribeKind, { what: string; settings: string | null }>;

  it.each(Object.keys(UNSUBSCRIBE_KINDS) as UnsubscribeKind[])('describes what %s changes and where its settings are', async (kind) => {
    await open(kind);
    expect(screen.getByTestId('unsubscribe-what').textContent).toBe(EXPECTED[kind].what);
    const link = screen.queryByRole('link', { name: 'notification settings' });
    if (EXPECTED[kind].settings === null) expect(link).not.toBeInTheDocument();
    else expect(link).toHaveAttribute('href', EXPECTED[kind].settings);
  });

  it.each(Object.keys(UNSUBSCRIBE_KINDS) as UnsubscribeKind[])('confirms %s truthfully after unsubscribing', async (kind) => {
    stubFetch(() => respond(200, { data: { unsubscribed: true } }));
    await open(kind);
    fireEvent.click(screen.getByRole('button', BUTTON));
    await settle();
    const status = screen.getByRole('status');
    const settings = EXPECTED[kind].settings;
    if (settings === null) {
      expect(status).toHaveTextContent('You\u2019ve declined the invitation. That teacher can\u2019t add your address again.');
      expect(status).not.toHaveTextContent('change this');
      expect(screen.queryByRole('link', { name: 'notification settings' })).not.toBeInTheDocument();
    } else {
      expect(status).toHaveTextContent('You can change this any time in your notification settings.');
      expect(screen.getByRole('link', { name: 'notification settings' })).toHaveAttribute('href', settings);
    }
  });

  it('describes an invitation unsubscribe as a decline', async () => {
    await open('invitation');
    expect(screen.getByTestId('unsubscribe-what')).toHaveTextContent(
      "This declines the invitation, and that teacher can't add your address again.",
    );
    expect(screen.queryByRole('link', { name: 'notification settings' })).not.toBeInTheDocument();
  });

  it('describes a student reminder unsubscribe and links the student settings', async () => {
    await open('student_reminders');
    expect(screen.getByTestId('unsubscribe-what')).toHaveTextContent(
      "Class reminders stop coming by email. If email was the only way you got them, reminders turn off.",
    );
    expect(screen.getByRole('link', { name: 'notification settings' })).toHaveAttribute('href', '/account/notifications');
  });

  it('links the teacher settings for a teacher kind', async () => {
    await open('teacher_bookings');
    expect(screen.getByRole('link', { name: 'notification settings' })).toHaveAttribute('href', '/settings/notifications');
  });

  it('posts nothing on load', async () => {
    const fetchMock = stubFetch(() => respond(200, { data: { unsubscribed: true } }));
    await open('teacher_bookings');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the one-click form body on the button, then confirms and drops the fragment', async () => {
    const fetchMock = stubFetch(() => respond(200, { data: { unsubscribed: true } }));
    const token = await open('student_notifications');
    const replaceState = vi.spyOn(window.history, 'replaceState');

    fireEvent.click(screen.getByRole('button', BUTTON));
    await settle();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/unsubscribe?t=${encodeURIComponent(token)}`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    expect(String(init?.body)).toBe('List-Unsubscribe=One-Click');
    expect(screen.getByRole('status')).toHaveTextContent("You\u2019re unsubscribed");
    expect(screen.queryByRole('button', BUTTON)).not.toBeInTheDocument();
    expect(replaceState).toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it('shows the same success when nothing changed', async () => {
    stubFetch(() => respond(200, { data: { unsubscribed: true, outcome: 'unchanged' } }));
    await open('teacher_invitations');
    fireEvent.click(screen.getByRole('button', BUTTON));
    await settle();
    expect(screen.getByRole('status')).toHaveTextContent("You\u2019re unsubscribed");
  });

  it('says the link no longer works, with a sign-in link, on UNSUBSCRIBE_LINK_INVALID', async () => {
    stubFetch(() => respond(404, { error: { code: 'UNSUBSCRIBE_LINK_INVALID', message: 'x' } }));
    await open('teacher_bookings');
    fireEvent.click(screen.getByRole('button', BUTTON));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('This link no longer works');
    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('button', BUTTON)).not.toBeInTheDocument();
  });

  it('says the link is incomplete without a fragment, and shows no button', async () => {
    window.history.replaceState(null, '', '/unsubscribe');
    render(<UnsubscribeForm />);
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('This link is incomplete');
    expect(screen.queryByRole('button', BUTTON)).not.toBeInTheDocument();
  });

  it('says the link is incomplete for a token that names no kind', async () => {
    window.history.replaceState(null, '', '/unsubscribe#t=garbage');
    render(<UnsubscribeForm />);
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('This link is incomplete');
    expect(screen.queryByRole('button', BUTTON)).not.toBeInTheDocument();
  });

  it('asks to wait on 429 and keeps the button', async () => {
    stubFetch(() => respond(429, { error: { message: 'slow down' } }));
    await open('teacher_bookings');
    fireEvent.click(screen.getByRole('button', BUTTON));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Too many attempts');
    expect(screen.getByRole('button', BUTTON)).toBeEnabled();
  });

  it('says nothing changed on a network error and keeps the button', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch(() => Promise.reject(new TypeError('offline')));
    await open('teacher_bookings');
    fireEvent.click(screen.getByRole('button', BUTTON));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing changed');
    expect(screen.getByRole('button', BUTTON)).toBeEnabled();
  });
});
