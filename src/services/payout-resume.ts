import type { Currency, PaymentStatus, PayoutChangeKind, Prisma, PrismaClient } from '@prisma/client';
import { lockTeacherForNoKeyUpdate } from '@/lib/db-locks';
import { payoutFingerprint } from '@/lib/payout-fingerprint';
import {
  bankAccountDataSelect,
  payGuidanceFor,
  paymentMethodsForTeacher,
  teacherPaymentSelect,
  type BankAccountData,
} from '@/lib/payment-methods';
import { studentPaymentReminderBody } from '@/lib/payment-request-copy';
import { OUTSTANDING_STATUSES } from '@/lib/payment-status';
import { studentNameSelect, teacherVisibleName } from '@/lib/student-visibility';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';

/**
 * How long after a pause a resume stops requiring the passkey the pause froze:
 * a teacher who lost the device it lives on is not locked out of collecting
 * payments for good.
 */
export const PAUSE_PASSKEY_FALLBACK_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant a pause made at `pausedAt` stops requiring its passkey. */
export function pauseFallbackOpensAt(pausedAt: Date): Date {
  return new Date(pausedAt.getTime() + PAUSE_PASSKEY_FALLBACK_DAYS * DAY_MS);
}

/** The teacher columns the passkey gate reads. */
interface PauseState {
  accountId: string;
  paymentsPausedAt: Date;
  pausePasskeyCutoff: Date | null;
}

/**
 * `required` is false when the pause froze no cutoff or its fallback has
 * opened; `satisfied` is whether this session signed in with one of the
 * account's passkeys created before the cutoff; `fallbackOpensAt` is set only
 * while the requirement stands.
 */
interface PasskeyGate {
  required: boolean;
  satisfied: boolean;
  fallbackOpensAt: Date | null;
}

async function passkeyGate(
  db: PrismaClient | Prisma.TransactionClient,
  state: PauseState,
  sessionId: string,
  now: Date,
): Promise<PasskeyGate> {
  const cutoff = state.pausePasskeyCutoff;
  if (cutoff === null) return { required: false, satisfied: false, fallbackOpensAt: null };
  const opensAt = pauseFallbackOpensAt(state.paymentsPausedAt);
  if (now >= opensAt) return { required: false, satisfied: false, fallbackOpensAt: null };
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: { accountId: true, passkeyCredential: { select: { accountId: true, createdAt: true } } },
  });
  const credential = session?.passkeyCredential ?? null;
  const satisfied =
    session !== null &&
    session.accountId === state.accountId &&
    credential !== null &&
    credential.accountId === state.accountId &&
    credential.createdAt < cutoff;
  return { required: true, satisfied, fallbackOpensAt: opensAt };
}

/** The teacher columns a review and a resume read. */
const pauseSelect = {
  accountId: true,
  paymentsPausedAt: true,
  pauseWindowStart: true,
  pausePasskeyCutoff: true,
} as const satisfies Prisma.TeacherSelect;

/** One payment as the resume screen lists it. */
export interface ReviewPayment {
  id: string;
  studentName: string;
  classType: string;
  classDate: Date;
  startTime: Date;
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  paidAt: Date | null;
  notChargedAt: Date | null;
}

export interface ReviewEvent {
  id: string;
  kind: PayoutChangeKind;
  accountCurrency: Currency | null;
  before: string | null;
  after: string | null;
  createdAt: Date;
}

/**
 * Everything the resume screen shows (`docs/superpowers/specs/2026-10-08-payout-change-alert-design.md`,
 * "4 · Resuming"): the payout changes since the pause's window start, the
 * payments created before the pause that are still outstanding, the payments
 * marked paid or not charged between the window start and the pause, and the
 * payout details as they stand, in full, with their fingerprint.
 */
export interface ResumeReview {
  pausedAt: Date;
  windowStart: Date;
  events: ReviewEvent[];
  outstanding: ReviewPayment[];
  settled: ReviewPayment[];
  details: { paymentLink: string | null; bankAccounts: BankAccountData[] };
  fingerprint: string;
  passkeyRequired: boolean;
  sessionSatisfiesPasskey: boolean;
  fallbackOpensAt: Date | null;
}

function reviewPaymentSelect(teacherId: string) {
  return {
    id: true,
    amount: true,
    status: true,
    paidAt: true,
    notChargedAt: true,
    registration: {
      select: {
        student: { select: studentNameSelect(teacherId) },
        class: {
          select: {
            currency: true,
            calendarEntry: { select: { classType: true, date: true, startTime: true } },
          },
        },
      },
    },
  } as const satisfies Prisma.PaymentSelect;
}

type ReviewPaymentRow = Prisma.PaymentGetPayload<{ select: ReturnType<typeof reviewPaymentSelect> }>;

function toReviewPayment(row: ReviewPaymentRow, teacherId: string): ReviewPayment {
  const cls = row.registration.class;
  return {
    id: row.id,
    studentName: teacherVisibleName(row.registration.student, teacherId),
    classType: cls.calendarEntry.classType,
    classDate: cls.calendarEntry.date,
    startTime: cls.calendarEntry.startTime,
    amount: Number(row.amount),
    currency: cls.currency,
    status: row.status,
    paidAt: row.paidAt,
    notChargedAt: row.notChargedAt,
  };
}

/** The teacher's payout details, read whole: every account in every currency, and the link. */
async function readPayoutDetails(
  db: PrismaClient | Prisma.TransactionClient,
  teacherId: string,
): Promise<{ paymentLink: string | null; bankAccounts: BankAccountData[] }> {
  const t = await db.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { paymentLink: true, bankAccounts: { select: bankAccountDataSelect, orderBy: { currency: 'asc' } } },
  });
  return { paymentLink: t.paymentLink, bankAccounts: t.bankAccounts };
}

/**
 * The resume screen for a paused teacher, or null when the teacher's payments
 * are not paused (or the teacher is gone). Both window lists are bounded by
 * the window start and the pause instant the pause stored.
 */
export async function readResumeReview(
  db: PrismaClient,
  teacherId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<ResumeReview | null> {
  const teacher = await db.teacher.findFirst({ where: { id: teacherId, deletedAt: null }, select: pauseSelect });
  if (teacher === null || teacher.paymentsPausedAt === null) return null;
  const pausedAt = teacher.paymentsPausedAt;
  // A pause always stores its window start; the pause instant bounds it if a
  // row was ever written without one.
  const windowStart = teacher.pauseWindowStart ?? pausedAt;
  const ofTeacher = { registration: { class: { calendarEntry: { teacherId } } } } as const;
  const select = reviewPaymentSelect(teacherId);

  const [events, outstanding, settled, details, gate] = await Promise.all([
    db.payoutChangeEvent.findMany({
      where: { teacherId, createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, accountCurrency: true, before: true, after: true, createdAt: true },
    }),
    db.payment.findMany({
      where: { ...ofTeacher, status: { in: OUTSTANDING_STATUSES }, createdAt: { lt: pausedAt } },
      orderBy: { createdAt: 'asc' },
      select,
    }),
    db.payment.findMany({
      where: {
        ...ofTeacher,
        OR: [
          { paidAt: { gte: windowStart, lte: pausedAt } },
          { notChargedAt: { gte: windowStart, lte: pausedAt } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      select,
    }),
    readPayoutDetails(db, teacherId),
    passkeyGate(db, { ...teacher, paymentsPausedAt: pausedAt }, sessionId, now),
  ]);

  return {
    pausedAt,
    windowStart,
    events,
    outstanding: outstanding.map((row) => toReviewPayment(row, teacherId)),
    settled: settled.map((row) => toReviewPayment(row, teacherId)),
    details,
    fingerprint: payoutFingerprint(details),
    passkeyRequired: gate.required,
    sessionSatisfiesPasskey: gate.satisfied,
    fallbackOpensAt: gate.fallbackOpensAt,
  };
}

export type ResumeOutcome =
  | { status: 'resumed' }
  | { status: 'not_paused' }
  | { status: 'passkey_required' }
  | { status: 'details_changed' }
  | { status: 'teacher_gone' };

/** What the resume tells each student it reminds. */
const RESUMED_TITLE = 'You can pay now';

/**
 * Resumes a paused teacher's payments, in the order the spec's "4 · Resuming"
 * fixes: not paused answers `not_paused`; then the passkey the pause froze, if
 * any and its fallback has not opened; then, under the teacher's
 * `FOR NO KEY UPDATE` lock, paused again and the fingerprint the screen showed
 * against the details now. The lock is the payout writers' own, so a save in
 * flight finishes first and its change fails the fingerprint
 * (`docs/lock-order.md`, "The `Teacher` row is the first lock").
 *
 * Success clears the pause, stamps `paymentsResumedAt`, deletes the teacher's
 * pause links, and reminds each outstanding payment's student with the copy
 * the teacher's methods now give, stamping `reminderSentAt` so the overdue
 * sweep does not repeat it within its interval.
 */
export async function resumePayments(
  db: PrismaClient,
  input: { teacherId: string; sessionId: string; fingerprint: string; now?: Date },
): Promise<ResumeOutcome> {
  const { teacherId, sessionId, fingerprint } = input;
  const now = input.now ?? new Date();

  const before = await db.teacher.findFirst({ where: { id: teacherId, deletedAt: null }, select: pauseSelect });
  if (before === null) return { status: 'teacher_gone' };
  if (before.paymentsPausedAt === null) return { status: 'not_paused' };
  const preGate = await passkeyGate(db, { ...before, paymentsPausedAt: before.paymentsPausedAt }, sessionId, now);
  if (preGate.required && !preGate.satisfied) return { status: 'passkey_required' };

  return db.$transaction(async (tx): Promise<ResumeOutcome> => {
    if ((await lockTeacherForNoKeyUpdate(tx, teacherId)) === null) return { status: 'teacher_gone' };
    const locked = await tx.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: pauseSelect });
    if (locked.paymentsPausedAt === null) return { status: 'not_paused' };
    // A resume and re-pause between the read above and this lock would have
    // frozen a new cutoff; the gate answers for the pause that stands now.
    const gate = await passkeyGate(tx, { ...locked, paymentsPausedAt: locked.paymentsPausedAt }, sessionId, now);
    if (gate.required && !gate.satisfied) return { status: 'passkey_required' };
    if (payoutFingerprint(await readPayoutDetails(tx, teacherId)) !== fingerprint) return { status: 'details_changed' };

    await tx.teacher.update({
      where: { id: teacherId },
      data: { paymentsPausedAt: null, pauseWindowStart: null, pausePasskeyCutoff: null, paymentsResumedAt: now },
    });
    await tx.payoutPauseToken.deleteMany({ where: { teacherId } });

    const resumed = await tx.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: teacherPaymentSelect });
    const owed = await tx.payment.findMany({
      where: {
        status: { in: OUTSTANDING_STATUSES },
        registration: { student: { deletedAt: null }, class: { calendarEntry: { teacherId } } },
      },
      select: {
        id: true,
        amount: true,
        registration: {
          select: {
            studentId: true,
            class: {
              select: {
                id: true,
                currency: true,
                calendarEntry: { select: { classType: true, date: true, startTime: true } },
              },
            },
          },
        },
      },
    });
    if (owed.length > 0) {
      const notifications: CreateNotificationInput[] = owed.map((p) => {
        const cls = p.registration.class;
        const guidance = payGuidanceFor(paymentMethodsForTeacher(resumed, cls.currency));
        return {
          recipientType: 'student',
          recipientId: p.registration.studentId,
          type: 'reminder',
          title: RESUMED_TITLE,
          body: studentPaymentReminderBody(cls.calendarEntry, Number(p.amount), guidance, cls.currency),
          relatedClassId: cls.id,
        };
      });
      await tx.payment.updateMany({ where: { id: { in: owed.map((p) => p.id) } }, data: { reminderSentAt: now } });
      await createBulkNotifications(tx, notifications);
    }
    return { status: 'resumed' };
  });
}
