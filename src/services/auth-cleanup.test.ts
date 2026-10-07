import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { cleanupExpiredAuth } from './auth-cleanup';
import { HANDOFF_EMAIL_WINDOW_MS } from '@/lib/auth/handoff';
import { scopeSweep } from '../../tests/scoped-sweep';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

const liveSessionId = crypto.randomBytes(32).toString('hex');
const deadSessionId = crypto.randomBytes(32).toString('hex');
const liveTokenHash = crypto.randomBytes(32).toString('hex');
const deadTokenHash = crypto.randomBytes(32).toString('hex');
const staleBudgetEmail = `cleanup-budget-stale-${uniqueSuffix}@test.local`;
const freshBudgetEmail = `cleanup-budget-fresh-${uniqueSuffix}@test.local`;
// Fixed, and passed to the sweep, so every fixture sits a known distance from
// it: one budget window ended exactly at it, the other a millisecond short.
const now = new Date();

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
          expiresAt: new Date(now.getTime() + 86400000),
        },
        {
          id: deadSessionId,
          accountId: teacherAccountId,
          expiresAt: new Date(now.getTime() - 1000),
        },
      ],
    });
    await prisma.magicLinkToken.createMany({
      data: [
        {
          tokenHash: liveTokenHash,
          email: `cleanup-${uniqueSuffix}@test.local`,
          expiresAt: new Date(now.getTime() + 600000),
        },
        {
          tokenHash: deadTokenHash,
          email: `cleanup-${uniqueSuffix}@test.local`,
          expiresAt: new Date(now.getTime() - 1000),
        },
      ],
    });
    await prisma.handoffAttemptBudget.createMany({
      data: [
        {
          email: staleBudgetEmail,
          attempts: 10,
          windowStartsAt: new Date(now.getTime() - HANDOFF_EMAIL_WINDOW_MS),
        },
        {
          email: freshBudgetEmail,
          attempts: 10,
          windowStartsAt: new Date(now.getTime() - HANDOFF_EMAIL_WINDOW_MS + 1),
        },
      ],
    });
  });

  afterAll(async () => {
    try {
      await prisma.session.deleteMany({ where: { id: { in: [liveSessionId, deadSessionId] } } });
      await prisma.magicLinkToken.deleteMany({ where: { email: { contains: uniqueSuffix } } });
      await prisma.handoffAttemptBudget.deleteMany({ where: { email: { contains: uniqueSuffix } } });
      // By this run's email, not a captured id: an id left unset by a failed
      // beforeAll would be dropped from the where, widening the delete.
      await prisma.teacher.deleteMany({ where: { email: `cleanup-${uniqueSuffix}@test.local` } });
      await prisma.account.deleteMany({ where: { email: `cleanup-${uniqueSuffix}@test.local` } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('deletes expired sessions, tokens and ended handoff budgets, keeps live ones', async () => {
    const scoped = scopeSweep(prisma, {
      Session: { id: { in: [liveSessionId, deadSessionId] } },
      MagicLinkToken: { tokenHash: { in: [liveTokenHash, deadTokenHash] } },
      HandoffAttemptBudget: { email: { in: [staleBudgetEmail, freshBudgetEmail] } },
    });
    const result = await cleanupExpiredAuth(scoped.db, now);
    // One dead, one live session (and token, and budget) built above: exactly
    // one of each is a deletion candidate.
    expect(result.sessions).toBe(1);
    expect(result.magicLinkTokens).toBe(1);
    expect(result.handoffAttemptBudgets).toBe(1);

    expect(await prisma.session.findUnique({ where: { id: liveSessionId } })).not.toBeNull();
    expect(await prisma.session.findUnique({ where: { id: deadSessionId } })).toBeNull();
    expect(
      await prisma.magicLinkToken.findUnique({ where: { tokenHash: liveTokenHash } }),
    ).not.toBeNull();
    expect(
      await prisma.magicLinkToken.findUnique({ where: { tokenHash: deadTokenHash } }),
    ).toBeNull();
    expect(
      await prisma.handoffAttemptBudget.findUnique({ where: { email: freshBudgetEmail } }),
    ).not.toBeNull();
    expect(
      await prisma.handoffAttemptBudget.findUnique({ where: { email: staleBudgetEmail } }),
    ).toBeNull();
  });
});
