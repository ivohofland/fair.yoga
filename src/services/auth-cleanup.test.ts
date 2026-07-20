import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { cleanupExpiredAuth } from './auth-cleanup';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

let teacherId: string;
const liveSessionId = crypto.randomBytes(32).toString('hex');
const deadSessionId = crypto.randomBytes(32).toString('hex');
const liveTokenHash = crypto.randomBytes(32).toString('hex');
const deadTokenHash = crypto.randomBytes(32).toString('hex');

describe('cleanupExpiredAuth', () => {
  beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Cleanup',
        lastName: 'Teacher',
        email: `cleanup-${uniqueSuffix}@test.local`,
        account: { create: { email: `cleanup-${uniqueSuffix}@test.local` } },
        bio: 'auth cleanup test',
        pageSlug: `cleanup-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    const teacherAccountId = teacher.accountId;

    await prisma.session.createMany({
      data: [
        {
          id: liveSessionId,
          accountId: teacherAccountId,
          expiresAt: new Date(Date.now() + 86400000),
        },
        {
          id: deadSessionId,
          accountId: teacherAccountId,
          expiresAt: new Date(Date.now() - 1000),
        },
      ],
    });
    await prisma.magicLinkToken.createMany({
      data: [
        {
          tokenHash: liveTokenHash,
          email: `cleanup-${uniqueSuffix}@test.local`,
          expiresAt: new Date(Date.now() + 600000),
        },
        {
          tokenHash: deadTokenHash,
          email: `cleanup-${uniqueSuffix}@test.local`,
          expiresAt: new Date(Date.now() - 1000),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { id: { in: [liveSessionId, deadSessionId] } } });
    await prisma.magicLinkToken.deleteMany({ where: { email: { contains: uniqueSuffix } } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('deletes expired sessions and tokens, keeps live ones', async () => {
    const result = await cleanupExpiredAuth(prisma);
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(result.magicLinkTokens).toBeGreaterThanOrEqual(1);

    expect(await prisma.session.findUnique({ where: { id: liveSessionId } })).not.toBeNull();
    expect(await prisma.session.findUnique({ where: { id: deadSessionId } })).toBeNull();
    expect(
      await prisma.magicLinkToken.findUnique({ where: { tokenHash: liveTokenHash } }),
    ).not.toBeNull();
    expect(
      await prisma.magicLinkToken.findUnique({ where: { tokenHash: deadTokenHash } }),
    ).toBeNull();
  });
});
