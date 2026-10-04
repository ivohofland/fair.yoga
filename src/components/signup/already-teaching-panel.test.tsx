import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AlreadyTeachingPanel } from './already-teaching-panel';
import { routerPush } from '../../../tests/setup/components';
import { enqueueAttendance, resetOutboxForTests } from '@/lib/attendance-outbox';

describe('AlreadyTeachingPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    resetOutboxForTests();
  });

  it('names the address the browser is signed in as, and why that settles it', () => {
    render(<AlreadyTeachingPanel email="ivo@example.com" accountId="acc-1" />);

    expect(screen.getByText('ivo@example.com')).toBeInTheDocument();
    expect(screen.getByText(/already has a teacher page/)).toBeInTheDocument();
  });

  it('offers the schedule as the way on', () => {
    render(<AlreadyTeachingPanel email="ivo@example.com" accountId="acc-1" />);

    expect(screen.getByRole('link', { name: /Go to your schedule/ })).toHaveAttribute(
      'href',
      '/schedule',
    );
  });

  it('signs out back to /signup, the page the reader was trying to use', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<AlreadyTeachingPanel email="ivo@example.com" accountId="acc-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/signup'));
    expect(routerPush).not.toHaveBeenCalledWith('/login');
  });

  // The panel's account has a teacher page, so its queue may hold check-ins
  // taken offline.
  it("tries to sync the account's queued attendance, and says what would be lost before signing out", async () => {
    enqueueAttendance('acc-1', {
      registrationId: 'reg-1',
      classId: 'class-1',
      classLabel: 'Hatha on Tue 6 Oct 18:00',
      studentName: 'Grace Hopper',
      target: 'attended',
      knownCompleted: false,
    });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    render(<AlreadyTeachingPanel email="ivo@example.com" accountId="acc-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText("1 attendance change hasn't synced and will be lost.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/registrations/reg-1', expect.objectContaining({ method: 'PUT' }));
    expect(fetchMock).not.toHaveBeenCalledWith('/api/auth/session', expect.anything());
    expect(routerPush).not.toHaveBeenCalled();
  });
});
