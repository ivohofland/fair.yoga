import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { cleanupExpiredAuth } from './auth-cleanup';
import { scopeSweep } from '../../tests/scoped-sweep';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

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
    try {
      await prisma.session.deleteMany({ where: { id: { in: [liveSessionId, deadSessionId] } } });
      await prisma.magicLinkToken.deleteMany({ where: { email: { contains: uniqueSuffix } } });
      // By this run's email, not a captured id: an id left unset by a failed
      // beforeAll would be dropped from the where, widening the delete.
      await prisma.teacher.deleteMany({ where: { email: `cleanup-${uniqueSuffix}@test.local` } });
      await prisma.account.deleteMany({ where: { email: `cleanup-${uniqueSuffix}@test.local` } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('deletes expired sessions and tokens, keeps live ones', async () => {
    const scoped = scopeSweep(prisma, {
      Session: { id: { in: [liveSessionId, deadSessionId] } },
      MagicLinkToken: { tokenHash: { in: [liveTokenHash, deadTokenHash] } },
    });
    const result = await cleanupExpiredAuth(scoped.db);
    // One dead, one live session (and token) built above: exactly one of
    // each is a deletion candidate.
    expect(result.sessions).toBe(1);
    expect(result.magicLinkTokens).toBe(1);

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
