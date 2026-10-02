import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NotificationPrefsForm } from './notification-prefs-form';
import { REMINDER_CHANNEL_OPTIONS } from '@/lib/reminder-options';
import type { TeacherNotificationPrefs } from '@/services/notification-policy';
import type { TeacherPushPrefs } from '@/lib/push-policy';

vi.mock('@/components/settings/push-device-control', () => ({
  PushDeviceControl: ({ vapidPublicKey }: { vapidPublicKey: string | null }) => (
    <div data-testid="push-device-control" data-vapid-public-key={vapidPublicKey ?? ''} />
  ),
}));

const DEFAULTS: TeacherNotificationPrefs & TeacherPushPrefs = {
  bookingNotifications: 'inbox_and_email',
  emailOnClassCompleted: true,
  emailOnInvitation: true,
  classReminder: 'evening_before',
  classReminderChannel: 'inbox',
  pushAutoCancelled: true,
  pushBookings: false,
  pushClassCompleted: false,
  pushClassReminders: false,
  pushInvitations: false,
};

// The brief's verbatim labels, typed against `TeacherPushPrefs` so a new push
// column fails to compile here until it is given one.
const PUSH_LABELS = {
  pushAutoCancelled: 'Auto-cancelled classes',
  pushBookings: 'New bookings',
  pushClassCompleted: 'Class completed',
  pushClassReminders: 'Class reminders',
  pushInvitations: 'Invitations',
} satisfies Record<keyof TeacherPushPrefs, string>;

const PUSH_LABEL_ENTRIES = Object.entries(PUSH_LABELS) as Array<[keyof TeacherPushPrefs, string]>;

// `PushDeviceControl` is stubbed throughout: its own behaviour is covered by
// `push-device-control.test.tsx`; here only the prop it is handed and the
// TeacherPushPrefs checkboxes beside it are this form's concern.
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
    render(
      <NotificationPrefsForm
        teacherId="t1"
        initial={{ ...DEFAULTS, bookingNotifications: 'inbox_only', emailOnClassCompleted: false, emailOnInvitation: true }}
        vapidPublicKey="KEY"
      />,
    );
    const group = screen.getByRole('group', { name: /new booking/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'In the inbox only' })).toBeChecked();
    const other = screen.getByRole('group', { name: /other emails/i });
    expect(within(other).getByRole('checkbox', { name: /class-completed summary/i })).not.toBeChecked();
    expect(within(other).getByRole('checkbox', { name: /invitation/i })).toBeChecked();
    expect(screen.getByText(/always emailed if you miss it/i)).toBeInTheDocument();
  });

  it('sends exactly the NotificationPrefsBody keys', async () => {
    stubFetch();
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} vapidPublicKey="KEY" />);
    const otherEmails = screen.getByRole('group', { name: /other emails/i });
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(within(otherEmails).getByRole('checkbox', { name: /class-completed summary/i }));
    fireEvent.click(within(otherEmails).getByRole('checkbox', { name: /invitation/i }));
    const { url, method, body } = await save();
    expect(url).toBe('/api/teachers/t1');
    expect(method).toBe('PUT');
    expect(Object.keys(body).sort()).toEqual([
      'bookingNotifications',
      'classReminder',
      'classReminderChannel',
      'emailOnClassCompleted',
      'emailOnInvitation',
      'pushAutoCancelled',
      'pushBookings',
      'pushClassCompleted',
      'pushClassReminders',
      'pushInvitations',
    ]);
    expect(body).toEqual({
      bookingNotifications: 'off',
      emailOnClassCompleted: false,
      emailOnInvitation: false,
      classReminder: 'evening_before',
      classReminderChannel: 'inbox',
      pushAutoCancelled: true,
      pushBookings: false,
      pushClassCompleted: false,
      pushClassReminders: false,
      pushInvitations: false,
    });
  });

  // Booleans give a checkbox only two starting values, so a fixture with every
  // push field at the same value can't tell a correct assignment from a swap
  // between two keys that happen to start equal. Toggling exactly one key and
  // pinning the rest to the fixture is what makes each key individually
  // provable, whatever it starts at or shares a start value with.
  it.each(PUSH_LABEL_ENTRIES)('toggles only %s, pinned to its own key', async (key, label) => {
    stubFetch();
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} vapidPublicKey="KEY" />);
    const checkbox = screen.getByRole('checkbox', { name: label });
    fireEvent.click(checkbox);
    // Catches a `checked` prop bound to a sibling's state: onChange would
    // still update the right variable (so the payload below could look
    // correct), but this exact checkbox would keep displaying its sibling's
    // unchanged value instead of its own toggle.
    expect(checkbox).toHaveProperty('checked', !DEFAULTS[key]);
    const { body } = await save();
    const expectedPush: TeacherPushPrefs = {
      pushAutoCancelled: DEFAULTS.pushAutoCancelled,
      pushBookings: DEFAULTS.pushBookings,
      pushClassCompleted: DEFAULTS.pushClassCompleted,
      pushClassReminders: DEFAULTS.pushClassReminders,
      pushInvitations: DEFAULTS.pushInvitations,
      [key]: !DEFAULTS[key],
    };
    expect(body).toMatchObject(expectedPush);
  });

  it('offers a Class reminder timing and channel, and sends both (#721)', async () => {
    stubFetch();
    render(
      <NotificationPrefsForm
        teacherId="t1"
        initial={{ ...DEFAULTS, classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' }}
        vapidPublicKey="KEY"
      />,
    );
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'one_hour_before' } });
    fireEvent.change(screen.getByLabelText('How'), { target: { value: 'email' } });
    const { body } = await save();
    expect(body).toMatchObject({ classReminder: 'one_hour_before', classReminderChannel: 'email' });
  });

  it('disables How while When is Off, and keeps the chosen channel (#721)', () => {
    render(
      <NotificationPrefsForm
        teacherId="t1"
        initial={{ ...DEFAULTS, classReminder: 'morning_of', classReminderChannel: 'email' }}
        vapidPublicKey="KEY"
      />,
    );
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'off' } });
    expect(screen.getByLabelText('How')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'evening_before' } });
    expect(screen.getByLabelText('How')).toHaveValue('email');
  });

  it('shows the disabled How select as inactive, and the enabled one as active (#721)', () => {
    render(
      <NotificationPrefsForm teacherId="t1" initial={{ ...DEFAULTS, classReminder: 'morning_of' }} vapidPublicKey="KEY" />,
    );
    expect(screen.getByLabelText('How')).not.toHaveClass('opacity-50');
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'off' } });
    expect(screen.getByLabelText('How')).toHaveClass('opacity-50', 'cursor-not-allowed');
  });

  it('offers the channel options in order from REMINDER_CHANNEL_OPTIONS (#721)', () => {
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} vapidPublicKey="KEY" />);
    const how = within(screen.getByLabelText('How'));
    expect(how.getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(
      REMINDER_CHANNEL_OPTIONS.map((o) => o.value),
    );
    expect(how.getAllByRole('option').map((o) => o.textContent)).toEqual(
      REMINDER_CHANNEL_OPTIONS.map((o) => o.label),
    );
  });

  it('clears the saved notice when edited after a save', async () => {
    stubFetch();
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} vapidPublicKey="KEY" />);
    await save();
    await screen.findByText(/saved/i);
    fireEvent.click(screen.getByRole('radio', { name: 'In the inbox only' }));
    expect(screen.queryByText(/saved/i)).not.toBeInTheDocument();
  });

  it('shows the server’s error message', async () => {
    stubFetch({ ok: false, status: 400, json: async () => ({ error: 'Nope from server' }) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} vapidPublicKey="KEY" />);
    await save();
    expect(await screen.findByText('Nope from server')).toBeInTheDocument();
  });

  it('shows network copy and logs when the request itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} vapidPublicKey="KEY" />);
    fireEvent.click(screen.getByRole('button', { name: /save notifications/i }));
    expect(await screen.findByText('Network error. Try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[notification-prefs-form] request failed',
      expect.objectContaining({ err: expect.any(TypeError) }),
    );
  });

  it('passes the server VAPID key to PushDeviceControl', () => {
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} vapidPublicKey="KEY" />);
    expect(screen.getByTestId('push-device-control')).toHaveAttribute('data-vapid-public-key', 'KEY');
  });

  it.each(PUSH_LABEL_ENTRIES)('checks only the %s box when only that column is on', (key) => {
    const oneHot = Object.fromEntries(PUSH_LABEL_ENTRIES.map(([k]) => [k, k === key])) as unknown as TeacherPushPrefs;
    render(<NotificationPrefsForm teacherId="t1" initial={{ ...DEFAULTS, ...oneHot }} vapidPublicKey="KEY" />);
    for (const [k, label] of PUSH_LABEL_ENTRIES) {
      const box = screen.getByRole('checkbox', { name: label });
      if (k === key) expect(box).toBeChecked();
      else expect(box).not.toBeChecked();
    }
  });

  it('renders the TeacherPushPrefs checkboxes at their stored values and saves a toggle', async () => {
    stubFetch();
    render(
      <NotificationPrefsForm
        teacherId="t1"
        initial={{ ...DEFAULTS, pushBookings: true, pushInvitations: true }}
        vapidPublicKey="KEY"
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Auto-cancelled classes' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'New bookings' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Class completed' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Class reminders' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Invitations' })).toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-cancelled classes' }));
    const { body } = await save();
    expect(body).toMatchObject({ pushAutoCancelled: false, pushBookings: true, pushInvitations: true });
  });
});
