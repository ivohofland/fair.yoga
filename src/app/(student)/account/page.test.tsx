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
});
