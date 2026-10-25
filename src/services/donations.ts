import type { Prisma } from '@/lib/prisma-client';
import { DONATION_INVITED_STATUSES } from '@/lib/registration-status';
import { formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import type { CreateNotificationInput } from '@/services/notifications';

export type InvitedRow = { id: string; studentId: string };

/**
 * Stamps every booking of `classId` that came and was not yet invited, and
 * returns exactly the rows it stamped — the invitations go to these, never
 * to a re-read. Runs inside `completeClass`'s transaction, under its class lock.
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
