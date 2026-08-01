import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationsForm } from './notifications-form';

/**
 * #136. This form's reverse pin proves its two keys —
 * `emailNotifications` and `reminderPref` — are ones `updateStudentSchema`
 * accepts. It deliberately has no forward pin: the schema has eight keys,
 * `tier-form.tsx` sends a third, and five have no student-facing input
 * anywhere. A pin cannot see what actually reaches the API, so this test
 * holds that: the exact key set sent, and that all four reminder options —
 * now produced from `REMINDER_OPTIONS` instead of inline JSX — still render.
 *
 * Nothing fetches on mount, so the save click is the first (and only) call.
 */
describe('NotificationsForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
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
});
