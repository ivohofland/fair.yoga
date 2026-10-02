import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NotificationsForm } from './notifications-form';
import { REMINDER_TIMING_OPTIONS } from '@/lib/reminder-options';
import type { StudentPushPrefs } from '@/lib/push-policy';

vi.mock('@/components/settings/push-device-control', () => ({
  PushDeviceControl: ({ vapidPublicKey }: { vapidPublicKey: string | null }) => (
    <div data-testid="push-device-control" data-vapid-public-key={vapidPublicKey ?? ''} />
  ),
}));

/**
 * #136. The reverse pin in `notifications-form.tsx` proves its keys are ones
 * `updateStudentSchema` accepts, but cannot see what reaches the API. That is
 * what these tests hold: what the pin cannot see — the exact key set that
 * reaches the API, that every `REMINDER_TIMING_OPTIONS` entry renders, and how the
 * form behaves when the request fails.
 *
 * No forward pin on the form: the schema carries fields this form has no
 * business rendering.
 *
 * Nothing fetches on mount, so the save click is the first (and only) call.
 *
 * `PushDeviceControl` is stubbed throughout: its own behaviour is covered by
 * `push-device-control.test.tsx`; here only the prop it is handed and the
 * StudentPushPrefs checkboxes beside it are this form's concern.
 */
describe('NotificationsForm', () => {
  const fetchMock = vi.fn();

  const DEFAULT_PUSH: StudentPushPrefs = {
    pushWaitlist: true,
    pushClassChanges: true,
    pushPayments: false,
    pushClassReminders: false,
    pushAnnouncements: false,
    pushInvitations: false,
  };

  // The brief's verbatim labels, typed against `StudentPushPrefs` so a new
  // push column fails to compile here until it is given one.
  const PUSH_LABELS = {
    pushWaitlist: 'Waitlist spots',
    pushClassChanges: 'Class changes',
    pushPayments: 'Payments',
    pushClassReminders: 'Class reminders',
    pushAnnouncements: 'Announcements',
    pushInvitations: 'Invitations',
  } satisfies Record<keyof StudentPushPrefs, string>;

  const PUSH_LABEL_ENTRIES = Object.entries(PUSH_LABELS) as Array<[keyof StudentPushPrefs, string]>;

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  }

  async function save(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    fireEvent.click(screen.getByRole('button', { name: /save notifications/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  it('sends exactly the NotificationsBody keys', async () => {
    stubFetch();
    render(
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="morning_of"
        classReminderChannel="inbox_and_email"
        {...DEFAULT_PUSH}
        vapidPublicKey="KEY"
      />,
    );
    const { url, method, body } = await save();
    expect(url).toBe('/api/students/student-1');
    expect(method).toBe('PUT');
    expect(Object.keys(body).sort()).toEqual([
      'classReminder',
      'classReminderChannel',
      'emailNotifications',
      'pushAnnouncements',
      'pushClassChanges',
      'pushClassReminders',
      'pushInvitations',
      'pushPayments',
      'pushWaitlist',
    ]);
    expect(body).toEqual({
      emailNotifications: true,
      classReminder: 'morning_of',
      classReminderChannel: 'inbox_and_email',
      ...DEFAULT_PUSH,
    });
  });

  // Booleans give a checkbox only two starting values, so a fixture with every
  // push field at the same value can't tell a correct assignment from a swap
  // between two keys that happen to start equal. Toggling exactly one key and
  // pinning the rest to the fixture is what makes each key individually
  // provable, whatever it starts at or shares a start value with.
  it.each(PUSH_LABEL_ENTRIES)('toggles only %s, pinned to its own key', async (key, label) => {
    stubFetch();
    render(
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="morning_of"
        classReminderChannel="inbox_and_email"
        {...DEFAULT_PUSH}
        vapidPublicKey="KEY"
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: label }));
    const { body } = await save();
    const expectedPush: StudentPushPrefs = {
      pushWaitlist: DEFAULT_PUSH.pushWaitlist,
      pushClassChanges: DEFAULT_PUSH.pushClassChanges,
      pushPayments: DEFAULT_PUSH.pushPayments,
      pushClassReminders: DEFAULT_PUSH.pushClassReminders,
      pushAnnouncements: DEFAULT_PUSH.pushAnnouncements,
      pushInvitations: DEFAULT_PUSH.pushInvitations,
      [key]: !DEFAULT_PUSH[key],
    };
    expect(body).toMatchObject(expectedPush);
  });

  it('sends a toggled and reselected value, not just the initial ones', async () => {
    stubFetch();
    render(
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="morning_of"
        classReminderChannel="inbox_and_email"
        {...DEFAULT_PUSH}
        vapidPublicKey="KEY"
      />,
    );
    fireEvent.click(screen.getByLabelText(/email me when I miss/i));
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'off' } });
    const { body } = await save();
    expect(body).toEqual({
      emailNotifications: false,
      classReminder: 'off',
      classReminderChannel: 'inbox_and_email',
      ...DEFAULT_PUSH,
    });
  });

  it('renders every timing option, in order, from REMINDER_TIMING_OPTIONS', () => {
    stubFetch();
    render(
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="morning_of"
        classReminderChannel="inbox_and_email"
        {...DEFAULT_PUSH}
        vapidPublicKey="KEY"
      />,
    );
    const when = within(screen.getByLabelText('When'));
    expect(when.getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(
      REMINDER_TIMING_OPTIONS.map((o) => o.value),
    );
    expect(when.getAllByRole('option').map((o) => o.textContent)).toEqual(
      REMINDER_TIMING_OPTIONS.map((o) => o.label),
    );
  });

  it('offers a Class reminder timing and channel, and sends both (#721)', async () => {
    stubFetch();
    render(
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="morning_of"
        classReminderChannel="inbox_and_email"
        {...DEFAULT_PUSH}
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
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="morning_of"
        classReminderChannel="email"
        {...DEFAULT_PUSH}
        vapidPublicKey="KEY"
      />,
    );
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'off' } });
    expect(screen.getByLabelText('How')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'evening_before' } });
    expect(screen.getByLabelText('How')).toHaveValue('email');
  });

  it('starts from the stored values: Off shows Off with How disabled, and saves Off (#721)', async () => {
    stubFetch();
    render(
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="off"
        classReminderChannel="email"
        {...DEFAULT_PUSH}
        vapidPublicKey="KEY"
      />,
    );
    expect(screen.getByLabelText('When')).toHaveValue('off');
    expect(screen.getByLabelText('How')).toHaveValue('email');
    expect(screen.getByLabelText('How')).toBeDisabled();
    const { body } = await save();
    expect(body).toEqual({
      emailNotifications: true,
      classReminder: 'off',
      classReminderChannel: 'email',
      ...DEFAULT_PUSH,
    });
  });

  it('logs the failure and tells the student when fetch itself fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="morning_of"
        classReminderChannel="inbox_and_email"
        {...DEFAULT_PUSH}
        vapidPublicKey="KEY"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save notifications/i }));
    await waitFor(() => {
      expect(screen.getByText('Network error. Try again.')).toBeInTheDocument();
    });
    expect(logged).toHaveBeenCalledWith('[notifications-form] request failed', { err: expect.any(Error) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs and surfaces the server message when the response is not ok', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid reminder preference' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="morning_of"
        classReminderChannel="inbox_and_email"
        {...DEFAULT_PUSH}
        vapidPublicKey="KEY"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save notifications/i }));
    await waitFor(() => {
      expect(screen.getByText('Invalid reminder preference')).toBeInTheDocument();
    });
    expect(logged).toHaveBeenCalledWith('student notification prefs save failed (HTTP)', 400);
  });

  it('passes the server VAPID key to PushDeviceControl', () => {
    render(
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="morning_of"
        classReminderChannel="inbox_and_email"
        {...DEFAULT_PUSH}
        vapidPublicKey="KEY"
      />,
    );
    expect(screen.getByTestId('push-device-control')).toHaveAttribute('data-vapid-public-key', 'KEY');
  });

  it('renders the StudentPushPrefs checkboxes at their stored values and saves a toggle', async () => {
    stubFetch();
    render(
      <NotificationsForm
        studentId="student-1"
        emailNotifications={true}
        classReminder="morning_of"
        classReminderChannel="inbox_and_email"
        {...DEFAULT_PUSH}
        vapidPublicKey="KEY"
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Waitlist spots' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Class changes' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Payments' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Class reminders' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Announcements' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Invitations' })).not.toBeChecked();
    expect(screen.getByText(/being added as a walk-in/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Payments' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Waitlist spots' }));
    const { body } = await save();
    expect(body).toEqual({
      emailNotifications: true,
      classReminder: 'morning_of',
      classReminderChannel: 'inbox_and_email',
      pushWaitlist: false,
      pushClassChanges: true,
      pushPayments: true,
      pushClassReminders: false,
      pushAnnouncements: false,
      pushInvitations: false,
    });
  });
});
