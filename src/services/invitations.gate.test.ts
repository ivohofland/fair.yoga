import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { inviteContact } from './invitations';
import { log } from '@/lib/log';

// `invitations.ts` imports `@/lib/log`, so the specifier here must match that
// one — the same constraint `api-utils.test.ts` documents for its own mock.
vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * #412. `ALREADY_LINKED` is a distinct, teacher-visible outcome, so answering
 * it on the strength of the link alone confirmed that a typed address belongs
 * to one of this teacher's students — a fact `projectStudentForTeacher`
 * (lib/student-visibility.ts) returns as `null` everywhere else once a
 * CLAIMED student has withheld it. An unclaimed student withholds nothing
 * from anyone — every teacher-facing surface hands over their address in
 * full — so since #419 this gate mirrors that rather than being the one
 * place that pretends otherwise.
 *
 * A hit costs nothing and leaves nothing: `inviteContact` returns before any
 * write, and the route answers 409 before both the `lastNotifiedAt` write and
 * `deliverInvitation`. That is why the targeted case — testing one guessed
 * address against one suspected student — is the one worth closing, and it is
 * what these tests are written against.
 */
describe('inviteContact — the visibility gate on ALREADY_LINKED (#412, #419)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let otherTeacherId: string;
  let otherTeacherAccountId: string;
  const studentIds: string[] = [];
  const studentAccountIds: string[] = [];

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gate', lastName: 'Teacher',
        email: `gate-teacher-${suffix}@test.local`,
        account: { create: { email: `gate-teacher-${suffix}@test.local` } },
        bio: '#412 shareEmail gate fixture',
        pageSlug: `gate-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    // A second teacher, used below to prove `rosterLinkState`'s
    // `teacherStudents` read is scoped to `teacherId` — "linked to SOME
    // teacher" must not read as "linked to THIS teacher".
    const other = await prisma.teacher.create({
      data: {
        firstName: 'Gate', lastName: 'OtherTeacher',
        email: `gate-other-teacher-${suffix}@test.local`,
        account: { create: { email: `gate-other-teacher-${suffix}@test.local` } },
        bio: '#412 shareEmail gate fixture — cross-teacher scoping',
        pageSlug: `gate-other-teacher-${suffix}`,
      },
    });
    otherTeacherId = other.id;
    otherTeacherAccountId = other.accountId;
  });

  afterAll(async () => {
    if (studentIds.length) {
      await prisma.teacherStudent.deleteMany({ where: { studentId: { in: studentIds } } });
      await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    // After the students, never before: `Student.accountId` is the FK.
    if (studentAccountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: studentAccountIds } } });
    }
    if (teacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId } });
      await prisma.teacher.delete({ where: { id: teacherId } });
      await prisma.account.delete({ where: { id: teacherAccountId } });
    }
    if (otherTeacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId: otherTeacherId } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId: otherTeacherId } });
      await prisma.teacher.delete({ where: { id: otherTeacherId } });
      await prisma.account.delete({ where: { id: otherTeacherAccountId } });
    }
    await prisma.$disconnect();
  });

  /**
   * A CLAIMED student on this teacher's roster, with the privacy row this
   * test wants.
   *
   * Claimed is load-bearing, not incidental (#419). An unclaimed student
   * takes `rosterLinkState`'s `unclaimed ||` disjunct and reads
   * `mayBeTold: true` whatever the privacy row below says, so a test seeded
   * through here would certify the bypass instead of the flag it meant to
   * pin. Drop `claimedAt`/`account` and the cases that turn on a withheld
   * address go red — which is how this helper came to need fixing at all.
   *
   * The `account` is not optional decoration either — `Student_claim_link_check`
   * is `CHECK (("claimedAt" IS NULL) = ("accountId" IS NULL))`, so a claim
   * without one is rejected by Postgres.
   */
  async function seedLinked(
    label: string,
    privacy: { shareEmail: boolean } | null,
    opts: { linked?: boolean } = {},
  ): Promise<string> {
    const email = `gate-${label}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: label, email,
        claimedAt: new Date(),
        account: { create: { email } },
        ...(opts.linked === false ? {} : { teacherStudents: { create: { teacherId } } }),
        ...(privacy ? { studentPrivacy: { create: { teacherId, ...privacy } } } : {}),
      },
      select: { id: true, accountId: true },
    });
    studentIds.push(student.id);
    // Deleting the Student leaves its Account standing — `Student.accountId`
    // is the FK and there is no cascade — so these have to be collected and
    // dropped by hand, as the two teacher accounts already are.
    if (student.accountId) studentAccountIds.push(student.accountId);
    return email;
  }

  it('does not answer ALREADY_LINKED when the student has not shared their email', async () => {
    const email = await seedLinked('unshared', null);

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    // The whole point: an ordinary, indistinguishable success. The row must
    // genuinely be created — "did a new contact appear in my list?" is itself
    // a yes/no channel carrying the bit being withheld.
    if (!result.ok) throw new Error(`expected a fall-through invite, got ${result.reason}`);
    expect(result.value.delivered).toBe(false);
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email } },
      select: { status: true },
    });
    expect(row.status).toBe('pending');
  });

  it('treats an explicit shareEmail: false exactly as a missing privacy row', async () => {
    const email = await seedLinked('explicit-false', { shareEmail: false });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    expect(result.ok).toBe(true);
  });

  it('answers ALREADY_LINKED when the student HAS shared their email with this teacher', async () => {
    const email = await seedLinked('shared', { shareEmail: true });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_LINKED' });
    // A refusal, not a refusal-shaped success.
    expect(
      await prisma.invitation.findUnique({ where: { teacherId_email: { teacherId, email } } }),
    ).toBeNull();
  });

  it('answers ALREADY_LINKED when the student is unclaimed, bypassing shareEmail', async () => {
    const email = `gate-unclaimed-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: 'Unclaimed', email,
        // Unclaimed on purpose: no Account, and `claimedAt` left unset.
        // `Student_claim_link_check` forbids any other pairing of the two.
        teacherStudents: { create: { teacherId } },
        studentPrivacy: { create: { teacherId, shareEmail: false } },
      },
      select: { id: true },
    });
    studentIds.push(student.id);

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_LINKED' });
    expect(
      await prisma.invitation.findUnique({ where: { teacherId_email: { teacherId, email } } }),
    ).toBeNull();
  });

  it('still invites an UNCLAIMED student who is not on this teacher\'s roster', async () => {
    // The half of the #419 bypass that must not move. `mayBeTold` reads
    // `true` for any unclaimed row, linked or not — deliberately, since it is
    // only ever read behind `linked &&` — so this is the case that would turn
    // the gate back into #166's account-enumeration oracle if the conjunct
    // were ever dropped. The sibling test above pins the conjunct with a
    // CLAIMED, shared student; this one pins it on the path where the
    // producer itself has stopped withholding.
    const email = `gate-unclaimed-stranger-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: 'UnclaimedStranger', email,
        studentPrivacy: { create: { teacherId, shareEmail: false } },
      },
      select: { id: true },
    });
    studentIds.push(student.id);

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Not', lastName: 'Mine',
    });

    // Indistinguishable from inviting an address with no Student row at all:
    // an ordinary, delivered invitation.
    if (!result.ok) throw new Error(`expected an ordinary delivered invite, got ${result.reason}`);
    expect(result.value.delivered).toBe(true);
  });

  it('does not answer ALREADY_LINKED for a shared address that is NOT on the roster', async () => {
    // Pins the `linked &&` conjunct. Without it, `shareEmail: true` alone
    // would refuse an invitation to someone this teacher has never had.
    const email = await seedLinked('shared-unlinked', { shareEmail: true }, { linked: false });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Not', lastName: 'Mine',
    });

    expect(result.ok).toBe(true);
  });

  it('does not treat a student linked to a DIFFERENT teacher as linked to this one', async () => {
    // Two independent reviewers each manually deleted `where: { teacherId }`
    // from `rosterLinkState`'s `teacherStudents` select and found the entire
    // unit suite still green — this teacher-scoping was completely
    // untested. "Linked to SOME teacher" is not the same fact as "linked to
    // THIS teacher"; conflating them would make `linked` read true for any
    // teacher who happens to query an address already on a peer's roster,
    // reopening the exact account-enumeration oracle #166 closed (and #412
    // sharpened) via `ALREADY_LINKED`.
    //
    // This fixture is unclaimed and that is now deliberate: claiming it
    // leaves the whole suite green, so its unclaimedness is the only thing
    // making it exercise the #419 bypass alongside the scoping. The
    // stranger test above covers the same ground on purpose rather than by
    // accident — this note exists so a future edit does not quietly claim
    // this row the way `seedLinked`'s students were quietly claimed.
    const email = `gate-other-teacher-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: 'OtherTeacherStudent', email,
        teacherStudents: { create: { teacherId: otherTeacherId } },
      },
      select: { id: true },
    });
    studentIds.push(student.id);

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Not', lastName: 'Mine',
    });

    // Also closes an already-known, separately-flagged gap: no
    // unit-runnable test previously pinned `delivered === true` on the
    // ordinary (unblocked, unlinked-to-THIS-teacher) success path.
    if (!result.ok) throw new Error(`expected an ordinary delivered invite, got ${result.reason}`);
    expect(result.value.delivered).toBe(true);
  });

  it('answers ALREADY_LINKED on an accepted invitation, and leaves that row untouched', async () => {
    // The second disjunct. It exists to keep the gated path out of
    // `revivePendingInvitation`, which would flip this row to `pending`
    // (rendering it as an outstanding "Invited" contact for someone already
    // in the directory), clear `isArchived`, and overwrite the names.
    const email = await seedLinked('accepted', null);
    const acceptedAt = new Date('2026-01-02T03:04:05.000Z');
    await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Original', lastName: 'Name',
        status: 'accepted', respondedAt: acceptedAt, isArchived: true,
      },
    });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Rewritten', lastName: 'Name',
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_LINKED' });
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email } },
      select: {
        status: true, respondedAt: true, isArchived: true,
        firstName: true, lastName: true,
      },
    });
    expect(row).toEqual({
      status: 'accepted',
      respondedAt: acceptedAt,
      isArchived: true,
      firstName: 'Original',
      lastName: 'Name',
    });
  });

  /**
   * `rosterLinkState`'s `log.warn` is the only runtime record that the #419
   * bypass fired, and it is not redundant with `bypassesPrivacy`'s: that one
   * needs the student to be PROJECTED, and `GET /api/students` lists only
   * `isArchived: false` links while this gate reads links unfiltered. An
   * archived unclaimed contact is therefore bypassed here and logged nowhere
   * else.
   *
   * Both directions, for the reason `student-visibility.test.ts` gives for
   * its twin: a warn that fired unconditionally would satisfy a firing test
   * while logging on every ordinary invitation, and a deleted one leaves
   * every suite green.
   */
  describe('the unclaimed-student tripwire', () => {
    beforeEach(() => {
      vi.mocked(log.warn).mockClear();
    });

    it('warns with both ids when the bypass decides a linked pair', async () => {
      const email = `gate-warn-fires-${suffix}@test.local`;
      const student = await prisma.student.create({
        data: {
          firstName: 'Gate', lastName: 'WarnFires', email,
          teacherStudents: { create: { teacherId } },
        },
        select: { id: true },
      });
      studentIds.push(student.id);

      await inviteContact(prisma, { teacherId, email, firstName: 'A', lastName: 'B' });

      // Both ids: `studentId` says whose privacy was bypassed, `teacherId`
      // says who was told — the payload `bypassesPrivacy` settled on in
      // #167's round-two review, for the same reason.
      expect(log.warn).toHaveBeenCalledWith(
        { studentId: student.id, teacherId },
        expect.stringContaining('unclaimed Student'),
      );
    });

    it('stays silent for a claimed student, and for an unclaimed stranger', async () => {
      // Claimed: nothing was bypassed. Unclaimed but unlinked: `mayBeTold`
      // reads `true`, but the caller never reaches it, so no bypass changed
      // an answer and there is nothing to report. A warn here would fire on
      // ordinary invitations to strangers and drown the real signal.
      const claimed = await seedLinked('warn-silent-claimed', { shareEmail: true });
      await inviteContact(prisma, { teacherId, email: claimed, firstName: 'A', lastName: 'B' });

      const strangerEmail = `gate-warn-silent-stranger-${suffix}@test.local`;
      const stranger = await prisma.student.create({
        data: { firstName: 'Gate', lastName: 'WarnSilentStranger', email: strangerEmail },
        select: { id: true },
      });
      studentIds.push(stranger.id);
      await inviteContact(prisma, {
        teacherId, email: strangerEmail, firstName: 'A', lastName: 'B',
      });

      expect(log.warn).not.toHaveBeenCalled();
    });
  });
});
