import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { inviteContact, unlinkTeacher } from './invitations';
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
    opts: { linked?: boolean; archived?: boolean } = {},
  ): Promise<string> {
    const email = `gate-${label}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: label, email,
        claimedAt: new Date(),
        account: { create: { email } },
        ...(opts.linked === false
          ? {}
          : { teacherStudents: { create: { teacherId, isArchived: opts.archived ?? false } } }),
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
      select: { status: true, delivered: true },
    });
    expect(row.status).toBe('pending');
    // Not just the in-memory return value — the row itself has to carry
    // `delivered` too, since that is what a later writer will need to scope
    // a mutation to rows that were actually delivered.
    expect(row.delivered).toBe(false);
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

  it('still answers ALREADY_LINKED when the roster link is archived', async () => {
    // `shareEmail: true`, not `false`/`null`: this turns the assertion on
    // `linked` alone. With `mayBeTold` withheld, an archived link that failed
    // to count as `linked` would fall through to the same ordinary success as
    // an unshared one — this test would pass either way, and catch nothing.
    const email = await seedLinked('archived', { shareEmail: true }, { archived: true });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_LINKED' });
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
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email } },
      select: { delivered: true },
    });
    expect(row.delivered).toBe(true);
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
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email } },
      select: { delivered: true },
    });
    expect(row.delivered).toBe(true);
  });

  /**
   * #418's bundled gap B. Every case above pins one side of the
   * indistinguishability property in isolation — a stranger fixture in one
   * `it`, a gated fixture in another — so nothing catches a change that
   * moves both sides in step. This test invites both in the same run and
   * compares the two outcomes against each other, not against a literal
   * repeated on each side.
   *
   * The stranger fixture is deliberately a bare address with no `Student`
   * row at all — the actual baseline `rosterLinkState` returns
   * `{ linked: false, mayBeTold: false }` for — and not the fixture in
   * `'still invites an UNCLAIMED student who is not on this teacher's
   * roster'` above, which is a different population `rosterLinkState`
   * reaches through the `unclaimed ||` disjunct and which already has its
   * own test.
   *
   * Every comparison below is load-bearing or absent. A cross-comparison
   * standing beside absolute assertions of both its sides certifies nothing —
   * it is implied by them — so where one is kept, exactly one side is pinned
   * and the other is left for the comparison to derive.
   */
  it('answers a gated linked-unshared student the same as a genuine stranger, apart from the withheld delivered bit', async () => {
    const strangerEmail = `gate-cmp-stranger-${suffix}@test.local`;
    const gatedEmail = await seedLinked('cmp-gated', { shareEmail: false });

    const strangerResult = await inviteContact(prisma, {
      teacherId, email: strangerEmail, firstName: 'Compare', lastName: 'Stranger',
    });
    const gatedResult = await inviteContact(prisma, {
      teacherId, email: gatedEmail, firstName: 'Compare', lastName: 'Gated',
    });

    // Both narrowed to the success arm, which is STRONGER than comparing the
    // two `ok`s: it says they agree AND which way. A cross-comparison here
    // would certify nothing on top of these — the pair of throws already
    // rules out both-false — and TypeScript needs them anyway to reach
    // `.value` below.
    if (!strangerResult.ok) {
      throw new Error(`expected the stranger invite to succeed, got ${strangerResult.reason}`);
    }
    if (!gatedResult.ok) {
      throw new Error(`expected the gated invite to succeed, got ${gatedResult.reason}`);
    }

    // Same result-object shape — the keys the caller gets back, compared
    // against each other rather than against a hardcoded list. Values are
    // not compared here: `id` is a fresh uuid per row and necessarily
    // differs.
    expect(Object.keys(gatedResult.value).sort()).toEqual(Object.keys(strangerResult.value).sort());

    // `delivered` is the one field this pair is allowed to differ on, by
    // design — see its own docblock on `InviteResult`. Two assertions, not
    // three: the gated side is pinned absolutely, and the stranger's `true`
    // is what the cross-comparison then DERIVES rather than restates. Pin
    // both absolutely and the comparison stops carrying anything.
    expect(gatedResult.value.delivered).toBe(false);
    expect(gatedResult.value.delivered).not.toBe(strangerResult.value.delivered);

    const [strangerRow, gatedRow] = await Promise.all([
      prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email: strangerEmail } },
        select: { status: true, respondedAt: true, isArchived: true },
      }),
      prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email: gatedEmail } },
        select: { status: true, respondedAt: true, isArchived: true },
      }),
    ]);

    // The resulting `Invitation` rows, compared against each other.
    // `findUniqueOrThrow` above is what proves a row exists in both cases —
    // a missing row throws before this assertion is ever reached.
    expect(gatedRow).toEqual(strangerRow);

    // `delivered` read separately, on each row, rather than folded into the
    // comparison above: it is the one field this pair is allowed to differ
    // on (see the assertions on `.value.delivered` above), so it stays out
    // of the equality check and is pinned absolutely instead.
    const [strangerDelivered, gatedDelivered] = await Promise.all([
      prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email: strangerEmail } },
        select: { delivered: true },
      }),
      prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email: gatedEmail } },
        select: { delivered: true },
      }),
    ]);
    expect(strangerDelivered.delivered).toBe(true);
    expect(gatedDelivered.delivered).toBe(false);
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
   * Task 2 (`unlinkTeacher`'s tombstone scope) reads `delivered` off the row
   * at the moment it acts, not off whatever the row's very first write said —
   * so a revive has to keep that value current every time it fires, not just
   * the first. This drives the SAME row through two revives: an ordinary one
   * (no block, no link — `delivered: true`), then a second one after a
   * `TeacherBlock` appears at the address, and checks the persisted column
   * flips with it.
   */
  it('a revive persists the CURRENT delivered value, not the one from its first write', async () => {
    const email = `gate-revive-delivered-${suffix}@test.local`;
    const acceptedAt = new Date('2026-02-03T04:05:06.000Z');
    // Hand-written `accepted` row, the same fixture shape
    // `invitations.revive.test.ts` uses to drive `revivePendingInvitation`
    // without a full accept flow. No `Student`/`TeacherStudent` row at this
    // address, so `rosterLinkState` reads `{ linked: false, mayBeTold:
    // false }` for both invites below — only the `TeacherBlock` planted
    // between them is what changes.
    const invitation = await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Revive', lastName: 'Original',
        status: 'accepted', respondedAt: acceptedAt,
      },
      select: { id: true },
    });

    const firstResult = await inviteContact(prisma, {
      teacherId, email, firstName: 'Revive', lastName: 'First',
    });
    if (!firstResult.ok) {
      throw new Error(`expected the first revive to succeed, got ${firstResult.reason}`);
    }
    expect(firstResult.value.id).toBe(invitation.id);
    expect(firstResult.value.delivered).toBe(true);
    expect(
      (
        await prisma.invitation.findUniqueOrThrow({
          where: { id: invitation.id },
          select: { delivered: true },
        })
      ).delivered,
    ).toBe(true);

    // Move the SAME row back to `accepted` — standing in for a second accept
    // — and plant a block, so the next invite both revives this row again
    // and finds it undelivered.
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: 'accepted', respondedAt: acceptedAt },
    });
    await prisma.teacherBlock.create({ data: { teacherId, email } });

    const secondResult = await inviteContact(prisma, {
      teacherId, email, firstName: 'Revive', lastName: 'Second',
    });
    if (!secondResult.ok) {
      throw new Error(`expected the second revive to succeed, got ${secondResult.reason}`);
    }
    expect(secondResult.value.id).toBe(invitation.id);
    expect(secondResult.value.delivered).toBe(false);
    expect(
      (
        await prisma.invitation.findUniqueOrThrow({
          where: { id: invitation.id },
          select: { delivered: true },
        })
      ).delivered,
    ).toBe(false);
  });

  /**
   * `rosterLinkState`'s `log.warn` is the only runtime record that the #419
   * bypass fired at THIS gate, and it is not redundant with
   * `bypassesPrivacy`'s: that one needs the student to be PROJECTED, and this
   * gate is not a projection — see `rosterLinkState`'s own tripwire comment
   * (`services/invitations.ts`) for why that difference means both need their
   * own warn.
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

/**
 * Task 2 of #502: `unlinkTeacher`'s tombstone `updateMany`
 * (`src/services/invitations.ts`) now scopes its `where` to
 * `delivered: true`. These two tests drive the real gate above to produce a
 * genuine `delivered: false` decoy row and the real `unlinkTeacher` against
 * it, rather than fabricating a row shape by hand — the same rigor the
 * `unlinkTeacher`-behavior tests in `tests/integration/invitations-api.test
 * .ts` use, minus the HTTP layer (this file already has no server on
 * `:3000` to reach).
 */
describe('unlinkTeacher scopes its tombstone to delivered invitations (#502)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  const studentIds: string[] = [];
  const studentAccountIds: string[] = [];

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Unlink', lastName: 'Scope',
        email: `unlink-scope-teacher-${suffix}@test.local`,
        account: { create: { email: `unlink-scope-teacher-${suffix}@test.local` } },
        bio: '#502 task 2 unlink-tombstone-scope fixture',
        pageSlug: `unlink-scope-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
  });

  afterAll(async () => {
    if (studentIds.length) {
      await prisma.teacherStudent.deleteMany({ where: { studentId: { in: studentIds } } });
      await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    if (studentAccountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: studentAccountIds } } });
    }
    if (teacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId } });
      await prisma.teacher.delete({ where: { id: teacherId } });
      await prisma.account.delete({ where: { id: teacherAccountId } });
    }
    await prisma.$disconnect();
  });

  it('leaves a genuinely never-delivered invitation pending after its guessed student unlinks', async () => {
    // Linked, claimed, no shared privacy: the same #417/#418 gate shape as
    // `seedLinked(label, null)` above, reproduced here (rather than reusing
    // that helper) because this test also needs the student's own id to
    // call `unlinkTeacher`, which `seedLinked` does not return.
    const email = `unlink-scope-undelivered-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Unlink', lastName: 'Undelivered', email,
        claimedAt: new Date(),
        account: { create: { email } },
        teacherStudents: { create: { teacherId } },
      },
      select: { id: true, accountId: true },
    });
    studentIds.push(student.id);
    if (student.accountId) studentAccountIds.push(student.accountId);

    const invited = await inviteContact(prisma, {
      teacherId, email, firstName: 'Guessed', lastName: 'Decoy',
    });
    if (!invited.ok) throw new Error(`expected the gated invite to succeed, got ${invited.reason}`);
    expect(invited.value.delivered).toBe(false);

    const result = await unlinkTeacher(prisma, {
      teacherId, studentId: student.id, accountEmail: email,
    });
    expect(result).toEqual({ ok: true });

    // The invitee was never told this row exists, so `unlinkTeacher`'s
    // scoped `updateMany` must not match it — it stays exactly as
    // `inviteContact` left it.
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email } },
      select: { status: true, respondedAt: true },
    });
    expect(row.status).toBe('pending');
    expect(row.respondedAt).toBeNull();
  });

  it('still tombstones a genuinely delivered invitation when its student unlinks (regression)', async () => {
    // Invited BEFORE any link exists, so `rosterLinkState` reads
    // `{ linked: false }` and `inviteContact` takes its ordinary path —
    // `delivered: true`, no gate involved.
    const email = `unlink-scope-delivered-${suffix}@test.local`;
    const invited = await inviteContact(prisma, {
      teacherId, email, firstName: 'Ordinary', lastName: 'Invite',
    });
    if (!invited.ok) throw new Error(`expected an ordinary delivered invite, got ${invited.reason}`);
    expect(invited.value.delivered).toBe(true);

    // The link forms afterward, independently of the invitation — a
    // booking, in the real app (the same shape as the two residual routes
    // `docs/superpowers/specs/2026-09-07-gated-ghost-invitation-design.md`
    // §3 already names: a delivered `pending` row still standing once a
    // link exists).
    const student = await prisma.student.create({
      data: {
        firstName: 'Unlink', lastName: 'DeliveredRegression', email,
        claimedAt: new Date(),
        account: { create: { email } },
        teacherStudents: { create: { teacherId } },
      },
      select: { id: true, accountId: true },
    });
    studentIds.push(student.id);
    if (student.accountId) studentAccountIds.push(student.accountId);

    const result = await unlinkTeacher(prisma, {
      teacherId, studentId: student.id, accountEmail: email,
    });
    expect(result).toEqual({ ok: true });

    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email } },
      select: { status: true, respondedAt: true },
    });
    expect(row.status).toBe('declined');
    expect(row.respondedAt).not.toBeNull();
  });
});
