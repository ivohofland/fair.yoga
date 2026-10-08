import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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
vi.mock('@/components/account/sign-out-button', () => ({
  SignOutButton: ({ accountId }: { accountId: string | null }) => (
    <span data-testid="sign-out" data-account-id={String(accountId)} />
  ),
}));

import StudentSettingsPage from './page';

describe('StudentSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('signs out as the session\'s account, so its queued attendance changes are sent', async () => {
    getSession.mockResolvedValue({ accountId: 'acct-1', studentId: STUDENT_ID, teacherId: 'teacher-1' });
    findUnique.mockResolvedValue({ id: STUDENT_ID, firstName: 'Anna', lastName: 'Smith' });

    render(await StudentSettingsPage());

    expect(screen.getByTestId('sign-out')).toHaveAttribute('data-account-id', 'acct-1');
  });

  it('links Report a problem to the public CONTRIBUTING reporting section', async () => {
    getSession.mockResolvedValue({ accountId: 'acct-1', studentId: STUDENT_ID, teacherId: null });
    findUnique.mockResolvedValue({ id: STUDENT_ID, firstName: 'Anna', lastName: 'Smith' });

    render(await StudentSettingsPage());

    expect(screen.getByRole('link', { name: /Report a problem/ })).toHaveAttribute(
      'href',
      'https://github.com/ivohofland/fair.yoga/blob/main/CONTRIBUTING.md#teachers-and-students',
    );
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
