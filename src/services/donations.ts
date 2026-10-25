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
