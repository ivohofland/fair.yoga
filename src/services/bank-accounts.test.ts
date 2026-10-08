import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, type Currency, type PayoutChangeEvent } from '@prisma/client';
import { saveBankAccount, removeBankAccount, type BankAccountFailure } from './bank-accounts';
import { updateTeacherProfile } from './teacher-profile';
import { resolveSteps } from '@/lib/onboarding';
import { hasPayoutDetails } from '@/lib/payment-methods';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const teacherIds: string[] = [];

async function makeTeacher(currency: Currency = 'EUR'): Promise<string> {
  const s = uniqueSuffix();
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Bank', lastName: 'Teacher', email: `bank-acct-${s}@test.local`, currency,
      account: { create: { email: `bank-acct-${s}@test.local` } }, bio: '', pageSlug: `bank-acct-${s}`,
    },
  });
  teacherIds.push(t.id);
  return t.id;
}

afterAll(async () => {
  if (teacherIds.length > 0) {
    const accounts = await prisma.teacher.findMany({ where: { id: { in: teacherIds } }, select: { accountId: true } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } }); // cascades TeacherBankAccount
    const accountIds = accounts.map((a) => a.accountId);
    if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
});

async function storedAccounts(teacherId: string) {
  return prisma.teacherBankAccount.findMany({
    where: { teacherId },
    select: { currency: true, holderName: true, iban: true, bic: true, sortCode: true, accountNumber: true, routingNumber: true },
    orderBy: { currency: 'asc' },
  });
}

type EventRow = Pick<PayoutChangeEvent, 'id' | 'kind' | 'accountCurrency' | 'before' | 'after'>;

async function events(teacherId: string): Promise<EventRow[]> {
  return prisma.payoutChangeEvent.findMany({
    where: { teacherId },
    select: { id: true, kind: true, accountCurrency: true, before: true, after: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** Fails when any event column holds `secret` whole. */
async function expectNoEventHolds(teacherId: string, secret: string): Promise<void> {
  const rows = await prisma.payoutChangeEvent.findMany({ where: { teacherId } });
  expect(rows.length).toBeGreaterThan(0);
  expect(JSON.stringify(rows)).not.toContain(secret);
}

describe('saveBankAccount', () => {
  it('saves a euro account, normalised', async () => {
    const teacherId = await makeTeacher();
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: '  A. Teacher ', iban: 'nl91 abna 0417 1643 00' });
    expect(out.kind).toBe('saved');
    expect(await storedAccounts(teacherId)).toEqual([
      { currency: 'EUR', holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: null, sortCode: null, accountNumber: null, routingNumber: null },
    ]);
  });

  it('refuses a non-EEA IBAN in euros without a BIC, and stores nothing', async () => {
    const teacherId = await makeTeacher();
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'CH9300762011623852957' });
    expect(out).toEqual({ kind: 'invalid', failure: { error: 'bic_required', field: 'bic' } });
    expect(await storedAccounts(teacherId)).toEqual([]);
  });

  it('refuses a blank holder name', async () => {
    const teacherId = await makeTeacher();
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: '   ', iban: 'NL91ABNA0417164300' });
    expect(out).toEqual({ kind: 'invalid', failure: { error: 'holder_required', field: 'holderName' } });
    expect(await storedAccounts(teacherId)).toEqual([]);
  });

  it('saves a sterling account by sort code', async () => {
    const teacherId = await makeTeacher('GBP');
    const out = await saveBankAccount(prisma, teacherId, 'GBP', { holderName: 'A. Teacher', sortCode: '12-34-56', accountNumber: '12345678' });
    expect(out.kind).toBe('saved');
    expect(await storedAccounts(teacherId)).toEqual([
      { currency: 'GBP', holderName: 'A. Teacher', iban: null, bic: null, sortCode: '123456', accountNumber: '12345678', routingNumber: null },
    ]);
  });

  it('stores the currency the call names, not the teacher’s current one', async () => {
    const teacherId = await makeTeacher('GBP');
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    expect(out.kind).toBe('saved');
    expect((await storedAccounts(teacherId)).map((a) => a.currency)).toEqual(['EUR']);
  });

  // EUR and CHF accounts both hold an IBAN, so only the stored currency
  // tells the two apart.
  it('stores the named currency when the teacher’s current one shares its columns', async () => {
    const teacherId = await makeTeacher('CHF');
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    expect(out.kind).toBe('saved');
    expect((await storedAccounts(teacherId)).map((a) => a.currency)).toEqual(['EUR']);
  });

  it('replaces an existing account in the same currency, keeping one row', async () => {
    const teacherId = await makeTeacher();
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'Old Name', iban: 'NL91ABNA0417164300' });
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'New Name', iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A' });
    expect(out.kind).toBe('saved');
    expect(await storedAccounts(teacherId)).toEqual([
      { currency: 'EUR', holderName: 'New Name', iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A', sortCode: null, accountNumber: null, routingNumber: null },
    ]);
  });

  it('clears a stored BIC when the replacing save has none', async () => {
    const teacherId = await makeTeacher();
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' });
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    expect(out.kind).toBe('saved');
    expect(await storedAccounts(teacherId)).toEqual([
      { currency: 'EUR', holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: null, sortCode: null, accountNumber: null, routingNumber: null },
    ]);
  });

  it('answers teacher_gone for an erased teacher and stores nothing', async () => {
    const teacherId = await makeTeacher();
    await prisma.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    expect(out).toEqual({ kind: 'teacher_gone' });
    expect(await storedAccounts(teacherId)).toEqual([]);
    expect(await events(teacherId)).toEqual([]);
  });
});

describe('saveBankAccount records a payout-change event (#786)', () => {
  it('records an add with no before and the masked identifier after, and returns its id', async () => {
    const teacherId = await makeTeacher();
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    if (out.kind !== 'saved') throw new Error(`expected saved, got ${out.kind}`);
    expect(await events(teacherId)).toEqual([
      { id: out.eventId, kind: 'bank_account_added', accountCurrency: 'EUR', before: null, after: '•••• 4300' },
    ]);
    await expectNoEventHolds(teacherId, 'NL91ABNA0417164300');
  });

  it('records an edit with both identifiers masked', async () => {
    const teacherId = await makeTeacher();
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A' });
    if (out.kind !== 'saved') throw new Error(`expected saved, got ${out.kind}`);
    expect((await events(teacherId)).slice(1)).toEqual([
      { id: out.eventId, kind: 'bank_account_changed', accountCurrency: 'EUR', before: '•••• 4300', after: '•••• 2957' },
    ]);
    await expectNoEventHolds(teacherId, 'NL91ABNA0417164300');
    await expectNoEventHolds(teacherId, 'CH9300762011623852957');
  });

  it('names the account’s own currency, not the teacher’s', async () => {
    const teacherId = await makeTeacher('EUR');
    await saveBankAccount(prisma, teacherId, 'GBP', { holderName: 'A. Teacher', sortCode: '123456', accountNumber: '12345678' });
    expect(await events(teacherId)).toMatchObject([{ kind: 'bank_account_added', accountCurrency: 'GBP', after: '•••• 5678' }]);
    await expectNoEventHolds(teacherId, '12345678');
  });

  it('answers unchanged to a re-save that stores the same values, and records nothing', async () => {
    const teacherId = await makeTeacher();
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' });
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: ' A. Teacher ', iban: 'nl91 abna 0417 1643 00', bic: 'abnanl2a' });
    expect(out).toMatchObject({ kind: 'unchanged', account: { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' } });
    expect(await events(teacherId)).toHaveLength(1);
  });

  // Every stored column the upsert writes takes part in the comparison: a
  // change to any one of them alone is a save, and records an edit.
  it.each([
    ['holderName', 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' }, { holderName: 'B. Teacher', iban: 'NL91ABNA0417164300' }],
    ['iban', 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' }, { holderName: 'A. Teacher', iban: 'DE89370400440532013000' }],
    ['bic', 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' }, { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' }],
    ['sortCode', 'GBP', { holderName: 'A. Teacher', sortCode: '123456', accountNumber: '12345678' }, { holderName: 'A. Teacher', sortCode: '654321', accountNumber: '12345678' }],
    ['accountNumber', 'GBP', { holderName: 'A. Teacher', sortCode: '123456', accountNumber: '12345678' }, { holderName: 'A. Teacher', sortCode: '123456', accountNumber: '87654321' }],
    ['routingNumber', 'USD', { holderName: 'A. Teacher', routingNumber: '021000021', accountNumber: '1234567' }, { holderName: 'A. Teacher', routingNumber: '011000015', accountNumber: '1234567' }],
  ] as const)('saves and records an edit when only %s differs', async (_column, currency, first, second) => {
    const teacherId = await makeTeacher(currency);
    expect((await saveBankAccount(prisma, teacherId, currency, first)).kind).toBe('saved');
    const out = await saveBankAccount(prisma, teacherId, currency, second);
    expect(out.kind).toBe('saved');
    expect((await events(teacherId)).map((e) => e.kind)).toEqual(['bank_account_added', 'bank_account_changed']);
  });
});

describe('BankAccountFailure', () => {
  it('pairs holder_required with the holder name only', () => {
    const paired: BankAccountFailure = { error: 'holder_required', field: 'holderName' };
    // @ts-expect-error holder_required names the holder name, never a scheme field
    const mispaired: BankAccountFailure = { error: 'holder_required', field: 'iban' };
    expect([paired, mispaired]).toHaveLength(2);
  });
});

describe('removeBankAccount', () => {
  it('removes the account in that currency only', async () => {
    const teacherId = await makeTeacher();
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    await saveBankAccount(prisma, teacherId, 'GBP', { holderName: 'A. Teacher', sortCode: '123456', accountNumber: '12345678' });
    const out = await removeBankAccount(prisma, teacherId, 'EUR');
    expect(out).toEqual({ kind: 'removed', eventId: expect.any(String) });
    expect((await storedAccounts(teacherId)).map((a) => a.currency)).toEqual(['GBP']);
  });

  it('records the removal with the masked identifier before, and returns its id (#786)', async () => {
    const teacherId = await makeTeacher();
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    const out = await removeBankAccount(prisma, teacherId, 'EUR');
    if (out.kind !== 'removed') throw new Error(`expected removed, got ${out.kind}`);
    expect((await events(teacherId)).slice(1)).toEqual([
      { id: out.eventId, kind: 'bank_account_removed', accountCurrency: 'EUR', before: '•••• 4300', after: null },
    ]);
    await expectNoEventHolds(teacherId, 'NL91ABNA0417164300');
  });

  it('answers absent when there is no account in that currency, and records nothing', async () => {
    const teacherId = await makeTeacher();
    expect(await removeBankAccount(prisma, teacherId, 'EUR')).toEqual({ kind: 'absent' });
    expect(await events(teacherId)).toEqual([]);
  });

  it('answers teacher_gone for an erased teacher, and records nothing', async () => {
    const teacherId = await makeTeacher();
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    await prisma.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });
    expect(await removeBankAccount(prisma, teacherId, 'EUR')).toEqual({ kind: 'teacher_gone' });
    expect((await events(teacherId)).map((e) => e.kind)).toEqual(['bank_account_added']);
  });
});

describe('the onboarding bank step against stored accounts', () => {
  async function bankDone(teacherId: string): Promise<boolean> {
    const teacher = await prisma.teacher.findUniqueOrThrow({
      where: { id: teacherId },
      select: { currency: true, paymentLink: true, bankAccounts: { select: { currency: true } } },
    });
    const steps = resolveSteps({
      bio: '',
      payoutDetailsSet: hasPayoutDetails(teacher),
      roomCount: 0,
      classCount: 0,
      skipped: [],
    });
    return steps.find((s) => s.key === 'bank')?.state === 'done';
  }

  it('is done with an account in the current currency, and not after a switch until one exists in the new one', async () => {
    const teacherId = await makeTeacher('EUR');
    expect(await bankDone(teacherId)).toBe(false);
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    expect(await bankDone(teacherId)).toBe(true);

    expect((await updateTeacherProfile(prisma, teacherId, { currency: 'GBP', fields: {} })).kind).toBe('saved');
    expect(await bankDone(teacherId)).toBe(false);

    await saveBankAccount(prisma, teacherId, 'GBP', { holderName: 'A. Teacher', sortCode: '123456', accountNumber: '12345678' });
    expect(await bankDone(teacherId)).toBe(true);
  });

  it('is done with a payment link and no account, whatever the currency', async () => {
    const teacherId = await makeTeacher('GBP');
    await prisma.teacher.update({ where: { id: teacherId }, data: { paymentLink: 'https://revolut.me/anna' } });
    expect(await bankDone(teacherId)).toBe(true);
  });
});
