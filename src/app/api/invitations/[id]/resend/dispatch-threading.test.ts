import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { cookie, seedSession, uniqueSuffix } from '../../../../../../tests/helpers';
import { POST } from './route';

/**
 * #392 review, Important #2 — sibling of `students/dispatch-threading.test.ts`
 * for this route. See that file's docblock for the full reasoning; the risk
 * and the mechanism are identical here, just for the resend path.
 */
const suffix = uniqueSuffix();

function resend(id: string, token: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/invitations/${id}/resend`, {
    method: 'POST',
    headers: cookie(token),
  });
}

describe('POST /api/invitations/[id]/resend threads a single dispatchedAt into deliverInvitation (#392 review)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let token: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'ThreadResend', lastName: 'Teacher',
        email: `thread-resend-teacher-${suffix}@test.local`,
        account: { create: { email: `thread-resend-teacher-${suffix}@test.local` } },
        bio: '#392 review dispatchedAt-threading fixture (resend)',
        pageSlug: `thread-resend-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    token = await seedSession(prisma, teacherAccountId);
  });

  afterAll(async () => {
    if (teacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId } });
      await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
      await prisma.teacher.delete({ where: { id: teacherId } });
      await prisma.account.delete({ where: { id: teacherAccountId } });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a dispatch failure forced through the real route lands on the row', async () => {
    const invitation = await prisma.invitation.create({
      data: {
        teacherId, email: `thread-resend-target-${suffix}@test.local`,
        firstName: 'ThreadResend', lastName: 'Target',
      },
      select: { id: true },
    });

    const spy = vi
      .spyOn(prisma.teacher, 'findUniqueOrThrow')
      .mockRejectedValueOnce(new Error('forced #392 threading check (resend)'));

    const res = await POST(
      resend(invitation.id, token),
      { params: Promise.resolve({ id: invitation.id }) },
    );
    expect(res.status).toBe(200);

    // Same reasoning as the sibling test: a route that computed a second,
    // separate `new Date()` for `deliverInvitation` instead of reusing the
    // one it wrote synchronously would leave this write permanently unable
    // to match the row, and this assertion would time out.
    await vi.waitFor(async () => {
      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
        select: { lastNotifyFailedAt: true },
      });
      expect(row.lastNotifyFailedAt).not.toBeNull();
    }, { timeout: 3000 });

    spy.mockRestore();
  });
});
