import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { cookie, seedSession, uniqueSuffix } from '../../../../tests/helpers';

const { deliverInvitation } = vi.hoisted(() => ({
  deliverInvitation: vi.fn<(db: unknown, input: { priorDispatch: string }) => void>(),
}));
vi.mock('@/services/invitations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/invitations')>()),
  deliverInvitation,
}));

import { POST } from './route';

const suffix = uniqueSuffix();

function add(email: string, token: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/students', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    body: JSON.stringify({ firstName: 'Prior', lastName: 'Add', email }),
  });
}

describe('POST /api/students always makes a first dispatch (#172)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let token: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'PriorDispatch', lastName: 'AddTeacher',
        email: `prior-dispatch-add-${suffix}@test.local`,
        account: { create: { email: `prior-dispatch-add-${suffix}@test.local` } },
        bio: '#172 priorDispatch threading fixture (create)',
        pageSlug: `prior-dispatch-add-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    token = await seedSession(prisma, teacherAccountId);
  });

  afterAll(async () => {
    await prisma.invitation.deleteMany({ where: { teacherId } });
    await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: teacherAccountId } });
  });

  beforeEach(() => { deliverInvitation.mockClear(); });

  function dispatchedInput(): unknown {
    expect(deliverInvitation).toHaveBeenCalledTimes(1);
    const call = deliverInvitation.mock.calls[0];
    if (!call) throw new Error('deliverInvitation was not called');
    return call[1];
  }

  it('passes none for a new contact', async () => {
    const res = await POST(add(`prior-dispatch-new-${suffix}@test.local`, token));
    expect(res.status).toBe(201);
    expect(dispatchedInput()).toMatchObject({ priorDispatch: 'none' });
  });

  it('passes none for a revived invitation, even though its markers name the same address', async () => {
    const email = `prior-dispatch-revive-${suffix}@test.local`;
    await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Prior', lastName: 'Revive',
        status: 'accepted', respondedAt: new Date(),
        lastNotifiedAt: new Date(), lastNotifiedEmail: email,
      },
    });
    const res = await POST(add(email, token));
    expect(res.status).toBe(201);
    expect(dispatchedInput()).toMatchObject({ priorDispatch: 'none' });
  });
});
