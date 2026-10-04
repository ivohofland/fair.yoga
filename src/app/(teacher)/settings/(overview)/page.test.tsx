import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { enqueueAttendance, resetOutboxForTests } from '@/lib/attendance-outbox';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('@/lib/session', () => ({ getSession }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import SettingsPage from './page';

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    resetOutboxForTests();
  });

  // A teacher's queue may hold check-ins taken offline.
  it("signs out through the session account's attendance queue: a mark that cannot sync is named first", async () => {
    getSession.mockResolvedValue({ accountId: 'acc-1', studentId: null, teacherId: 'teacher-1' });
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

    render(await SettingsPage());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText("1 attendance change hasn't synced and will be lost.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/registrations/reg-1', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith('/api/auth/session', expect.anything());
  });
});
