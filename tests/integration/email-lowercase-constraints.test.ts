import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * The four CHECK constraints #170 added, asserted at the DATABASE rather than
 * through any service — same standing as `invitation-constraints.test.ts` and
 * for the same reason. `emailField` is exactly what these exist to survive; a
 * test that went through a route would prove the schema, not the constraint.
 */
describe('email lowercase check constraints', () => {
  const created: string[] = [];

  afterAll(async () => {
    await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.teacher.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.account.deleteMany({ where: { id: { in: created } } });
    await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.$disconnect();
  });

  it('rejects a mixed-case Account.email on create', async () => {
    await expect(
      prisma.account.create({ data: { email: `Case-Acct-${suffix}@Test.Local` } }),
    ).rejects.toThrow(/Account_email_lowercase_check/);
  });

  it('rejects a mixed-case Account.email on update, and leaves the row alone', async () => {
    const email = `case-acct-upd-${suffix}@test.local`;
    const row = await prisma.account.create({ data: { email }, select: { id: true } });
    created.push(row.id);

    await expect(
      prisma.account.update({ where: { id: row.id }, data: { email: email.toUpperCase() } }),
    ).rejects.toThrow(/Account_email_lowercase_check/);

    const after = await prisma.account.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.email).toBe(email);
  });

  it('rejects a mixed-case Teacher.email on create', async () => {
    await expect(
      prisma.teacher.create({
        data: {
          firstName: 'Mixed', lastName: 'Case',
          email: `Case-Teach-${suffix}@Test.Local`,
          bio: 'Fixture for the #170 CHECK constraints',
          pageSlug: `case-teach-${suffix}`,
          account: { create: { email: `case-teach-acct-${suffix}@test.local` } },
        },
      }),
    ).rejects.toThrow(/Teacher_email_lowercase_check/);
  });

  it('rejects a mixed-case Student.email on create', async () => {
    await expect(
      prisma.student.create({
        data: {
          firstName: 'Mixed', lastName: 'Case',
          email: `Case-Stud-${suffix}@Test.Local`,
        },
      }),
    ).rejects.toThrow(/Student_email_lowercase_check/);
  });

  it('rejects a mixed-case MagicLinkToken.email on create', async () => {
    await expect(
      prisma.magicLinkToken.create({
        data: {
          tokenHash: `case-token-${suffix}`,
          email: `Case-Token-${suffix}@Test.Local`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow(/MagicLinkToken_email_lowercase_check/);
  });

  it('accepts the lowercase form every writer is expected to produce', async () => {
    const email = `case-ok-${suffix}@test.local`;
    const row = await prisma.account.create({ data: { email }, select: { id: true } });
    created.push(row.id);
    expect(row.id).toBeTruthy();
  });

  it("accepts gdpr.ts's synthesized erasure address", async () => {
    // `deleted-<uuid>@deleted.invalid` is the shape gdpr.ts writes at five
    // sites during erasure, bypassing Zod entirely. Prisma's `@default(uuid())`
    // is lowercase hex, so it satisfies the constraint — pinned here because a
    // CHECK that rejected it would break the right-to-erasure path, and that
    // failure would surface only when someone actually erased an account.
    //
    // Uses a real uuid rather than a hand-shaped literal: the point is that
    // whatever `uuid()` produces passes, so generating one is the honest probe.
    const row = await prisma.account.create({
      data: { email: `deleted-${randomUUID()}@deleted.invalid` },
      select: { id: true },
    });
    created.push(row.id);
    expect(row.id).toBeTruthy();
  });
});
