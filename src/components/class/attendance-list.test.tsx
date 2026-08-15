import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AttendanceList, type AttendanceItem } from './attendance-list';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

/**
 * A student who cancels late is still charged (`late_cancel` is in
 * `CHARGED_STATUSES`) but their seat is freed. Some of them turn up anyway, and
 * the teacher lets them in — a routine venue scenario, and the reason this file
 * exists.
 *
 * `activeRegistrations` (`(teacher)/class/[id]/page.tsx`) keeps those rows
 * deliberately, so they render here with a control. Two things about that row
 * are easy to get wrong and are held below.
 *
 * FIRST: the server refuses `late_cancel -> attended` while the class is still
 * `open`, and an earlier version of this component took a `classIsOpen` prop to
 * avoid offering a doomed tap. That could not work. The page is server-rendered
 * with no revalidation and check-in opens from T-15min, so the prop froze at
 * render and the control never unlocked once the class actually started — a
 * silent failure in place of a visible one. The server decides; a refusal
 * refreshes.
 *
 * SECOND: the toggle must not destroy the record. `late_cancel` is what tells
 * the student, on their own `/bookings`, why they were charged for a class they
 * did not attend.
 */
describe('AttendanceList', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    refresh.mockReset();
    vi.unstubAllGlobals();
  });

  const lateCancel: AttendanceItem = {
    registrationId: 'reg-late',
    studentName: 'Ada Lovelace',
    status: 'late_cancel',
  };

  it('labels a late-cancelled student as such rather than as a no-show', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[lateCancel]} />);

    // `getByText` throws on a miss, so its return value asserts nothing — the
    // real assertion is the negative one beside it.
    screen.getByText('Late cancel');
    expect(screen.queryByText('No-show')).toBeNull();
  });

  /**
   * The control is OFFERED regardless of class status, because this component
   * cannot know it. Whether the write lands is the server's call, and the
   * previous attempt to pre-empt it here is what produced a permanently dead
   * button.
   */
  it('offers the control and marks the student present', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[lateCancel]} />);

    const button = screen.getByRole('button', { name: /mark them present/i });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/registrations/reg-late',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 'attended' }) }),
    );
  });

  /**
   * The second tap, which a plain attended/no_show toggle would use to erase
   * `late_cancel` for good — no teacher-side path writes that value back.
   * A student who cancelled late is not a no-show; the only meaningful
   * correction for them is "they came after all", and it has to be undoable.
   */
  it('returns a walked-in late cancel to late_cancel, never to no_show', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[lateCancel]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));
    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /mark them cancelled again/i }));
    await waitFor(() => expect(screen.getByText('Late cancel')).toBeTruthy());

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/registrations/reg-late',
      expect.objectContaining({ body: JSON.stringify({ status: 'late_cancel' }) }),
    );
    const bodies = fetchMock.mock.calls.map((c) => (c[1] as { body: string }).body);
    expect(bodies.some((b) => b.includes('no_show'))).toBe(false);
  });

  it('still toggles an ordinary registration between present and no-show', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <AttendanceList
        items={[{ registrationId: 'reg-1', studentName: 'Grace Hopper', status: 'registered' }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Mark Grace Hopper as present/i }));
    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Mark Grace Hopper as no-show/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/registrations/reg-1',
        expect.objectContaining({ body: JSON.stringify({ status: 'no_show' }) }),
      ),
    );
  });

  it("surfaces the server's reason for a refusal and refreshes the stale page", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      // The shape `respondError` actually emits — `{ error: { message, code } }`,
      // not a bare string. The bare-string branch of `readErrorMessage` exists
      // for defensiveness; mocking it here would exercise a path the server
      // never produces and quietly stop testing the real one.
      json: async () => ({
        error: {
          message:
            'This student cancelled late. You can mark them attended once the class has started.',
          code: 'CONFLICT',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[lateCancel]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('once the class has started');
    expect(alert.textContent).not.toContain('try again');
    // Without this the teacher is stuck: the page's class status is a render-time
    // snapshot, so a refusal it no longer reflects would repeat forever.
    expect(refresh).toHaveBeenCalled();
  });
});
