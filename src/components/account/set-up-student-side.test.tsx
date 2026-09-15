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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({}) }));
    render(<SetUpStudentSide />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith(STUDENT_INVITATION_PATH));
  });

  it('says so, and stays put, when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    render(<SetUpStudentSide />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not set up your student side/);
    expect(routerPush).not.toHaveBeenCalled();
  });
});
