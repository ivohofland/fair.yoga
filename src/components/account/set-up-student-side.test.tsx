import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerPush } from '../../../tests/setup/components';
import { STUDENT_INVITATION_PATH } from '@/lib/notification-links';
import { SetUpStudentSide } from './set-up-student-side';

describe('SetUpStudentSide (#172)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('adds the student side, then goes to the page that answers invitations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchMock);
    render(<SetUpStudentSide />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith(STUDENT_INVITATION_PATH));
    expect(fetchMock).toHaveBeenCalledWith('/api/account/student-profile', { method: 'POST' });
  });

  it('treats a student side that already exists as done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { studentId: 's-1' }, outcome: 'unchanged' }),
    }));
    render(<SetUpStudentSide />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith(STUDENT_INVITATION_PATH));
  });

  // A student side that already exists is a 200, so no 409 is a disguised
  // success. Treating one as success navigated to a page this account cannot
  // open, which bounced it to the schedule saying nothing.
  it('does not claim success for any 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'UNIQUE_CONFLICT', message: 'That already exists. Refresh to see the latest.' },
      }),
    }));
    render(<SetUpStudentSide />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/That already exists/);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('says so, and stays put, when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    render(<SetUpStudentSide />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not set up your student side/);
    expect(routerPush).not.toHaveBeenCalled();
  });
});
