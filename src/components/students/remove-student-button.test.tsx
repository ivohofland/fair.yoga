import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerPush } from '../../../tests/setup/components';
import { RemoveStudentButton } from './remove-student-button';

/**
 * #166. This component had no test file before this one — the gap the task
 * brief calls out by name: `DELETE /api/students/[id]`, the route this
 * button used to call, is gone (Task 10), and nothing else in the suite
 * would have noticed a bad repoint. It now fetches `DELETE
 * /api/invitations/[id]` instead; these tests pin that URL, the confirm
 * step, and that a declined contact's 409 arrives on screen through
 * `readErrorMessage` unmodified.
 */
describe('RemoveStudentButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function clickThroughConfirm(): void {
    fireEvent.click(screen.getByRole('button', { name: /remove contact/i }));
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
  }

  it('renders no confirmation until the trigger is clicked', () => {
    render(<RemoveStudentButton invitationId="inv-1" studentName="Lena Visser" />);
    expect(screen.queryByText(/from your contacts\?/i)).toBeNull();
    expect(screen.getByRole('button', { name: /remove contact/i })).toBeInTheDocument();
  });

  it('asks for confirmation, naming the contact', () => {
    render(<RemoveStudentButton invitationId="inv-1" studentName="Lena Visser" />);
    fireEvent.click(screen.getByRole('button', { name: /remove contact/i }));
    expect(screen.getByText('Remove Lena Visser from your contacts?')).toBeInTheDocument();
  });

  it('DELETEs /api/invitations/:id, not /api/students/:id', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<RemoveStudentButton invitationId="inv-1" studentName="Lena Visser" />);
    clickThroughConfirm();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/invitations/inv-1', { method: 'DELETE' }),
    );
  });

  it('navigates to /students after a successful remove', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<RemoveStudentButton invitationId="inv-1" studentName="Lena Visser" />);
    clickThroughConfirm();
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/students'));
  });

  it('cancel returns to the unconfirmed state without fetching', () => {
    render(<RemoveStudentButton invitationId="inv-1" studentName="Lena Visser" />);
    fireEvent.click(screen.getByRole('button', { name: /remove contact/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByText(/from your contacts\?/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The backstop, not the UX — the contact page hides this button entirely
  // for a declined contact (see `/students/contacts/[id]/page.tsx`). This
  // pins what happens on the rare path where the click still reaches the
  // server anyway: the server's own wording, not a generic failure line.
  it('surfaces DECLINED_IS_PERMANENT verbatim if it ever reaches the server', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          message: 'This person declined. You can archive this contact, but it cannot be removed.',
          code: 'DECLINED_IS_PERMANENT',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RemoveStudentButton invitationId="inv-1" studentName="Nadia Bakker" />);
    clickThroughConfirm();
    expect(
      await screen.findByText(
        'This person declined. You can archive this contact, but it cannot be removed.',
      ),
    ).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the server sends none', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(<RemoveStudentButton invitationId="inv-1" studentName="Lena Visser" />);
    clickThroughConfirm();
    expect(await screen.findByText('Could not remove the contact. Try again.')).toBeInTheDocument();
  });
});
