import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Prisma } from '@/lib/prisma-client';

const { requireTeacherSession, findUniqueOrThrow, mollieDeps, readConnectionView } = vi.hoisted(() => ({
  requireTeacherSession: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  mollieDeps: vi.fn(),
  readConnectionView: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ requireTeacherSession }));
vi.mock('@/lib/db', () => ({ prisma: { teacher: { findUniqueOrThrow } } }));
vi.mock('@/components/settings/profile-form', () => ({
  ProfileForm: (props: { initial: Record<string, unknown> }) => (
    <span data-testid="profile-form" data-initial={JSON.stringify(props.initial)} />
  ),
}));
vi.mock('@/components/settings/profile-photo-field', () => ({ ProfilePhotoField: () => null }));
vi.mock('@/components/settings/bank-account-form', () => ({
  BankAccountForm: (props: { currency: string; initial: Record<string, string>; others: unknown[] }) => (
    <span data-testid="bank-account-form" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock('@/components/settings/payment-link-form', () => ({
  PaymentLinkForm: (props: { teacherId: string; initial: string; hasLink: boolean }) => (
    <span data-testid="payment-link-form" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock('@/components/account/account-security', () => ({ AccountSecurity: () => null }));
vi.mock('@/services/mollie-deps', () => ({ mollieDeps }));
vi.mock('@/services/processor-connection', () => ({ readConnectionView }));
vi.mock('@/components/settings/mollie-connection-section', () => ({
  MollieConnectionSection: (props: Record<string, unknown>) => (
    <span data-testid="mollie-section" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock('@/components/account/data-and-deletion', () => ({
  DataAndDeletion: ({ accountId }: { accountId: string }) => (
    <span data-testid="data-and-deletion" data-account-id={accountId} />
  ),
}));

import ProfilePage from './page';

const TEACHER = {
  id: 'teacher-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', bio: '', pageSlug: 'ada',
  currency: 'EUR', defaultVatPercent: new Prisma.Decimal(9), defaultTimezone: 'Europe/Amsterdam', photo: null, paymentLink: null, bankAccounts: [],
};

function mollieProps(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId('mollie-section').getAttribute('data-props') ?? '{}') as Record<string, unknown>;
}

describe('ProfilePage', () => {
  beforeEach(() => {
    mollieDeps.mockReset().mockReturnValue(null);
    readConnectionView.mockReset();
  });

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
      defaultVatPercent: new Prisma.Decimal(9),
      defaultTimezone: 'Europe/Amsterdam',
      photo: null,
      paymentLink: null,
      bankAccounts: [],
    });

    render(await ProfilePage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('data-and-deletion')).toHaveAttribute('data-account-id', 'acct-1');
    const initial = JSON.parse(screen.getByTestId('profile-form').getAttribute('data-initial') ?? '{}') as Record<string, unknown>;
    expect(initial.defaultVatPercent).toBe(9);
  });

  it('hands the bank block the current currency’s account and masks the others', async () => {
    requireTeacherSession.mockResolvedValue({ accountId: 'acct-1', teacherId: 'teacher-1', studentId: null });
    const none = { iban: null, bic: null, sortCode: null, accountNumber: null, routingNumber: null, bankCode: null };
    findUniqueOrThrow.mockResolvedValue({
      id: 'teacher-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', bio: '', pageSlug: 'ada',
      currency: 'GBP', defaultVatPercent: new Prisma.Decimal(9), defaultTimezone: 'Europe/London', photo: null, paymentLink: null,
      bankAccounts: [
        { ...none, currency: 'EUR', holderName: 'Ada L', iban: 'NL91ABNA0417164300' },
        { ...none, currency: 'GBP', holderName: 'Ada Lovelace', sortCode: '123456', accountNumber: '12345678' },
      ],
    });

    render(await ProfilePage({ searchParams: Promise.resolve({}) }));

    const props = JSON.parse(screen.getByTestId('bank-account-form').getAttribute('data-props') ?? '{}') as unknown;
    expect(props).toEqual({
      currency: 'GBP',
      teacherId: 'teacher-1',
      hasAccount: true,
      initial: { holderName: 'Ada Lovelace', iban: '', bic: '', sortCode: '123456', accountNumber: '12345678', routingNumber: '', bankCode: '' },
      others: [{ currency: 'EUR', masked: '•••• 4300' }],
    });
  });

  it('says there is no current-currency account to remove when only another currency has one', async () => {
    requireTeacherSession.mockResolvedValue({ accountId: 'acct-1', teacherId: 'teacher-1', studentId: null });
    const none = { iban: null, bic: null, sortCode: null, accountNumber: null, routingNumber: null, bankCode: null };
    findUniqueOrThrow.mockResolvedValue({
      id: 'teacher-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', bio: '', pageSlug: 'ada',
      currency: 'GBP', defaultVatPercent: new Prisma.Decimal(9), defaultTimezone: 'Europe/London', photo: null, paymentLink: null,
      bankAccounts: [{ ...none, currency: 'EUR', holderName: 'Ada L', iban: 'NL91ABNA0417164300' }],
    });

    render(await ProfilePage({ searchParams: Promise.resolve({}) }));

    const props = JSON.parse(screen.getByTestId('bank-account-form').getAttribute('data-props') ?? '{}') as { hasAccount: boolean };
    expect(props.hasAccount).toBe(false);
  });

  it('hands the link block nothing to remove when no link is stored', async () => {
    requireTeacherSession.mockResolvedValue({ accountId: 'acct-1', teacherId: 'teacher-1', studentId: null });
    findUniqueOrThrow.mockResolvedValue({
      id: 'teacher-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', bio: '', pageSlug: 'ada',
      currency: 'EUR', defaultVatPercent: new Prisma.Decimal(9), defaultTimezone: 'Europe/Amsterdam', photo: null, paymentLink: null, bankAccounts: [],
    });

    render(await ProfilePage({ searchParams: Promise.resolve({}) }));

    const props = JSON.parse(screen.getByTestId('payment-link-form').getAttribute('data-props') ?? '{}') as unknown;
    expect(props).toEqual({ teacherId: 'teacher-1', initial: '', hasLink: false });
  });

  it('hands the link block the stored link', async () => {
    requireTeacherSession.mockResolvedValue({ accountId: 'acct-1', teacherId: 'teacher-1', studentId: null });
    findUniqueOrThrow.mockResolvedValue({
      id: 'teacher-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', bio: '', pageSlug: 'ada',
      currency: 'EUR', defaultVatPercent: new Prisma.Decimal(9), defaultTimezone: 'Europe/Amsterdam', photo: null, paymentLink: 'https://paypal.me/ada', bankAccounts: [],
    });

    render(await ProfilePage({ searchParams: Promise.resolve({}) }));

    const props = JSON.parse(screen.getByTestId('payment-link-form').getAttribute('data-props') ?? '{}') as unknown;
    expect(props).toEqual({ teacherId: 'teacher-1', initial: 'https://paypal.me/ada', hasLink: true });
  });

  it('hands the Mollie block an unconfigured state without asking Mollie anything', async () => {
    requireTeacherSession.mockResolvedValue({ accountId: 'acct-1', teacherId: 'teacher-1', studentId: null });
    findUniqueOrThrow.mockResolvedValue(TEACHER);

    render(await ProfilePage({ searchParams: Promise.resolve({ mollie: 'connected' }) }));

    expect(mollieProps()).toEqual({ teacherId: 'teacher-1', configured: false, view: { kind: 'none' }, status: 'connected' });
    expect(readConnectionView).not.toHaveBeenCalled();
  });

  it('hands the Mollie block the connection as Mollie describes it, and ignores an unknown return status', async () => {
    requireTeacherSession.mockResolvedValue({ accountId: 'acct-1', teacherId: 'teacher-1', studentId: null });
    findUniqueOrThrow.mockResolvedValue(TEACHER);
    mollieDeps.mockReturnValue({ marker: 'deps' });
    readConnectionView.mockResolvedValue({ kind: 'unavailable' });

    render(await ProfilePage({ searchParams: Promise.resolve({ mollie: 'bogus' }) }));

    expect(mollieProps()).toEqual({ teacherId: 'teacher-1', configured: true, view: { kind: 'unavailable' }, status: null });
    expect(readConnectionView).toHaveBeenCalledWith(expect.anything(), { marker: 'deps' }, 'teacher-1');
  });
});
