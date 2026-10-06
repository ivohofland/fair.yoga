import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { expectRefusal } from '../api-assertions';
import { isCheckViolationOn } from '@/lib/check-violation';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let teacherAccountId: string;
let teacherToken: string;
let otherTeacherId: string;

async function putTeacher(
  id: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  return fetch(`${BASE_URL}/api/teachers/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? cookie(token) : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/teachers/[id]', () => {
  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Settings',
        lastName: 'Teacher',
        email: `settings-teacher-${suffix}@test.local`,
        account: { create: { email: `settings-teacher-${suffix}@test.local` } },
        bio: 'Teacher settings tests',
        pageSlug: `settings-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const other = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: `settings-other-${suffix}@test.local`,
        account: { create: { email: `settings-other-${suffix}@test.local` } },
        bio: 'Ownership fixture',
        pageSlug: `settings-other-${suffix}`,
      },
    });
    otherTeacherId = other.id;

    teacherToken = await seedSession(prisma, teacherAccountId);
  });

  afterAll(async () => {
    if (teacherAccountId) {
      await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
    }
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    if (otherTeacherId) await prisma.teacher.delete({ where: { id: otherTeacherId } });
    await prisma.account.deleteMany({
      where: {
        email: {
          in: [
            `settings-teacher-${suffix}@test.local`,
            `settings-other-${suffix}@test.local`,
          ],
        },
      },
    });
    await prisma.$disconnect();
  });

  it('updates and persists valid settings — resubmitting the own slug is not a conflict', async () => {
    const res = await putTeacher(
      teacherId,
      {
        bio: 'Updated bio',
        defaultTimezone: 'Europe/London',
        // The unchanged own slug must pass the conflict check: losing the
        // existing.id !== id exclusion would 409 every settings save.
        pageSlug: `settings-teacher-${suffix}`,
      },
      teacherToken,
    );
    expect(res.status).toBe(200);

    const persisted = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(persisted.bio).toBe('Updated bio');
    expect(persisted.defaultTimezone).toBe('Europe/London');
  });

  it('rejects unknown fields — the schema is strict', async () => {
    const res = await putTeacher(teacherId, { role: 'admin' }, teacherToken);
    expect(res.status).toBe(400);
  });

  it('rejects a timezone Intl cannot resolve', async () => {
    const before = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });

    const res = await putTeacher(teacherId, { defaultTimezone: 'Not/AZone' }, teacherToken);
    expect(res.status).toBe(400);

    const after = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(after).toEqual(before);
  });

  it('stores a renamed zone under its current IANA name', async () => {
    const res = await putTeacher(teacherId, { defaultTimezone: 'Europe/Kiev' }, teacherToken);
    expect(res.status).toBe(200);

    const persisted = await prisma.teacher.findUniqueOrThrow({
      where: { id: teacherId },
      select: { defaultTimezone: true },
    });
    expect(persisted.defaultTimezone).toBe('Europe/Kyiv');
  });

  it("rejects updating another teacher's profile", async () => {
    const res = await putTeacher(otherTeacherId, { bio: 'Hijacked' }, teacherToken);
    expect(res.status).toBe(403);

    const persisted = await prisma.teacher.findUniqueOrThrow({ where: { id: otherTeacherId } });
    expect(persisted.bio).toBe('Ownership fixture');
  });

  it('round-trips the notification preferences without touching the profile (#49)', async () => {
    const before = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    const res = await putTeacher(teacherId, {
      bookingNotifications: 'inbox_only',
      emailOnClassCompleted: false,
      emailOnInvitation: false,
      classReminder: 'evening_before',
      classReminderChannel: 'inbox',
    }, teacherToken);
    expect(res.status).toBe(200);
    const after = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(after.bookingNotifications).toBe('inbox_only');
    expect(after.emailOnClassCompleted).toBe(false);
    expect(after.emailOnInvitation).toBe(false);
    expect(after.classReminder).toBe('evening_before');
    expect(after.classReminderChannel).toBe('inbox');
    // every other column is untouched; only the preferences moved
    expect({ ...after, bookingNotifications: before.bookingNotifications, emailOnClassCompleted: before.emailOnClassCompleted, emailOnInvitation: before.emailOnInvitation, classReminder: before.classReminder, classReminderChannel: before.classReminderChannel, updatedAt: before.updatedAt })
      .toEqual(before);
  });

  it('refuses an unknown bookingNotifications value (#49)', async () => {
    const res = await putTeacher(teacherId, { bookingNotifications: 'sometimes' }, teacherToken);
    expect(res.status).toBe(400);
  });

  it('refuses an unknown classReminder value (#721)', async () => {
    const res = await putTeacher(teacherId, { classReminder: 'eve' }, teacherToken);
    expect(res.status).toBe(400);
  });

  it('refuses the retired defaultReminder key (#721)', async () => {
    const res = await putTeacher(teacherId, { defaultReminder: 'morning_of' }, teacherToken);
    expect(res.status).toBe(400);
  });

  it('refuses a non-boolean email toggle (#49)', async () => {
    const res = await putTeacher(teacherId, { emailOnInvitation: 'no' }, teacherToken);
    expect(res.status).toBe(400);
  });

  it('refuses another teacher writing these preferences (#49)', async () => {
    const res = await putTeacher(otherTeacherId, { bookingNotifications: 'off' }, teacherToken);
    expect(res.status).toBe(403);
    const other = await prisma.teacher.findUniqueOrThrow({ where: { id: otherTeacherId } });
    expect(other.bookingNotifications).toBe('inbox_and_email');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await putTeacher(teacherId, { bio: 'Anonymous' });
    expect(res.status).toBe(401);
  });

  it("rejects claiming another teacher's page slug with the SLUG_TAKEN code", async () => {
    const res = await putTeacher(
      teacherId,
      { pageSlug: `settings-other-${suffix}` },
      teacherToken,
    );
    // The pre-check's answer. A slug claimed after that read reaches the
    // update's own catch, which answers the same code
    // (`src/app/api/teachers/[id]/route-lock-order.test.ts`).
    await expectRefusal(res, 'SLUG_TAKEN');
  });

  it("rejects reading another teacher's profile — the raw row carries bank details", async () => {
    const res = await fetch(`${BASE_URL}/api/teachers/${otherTeacherId}`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(403);
  });
});

/**
 * Bank details live in `TeacherBankAccount`, one row per currency; the
 * profile PUT names none of them.
 */
describe('PUT /api/teachers/[id] — no bank fields', () => {
  const email = `holder-teacher-${suffix}@test.local`;
  let holderTeacherId = '';
  let holderAccountId = '';
  let holderToken = '';

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Holder',
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: 'Holder-name fixture',
        pageSlug: `holder-teacher-${suffix}`,
      },
    });
    holderTeacherId = teacher.id;
    holderAccountId = teacher.accountId;
    holderToken = await seedSession(prisma, holderAccountId);
  });

  afterAll(async () => {
    if (holderAccountId) await prisma.session.deleteMany({ where: { accountId: holderAccountId } });
    if (holderTeacherId) await prisma.teacher.delete({ where: { id: holderTeacherId } });
    await prisma.account.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it('refuses a body naming the old bank fields with the schema’s 400, and stores no account', async () => {
    const res = await putTeacher(
      holderTeacherId,
      { bankIban: 'NL91ABNA0417164300', bankAccountName: 'H. Teacher' },
      holderToken,
    );
    expect(res.status).toBe(400);
    expect(await prisma.teacherBankAccount.count({ where: { teacherId: holderTeacherId } })).toBe(0);
  });

  /**
   * `TeacherBankAccount_scheme_check`: each currency sets exactly its
   * scheme's columns, and the holder name is never blank.
   */
  describe('the database holds each currency to its scheme', () => {
    const blank = { iban: null, bic: null, sortCode: null, accountNumber: null, routingNumber: null };
    type Row = { currency: 'EUR' | 'GBP' | 'USD' | 'CHF'; holderName: string } & Partial<Record<keyof typeof blank, string>>;

    async function store(row: Row): Promise<unknown> {
      await prisma.teacherBankAccount.deleteMany({ where: { teacherId: holderTeacherId } });
      return prisma.teacherBankAccount.create({ data: { teacherId: holderTeacherId, ...blank, ...row } }).then(
        () => 'stored',
        (err: unknown) => err,
      );
    }

    it.each<[string, Row]>([
      ['a EUR IBAN', { currency: 'EUR', holderName: 'H. Teacher', iban: 'NL91ABNA0417164300' }],
      ['a EUR IBAN with its BIC', { currency: 'EUR', holderName: 'H. Teacher', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' }],
      ['a CHF IBAN', { currency: 'CHF', holderName: 'H. Teacher', iban: 'CH9300762011623852957' }],
      ['a GBP sort code and account number', { currency: 'GBP', holderName: 'H. Teacher', sortCode: '123456', accountNumber: '12345678' }],
      ['a USD routing and account number', { currency: 'USD', holderName: 'H. Teacher', routingNumber: '021000021', accountNumber: '1234567' }],
    ])('stores %s', async (_label, row) => {
      expect(await store(row)).toBe('stored');
    });

    it.each<[string, Row]>([
      ['a holder name of only spaces', { currency: 'EUR', holderName: '   ', iban: 'NL91ABNA0417164300' }],
      ['a EUR account with no IBAN', { currency: 'EUR', holderName: 'H. Teacher' }],
      ['a EUR IBAN of only spaces', { currency: 'EUR', holderName: 'H. Teacher', iban: '   ' }],
      ['a BIC of only spaces', { currency: 'EUR', holderName: 'H. Teacher', iban: 'NL91ABNA0417164300', bic: '  ' }],
      ['a EUR account with a sort code', { currency: 'EUR', holderName: 'H. Teacher', iban: 'NL91ABNA0417164300', sortCode: '123456' }],
      ['a GBP account with an IBAN', { currency: 'GBP', holderName: 'H. Teacher', sortCode: '123456', accountNumber: '12345678', iban: 'GB29NWBK60161331926819' }],
      ['a GBP account with a BIC', { currency: 'GBP', holderName: 'H. Teacher', sortCode: '123456', accountNumber: '12345678', bic: 'NWBKGB2L' }],
      ['a GBP account with no account number', { currency: 'GBP', holderName: 'H. Teacher', sortCode: '123456' }],
      ['a GBP sort code of only spaces', { currency: 'GBP', holderName: 'H. Teacher', sortCode: ' ', accountNumber: '12345678' }],
      ['a USD account with no routing number', { currency: 'USD', holderName: 'H. Teacher', accountNumber: '1234567' }],
      ['a USD account with a sort code', { currency: 'USD', holderName: 'H. Teacher', routingNumber: '021000021', accountNumber: '1234567', sortCode: '123456' }],
    ])('refuses %s', async (_label, row) => {
      const err = await store(row);
      expect(isCheckViolationOn(err, 'TeacherBankAccount_scheme_check')).toBe(true);
      expect(await prisma.teacherBankAccount.count({ where: { teacherId: holderTeacherId } })).toBe(0);
    });
  });
});
