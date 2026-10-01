import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NotificationPrefsForm } from './notification-prefs-form';
import type { TeacherNotificationPrefs } from '@/services/notification-policy';

const DEFAULTS: TeacherNotificationPrefs = {
  bookingNotifications: 'inbox_and_email',
  emailOnClassCompleted: true,
  emailOnInvitation: true,
  classReminder: 'evening_before',
  classReminderChannel: 'inbox',
};

describe('NotificationPrefsForm', () => {
  const fetchMock = vi.fn();
  afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function stubFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> } = { ok: true, json: async () => ({}) }) {
    fetchMock.mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
  }

  async function save() {
    fireEvent.click(screen.getByRole('button', { name: /save notifications/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, opts] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    return { url, method: opts.method, body: JSON.parse(opts.body) as Record<string, unknown> };
  }

  it('renders the stored values', () => {
    render(<NotificationPrefsForm teacherId="t1" initial={{ ...DEFAULTS, bookingNotifications: 'inbox_only', emailOnClassCompleted: false, emailOnInvitation: true }} />);
    const group = screen.getByRole('group', { name: /new booking/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'In the inbox only' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /class-completed summary/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /invitation/i })).toBeChecked();
    expect(screen.getByText(/always emailed if you miss it/i)).toBeInTheDocument();
    const other = screen.getByRole('group', { name: /other emails/i });
    expect(within(other).getByRole('checkbox', { name: /class-completed summary/i })).toBeInTheDocument();
    expect(within(other).getByRole('checkbox', { name: /invitation/i })).toBeInTheDocument();
  });

  it('sends exactly the five preference keys to the teacher route, each at a non-default value', async () => {
    stubFetch();
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /class-completed summary/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /invitation/i }));
    const { url, method, body } = await save();
    expect(url).toBe('/api/teachers/t1');
    expect(method).toBe('PUT');
    expect(body).toEqual({
      bookingNotifications: 'off',
      emailOnClassCompleted: false,
      emailOnInvitation: false,
      classReminder: 'evening_before',
      classReminderChannel: 'inbox',
    });
  });

  it('clears the saved notice when edited after a save', async () => {
    stubFetch();
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} />);
    await save();
    await screen.findByText(/saved/i);
    fireEvent.click(screen.getByRole('radio', { name: 'In the inbox only' }));
    expect(screen.queryByText(/saved/i)).not.toBeInTheDocument();
  });

  it('shows the server’s error message', async () => {
    stubFetch({ ok: false, status: 400, json: async () => ({ error: 'Nope from server' }) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} />);
    await save();
    expect(await screen.findByText('Nope from server')).toBeInTheDocument();
  });

  it('shows network copy and logs when the request itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} />);
    fireEvent.click(screen.getByRole('button', { name: /save notifications/i }));
    expect(await screen.findByText('Network error. Try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[notification-prefs-form] request failed',
      expect.objectContaining({ err: expect.any(TypeError) }),
    );
  });
});
