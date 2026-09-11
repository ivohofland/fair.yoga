import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { cookie, seedSession, uniqueSuffix } from '../../../../tests/helpers';
import { POST } from './route';

/**
 * #392 review, Important #2: nothing previously tested that this route
 * threads a single `dispatchedAt` value into both its synchronous
 * `lastNotifiedAt` pre-write and its `deliverInvitation` call. A future
 * edit that computed a second, separate `new Date()` for either one would
 * silently disable `deliverInvitation`'s CAS-scoped failure write forever
 * (see that function's own docblock, `services/invitations.ts`) — every
 * other test either checks the CLEARING direction (`lastNotifyFailedAt`
 * reset to `null`) or calls `deliverInvitation` directly rather than
 * through this route, so a mismatch here would leave the whole suite
 * green while the feature quietly stopped working.
 *
 * `POST` is invoked directly, the pattern `put-readdress-delivered.test.ts`
 * (this route's sibling family) established — `NextRequest` is a plain
 * Web-standard class Next.js exports, so the real handler runs against the
 * real test database with no server anywhere. `prisma` imported above is
 * the `@/lib/db` singleton — the exact object both `route.ts` and
 * `deliverInvitation` call through — so spying on `teacher.findUniqueOrThrow`
 * forces a real dispatch failure reached through the route's own wiring,
 * not a direct service call.
 */
const suffix = uniqueSuffix();

function createRequest(body: unknown, token: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/students', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/students threads a single dispatchedAt into deliverInvitation (#392 review)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let token: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Thread', lastName: 'Teacher',
        email: `thread-teacher-${suffix}@test.local`,
        account: { create: { email: `thread-teacher-${suffix}@test.local` } },
        bio: '#392 review dispatchedAt-threading fixture',
        pageSlug: `thread-teacher-${suffix}`,
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
    // Forces deliverInvitation's very first operation to throw for exactly
    // the next call — the same failure mode the "bogus teacherId" trick
    // simulates in invitations.deliver.test.ts, but reached here through
    // the route's real wiring rather than a direct service call.
    const spy = vi
      .spyOn(prisma.teacher, 'findUniqueOrThrow')
      .mockRejectedValueOnce(new Error('forced #392 threading check'));

    const res = await POST(createRequest({
      firstName: 'Thread', lastName: 'Target',
      email: `thread-target-${suffix}@test.local`,
    }, token));
    expect(res.status).toBe(201);
    const { data: { id: invitationId } } = (await res.json()) as { data: { id: string } };

    // If the route computed a second, separate `new Date()` for
    // `deliverInvitation` instead of reusing the one it wrote
    // synchronously above, the CAS scope
    // (`where: { id, lastNotifiedAt: dispatchedAt }`) would never match
    // this row and the write would silently never land — this assertion
    // times out rather than merely failing, which is itself diagnostic of
    // exactly that regression.
    await vi.waitFor(async () => {
      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { lastNotifyFailedAt: true },
      });
      expect(row.lastNotifyFailedAt).not.toBeNull();
    }, { timeout: 3000 });

    spy.mockRestore();
  });
});
