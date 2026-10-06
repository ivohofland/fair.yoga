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
vi.mock('@/components/settings/bank-account-form', () => ({
  BankAccountForm: (props: { currency: string; initial: Record<string, string>; others: unknown[] }) => (
    <span data-testid="bank-account-form" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock('@/components/account/account-security', () => ({ AccountSecurity: () => null }));
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
      currency: 'EUR',
      defaultTimezone: 'Europe/Amsterdam',
      photo: null,
      bankAccounts: [],
    });

    render(await ProfilePage());

    expect(screen.getByTestId('data-and-deletion')).toHaveAttribute('data-account-id', 'acct-1');
  });

  it('hands the bank block the current currency’s account and masks the others', async () => {
    requireTeacherSession.mockResolvedValue({ accountId: 'acct-1', teacherId: 'teacher-1', studentId: null });
    const none = { iban: null, bic: null, sortCode: null, accountNumber: null, routingNumber: null };
    findUniqueOrThrow.mockResolvedValue({
      id: 'teacher-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', bio: '', pageSlug: 'ada',
      currency: 'GBP', defaultTimezone: 'Europe/London', photo: null,
      bankAccounts: [
        { ...none, currency: 'EUR', holderName: 'Ada L', iban: 'NL91ABNA0417164300' },
        { ...none, currency: 'GBP', holderName: 'Ada Lovelace', sortCode: '123456', accountNumber: '12345678' },
      ],
    });

    render(await ProfilePage());

    const props = JSON.parse(screen.getByTestId('bank-account-form').getAttribute('data-props') ?? '{}') as unknown;
    expect(props).toEqual({
      currency: 'GBP',
      teacherId: 'teacher-1',
      hasAccount: true,
      initial: { holderName: 'Ada Lovelace', iban: '', bic: '', sortCode: '123456', accountNumber: '12345678', routingNumber: '' },
      others: [{ currency: 'EUR', masked: '•••• 4300' }],
    });
  });

  it('says there is no current-currency account to remove when only another currency has one', async () => {
    requireTeacherSession.mockResolvedValue({ accountId: 'acct-1', teacherId: 'teacher-1', studentId: null });
    const none = { iban: null, bic: null, sortCode: null, accountNumber: null, routingNumber: null };
    findUniqueOrThrow.mockResolvedValue({
      id: 'teacher-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', bio: '', pageSlug: 'ada',
      currency: 'GBP', defaultTimezone: 'Europe/London', photo: null,
      bankAccounts: [{ ...none, currency: 'EUR', holderName: 'Ada L', iban: 'NL91ABNA0417164300' }],
    });

    render(await ProfilePage());

    const props = JSON.parse(screen.getByTestId('bank-account-form').getAttribute('data-props') ?? '{}') as { hasAccount: boolean };
    expect(props.hasAccount).toBe(false);
  });
});
