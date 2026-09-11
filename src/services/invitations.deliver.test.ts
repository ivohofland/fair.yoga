import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { deliverInvitation } from './invitations';
import { log } from '@/lib/log';

const prisma = new PrismaClient();

/**
 * `deliverInvitation` is the one function in this file a caller must not be
 * able to wait for: awaited, it turns a Resend outage into a 500 for an
 * unregistered address while a registered one still answers normally, and
 * even healthy it is a timing channel (#166). The compiler holds the shape
 * (`FireAndForget`, plus the pin beside the function); these hold the
 * behaviour that shape depends on — that the rejection path is owned inside,
 * because there is no longer a caller `.catch` to own it.
 */
describe('deliverInvitation — fire-and-forget by construction (#391)', () => {
  let teacherId: string;
  let invitationId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Deliver', lastName: 'Teacher',
        email: `deliver-392-teacher-${Date.now()}@test.local`,
        account: { create: { email: `deliver-392-teacher-${Date.now()}@test.local` } },
        bio: '#392 failure-signal tests',
        pageSlug: `deliver-392-teacher-${Date.now()}`,
      },
    });
    teacherId = teacher.id;

    const invitation = await prisma.invitation.create({
      data: {
        teacherId, email: `deliver-392-invitee-${Date.now()}@test.local`,
        firstName: 'Deliver', lastName: 'Target',
      },
      select: { id: true },
    });
    invitationId = invitation.id;
  });

  afterAll(async () => {
    if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
    if (teacherId) {
      const accountId = (await prisma.teacher.findUnique({
        where: { id: teacherId }, select: { accountId: true },
      }))?.accountId;
      await prisma.teacher.delete({ where: { id: teacherId } });
      if (accountId) await prisma.account.deleteMany({ where: { id: accountId } });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns nothing a caller could await on', async () => {
    // Spied because this call is going to fail (no such teacher) and log. The
    // assertion here is only about the return value, but an unspied failure
    // would print after the test ended, once `restoreAllMocks` had put the
    // real logger back.
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const result = deliverInvitation(prisma, {
      teacherId: 'no-such-teacher-391a',
      email: 'nobody-391a@test.local',
      invitationId: 'inv-391a',
      source: 'create',
    });

    expect(result).toBeUndefined();

    // Let the internal rejection settle inside the test, not after it.
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  });

  it('logs a failure and swallows it, instead of rejecting into the caller', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      deliverInvitation(prisma, {
        teacherId: 'no-such-teacher-391b',
        email: 'nobody-391b@test.local',
        invitationId: 'inv-391b',
        source: 'create',
      });

      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));

      expect(error.mock.calls[0]?.[1]).toBe('failed to notify invitee');
      const context = error.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(context.teacherId).toBe('no-such-teacher-391b');
      expect(context.invitationId).toBe('inv-391b');
      // The address is the one field on this pair worth keeping out of the
      // logs (#166 review, F4) — the id pair is what finds the row.
      expect(JSON.stringify(context)).not.toContain('nobody-391b@test.local');

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('names the resend path in its own log line', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    deliverInvitation(prisma, {
      teacherId: 'no-such-teacher-391c',
      email: 'nobody-391c@test.local',
      invitationId: 'inv-391c',
      source: 'resend',
    });

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0]?.[1]).toBe('failed to resend invitation');
  });

  it('records a delivery failure on the invitation row (#392)', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    // A bogus teacherId (not this fixture's real one) makes
    // `db.teacher.findUniqueOrThrow` throw before `notifyInvitee` is ever
    // called — the same trick the existing tests above use. The write
    // this test proves is scoped only by `invitationId`, so it lands
    // regardless of which teacherId the throw came from.
    const result = deliverInvitation(prisma, {
      teacherId: 'no-such-teacher-392d',
      email: 'nobody-392d@test.local',
      invitationId,
      source: 'create',
    });
    expect(result).toBeUndefined();

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));

    const after = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { lastNotifyFailedAt: true },
    });
    expect(after.lastNotifyFailedAt).not.toBeNull();
  });
});
