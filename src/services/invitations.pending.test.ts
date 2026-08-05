import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { listPendingInvitations } from './invitations';

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * #166 Task 11. `listPendingInvitations` is the read
 * `(student)/account/privacy/page.tsx` renders above the teacher list — an
 * async server component, so no component test can reach its query, which
 * is why this DB-query guard gets a service-level test instead. Same
 * precedent as `invitations.notify.test.ts` for `notifyInvitee`: a real
 * Prisma call against the test database, not a pure predicate like
 * `canRemoveContact` — a `where` clause has no pure-function form to
 * extract into.
 *
 * The block-exclusion tests matter most: a `TeacherBlock` is the student's
 * standing refusal of a teacher, and `acceptInvitation`'s own re-check of
 * it is defence in depth ONLY because this function is supposed to keep a
 * blocked pair off the list in the first place — see that function's
 * docblock in invitations.ts. Two mutations pass every test that existed
 * before this review pass without this function actually working:
 * `none: { email }` → `none: {}` (hides a teacher's entire pending list
 * the moment they've blocked ANYONE, not just this address) and
 * `status: 'pending'` → `status: { not: 'accepted' }` (resurrects a
 * declined invitation). The tests below are written to fail under each.
 */
describe('listPendingInvitations', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let otherTeacherId: string;
  let otherTeacherAccountId: string;
  let erasedTeacherId: string;
  let erasedTeacherAccountId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Pending', lastName: 'Teacher',
        email: `pending-list-teacher-${suffix}@test.local`,
        account: { create: { email: `pending-list-teacher-${suffix}@test.local` } },
        bio: 'Task 11 pending-invitations list fixture',
        pageSlug: `pending-list-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const other = await prisma.teacher.create({
      data: {
        firstName: 'Other', lastName: 'Teacher',
        email: `pending-list-other-${suffix}@test.local`,
        account: { create: { email: `pending-list-other-${suffix}@test.local` } },
        bio: 'Task 11 pending-invitations list — second-teacher fixture',
        pageSlug: `pending-list-other-${suffix}`,
      },
    });
    otherTeacherId = other.id;
    otherTeacherAccountId = other.accountId;

    // `deletedAt` set at creation, with the renamed fields erasure actually
    // writes (`deleteTeacherAccount`, services/gdpr.ts) — the "Deleted
    // Teacher" name below is what the student's card would render if this
    // row were ever offered to them.
    const erased = await prisma.teacher.create({
      data: {
        firstName: 'Deleted', lastName: 'Teacher',
        email: `pending-list-erased-${suffix}@test.local`,
        account: { create: { email: `pending-list-erased-${suffix}@test.local` } },
        bio: '',
        pageSlug: `pending-list-erased-${suffix}`,
        deletedAt: new Date(),
      },
    });
    erasedTeacherId = erased.id;
    erasedTeacherAccountId = erased.accountId;
  });

  afterAll(async () => {
    const teacherIds = [teacherId, otherTeacherId, erasedTeacherId].filter(Boolean);
    const accountIds = [
      teacherAccountId, otherTeacherAccountId, erasedTeacherAccountId,
    ].filter(Boolean);
    if (teacherIds.length) {
      await prisma.invitation.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    }
    if (accountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
    await prisma.$disconnect();
  });

  it('returns a pending invitation addressed to the account, matched case-insensitively', async () => {
    const email = `pending-list-student-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Some', lastName: 'Student' },
      select: { id: true },
    });
    try {
      // Mixed case on the account side is the point: this proves the
      // lowercasing, not merely that two identically-cased strings match.
      const result = await listPendingInvitations(prisma, { accountEmail: email.toUpperCase() });
      expect(result.map((r) => r.id)).toEqual([invitation.id]);
      expect(result[0]!.teacher).toEqual({ firstName: 'Pending', lastName: 'Teacher' });
    } finally {
      await prisma.invitation.deleteMany({ where: { id: invitation.id } });
    }
  });

  it('excludes an invitation already accepted or declined', async () => {
    // Both statuses, not just one: `status: 'pending'` and
    // `status: { not: 'accepted' }` agree on the accepted row and disagree
    // on the declined one — only the declined fixture can catch a
    // regression to the looser form, which would resurrect a tombstone
    // `declineInvitation` (services/invitations.ts) means to be permanent.
    const acceptedEmail = `pending-list-accepted-${suffix}@test.local`;
    const declinedEmail = `pending-list-declined-${suffix}@test.local`;
    const accepted = await prisma.invitation.create({
      data: {
        teacherId, email: acceptedEmail, status: 'accepted', respondedAt: new Date(),
        firstName: 'Answered', lastName: 'Accepted',
      },
      select: { id: true },
    });
    const declined = await prisma.invitation.create({
      data: {
        teacherId, email: declinedEmail, status: 'declined', respondedAt: new Date(),
        firstName: 'Answered', lastName: 'Declined',
      },
      select: { id: true },
    });
    try {
      expect(await listPendingInvitations(prisma, { accountEmail: acceptedEmail })).toEqual([]);
      expect(await listPendingInvitations(prisma, { accountEmail: declinedEmail })).toEqual([]);
    } finally {
      await prisma.invitation.deleteMany({ where: { id: { in: [accepted.id, declined.id] } } });
    }
  });

  it('excludes a pending invitation from a teacher the student has blocked', async () => {
    const email = `pending-list-blocked-${suffix}@test.local`;
    let block: { id: string } | undefined;
    let invitation: { id: string } | undefined;
    try {
      block = await prisma.teacherBlock.create({
        data: { teacherId: otherTeacherId, email },
        select: { id: true },
      });
      invitation = await prisma.invitation.create({
        data: { teacherId: otherTeacherId, email, firstName: 'Blocked', lastName: 'Invite' },
        select: { id: true },
      });

      const result = await listPendingInvitations(prisma, { accountEmail: email });
      expect(result).toEqual([]);
    } finally {
      if (invitation) await prisma.invitation.deleteMany({ where: { id: invitation.id } });
      if (block) await prisma.teacherBlock.deleteMany({ where: { id: block.id } });
    }
  });

  it('does not let a block from one teacher hide a pending invitation from a different, unblocked teacher for the same address', async () => {
    // Contrast case for the block test above: proves the exclusion is
    // scoped to the teacher the block actually names, not to the address
    // globally — one teacher's block must not hide another teacher's
    // invitation to the same person.
    const email = `pending-list-mixed-${suffix}@test.local`;
    let block: { id: string } | undefined;
    let blockedInvitation: { id: string } | undefined;
    let openInvitation: { id: string } | undefined;
    try {
      block = await prisma.teacherBlock.create({
        data: { teacherId: otherTeacherId, email },
        select: { id: true },
      });
      blockedInvitation = await prisma.invitation.create({
        data: { teacherId: otherTeacherId, email, firstName: 'Blocked', lastName: 'Invite' },
        select: { id: true },
      });
      openInvitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Open', lastName: 'Invite' },
        select: { id: true },
      });

      const result = await listPendingInvitations(prisma, { accountEmail: email });
      expect(result.map((r) => r.id)).toEqual([openInvitation.id]);
    } finally {
      if (blockedInvitation) {
        await prisma.invitation.deleteMany({ where: { id: blockedInvitation.id } });
      }
      if (openInvitation) await prisma.invitation.deleteMany({ where: { id: openInvitation.id } });
      if (block) await prisma.teacherBlock.deleteMany({ where: { id: block.id } });
    }
  });

  it("does not let a teacher's block on one address hide their OWN pending invitation to a different address", async () => {
    // The block-exclusion test proves a block hides its own address; the
    // cross-teacher contrast case proves a block from one teacher doesn't
    // hide a DIFFERENT teacher's invitation to the same address. Neither
    // ever leaves `teacherId` holding a `TeacherBlock` row of its own, so a
    // `none: {}` mutation (any block at all, on any address, hides every
    // one of this teacher's pending invitations) passes both undetected.
    // This fixture closes that gap: `teacherId` holds a block on one
    // address and a separate, unrelated pending invitation on another — the
    // query below must still return that invitation.
    const blockedAddress = `pending-list-own-blocked-${suffix}@test.local`;
    const openAddress = `pending-list-own-open-${suffix}@test.local`;
    let block: { id: string } | undefined;
    let openInvitation: { id: string } | undefined;
    try {
      block = await prisma.teacherBlock.create({
        data: { teacherId, email: blockedAddress },
        select: { id: true },
      });
      openInvitation = await prisma.invitation.create({
        data: { teacherId, email: openAddress, firstName: 'Open', lastName: 'Address' },
        select: { id: true },
      });

      const result = await listPendingInvitations(prisma, { accountEmail: openAddress });
      expect(result.map((r) => r.id)).toEqual([openInvitation.id]);
    } finally {
      if (openInvitation) await prisma.invitation.deleteMany({ where: { id: openInvitation.id } });
      if (block) await prisma.teacherBlock.deleteMany({ where: { id: block.id } });
    }
  });

  it('excludes a pending invitation from a soft-deleted teacher while still returning a live one to the same address', async () => {
    // F7, #166 review. Erasure deletes every `TeacherStudent` row but leaves
    // `Invitation` standing, so a pre-erasure invitation stays `pending`
    // forever. Offered here, the student gets a card asking them to connect
    // with "Deleted Teacher" — and accepting it recreates a link erasure
    // deleted (`acceptInvitation` carries the matching guard).
    //
    // Both rows are addressed to ONE address on purpose. Asserting only that
    // the erased teacher's row is absent would pass just as well if
    // `deletedAt: null` were mistyped into something that matches nothing at
    // all; the live row in the same result proves the filter discriminates
    // rather than empties.
    const email = `pending-list-erased-target-${suffix}@test.local`;
    let erasedInvitation: { id: string } | undefined;
    let liveInvitation: { id: string } | undefined;
    try {
      erasedInvitation = await prisma.invitation.create({
        data: { teacherId: erasedTeacherId, email, firstName: 'Erased', lastName: 'Invite' },
        select: { id: true },
      });
      liveInvitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Live', lastName: 'Invite' },
        select: { id: true },
      });

      const result = await listPendingInvitations(prisma, { accountEmail: email });
      expect(result.map((r) => r.id)).toEqual([liveInvitation.id]);
    } finally {
      const ids = [erasedInvitation?.id, liveInvitation?.id].filter(
        (id): id is string => id !== undefined,
      );
      if (ids.length) await prisma.invitation.deleteMany({ where: { id: { in: ids } } });
    }
  });
});
