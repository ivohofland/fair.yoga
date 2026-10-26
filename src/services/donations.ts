import type { Prisma, PrismaClient } from '@/lib/prisma-client';
import { lockClassRow } from '@/lib/db-locks';
import { DONATION_INVITED_STATUSES } from '@/lib/registration-status';
import { formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import { createBulkNotifications, type CreateNotificationInput } from '@/services/notifications';

export type InvitedRow = { id: string; studentId: string };

/**
 * Stamps every booking of `classId` that came and was not yet invited, and
 * returns exactly the rows it stamped — the invitations go to these, never
 * to a re-read. The caller holds the class lock and passes its transaction.
 */
export async function claimCompletionInvitations(
  tx: Prisma.TransactionClient,
  classId: string,
  at: Date,
): Promise<InvitedRow[]> {
  return tx.registration.updateManyAndReturn({
    where: { classId, status: { in: [...DONATION_INVITED_STATUSES] }, donationInvitedAt: null },
    data: { donationInvitedAt: at },
    select: { id: true, studentId: true },
  });
}

export function donationInvitation(
  studentId: string,
  cls: { id: string; calendarEntry: { classType: string } },
): CreateNotificationInput {
  return {
    recipientType: 'student',
    recipientId: studentId,
    type: 'donation_invitation',
    title: 'Thank you for coming',
    body: `Thank you for coming to ${cls.calendarEntry.classType}. It was by donation — if you'd like to give, here's how.`,
    relatedClassId: cls.id,
  };
}

export type DonationNoticeClass = {
  id: string;
  calendarEntry: { teacherId: string; classType: string; date: Date; startTime: Date };
};

export function donationCompletionNotice(cls: DonationNoticeClass, invited: number): CreateNotificationInput {
  const { classType, date, startTime, teacherId } = cls.calendarEntry;
  const lead = `${classType} class on ${formatDayHeader(date)} at ${timeToHHmm(startTime)} is complete`;
  return {
    recipientType: 'teacher',
    recipientId: teacherId,
    type: 'payment_request',
    title: 'Class completed',
    body: invited === 0
      ? `${lead}. No one to invite.`
      : `${lead} — ${invited} ${invited === 1 ? 'student' : 'students'} invited to give.`,
    relatedClassId: cls.id,
  };
}

/**
 * Invites a booking a teacher has just corrected to `attended`, if this is the
 * first time it has been invited (#912). The caller's status write has already
 * committed and holds no class lock; the lock taken here is what closes the
 * race with `completeClass`, which stamps from the statuses it can see. The
 * argument is in `docs/lock-order.md` ("`Registration` status writers outside
 * the class lock"), where the lock order this takes is also fixed.
 */
export async function claimCorrectionInvitation(
  db: PrismaClient,
  registrationId: string,
): Promise<'invited' | 'not_invited'> {
  return db.$transaction(async (tx) => {
    const found = await tx.registration.findUnique({ where: { id: registrationId }, select: { classId: true } });
    if (!found) return 'not_invited';
    await lockClassRow(tx, found.classId);
    const [row] = await tx.registration.updateManyAndReturn({
      where: {
        id: registrationId,
        status: 'attended',
        donationInvitedAt: null,
        class: { status: 'completed', pricingMode: 'donation', calendarEntry: { cancelledAt: null } },
      },
      data: { donationInvitedAt: new Date() },
      select: { studentId: true },
    });
    if (!row) return 'not_invited';
    const cls = await tx.class.findUniqueOrThrow({
      where: { id: found.classId },
      select: { id: true, calendarEntry: { select: { classType: true } } },
    });
    await createBulkNotifications(tx, [donationInvitation(row.studentId, cls)]);
    return 'invited';
  });
}

export type HidePromptResult =
  | { kind: 'hidden'; hiddenAt: Date }
  | { kind: 'unchanged'; hiddenAt: Date }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'not_invited' };

/**
 * Hides a student's own donation prompt (#912). Takes no class lock: it writes
 * only `donationPromptHiddenAt`, no `status`, and the conditional write makes a
 * concurrent Hide answer `unchanged` with the instant that won. `studentId` is
 * matched against the booking's owner.
 */
export async function hideDonationPrompt(
  db: PrismaClient,
  studentId: string,
  registrationId: string,
): Promise<HidePromptResult> {
  const found = await db.registration.findUnique({
    where: { id: registrationId },
    select: { studentId: true, donationInvitedAt: true, donationPromptHiddenAt: true },
  });
  if (!found) return { kind: 'not_found' };
  if (found.studentId !== studentId) return { kind: 'forbidden' };
  if (found.donationInvitedAt === null) return { kind: 'not_invited' };
  if (found.donationPromptHiddenAt !== null) return { kind: 'unchanged', hiddenAt: found.donationPromptHiddenAt };
  const hiddenAt = new Date();
  // Raw so `updatedAt` is not bumped: a change to it after completion would show who hid.
  const written = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Registration" SET "donationPromptHiddenAt" = ${hiddenAt}
    WHERE id = ${registrationId}
      AND "donationInvitedAt" IS NOT NULL
      AND "donationPromptHiddenAt" IS NULL
    RETURNING id`;
  if (written.length === 1) return { kind: 'hidden', hiddenAt };
  const reread = await db.registration.findUnique({
    where: { id: registrationId },
    select: { donationPromptHiddenAt: true },
  });
  if (reread?.donationPromptHiddenAt == null) return { kind: 'not_found' };
  return { kind: 'unchanged', hiddenAt: reread.donationPromptHiddenAt };
}

export type RecordDonationTotalResult =
  | { ok: true; outcome: 'applied' | 'unchanged'; donationTotal: number | null }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'cancelled' | 'not_donation' | 'not_completed' };

const toCents = (v: number | null): number | null => (v === null ? null : Math.round(v * 100));

/**
 * Records, replaces or clears (`null`) what a donation class took in (#912).
 * Its own statement, not a field of `updateClass`. A caller must pass the session's own
 * teacher id.
 *
 * The refusals are read in the order the spec fixes (ownership, cancelled,
 * mode, completed). The write repeats those conditions, so a class that stopped
 * qualifying between the read and the write is not written. A write that
 * matches no row is classified from one fresh read; a second miss throws,
 * because nothing that reaches the write can move a completed class.
 */
export async function recordDonationTotal(
  db: PrismaClient,
  teacherId: string,
  classId: string,
  amount: number | null,
): Promise<RecordDonationTotalResult> {
  const wanted = toCents(amount);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cls = await db.class.findUnique({
      where: { id: classId },
      select: {
        status: true,
        pricingMode: true,
        donationTotal: true,
        calendarEntry: { select: { teacherId: true, cancelledAt: true } },
      },
    });
    if (!cls) return { ok: false, reason: 'not_found' };
    if (cls.calendarEntry.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };
    if (cls.calendarEntry.cancelledAt !== null) return { ok: false, reason: 'cancelled' };
    switch (cls.pricingMode) {
      case 'tiered':
        return { ok: false, reason: 'not_donation' };
      case 'donation':
        break;
      default: {
        const unhandled: never = cls.pricingMode;
        throw new Error(`recordDonationTotal: unhandled pricing mode ${String(unhandled)}`);
      }
    }
    if (cls.status !== 'completed') return { ok: false, reason: 'not_completed' };
    const stored = toCents(cls.donationTotal === null ? null : Number(cls.donationTotal));
    if (wanted === stored) {
      return { ok: true, outcome: 'unchanged', donationTotal: stored === null ? null : stored / 100 };
    }
    const written = await db.class.updateMany({
      where: {
        id: classId,
        status: 'completed',
        pricingMode: 'donation',
        calendarEntry: { teacherId, cancelledAt: null },
      },
      data: { donationTotal: wanted === null ? null : wanted / 100 },
    });
    if (written.count > 0) {
      return { ok: true, outcome: 'applied', donationTotal: wanted === null ? null : wanted / 100 };
    }
  }
  throw new Error(`recordDonationTotal: write matched no row twice for class ${classId}`);
}
