import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AttendanceList, type AttendanceItem } from './attendance-list';

/**
 * A student who cancels late is still charged (`late_cancel` is in
 * `CHARGED_STATUSES`) but their seat is freed. Some of them turn up anyway, and
 * the teacher lets them in — a routine venue scenario, and the reason this file
 * exists.
 *
 * `activeRegistrations` (`(teacher)/class/[id]/page.tsx`) keeps those rows
 * deliberately, so they render here with a control. The PUT route refuses
 * `late_cancel -> attended` while the class is still `open`, because that is the
 * only window in which the move can race `autoCancelClasses` into cancelling a
 * viable class. These tests hold the two halves of that boundary at the surface
 * a teacher actually touches: inert before the class starts, live after.
 *
 * The third test holds the thing that made the original defect invisible — a
 * 409 whose body was discarded in favour of "Please try again", advice that
 * could never work.
 */
describe('AttendanceList', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const lateCancel: AttendanceItem = {
    registrationId: 'reg-late',
    studentName: 'Ada Lovelace',
    status: 'late_cancel',
  };

  it('shows a late-cancelled student as such, and does not offer the control while the class is open', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[lateCancel]} classIsOpen />);

    expect(screen.getByText('Late cancel')).toBeTruthy();

    const button = screen.getByRole('button', { name: /cancelled late/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets the teacher mark that student present once the class has started', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[lateCancel]} classIsOpen={false} />);

    const button = screen.getByRole('button', { name: /Mark Ada Lovelace as present/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/registrations/reg-late',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 'attended' }) }),
    );
  });

  it("surfaces the server's reason for a refusal rather than telling the teacher to retry", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Cannot record attendance on a cancelled class' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <AttendanceList
        items={[{ registrationId: 'reg-1', studentName: 'Grace Hopper', status: 'registered' }]}
        classIsOpen={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Mark Grace Hopper as present/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Cannot record attendance on a cancelled class');
    expect(alert.textContent).not.toContain('try again');
  });
});
