import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, type Currency } from '@prisma/client';
import { saveBankAccount, removeBankAccount } from './bank-accounts';
import { updateTeacherProfile } from './teacher-profile';
import { resolveSteps } from '@/lib/onboarding';
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
    expect(out).toEqual({ kind: 'invalid', error: 'bic_required', field: 'bic' });
    expect(await storedAccounts(teacherId)).toEqual([]);
  });

  it('refuses a blank holder name', async () => {
    const teacherId = await makeTeacher();
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: '   ', iban: 'NL91ABNA0417164300' });
    expect(out).toEqual({ kind: 'invalid', error: 'holder_required', field: 'holderName' });
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

  it('replaces an existing account in the same currency, keeping one row', async () => {
    const teacherId = await makeTeacher();
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'Old Name', iban: 'NL91ABNA0417164300' });
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'New Name', iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A' });
    expect(out.kind).toBe('saved');
    expect(await storedAccounts(teacherId)).toEqual([
      { currency: 'EUR', holderName: 'New Name', iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A', sortCode: null, accountNumber: null, routingNumber: null },
    ]);
  });

  it('answers teacher_gone for an erased teacher and stores nothing', async () => {
    const teacherId = await makeTeacher();
    await prisma.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });
    const out = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    expect(out).toEqual({ kind: 'teacher_gone' });
    expect(await storedAccounts(teacherId)).toEqual([]);
  });
});

describe('removeBankAccount', () => {
  it('removes the account in that currency only', async () => {
    const teacherId = await makeTeacher();
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    await saveBankAccount(prisma, teacherId, 'GBP', { holderName: 'A. Teacher', sortCode: '123456', accountNumber: '12345678' });
    expect(await removeBankAccount(prisma, teacherId, 'EUR')).toEqual({ kind: 'removed' });
    expect((await storedAccounts(teacherId)).map((a) => a.currency)).toEqual(['GBP']);
  });

  it('answers absent when there is no account in that currency', async () => {
    const teacherId = await makeTeacher();
    expect(await removeBankAccount(prisma, teacherId, 'EUR')).toEqual({ kind: 'absent' });
  });

  it('answers teacher_gone for an erased teacher', async () => {
    const teacherId = await makeTeacher();
    await prisma.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });
    expect(await removeBankAccount(prisma, teacherId, 'EUR')).toEqual({ kind: 'teacher_gone' });
  });
});

describe('the onboarding bank step against stored accounts', () => {
  async function bankDone(teacherId: string): Promise<boolean> {
    const teacher = await prisma.teacher.findUniqueOrThrow({
      where: { id: teacherId },
      select: { currency: true, bankAccounts: { select: { currency: true } } },
    });
    const steps = resolveSteps({
      bio: '',
      bankAccountInCurrentCurrency: teacher.bankAccounts.some((a) => a.currency === teacher.currency),
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
});
