/**
 * A walk-in: a teacher registering someone at the door who is not on their
 * roster. Presence is acceptance — the teacher's act links the person and
 * accepts their invitation — which is the one exception to "a teacher may not
 * link a student unilaterally"; the rule and its accepted residuals are
 * `docs/data-model.md` (Invitation, "Walk-ins").
 *
 * Two steps, because `docs/lock-order.md` puts the class work between them:
 * `resolveWalkInStudent` runs before the transaction's first lock and may
 * INSERT the `Student` (first in the order); `completeWalkIn` runs after
 * `Registration` and writes `StudentPrivacy → TeacherStudent → Invitation`,
 * then reads `TeacherBlock`, then notifies the person.
 *
 * `resolveInvitationOnLink` is never called here: it deletes the block, and a
 * teacher's act must not lift a student's refusal.
 */
import type { InvitationStatus, Prisma } from '@prisma/client';
import { requireNormalised } from '@/lib/schemas';
import { isErasedAddress } from '@/lib/erased-address';
import { linkTeacherStudent } from './roster-link';
import { createBulkNotifications } from './notifications';

export type WalkInSubject =
  | { kind: 'invitation'; invitationId: string }
  | { kind: 'newContact'; firstName: string; lastName: string; email: string };

export type WalkInRefusal =
  | 'NOT_FOUND'
  | 'INVITATION_ERASED'
  | 'DECLINED'
  | 'WALK_IN_REFUSED'
  | 'CONCURRENT_MODIFICATION';

export class WalkInRefusedError extends Error {
  constructor(readonly refusal: WalkInRefusal) {
    super(`walk-in refused: ${refusal}`);
    this.name = 'WalkInRefusedError';
  }
}

export interface ResolvedWalkIn {
  readonly studentId: string;
  readonly incomeTier: number;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** True when this call created the Student row. Drives the privacy seed; never leaves the server. */
  readonly created: boolean;
}

export interface WalkInNotice {
  readonly teacherName: string;
  readonly classType: string;
  readonly dateLabel: string;
}

interface SubjectContact {
  email: string;
  firstName: string;
  lastName: string;
  /** This teacher's invitation for the address, or null when there is none. */
  status: InvitationStatus | null;
}

async function subjectContact(
  tx: Prisma.TransactionClient,
  teacherId: string,
  subject: WalkInSubject,
): Promise<SubjectContact> {
  if (subject.kind === 'invitation') {
    const row = await tx.invitation.findFirst({
      where: { id: subject.invitationId, teacherId },
      select: { email: true, firstName: true, lastName: true, status: true },
    });
    if (row === null) throw new WalkInRefusedError('NOT_FOUND');
    return row;
  }
  // Read only: a missing row is written by `completeWalkIn`, at the
  // `Invitation` position of the lock order.
  const email = requireNormalised(subject.email);
  const row = await tx.invitation.findUnique({
    where: { teacherId_email: { teacherId, email } },
    select: { status: true },
  });
  return { email, firstName: subject.firstName, lastName: subject.lastName, status: row?.status ?? null };
}

export async function resolveWalkInStudent(
  tx: Prisma.TransactionClient,
  input: { teacherId: string; subject: WalkInSubject },
): Promise<ResolvedWalkIn> {
  const contact = await subjectContact(tx, input.teacherId, input.subject);

  // Erased first: the teacher already reads "Deleted Student" on this row.
  if (isErasedAddress(contact.email)) throw new WalkInRefusedError('INVITATION_ERASED');
  // Declined before blocked: a decline also writes a block (#522), and the
  // teacher already reads `declined` on their own Contacts row.
  if (contact.status === 'declined') throw new WalkInRefusedError('DECLINED');
  const blocked = await tx.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId: input.teacherId, email: contact.email } },
    select: { id: true },
  });
  if (blocked) throw new WalkInRefusedError('WALK_IN_REFUSED');

  const existing = await tx.student.findUnique({
    where: { email: contact.email },
    select: { id: true, incomeTier: true },
  });
  if (existing) {
    return { studentId: existing.id, incomeTier: existing.incomeTier, ...names(contact), created: false };
  }

  // A teacher-only account holding this address gets the profile now; sign-in
  // would never claim it (`resolveOrClaimAccount` returns early when an
  // Account exists). One live profile per account (#623), so an account that
  // already has one is left alone and the row stays unclaimed.
  const account = await tx.account.findUnique({
    where: { email: contact.email },
    select: { id: true, students: { where: { deletedAt: null }, select: { id: true } } },
  });
  const attach = account !== null && account.students.length === 0 ? account.id : null;

  // `ON CONFLICT DO NOTHING` rather than a caught P2002: Postgres aborts an
  // interactive transaction on any error, so a catch could not re-read.
  // An empty result means a concurrent create took the address first.
  const [created] = await tx.student.createManyAndReturn({
    data: [{
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      // Scalar pair in one statement: `Student_claim_link_check`.
      ...(attach ? { accountId: attach, claimedAt: new Date() } : {}),
    }],
    skipDuplicates: true,
    select: { id: true, incomeTier: true },
  });
  if (created) {
    return { studentId: created.id, incomeTier: created.incomeTier, ...names(contact), created: true };
  }
  const raced = await tx.student.findUniqueOrThrow({
    where: { email: contact.email },
    select: { id: true, incomeTier: true },
  });
  return { studentId: raced.id, incomeTier: raced.incomeTier, ...names(contact), created: false };
}

function names(c: { email: string; firstName: string; lastName: string }) {
  return { email: c.email, firstName: c.firstName, lastName: c.lastName };
}

export async function completeWalkIn(
  tx: Prisma.TransactionClient,
  input: { teacherId: string; classId: string; resolved: ResolvedWalkIn; notice: WalkInNotice },
): Promise<void> {
  const { teacherId, resolved } = input;

  // The teacher typed the name and the address; they have no claim on the
  // rest. The match branch seeds nothing — that person's own settings govern.
  if (resolved.created) {
    await tx.studentPrivacy.create({
      data: { teacherId, studentId: resolved.studentId, shareFullName: true, shareEmail: true },
    });
  }

  await linkTeacherStudent(tx, { teacherId, studentId: resolved.studentId });

  // An existing row keeps its name; a missing one takes the typed name. No
  // invitation email is sent: the walk-in notification below replaces it.
  await tx.invitation.createMany({
    data: [{ teacherId, email: resolved.email, firstName: resolved.firstName, lastName: resolved.lastName }],
    skipDuplicates: true,
  });
  const updated = await tx.invitation.updateMany({
    where: { teacherId, email: resolved.email, status: 'pending' },
    data: { status: 'accepted', respondedAt: new Date() },
  });
  if (updated.count === 0) {
    // A miss is classified by re-reading.
    const current = await tx.invitation.findUnique({
      where: { teacherId_email: { teacherId, email: resolved.email } },
      select: { status: true },
    });
    if (current === null) throw new WalkInRefusedError('NOT_FOUND');
    switch (current.status) {
      case 'accepted':
        // What was asked for.
        break;
      case 'declined':
        throw new WalkInRefusedError('DECLINED');
      case 'pending':
        // The row moved away and back between the two statements.
        throw new WalkInRefusedError('CONCURRENT_MODIFICATION');
      default: {
        const unhandled: never = current.status;
        throw new Error(`unhandled invitation status after a walk-in miss: ${String(unhandled)}`);
      }
    }
  }

  // After the roster link and the compare-and-set, so a block committed after
  // `resolveWalkInStudent`'s read — an unlink of an undelivered row leaves the
  // invitation `pending` — is seen; and before the notification, whose payload
  // reaches the event bus before this transaction commits.
  const blockedNow = await tx.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId, email: resolved.email } },
    select: { id: true },
  });
  if (blockedNow) throw new WalkInRefusedError('WALK_IN_REFUSED');

  await createBulkNotifications(tx, [{
    recipientType: 'student',
    recipientId: resolved.studentId,
    type: 'walk_in_added',
    title: `You're in ${input.notice.classType}`,
    body: `${input.notice.teacherName} added you to ${input.notice.classType} on ${input.notice.dateLabel}. Your price is calculated after class.`,
    relatedClassId: input.classId,
  }]);
}
