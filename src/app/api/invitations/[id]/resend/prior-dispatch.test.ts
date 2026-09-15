import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { cookie, seedSession, uniqueSuffix } from '../../../../../../tests/helpers';

const { deliverInvitation } = vi.hoisted(() => ({
  deliverInvitation: vi.fn<(db: unknown, input: { priorDispatch: string }) => void>(),
}));
vi.mock('@/services/invitations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/invitations')>()),
  deliverInvitation,
}));

import { POST } from './route';

const suffix = uniqueSuffix();

function resend(id: string, token: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/invitations/${id}/resend`, {
    method: 'POST',
    headers: cookie(token),
  });
}

describe('POST /api/invitations/[id]/resend passes the row as it stood before its marker write (#172)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let token: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'PriorDispatch', lastName: 'Teacher',
        email: `prior-dispatch-resend-${suffix}@test.local`,
        account: { create: { email: `prior-dispatch-resend-${suffix}@test.local` } },
        bio: '#172 priorDispatch threading fixture (resend)',
        pageSlug: `prior-dispatch-resend-${suffix}`,
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

  async function resendRow(label: string, markers: {
    lastNotifiedAt?: Date; lastNotifiedEmail?: string; lastNotifyFailedAt?: Date;
  }): Promise<void> {
    const email = `prior-dispatch-${label}-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Prior', lastName: label, ...markers },
      select: { id: true },
    });
    const res = await POST(resend(invitation.id, token), { params: Promise.resolve({ id: invitation.id }) });
    expect(res.status).toBe(200);
  }

  it('passes same_address for a row last sent to its current address', async () => {
    const email = `prior-dispatch-same-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Prior', lastName: 'Same', lastNotifiedAt: new Date(), lastNotifiedEmail: email },
      select: { id: true },
    });
    const res = await POST(resend(invitation.id, token), { params: Promise.resolve({ id: invitation.id }) });
    expect(res.status).toBe(200);
    expect(dispatchedInput()).toMatchObject({ priorDispatch: 'same_address' });
  });

  it('passes none for a row never sent', async () => {
    await resendRow('never', {});
    expect(dispatchedInput()).toMatchObject({ priorDispatch: 'none' });
  });

  it('passes none for a row readdressed since its last dispatch', async () => {
    await resendRow('readdressed', {
      lastNotifiedAt: new Date(), lastNotifiedEmail: `prior-dispatch-typo-${suffix}@test.local`,
    });
    expect(dispatchedInput()).toMatchObject({ priorDispatch: 'none' });
  });

  it('passes none when the last dispatch recorded a failure', async () => {
    const email = `prior-dispatch-failed-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Prior', lastName: 'Failed',
        lastNotifiedAt: new Date(), lastNotifiedEmail: email, lastNotifyFailedAt: new Date(),
      },
      select: { id: true },
    });
    const res = await POST(resend(invitation.id, token), { params: Promise.resolve({ id: invitation.id }) });
    expect(res.status).toBe(200);
    expect(dispatchedInput()).toMatchObject({ priorDispatch: 'none' });
  });
});
