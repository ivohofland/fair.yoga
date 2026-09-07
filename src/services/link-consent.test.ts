/**
 * `resolveInvitationOnLink`'s decision table, and the oracle its `pending`
 * column closes (#418).
 *
 * Two inputs decide everything this function does — the invitation's status,
 * and whether the act being resolved is the one that put the student on this
 * teacher's roster — and each cell of that table is its own case below,
 * because the asymmetry between the two columns is the design rather than an
 * accident of it. `pending` resolves only on a link this act created;
 * `declined` resolves either way; `accepted` is never touched; the
 * `TeacherBlock` goes regardless. A later simplification that returned early
 * whenever the link already stood would satisfy every `pending` case here and
 * break the `declined` one, which is a student's only route back to a teacher
 * they declined.
 *
 * The last case is why the narrowing exists at all, and it runs end to end
 * through `inviteContact` rather than asserting about a row: the refusal the
 * teacher's second probe meets is the observable, and only a test that names
 * WHICH refusal can tell the closed oracle from the open one.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { InvitationStatus } from '@prisma/client';
import crypto from 'crypto';
import { resolveInvitationOnLink } from './link-consent';
import { inviteContact } from './invitations';

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

const teacherIds: string[] = [];
const studentIds: string[] = [];
const accountIds: string[] = [];

afterAll(async () => {
  if (teacherIds.length) {
    await prisma.invitation.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.studentPrivacy.deleteMany({ where: { teacherId: { in: teacherIds } } });
  }
  if (studentIds.length) {
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  }
  if (teacherIds.length) {
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  }
  // Last, and after both profiles: `Student.accountId` and `Teacher.accountId`
  // are plain FKs with no cascade, so an account dropped first is refused.
  if (accountIds.length) {
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
});

/**
 * A fresh teacher and a fresh CLAIMED student, linked, one pair per case — so
 * no two cases contend for the `(teacherId, email)` key an `Invitation` is
 * unique on, and none of them collides with a file running beside this one.
 *
 * Linked in every case, including the `linkCreatedNow: true` ones, because
 * that is the state this function is always called in: the link write runs
 * first and the flag says who wrote it, not whether it is there.
 *
 * Claimed is load-bearing for the last case and free for the rest.
 * `rosterLinkState` (`invitations.ts`) reads an unclaimed student as tellable
 * whatever their privacy row says, so an unclaimed fixture would meet
 * `ALREADY_LINKED` on the first probe and never reach the sequence under
 * test. The account is what `Student_claim_link_check` demands alongside
 * `claimedAt`.
 */
async function seedPair(
  label: string,
  opts: { invitation?: { status: InvitationStatus; respondedAt?: Date }; blocked?: boolean } = {},
): Promise<{ teacherId: string; email: string }> {
  const teacherEmail = `link-consent-${label}-teacher-${suffix}@test.local`;
  const email = `link-consent-${label}-student-${suffix}@test.local`;

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Link', lastName: 'Consent',
      email: teacherEmail,
      account: { create: { email: teacherEmail } },
      bio: '#418 link-consent fixture teacher',
      pageSlug: `link-consent-${label}-${suffix}`,
    },
    select: { id: true, accountId: true },
  });
  teacherIds.push(teacher.id);
  accountIds.push(teacher.accountId);

  const student = await prisma.student.create({
    data: {
      firstName: 'Link', lastName: 'Consent',
      email, claimedAt: new Date(),
      account: { create: { email } },
      teacherStudents: { create: { teacherId: teacher.id } },
      // Written out rather than left absent, though `rosterLinkState` reads a
      // missing row the same way: the withheld address is the precondition of
      // the last case, and a fixture that only implied it would go on passing
      // if that default ever changed.
      studentPrivacy: { create: { teacherId: teacher.id, shareEmail: false } },
    },
    select: { id: true, accountId: true },
  });
  studentIds.push(student.id);
  if (student.accountId) accountIds.push(student.accountId);

  if (opts.invitation) {
    await prisma.invitation.create({
      data: {
        teacherId: teacher.id, email,
        firstName: 'Link', lastName: 'Consent',
        status: opts.invitation.status,
        // `Invitation_responded_at_status_check` is
        // `("respondedAt" IS NULL) = (status = 'pending')`, so the timestamp
        // is not the fixture's choice to make independently of the status.
        respondedAt:
          opts.invitation.status === 'pending' ? null : (opts.invitation.respondedAt ?? new Date()),
      },
    });
  }

  if (opts.blocked) {
    await prisma.teacherBlock.create({ data: { teacherId: teacher.id, email } });
  }

  return { teacherId: teacher.id, email };
}

function invitationRow(teacherId: string, email: string) {
  return prisma.invitation.findUniqueOrThrow({
    where: { teacherId_email: { teacherId, email } },
    select: { status: true, respondedAt: true },
  });
}

describe('resolveInvitationOnLink', () => {
  /**
   * The change itself. Someone already on the roster has nothing left to
   * consent to, so their booking is not an acceptance of an invitation they
   * were never shown — and a row that never moves gives a second probe
   * nothing to read.
   */
  it('leaves a pending invitation standing when the link already existed', async () => {
    const { teacherId, email } = await seedPair('pending-existing-link', {
      invitation: { status: 'pending' },
    });

    await resolveInvitationOnLink(prisma, {
      teacherId, studentEmail: email, linkCreatedNow: false,
    });

    expect(await invitationRow(teacherId, email)).toEqual({ status: 'pending', respondedAt: null });
  });

  it('accepts a pending invitation when this act created the link', async () => {
    const { teacherId, email } = await seedPair('pending-new-link', {
      invitation: { status: 'pending' },
    });

    await resolveInvitationOnLink(prisma, {
      teacherId, studentEmail: email, linkCreatedNow: true,
    });

    const row = await invitationRow(teacherId, email);
    expect(row.status).toBe('accepted');
    expect(row.respondedAt).not.toBeNull();
  });

  /**
   * The deliberate asymmetry, and the case that makes it a decision rather
   * than a slip: this is the ONE cell where `false` still writes. A decline
   * is what `DELETE /api/invitations/[id]` refuses to remove, so a student
   * who is somehow linked behind a standing tombstone has no way out but
   * this write.
   */
  it('clears a declined tombstone even when the link already existed', async () => {
    const declinedAt = new Date('2026-02-03T04:05:06.000Z');
    const { teacherId, email } = await seedPair('declined-existing-link', {
      invitation: { status: 'declined', respondedAt: declinedAt },
    });

    await resolveInvitationOnLink(prisma, {
      teacherId, studentEmail: email, linkCreatedNow: false,
    });

    const row = await invitationRow(teacherId, email);
    expect(row.status).toBe('accepted');
    expect(row.respondedAt).not.toEqual(declinedAt);
  });

  it('clears a declined tombstone when this act created the link', async () => {
    const declinedAt = new Date('2026-02-03T04:05:06.000Z');
    const { teacherId, email } = await seedPair('declined-new-link', {
      invitation: { status: 'declined', respondedAt: declinedAt },
    });

    await resolveInvitationOnLink(prisma, {
      teacherId, studentEmail: email, linkCreatedNow: true,
    });

    const row = await invitationRow(teacherId, email);
    expect(row.status).toBe('accepted');
    expect(row.respondedAt).not.toEqual(declinedAt);
  });

  // The two cells that are the same under both columns, asserted under both
  // rather than under whichever one the writer happened to reach for.
  for (const linkCreatedNow of [true, false]) {
    it(`leaves an accepted invitation and its respondedAt alone (linkCreatedNow: ${linkCreatedNow})`, async () => {
      const acceptedAt = new Date('2026-01-02T03:04:05.000Z');
      const { teacherId, email } = await seedPair(`accepted-${linkCreatedNow}`, {
        invitation: { status: 'accepted', respondedAt: acceptedAt },
      });

      await resolveInvitationOnLink(prisma, { teacherId, studentEmail: email, linkCreatedNow });

      expect(await invitationRow(teacherId, email)).toEqual({
        status: 'accepted',
        respondedAt: acceptedAt,
      });
    });

    it(`deletes the TeacherBlock (linkCreatedNow: ${linkCreatedNow})`, async () => {
      const { teacherId, email } = await seedPair(`blocked-${linkCreatedNow}`, { blocked: true });

      await resolveInvitationOnLink(prisma, { teacherId, studentEmail: email, linkCreatedNow });

      const block = await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId, email } },
      });
      expect(block).toBeNull();
    });
  }

  /**
   * The sequence #418 is about, end to end through the real invite path.
   *
   * A teacher guesses the address of someone already on their roster who has
   * withheld it. #417 answers that with an ordinary success and a real,
   * undelivered `pending` row, so the first probe discloses nothing. The
   * second probe is where it used to disclose everything: the student's next
   * booking flipped that row to `accepted`, and an `accepted` row on a linked
   * pair is refused `ALREADY_LINKED` — an answer no stranger's address can
   * produce.
   *
   * The reason string is the assertion, not the refusal: both outcomes are
   * `ok: false`, and only one of them is the disclosure.
   */
  it('a gated address still answers ALREADY_INVITED on a second probe after the student books', async () => {
    const { teacherId, email } = await seedPair('oracle');

    const probeOne = await inviteContact(prisma, {
      teacherId, email, firstName: 'Guessed', lastName: 'Address',
    });
    if (!probeOne.ok) {
      throw new Error(`expected the gated fall-through invite, got ${probeOne.reason}`);
    }
    // The decoy: a row the teacher can see, an email nobody receives.
    expect(probeOne.value.delivered).toBe(false);
    expect((await invitationRow(teacherId, email)).status).toBe('pending');

    // What that student's next ordinary booking now does. They are already on
    // this teacher's roster, so the booking's own link write inserts nothing
    // and reports `false`.
    await resolveInvitationOnLink(prisma, {
      teacherId, studentEmail: email, linkCreatedNow: false,
    });

    const probeTwo = await inviteContact(prisma, {
      teacherId, email, firstName: 'Guessed', lastName: 'Address',
    });
    expect(probeTwo).toEqual({ ok: false, reason: 'ALREADY_INVITED' });
  });
});
