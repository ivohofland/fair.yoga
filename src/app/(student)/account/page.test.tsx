import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { enqueueAttendance, resetOutboxForTests } from '@/lib/attendance-outbox';

const STUDENT_ID = 'student-1';

const { findUnique, getSession, redirect } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getSession: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: { student: { findUnique } },
}));
vi.mock('@/lib/session', () => ({ getSession }));
vi.mock('next/navigation', () => ({
  redirect,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import StudentSettingsPage from './page';

describe('StudentSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    resetOutboxForTests();
  });

  // A dual-hat account reaches this page from its teacher settings; its queue
  // may hold check-ins taken offline.
  it("signs out through the account's attendance queue: a mark that cannot sync is named first", async () => {
    getSession.mockResolvedValue({ accountId: 'acc-1', studentId: STUDENT_ID, teacherId: 'teacher-1' });
    findUnique.mockResolvedValue({ id: STUDENT_ID, firstName: 'Anna', lastName: 'Smith' });
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

    render(await StudentSettingsPage());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText("1 attendance change hasn't synced and will be lost.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/auth/session', expect.anything());
  });

  it('renders NameForm with student name and settings links', async () => {
    getSession.mockResolvedValue({ studentId: STUDENT_ID, teacherId: null });
    findUnique.mockResolvedValue({
      id: STUDENT_ID,
      firstName: 'Anna',
      lastName: 'Smith',
    });

    const page = await StudentSettingsPage();
    render(page);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: STUDENT_ID } }),
    );

    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Personal details', level: 2 })).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Anna');
    expect(screen.getByLabelText('Last name')).toHaveValue('Smith');

    // Index links
    expect(screen.getByRole('link', { name: /your tier/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /notifications/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /privacy/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /data & deletion/i })).toBeInTheDocument();
  });

  it('redirects to /login when the student row is missing', async () => {
    getSession.mockResolvedValue({ studentId: STUDENT_ID, teacherId: null });
    findUnique.mockResolvedValue(null);
    redirect.mockImplementationOnce(() => {
      throw new Error('REDIRECT');
    });

    await expect(StudentSettingsPage()).rejects.toThrow('REDIRECT');

    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
