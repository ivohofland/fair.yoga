import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, type Currency, type PaymentStatus } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { hhmmToTime } from '@/lib/time-of-day';
import { payoutFingerprint } from '@/lib/payout-fingerprint';
import { bankAccountDataSelect } from '@/lib/payment-methods';
import { sendPaymentReminders } from './payment-reminders';
import { PAUSE_PASSKEY_FALLBACK_DAYS, readResumeReview, resumePayments } from './payout-resume';
import { createClassFixture } from '../../tests/class-fixtures';
import { scopeSweep } from '../../tests/scoped-sweep';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-20T12:00:00Z');
const daysBefore = (at: Date, days: number) => new Date(at.getTime() - days * DAY_MS);
const daysAfter = (at: Date, days: number) => new Date(at.getTime() + days * DAY_MS);

const teacherIds: string[] = [];
const accountIds: string[] = [];
const studentIds: string[] = [];
const roomIds: string[] = [];

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { recipientType: 'student', recipientId: { in: studentIds } } });
  await prisma.payment.deleteMany({ where: { registration: { studentId: { in: studentIds } } } });
  await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

interface Paused {
  teacherId: string;
  accountId: string;
  pausedAt: Date;
  windowStart: Date;
}

/**
 * A teacher paused at `pausedAt` (default: three days before NOW) with a
 * window starting two days before that, and `cutoff` as the frozen passkey
 * cutoff.
 */
async function pausedTeacher(opts: { cutoff?: Date | null; pausedAt?: Date; paused?: boolean } = {}): Promise<Paused> {
  const s = uniqueSuffix();
  const email = `resume-${s}@test.local`;
  const pausedAt = opts.pausedAt ?? daysBefore(NOW, 3);
  const windowStart = daysBefore(pausedAt, 2);
  const paused = opts.paused ?? true;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Resume', lastName: 'Teacher', email, bio: '', pageSlug: `resume-${s}`,
      account: { create: { email } },
      paymentsPausedAt: paused ? pausedAt : null,
      pauseWindowStart: paused ? windowStart : null,
      pausePasskeyCutoff: paused ? (opts.cutoff ?? null) : null,
    },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return { teacherId: t.id, accountId: t.accountId, pausedAt, windowStart };
}

async function session(accountId: string, passkeyCredentialId: string | null = null): Promise<string> {
  const id = hashToken(crypto.randomBytes(32).toString('hex'));
  await prisma.session.create({ data: { id, accountId, expiresAt: daysAfter(NOW, 30), passkeyCredentialId } });
  return id;
}

async function passkey(accountId: string, createdAt: Date): Promise<string> {
  const id = `resume-pk-${uniqueSuffix()}`;
  await prisma.passkeyCredential.create({
    data: { id, accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt },
  });
  return id;
}

async function currentFingerprint(teacherId: string): Promise<string> {
  const t = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { paymentLink: true, bankAccounts: { select: bankAccountDataSelect } },
  });
  return payoutFingerprint(t);
}

async function classFor(teacherId: string, currency: Currency = 'EUR', date = new Date('2026-06-01')) {
  const room = await prisma.room.create({
    data: {
      venueName: 'Resume Studio', address: `${uniqueSuffix()} Resume St`, city: 'Amsterdam', postcode: '1234RS',
      floor: '1', roomName: 'Main', maxCapacity: 20, createdById: teacherId,
    },
  });
  roomIds.push(room.id);
  const tr = await prisma.teacherRoom.create({ data: { teacherId, roomId: room.id, capacityOverride: 15, rentalRate: 30 } });
  return createClassFixture(prisma, {
    teacherId, teacherRoomId: tr.id, classType: 'Resume Hatha', date,
    startTime: hhmmToTime('09:00'), durationMinutes: 60, roomCost: 20, minRate: 15, targetRate: 25,
    minStudents: 1, maxStudents: 12, status: 'completed', currency,
  });
}

async function payment(
  classId: string,
  data: { status: PaymentStatus; createdAt: Date; paidAt?: Date; notChargedAt?: Date; reminderSentAt?: Date; firstName?: string },
) {
  const student = await prisma.student.create({
    data: { firstName: data.firstName ?? 'Pay', lastName: 'Er', email: `resume-st-${uniqueSuffix()}@test.local`, incomeTier: 3 },
  });
  studentIds.push(student.id);
  const reg = await prisma.registration.create({
    data: { classId, studentId: student.id, status: 'attended', tierAtBooking: 3, price: 12.5 },
  });
  const p = await prisma.payment.create({
    data: {
      registrationId: reg.id, amount: 12.5, status: data.status, createdAt: data.createdAt,
      paidAt: data.paidAt ?? null, notChargedAt: data.notChargedAt ?? null, reminderSentAt: data.reminderSentAt ?? null,
    },
  });
  return { paymentId: p.id, studentId: student.id };
}

describe('readResumeReview', () => {
  it('answers null for a teacher whose payments are not paused', async () => {
    const t = await pausedTeacher({ paused: false });
    expect(await readResumeReview(prisma, t.teacherId, await session(t.accountId), NOW)).toBeNull();
  });

  it('lists the window\'s events, outstanding and settled payments, each bounded at both ends', async () => {
    const t = await pausedTeacher();
    const before = await prisma.payoutChangeEvent.create({
      data: { teacherId: t.teacherId, kind: 'payment_link_added', after: 'revolut.me/…anna', createdAt: daysBefore(t.windowStart, 1) },
    });
    const inside = await prisma.payoutChangeEvent.create({
      data: { teacherId: t.teacherId, kind: 'payment_link_changed', before: 'revolut.me/…anna', after: 'revolut.me/…evil', createdAt: t.windowStart },
    });
    const cls = await classFor(t.teacherId);
    const owedBefore = await payment(cls.id, { status: 'pending', createdAt: daysBefore(t.pausedAt, 1), firstName: 'Owed' });
    const owedAfter = await payment(cls.id, { status: 'pending', createdAt: daysAfter(t.pausedAt, 1) });
    const paidInWindow = await payment(cls.id, { status: 'paid', createdAt: daysBefore(t.windowStart, 5), paidAt: daysAfter(t.windowStart, 1) });
    const waivedInWindow = await payment(cls.id, { status: 'not_charged', createdAt: daysBefore(t.windowStart, 5), notChargedAt: t.pausedAt });
    const paidBeforeWindow = await payment(cls.id, { status: 'paid', createdAt: daysBefore(t.windowStart, 5), paidAt: daysBefore(t.windowStart, 1) });
    const paidAfterPause = await payment(cls.id, { status: 'paid', createdAt: daysBefore(t.windowStart, 5), paidAt: daysAfter(t.pausedAt, 1) });

    const review = await readResumeReview(prisma, t.teacherId, await session(t.accountId), NOW);

    expect(review?.events.map((e) => e.id)).toEqual([inside.id]);
    expect(review?.events.map((e) => e.id)).not.toContain(before.id);
    expect(review?.outstanding.map((p) => p.id)).toEqual([owedBefore.paymentId]);
    expect(review?.outstanding.map((p) => p.id)).not.toContain(owedAfter.paymentId);
    expect(review?.outstanding[0]).toMatchObject({ studentName: 'Owed e.', classType: 'Resume Hatha', amount: 12.5, currency: 'EUR', status: 'pending' });
    expect(new Set(review?.settled.map((p) => p.id))).toEqual(new Set([paidInWindow.paymentId, waivedInWindow.paymentId]));
    expect(review?.settled.map((p) => p.id)).not.toContain(paidBeforeWindow.paymentId);
    expect(review?.settled.map((p) => p.id)).not.toContain(paidAfterPause.paymentId);
    expect(review?.pausedAt).toEqual(t.pausedAt);
    expect(review?.windowStart).toEqual(t.windowStart);
  });

  it('shows every currency\'s account and the link in full, with the fingerprint of all of them', async () => {
    const t = await pausedTeacher();
    await prisma.teacher.update({ where: { id: t.teacherId }, data: { paymentLink: 'https://revolut.me/annadevries' } });
    await prisma.teacherBankAccount.create({ data: { teacherId: t.teacherId, currency: 'EUR', holderName: 'Anna de Vries', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' } });
    await prisma.teacherBankAccount.create({ data: { teacherId: t.teacherId, currency: 'GBP', holderName: 'Anna de Vries', sortCode: '200000', accountNumber: '55779911' } });

    const review = await readResumeReview(prisma, t.teacherId, await session(t.accountId), NOW);

    expect(review?.details.paymentLink).toBe('https://revolut.me/annadevries');
    expect(review?.details.bankAccounts).toEqual([
      { currency: 'EUR', holderName: 'Anna de Vries', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A', sortCode: null, accountNumber: null, routingNumber: null },
      { currency: 'GBP', holderName: 'Anna de Vries', iban: null, bic: null, sortCode: '200000', accountNumber: '55779911', routingNumber: null },
    ]);
    expect(review?.fingerprint).toBe(await currentFingerprint(t.teacherId));
  });

  it('says whether a passkey is required, whether this session has it, and when the fallback opens', async () => {
    const cutoff = daysBefore(NOW, 20);
    const t = await pausedTeacher({ cutoff });
    const old = await passkey(t.accountId, daysBefore(cutoff, 1));

    const magic = await readResumeReview(prisma, t.teacherId, await session(t.accountId), NOW);
    const withPasskey = await readResumeReview(prisma, t.teacherId, await session(t.accountId, old), NOW);
    const opensAt = daysAfter(t.pausedAt, PAUSE_PASSKEY_FALLBACK_DAYS);

    expect(magic).toMatchObject({ passkeyRequired: true, sessionSatisfiesPasskey: false, fallbackOpensAt: opensAt });
    expect(withPasskey).toMatchObject({ passkeyRequired: true, sessionSatisfiesPasskey: true, fallbackOpensAt: opensAt });
    const later = await readResumeReview(prisma, t.teacherId, await session(t.accountId), opensAt);
    expect(later).toMatchObject({ passkeyRequired: false, sessionSatisfiesPasskey: false, fallbackOpensAt: null });
  });
});

describe('readResumeReview, a requirement no live passkey can meet', () => {
  it('says the passkey was removed when the cutoff stands and no passkey older than it is left', async () => {
    const cutoff = daysBefore(NOW, 20);
    const removed = await pausedTeacher({ cutoff });
    await passkey(removed.accountId, cutoff);
    const kept = await pausedTeacher({ cutoff });
    await passkey(kept.accountId, daysBefore(cutoff, 1));

    expect(await readResumeReview(prisma, removed.teacherId, await session(removed.accountId), NOW))
      .toMatchObject({ passkeyRequired: true, passkeyRemoved: true });
    expect(await readResumeReview(prisma, kept.teacherId, await session(kept.accountId), NOW))
      .toMatchObject({ passkeyRequired: true, passkeyRemoved: false });
  });

  it('says nothing about a removal once the fallback has opened', async () => {
    const t = await pausedTeacher({ cutoff: daysBefore(NOW, 20) });
    const opensAt = daysAfter(t.pausedAt, PAUSE_PASSKEY_FALLBACK_DAYS);

    expect(await readResumeReview(prisma, t.teacherId, await session(t.accountId), opensAt))
      .toMatchObject({ passkeyRequired: false, passkeyRemoved: false });
  });
});

describe('resumePayments, the passkey gate', () => {
  it('refuses a session with no passkey while a cutoff is frozen', async () => {
    const t = await pausedTeacher({ cutoff: daysBefore(NOW, 20) });
    await passkey(t.accountId, daysBefore(NOW, 30));

    const outcome = await resumePayments(prisma, {
      teacherId: t.teacherId, sessionId: await session(t.accountId), fingerprint: await currentFingerprint(t.teacherId), now: NOW,
    });

    expect(outcome).toEqual({ status: 'passkey_required' });
    const state = await prisma.teacher.findUniqueOrThrow({ where: { id: t.teacherId }, select: { paymentsPausedAt: true } });
    expect(state.paymentsPausedAt).toEqual(t.pausedAt);
  });

  it('refuses a session signed in with a passkey created after the cutoff', async () => {
    const cutoff = daysBefore(NOW, 20);
    const t = await pausedTeacher({ cutoff });
    const recent = await passkey(t.accountId, cutoff);

    const outcome = await resumePayments(prisma, {
      teacherId: t.teacherId, sessionId: await session(t.accountId, recent), fingerprint: await currentFingerprint(t.teacherId), now: NOW,
    });

    expect(outcome).toEqual({ status: 'passkey_required' });
  });

  it('resumes for a session signed in with a passkey created before the cutoff', async () => {
    const cutoff = daysBefore(NOW, 20);
    const t = await pausedTeacher({ cutoff });
    const old = await passkey(t.accountId, daysBefore(cutoff, 1));

    const outcome = await resumePayments(prisma, {
      teacherId: t.teacherId, sessionId: await session(t.accountId, old), fingerprint: await currentFingerprint(t.teacherId), now: NOW,
    });

    expect(outcome).toEqual({ status: 'resumed' });
  });

  it('resumes without the passkey once the fallback has opened', async () => {
    const pausedAt = daysBefore(NOW, PAUSE_PASSKEY_FALLBACK_DAYS);
    const t = await pausedTeacher({ cutoff: daysBefore(pausedAt, 10), pausedAt });

    const outcome = await resumePayments(prisma, {
      teacherId: t.teacherId, sessionId: await session(t.accountId), fingerprint: await currentFingerprint(t.teacherId), now: NOW,
    });

    expect(outcome).toEqual({ status: 'resumed' });
  });

  it('still refuses the moment before the fallback opens', async () => {
    const pausedAt = new Date(daysBefore(NOW, PAUSE_PASSKEY_FALLBACK_DAYS).getTime() + 1);
    const t = await pausedTeacher({ cutoff: daysBefore(pausedAt, 10), pausedAt });

    const outcome = await resumePayments(prisma, {
      teacherId: t.teacherId, sessionId: await session(t.accountId), fingerprint: await currentFingerprint(t.teacherId), now: NOW,
    });

    expect(outcome).toEqual({ status: 'passkey_required' });
  });

  it('needs no passkey when the pause froze no cutoff', async () => {
    const t = await pausedTeacher({ cutoff: null });

    const outcome = await resumePayments(prisma, {
      teacherId: t.teacherId, sessionId: await session(t.accountId), fingerprint: await currentFingerprint(t.teacherId), now: NOW,
    });

    expect(outcome).toEqual({ status: 'resumed' });
  });
});

describe('resumePayments', () => {
  it('answers not_paused for a teacher who is not paused, writing nothing', async () => {
    const t = await pausedTeacher({ paused: false });

    const outcome = await resumePayments(prisma, {
      teacherId: t.teacherId, sessionId: await session(t.accountId), fingerprint: await currentFingerprint(t.teacherId), now: NOW,
    });

    expect(outcome).toEqual({ status: 'not_paused' });
    const state = await prisma.teacher.findUniqueOrThrow({ where: { id: t.teacherId }, select: { paymentsResumedAt: true } });
    expect(state.paymentsResumedAt).toBeNull();
  });

  it('refuses when another currency\'s account changed after the screen was read', async () => {
    const t = await pausedTeacher();
    await prisma.teacherBankAccount.create({ data: { teacherId: t.teacherId, currency: 'EUR', holderName: 'Anna', iban: 'NL91ABNA0417164300' } });
    await prisma.teacherBankAccount.create({ data: { teacherId: t.teacherId, currency: 'GBP', holderName: 'Anna', sortCode: '200000', accountNumber: '55779911' } });
    const sessionId = await session(t.accountId);
    const review = await readResumeReview(prisma, t.teacherId, sessionId, NOW);
    if (review === null) throw new Error('expected a review');
    await prisma.teacherBankAccount.update({
      where: { teacherId_currency: { teacherId: t.teacherId, currency: 'GBP' } },
      data: { accountNumber: '99999999' },
    });

    const outcome = await resumePayments(prisma, { teacherId: t.teacherId, sessionId, fingerprint: review.fingerprint, now: NOW });

    expect(outcome).toEqual({ status: 'details_changed' });
    const state = await prisma.teacher.findUniqueOrThrow({ where: { id: t.teacherId }, select: { paymentsPausedAt: true } });
    expect(state.paymentsPausedAt).toEqual(t.pausedAt);
  });

  it('clears the pause, stamps the resume and deletes the teacher\'s pause links', async () => {
    const t = await pausedTeacher({ cutoff: null });
    const ev = await prisma.payoutChangeEvent.create({ data: { teacherId: t.teacherId, kind: 'payment_link_added', after: 'x' } });
    await prisma.payoutPauseToken.create({
      data: { tokenHash: hashToken(crypto.randomBytes(32).toString('hex')), teacherId: t.teacherId, eventId: ev.id, expiresAt: daysAfter(NOW, 5) },
    });

    expect(await resumePayments(prisma, {
      teacherId: t.teacherId, sessionId: await session(t.accountId), fingerprint: await currentFingerprint(t.teacherId), now: NOW,
    })).toEqual({ status: 'resumed' });

    const state = await prisma.teacher.findUniqueOrThrow({
      where: { id: t.teacherId },
      select: { paymentsPausedAt: true, pauseWindowStart: true, pausePasskeyCutoff: true, paymentsResumedAt: true },
    });
    expect(state).toEqual({ paymentsPausedAt: null, pauseWindowStart: null, pausePasskeyCutoff: null, paymentsResumedAt: NOW });
    expect(await prisma.payoutPauseToken.count({ where: { teacherId: t.teacherId } })).toBe(0);
  });

  it('tells each student with an outstanding payment once that they can pay, with the guidance of the resumed teacher', async () => {
    const t = await pausedTeacher();
    await prisma.teacherBankAccount.create({ data: { teacherId: t.teacherId, currency: 'EUR', holderName: 'Anna', iban: 'NL91ABNA0417164300' } });
    const eurClass = await classFor(t.teacherId, 'EUR');
    const chfClass = await classFor(t.teacherId, 'CHF', new Date('2026-06-02'));
    const pending = await payment(eurClass.id, { status: 'pending', createdAt: daysBefore(NOW, 2) });
    const overdue = await payment(eurClass.id, { status: 'overdue', createdAt: daysBefore(NOW, 20) });
    const noMethod = await payment(chfClass.id, { status: 'pending', createdAt: daysBefore(NOW, 2) });
    const paid = await payment(eurClass.id, { status: 'paid', createdAt: daysBefore(NOW, 20), paidAt: daysBefore(NOW, 10) });
    const other = await pausedTeacher({ paused: false });
    const otherClass = await classFor(other.teacherId);
    const otherOwed = await payment(otherClass.id, { status: 'pending', createdAt: daysBefore(NOW, 2) });
    const sessionId = await session(t.accountId);

    expect(await resumePayments(prisma, { teacherId: t.teacherId, sessionId, fingerprint: await currentFingerprint(t.teacherId), now: NOW }))
      .toEqual({ status: 'resumed' });
    expect(await resumePayments(prisma, { teacherId: t.teacherId, sessionId, fingerprint: await currentFingerprint(t.teacherId), now: NOW }))
      .toEqual({ status: 'not_paused' });

    const told = async (studentId: string) =>
      prisma.notification.findMany({ where: { recipientType: 'student', recipientId: studentId }, select: { type: true, body: true, relatedClassId: true } });
    const pendingTold = await told(pending.studentId);
    const overdueTold = await told(overdue.studentId);
    const noMethodTold = await told(noMethod.studentId);
    const paidTold = await told(paid.studentId);
    const otherTold = await told(otherOwed.studentId);
    expect(pendingTold).toHaveLength(1);
    expect(pendingTold[0]).toMatchObject({ type: 'reminder', relatedClassId: eurClass.id });
    expect(pendingTold[0]?.body).not.toContain('directly');
    expect(pendingTold[0]?.body).not.toContain('hold off');
    expect(overdueTold).toHaveLength(1);
    expect(noMethodTold).toHaveLength(1);
    expect(noMethodTold[0]?.body).toContain('Pay your teacher directly');
    expect(paidTold).toEqual([]);
    expect(otherTold).toEqual([]);

    const stamps = await prisma.payment.findMany({
      where: { id: { in: [pending.paymentId, overdue.paymentId, paid.paymentId, otherOwed.paymentId] } },
      select: { id: true, reminderSentAt: true },
    });
    const stampOf = (id: string) => stamps.find((s) => s.id === id)?.reminderSentAt ?? null;
    expect(stampOf(pending.paymentId)).toEqual(NOW);
    expect(stampOf(overdue.paymentId)).toEqual(NOW);
    expect(stampOf(paid.paymentId)).toBeNull();
    expect(stampOf(otherOwed.paymentId)).toBeNull();
  });

  it('tells no erased student, and leaves the payment of an erased student unstamped', async () => {
    const t = await pausedTeacher();
    const cls = await classFor(t.teacherId);
    const live = await payment(cls.id, { status: 'pending', createdAt: daysBefore(NOW, 2) });
    const erased = await payment(cls.id, { status: 'pending', createdAt: daysBefore(NOW, 2) });
    await prisma.student.update({ where: { id: erased.studentId }, data: { deletedAt: daysBefore(NOW, 1) } });

    expect(await resumePayments(prisma, {
      teacherId: t.teacherId, sessionId: await session(t.accountId), fingerprint: await currentFingerprint(t.teacherId), now: NOW,
    })).toEqual({ status: 'resumed' });

    const told = async (studentId: string) =>
      prisma.notification.count({ where: { recipientType: 'student', recipientId: studentId } });
    expect(await told(live.studentId)).toBe(1);
    expect(await told(erased.studentId)).toBe(0);
    const stamp = await prisma.payment.findUniqueOrThrow({ where: { id: erased.paymentId }, select: { reminderSentAt: true } });
    expect(stamp.reminderSentAt).toBeNull();
  });

  it('leaves the reminder sweep nothing to send for an overdue payment the resume just told', async () => {
    const t = await pausedTeacher();
    const cls = await classFor(t.teacherId);
    const overdue = await payment(cls.id, { status: 'overdue', createdAt: daysBefore(NOW, 30), reminderSentAt: daysBefore(NOW, 10) });
    const scoped = scopeSweep(prisma, { Payment: { id: { in: [overdue.paymentId] } } });

    expect(await resumePayments(prisma, {
      teacherId: t.teacherId, sessionId: await session(t.accountId), fingerprint: await currentFingerprint(t.teacherId), now: NOW,
    })).toEqual({ status: 'resumed' });

    expect(await sendPaymentReminders(scoped.db, daysAfter(NOW, 1))).toBe(0);
    // The presence check for that zero: the same scope still holds the
    // payment, and a week on the sweep reminds it again.
    expect(await sendPaymentReminders(scoped.db, daysAfter(NOW, 8))).toBe(1);
    expect(await prisma.notification.count({ where: { recipientType: 'student', recipientId: overdue.studentId } })).toBe(2);
  });

  it('answers teacher_gone for an erased teacher', async () => {
    const t = await pausedTeacher();
    const sessionId = await session(t.accountId);
    await prisma.teacher.update({ where: { id: t.teacherId }, data: { deletedAt: NOW } });

    expect(await resumePayments(prisma, { teacherId: t.teacherId, sessionId, fingerprint: 'x', now: NOW }))
      .toEqual({ status: 'teacher_gone' });
  });
});
