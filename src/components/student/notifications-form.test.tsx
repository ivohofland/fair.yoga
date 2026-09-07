import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationsForm } from './notifications-form';

/**
 * #136. The reverse pin in `notifications-form.tsx` proves its keys are ones
 * `updateStudentSchema` accepts, but cannot see what reaches the API. That is
 * what these tests hold: what the pin cannot see — the exact key set that
 * reaches the API, that every `REMINDER_OPTIONS` entry renders, and how the
 * form behaves when the request fails.
 *
 * No forward pin on the form: the schema carries fields this form has no
 * business rendering.
 *
 * Nothing fetches on mount, so the save click is the first (and only) call.
 */
describe('NotificationsForm', () => {
  const fetchMock = vi.fn();

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

  it('sends exactly emailNotifications and reminderPref', async () => {
    stubFetch();
    render(
      <NotificationsForm studentId="student-1" emailNotifications={true} reminderPref="morning" />,
    );
    const { url, method, body } = await save();
    expect(url).toBe('/api/students/student-1');
    expect(method).toBe('PUT');
    expect(Object.keys(body).sort()).toEqual(['emailNotifications', 'reminderPref']);
    expect(body).toEqual({ emailNotifications: true, reminderPref: 'morning' });
  });

  it('sends a toggled and reselected value, not just the initial ones', async () => {
    stubFetch();
    render(
      <NotificationsForm studentId="student-1" emailNotifications={true} reminderPref="morning" />,
    );
    fireEvent.click(screen.getByLabelText(/email me when I miss/i));
    fireEvent.change(screen.getByLabelText('Class reminder'), { target: { value: 'off' } });
    const { body } = await save();
    expect(body).toEqual({ emailNotifications: false, reminderPref: 'off' });
  });

  it('renders all four reminder options, in order, from the extracted array', () => {
    stubFetch();
    render(
      <NotificationsForm studentId="student-1" emailNotifications={true} reminderPref="morning" />,
    );
    expect(screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual([
      'eve',
      'morning',
      'one_hour',
      'off',
    ]);
    expect(screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).textContent)).toEqual([
      'Evening before',
      'Morning of class',
      'One hour before',
      'No reminders',
    ]);
  });

  it('logs the failure and tells the student when fetch itself fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <NotificationsForm studentId="student-1" emailNotifications={true} reminderPref="morning" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save notifications/i }));
    await waitFor(() => {
      expect(screen.getByText('Network error. Try again.')).toBeInTheDocument();
    });
    expect(logged).toHaveBeenCalledWith('student notification prefs save failed', expect.any(Error));
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
      <NotificationsForm studentId="student-1" emailNotifications={true} reminderPref="morning" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save notifications/i }));
    await waitFor(() => {
      expect(screen.getByText('Invalid reminder preference')).toBeInTheDocument();
    });
    expect(logged).toHaveBeenCalledWith('student notification prefs save failed (HTTP)', 400);
  });
});
