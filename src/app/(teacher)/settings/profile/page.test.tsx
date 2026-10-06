import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { requireTeacherSession, findUniqueOrThrow } = vi.hoisted(() => ({
  requireTeacherSession: vi.fn(),
  findUniqueOrThrow: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ requireTeacherSession }));
vi.mock('@/lib/db', () => ({ prisma: { teacher: { findUniqueOrThrow } } }));
vi.mock('@/components/settings/profile-form', () => ({ ProfileForm: () => null }));
vi.mock('@/components/settings/profile-photo-field', () => ({ ProfilePhotoField: () => null }));
vi.mock('@/components/account/add-passkey', () => ({ AddPasskey: () => null }));
vi.mock('@/components/account/data-and-deletion', () => ({
  DataAndDeletion: ({ accountId }: { accountId: string }) => (
    <span data-testid="data-and-deletion" data-account-id={accountId} />
  ),
}));

import ProfilePage from './page';

describe('ProfilePage', () => {
  it('deletes as the session\'s account, so only its queued attendance changes are cleared', async () => {
    requireTeacherSession.mockResolvedValue({ accountId: 'acct-1', teacherId: 'teacher-1', studentId: null });
    findUniqueOrThrow.mockResolvedValue({
      id: 'teacher-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      bio: null,
      pageSlug: 'ada',
      defaultCurrency: 'EUR',
      defaultTimezone: 'Europe/Amsterdam',
      photo: null,
    });

    render(await ProfilePage());

    expect(screen.getByTestId('data-and-deletion')).toHaveAttribute('data-account-id', 'acct-1');
  });
});
