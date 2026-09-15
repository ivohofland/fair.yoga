import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { requireTeacherSession, findUniqueOrThrow, listPendingInvitations, redirect } = vi.hoisted(() => ({
  requireTeacherSession: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  listPendingInvitations: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }),
}));

vi.mock('@/lib/session', () => ({ requireTeacherSession }));
vi.mock('@/lib/db', () => ({ prisma: { account: { findUniqueOrThrow } } }));
vi.mock('@/services/invitations', () => ({ listPendingInvitations }));
vi.mock('next/navigation', () => ({
  redirect,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import TeacherInvitationsPage from './page';

const TEACHER_ONLY = {
  sessionId: 's1', accountId: 'a1', teacherId: 't1', studentId: null, defaultTimezone: 'Europe/Amsterdam',
};

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueOrThrow.mockResolvedValue({ email: 'invitee@test.local' });
});

describe('the teacher invitations page (#172)', () => {
  it('sends an account that already has a student side to the student page', async () => {
    requireTeacherSession.mockResolvedValue({ ...TEACHER_ONLY, studentId: 'st1' });

    await expect(TeacherInvitationsPage()).rejects.toThrow('REDIRECT:/account/privacy');
    expect(listPendingInvitations).not.toHaveBeenCalled();
  });

  it('names each inviting teacher and offers the student side once', async () => {
    requireTeacherSession.mockResolvedValue(TEACHER_ONLY);
    listPendingInvitations.mockResolvedValue([
      { id: 'inv-1', teacher: { firstName: 'Anna', lastName: 'Teacher' } },
      { id: 'inv-2', teacher: { firstName: 'Ben', lastName: 'Teacher' } },
    ]);

    render(await TeacherInvitationsPage());

    expect(screen.getByText('Anna Teacher would like to connect with you as a student.')).toBeInTheDocument();
    expect(screen.getByText('Ben Teacher would like to connect with you as a student.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Set up student side' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute('href', '/inbox');
    expect(listPendingInvitations).toHaveBeenCalledWith(expect.anything(), { accountEmail: 'invitee@test.local' });
  });

  it('says plainly when nothing is waiting', async () => {
    requireTeacherSession.mockResolvedValue(TEACHER_ONLY);
    listPendingInvitations.mockResolvedValue([]);

    render(await TeacherInvitationsPage());

    expect(screen.getByText('No open invitations')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up student side' })).toBeNull();
  });
});
