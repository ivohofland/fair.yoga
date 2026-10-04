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
 * Verification of Payee: a student's bank checks the payee name against the
 * IBAN, so an IBAN is only stored with its holder name. The check reads the
 * row as it would be after the save — the PUT is partial, so the body alone
 * cannot tell an IBAN-only save that pairs with a stored name from one that
 * does not.
 */
describe('PUT /api/teachers/[id] — an IBAN needs its holder name', () => {
  const IBAN = 'NL91ABNA0417164300';
  const email = `holder-teacher-${suffix}@test.local`;
  let holderTeacherId = '';
  let holderAccountId = '';
  let holderToken = '';

  async function setBank(bank: { bankIban: string | null; bankAccountName: string | null }): Promise<void> {
    await prisma.teacher.update({ where: { id: holderTeacherId }, data: bank });
  }

  async function storedBank(): Promise<{ bankIban: string | null; bankAccountName: string | null }> {
    return prisma.teacher.findUniqueOrThrow({
      where: { id: holderTeacherId },
      select: { bankIban: true, bankAccountName: true },
    });
  }

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

  it('refuses an IBAN with no holder name, and stores nothing', async () => {
    await setBank({ bankIban: null, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bankIban: IBAN }, holderToken);
    expect(res.status).toBe(400);
    expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: null });
  });

  it('refuses an IBAN whose holder name is only whitespace', async () => {
    await setBank({ bankIban: null, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bankIban: IBAN, bankAccountName: '   ' }, holderToken);
    expect(res.status).toBe(400);
    expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: null });
  });

  it('accepts the IBAN and holder name together', async () => {
    await setBank({ bankIban: null, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bankIban: IBAN, bankAccountName: 'H. Teacher' }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
  });

  it('accepts a new holder name beside a stored IBAN', async () => {
    await setBank({ bankIban: IBAN, bankAccountName: 'Old Name' });
    const res = await putTeacher(holderTeacherId, { bankAccountName: 'H. Teacher' }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
  });

  it('accepts an IBAN added to a stored holder name', async () => {
    await setBank({ bankIban: null, bankAccountName: 'H. Teacher' });
    const res = await putTeacher(holderTeacherId, { bankIban: IBAN }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
  });

  it('refuses clearing the holder name while an IBAN is stored', async () => {
    await setBank({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
    const res = await putTeacher(holderTeacherId, { bankAccountName: null }, holderToken);
    expect(res.status).toBe(400);
    expect(await storedBank()).toEqual({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
  });

  it('accepts clearing both', async () => {
    await setBank({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
    const res = await putTeacher(holderTeacherId, { bankIban: null, bankAccountName: null }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: null });
  });

  it('stores blank bank fields as null', async () => {
    await setBank({ bankIban: null, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bankIban: '  ', bankAccountName: '' }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: null });
  });

  it('accepts a holder name with no IBAN', async () => {
    await setBank({ bankIban: null, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bankIban: null, bankAccountName: 'H. Teacher' }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: 'H. Teacher' });
  });

  // The database holds the rule too, for writes that do not come through
  // this route and for a teacher racing their own two saves past its check.
  describe('the database refuses an IBAN without its holder name', () => {
    async function refusalOf(bank: { bankIban: string | null; bankAccountName: string | null }): Promise<unknown> {
      await setBank({ bankIban: null, bankAccountName: null });
      return setBank(bank).then(
        () => 'stored',
        (err: unknown) => err,
      );
    }

    it('refuses an IBAN with a null holder name', async () => {
      const err = await refusalOf({ bankIban: IBAN, bankAccountName: null });
      expect(isCheckViolationOn(err, 'Teacher_bank_holder_name_check')).toBe(true);
      expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: null });
    });

    it('refuses an IBAN whose holder name is only spaces', async () => {
      const err = await refusalOf({ bankIban: IBAN, bankAccountName: '   ' });
      expect(isCheckViolationOn(err, 'Teacher_bank_holder_name_check')).toBe(true);
      expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: null });
    });

    it('refuses a blank IBAN', async () => {
      const err = await refusalOf({ bankIban: '   ', bankAccountName: 'H. Teacher' });
      expect(isCheckViolationOn(err, 'Teacher_bank_iban_not_blank_check')).toBe(true);
    });

    it('stores an IBAN with its holder name', async () => {
      expect(await refusalOf({ bankIban: IBAN, bankAccountName: 'H. Teacher' })).toBe('stored');
    });
  });
});
