import type { Prisma, PrismaClient } from '@prisma/client';
import { isErasedAddress } from '@/lib/erased-address';
import type { UnsubscribeTarget } from '@/lib/unsubscribe-kind';
import { addressTag, parseInvitationSubject } from '@/lib/unsubscribe-token';
import { declinePending } from './invitations';

export type UnsubscribeOutcome = { status: 'done' } | { status: 'unchanged' } | { status: 'invalid' };

const DONE: UnsubscribeOutcome = { status: 'done' };
const UNCHANGED: UnsubscribeOutcome = { status: 'unchanged' };
const INVALID: UnsubscribeOutcome = { status: 'invalid' };

/** A write that moved a row is done; one that did not is unchanged for a live subject, invalid for none. */
async function flip(
  result: Prisma.BatchPayload,
  liveSubjects: () => Promise<number>,
): Promise<UnsubscribeOutcome> {
  if (result.count > 0) return DONE;
  return (await liveSubjects()) > 0 ? UNCHANGED : INVALID;
}

/**
 * Applies one opt-out for a target the caller has already verified. Every
 * branch writes only if the subject is live and the preference is still on,
 * so a repeat or an erased subject changes nothing. The switches are the
 * table in `docs/superpowers/specs/2026-10-10-list-unsubscribe-design.md`
 * (Decision 3).
 */
export async function unsubscribe(
  db: PrismaClient,
  target: UnsubscribeTarget,
): Promise<UnsubscribeOutcome> {
  const { kind, subjectId: id } = target;
  return db.$transaction(async (tx) => {
    switch (kind) {
      case 'student_notifications':
        return flip(
          await tx.student.updateMany({
            where: { id, deletedAt: null, emailNotifications: true },
            data: { emailNotifications: false },
          }),
          () => tx.student.count({ where: { id, deletedAt: null } }),
        );
      case 'teacher_bookings':
        return flip(
          await tx.teacher.updateMany({
            where: { id, deletedAt: null, bookingNotifications: 'inbox_and_email' },
            data: { bookingNotifications: 'inbox_only' },
          }),
          () => tx.teacher.count({ where: { id, deletedAt: null } }),
        );
      case 'teacher_class_completed':
        return flip(
          await tx.teacher.updateMany({
            where: { id, deletedAt: null, emailOnClassCompleted: true },
            data: { emailOnClassCompleted: false },
          }),
          () => tx.teacher.count({ where: { id, deletedAt: null } }),
        );
      case 'teacher_invitations':
        return flip(
          await tx.teacher.updateMany({
            where: { id, deletedAt: null, emailOnInvitation: true },
            data: { emailOnInvitation: false },
          }),
          () => tx.teacher.count({ where: { id, deletedAt: null } }),
        );
      case 'student_reminders':
        return studentReminders(tx, id);
      case 'teacher_reminders':
        return teacherReminders(tx, id);
      case 'invitation':
        return declineByToken(tx, id);
      default: {
        const unhandled: never = kind;
        throw new Error(`unhandled unsubscribe kind: ${String(unhandled)}`);
      }
    }
  });
}

// The two reminders branches are written out per model: Prisma's delegates for
// Student and Teacher do not share a callable type.
//
// A reminder that arrives by email and in the inbox loses only the email half;
// one that arrives by email alone is switched off, because it has no other half.

async function studentReminders(tx: Prisma.TransactionClient, id: string): Promise<UnsubscribeOutcome> {
  const live = { id, deletedAt: null, classReminder: { not: 'off' } } satisfies Prisma.StudentWhereInput;
  const demoted = await tx.student.updateMany({
    where: { ...live, classReminderChannel: 'inbox_and_email' },
    data: { classReminderChannel: 'inbox' },
  });
  if (demoted.count > 0) return DONE;
  return flip(
    await tx.student.updateMany({
      where: { ...live, classReminderChannel: 'email' },
      data: { classReminder: 'off' },
    }),
    () => tx.student.count({ where: { id, deletedAt: null } }),
  );
}

async function teacherReminders(tx: Prisma.TransactionClient, id: string): Promise<UnsubscribeOutcome> {
  const live = { id, deletedAt: null, classReminder: { not: 'off' } } satisfies Prisma.TeacherWhereInput;
  const demoted = await tx.teacher.updateMany({
    where: { ...live, classReminderChannel: 'inbox_and_email' },
    data: { classReminderChannel: 'inbox' },
  });
  if (demoted.count > 0) return DONE;
  return flip(
    await tx.teacher.updateMany({
      where: { ...live, classReminderChannel: 'email' },
      data: { classReminder: 'off' },
    }),
    () => tx.teacher.count({ where: { id, deletedAt: null } }),
  );
}

/**
 * The subject binds the address the invitation was sent to, so a row that has
 * since been readdressed or erased answers invalid rather than declining for
 * an address the link was never sent to.
 */
async function declineByToken(tx: Prisma.TransactionClient, subjectId: string): Promise<UnsubscribeOutcome> {
  const parsed = parseInvitationSubject(subjectId);
  if (parsed === null) return INVALID;
  const invitation = await tx.invitation.findUnique({
    where: { id: parsed.invitationId },
    select: { id: true, teacherId: true, email: true, status: true },
  });
  if (invitation === null || isErasedAddress(invitation.email) || addressTag(invitation.email) !== parsed.tag) {
    return INVALID;
  }
  if (invitation.status !== 'pending') return UNCHANGED;
  return (await declinePending(tx, invitation)) ? DONE : UNCHANGED;
}
