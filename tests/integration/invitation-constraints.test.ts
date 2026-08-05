import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * The two CHECK constraints #166 added (F10, review), asserted at the
 * DATABASE, not at any TypeScript guard — same standing as
 * `income-tier-constraint.test.ts`, and for the same reason: the JS-side
 * `.toLowerCase()` calls and the `respondedAt` writes are exactly what these
 * exist to survive. A test that went through a service would prove the
 * service, not the constraint.
 *
 * `toThrow` matches each constraint's own name rather than accepting any
 * rejection: with the constraint absent, a bare `rejects.toThrow()` would be
 * satisfied by a masking unique-key collision or an FK violation from a
 * stale fixture. The names are this repo's identifiers, set in the
 * invitation_check_constraints migration, not Prisma internals.
 *
 * Every fixture address below carries uppercase somewhere. An all-lowercase
 * one would make `email = lower(email)` indistinguishable from `TRUE`.
 */
describe('Invitation and TeacherBlock check constraints', () => {
  let teacherId: string;
  let teacherAccountId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Constraint', lastName: 'Teacher',
        email: `inv-constraint-teacher-${suffix}@test.local`,
        account: { create: { email: `inv-constraint-teacher-${suffix}@test.local` } },
        bio: 'Fixture for the #166 invitation CHECK constraints',
        pageSlug: `inv-constraint-teacher-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
  });

  afterAll(async () => {
    if (teacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId } });
      await prisma.teacher.deleteMany({ where: { id: teacherId } });
    }
    if (teacherAccountId) {
      await prisma.account.deleteMany({ where: { id: teacherAccountId } });
    }
    await prisma.$disconnect();
  });

  describe('email is lowercase by construction', () => {
    it('rejects a mixed-case Invitation.email on create', async () => {
      await expect(
        prisma.invitation.create({
          data: {
            teacherId,
            email: `Inv-Constraint-Create-${suffix}@Test.Local`,
            firstName: 'Mixed', lastName: 'Case',
          },
        }),
      ).rejects.toThrow(/Invitation_email_lowercase_check/);
    });

    it('rejects a mixed-case Invitation.email on update, and leaves the row alone', async () => {
      // The update path is the one `PUT /api/invitations/[id]` runs, and the
      // one a psql data fix runs. Seeded lowercase — the state a dropped
      // `.toLowerCase()` would move away from.
      const email = `inv-constraint-update-${suffix}@test.local`;
      const row = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Lower', lastName: 'Case' },
        select: { id: true },
      });

      await expect(
        prisma.invitation.update({
          where: { id: row.id },
          data: { email: email.toUpperCase() },
        }),
      ).rejects.toThrow(/Invitation_email_lowercase_check/);

      const after = await prisma.invitation.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.email).toBe(email);
    });

    it('rejects a mixed-case TeacherBlock.email on create', async () => {
      await expect(
        prisma.teacherBlock.create({
          data: { teacherId, email: `Inv-Constraint-Block-${suffix}@Test.Local` },
        }),
      ).rejects.toThrow(/TeacherBlock_email_lowercase_check/);
    });

    it('accepts the lowercase form both tables are written in', async () => {
      const email = `inv-constraint-ok-${suffix}@test.local`;
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Fine', lastName: 'Case' },
      });
      expect(invitation.email).toBe(email);
      const block = await prisma.teacherBlock.create({ data: { teacherId, email } });
      expect(block.email).toBe(email);
    });
  });

  describe('respondedAt is null exactly when the invitation is pending', () => {
    it('rejects a pending invitation that already carries a response time', async () => {
      await expect(
        prisma.invitation.create({
          data: {
            teacherId,
            email: `inv-constraint-pending-stamped-${suffix}@test.local`,
            firstName: 'Pending', lastName: 'Stamped',
            status: 'pending',
            respondedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/Invitation_responded_at_status_check/);
    });

    it('rejects answering an invitation without stamping it', async () => {
      const row = await prisma.invitation.create({
        data: {
          teacherId,
          email: `inv-constraint-unstamped-${suffix}@test.local`,
          firstName: 'Answered', lastName: 'Unstamped',
        },
        select: { id: true },
      });

      // `acceptInvitation`, `declineInvitation`, `unlinkTeacher` and
      // `resolveInvitationOnLink` all write both fields in one statement;
      // this is what happens to a future writer that only sets one.
      await expect(
        prisma.invitation.update({ where: { id: row.id }, data: { status: 'accepted' } }),
      ).rejects.toThrow(/Invitation_responded_at_status_check/);

      const after = await prisma.invitation.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe('pending');
      expect(after.respondedAt).toBeNull();
    });

    it("rejects inviteContact's revive if it ever stops clearing respondedAt", async () => {
      // The write this constraint was really added for: `inviteContact` is
      // the only place in the codebase that moves a row BACK to `pending`,
      // so it is the only one that has to clear the column rather than set
      // it. The fixture starts accepted-and-stamped — the state a revive
      // begins from — so the half-done revive below is a real one.
      const row = await prisma.invitation.create({
        data: {
          teacherId,
          email: `inv-constraint-revive-${suffix}@test.local`,
          firstName: 'To', lastName: 'Revive',
          status: 'accepted',
          respondedAt: new Date('2026-01-02T03:04:05.000Z'),
        },
        select: { id: true },
      });

      await expect(
        prisma.invitation.update({ where: { id: row.id }, data: { status: 'pending' } }),
      ).rejects.toThrow(/Invitation_responded_at_status_check/);

      // And the whole revive, as `inviteContact` actually writes it.
      const revived = await prisma.invitation.update({
        where: { id: row.id },
        data: { status: 'pending', respondedAt: null },
      });
      expect(revived.status).toBe('pending');
      expect(revived.respondedAt).toBeNull();
    });

    it('accepts both answered shapes', async () => {
      for (const status of ['accepted', 'declined'] as const) {
        const row = await prisma.invitation.create({
          data: {
            teacherId,
            email: `inv-constraint-${status}-${suffix}@test.local`,
            firstName: 'Answered', lastName: status,
            status,
            respondedAt: new Date(),
          },
        });
        expect(row.status).toBe(status);
        expect(row.respondedAt).not.toBeNull();
      }
    });
  });
});
