import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { deliverInvitation } from './invitations';
import { __resetDispatchFailureTrackingForTests, recordDispatchFailure } from '@/lib/notify-health';
import { log } from '@/lib/log';
import { teardownTeacher, waitFor } from '../../tests/helpers';

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

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
  const invitationEmail = `deliver-invitee-${suffix}@test.local`;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Deliver', lastName: 'Teacher',
        email: `deliver-teacher-${suffix}@test.local`,
        account: { create: { email: `deliver-teacher-${suffix}@test.local` } },
        bio: '#392 failure-signal tests',
        pageSlug: `deliver-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;

    const invitation = await prisma.invitation.create({
      data: {
        teacherId, email: invitationEmail,
        firstName: 'Deliver', lastName: 'Target',
      },
      select: { id: true },
    });
    invitationId = invitation.id;
  });

  afterAll(async () => {
    if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
    await teardownTeacher(prisma, teacherId);
  });

  // Vitest isolates module state per test FILE, not per test — without this,
  // an earlier test's dispatch failures count toward a later test's systemic
  // threshold (`recordDispatchFailure`, `@/lib/notify-health`), and several
  // tests below deliberately drive that counter.
  beforeEach(() => {
    __resetDispatchFailureTrackingForTests();
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
      dispatchedAt: new Date(),    });

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
        dispatchedAt: new Date(),      });

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
      dispatchedAt: new Date(),    });

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0]?.[1]).toBe('failed to resend invitation');
  });

  it('records a delivery failure on the invitation row (#392)', async () => {
    // Spied only to keep the expected failure quiet — this test asserts via
    // the row's own state (below), not via the log call.
    vi.spyOn(log, 'error').mockImplementation(() => undefined);

    // The failure write is scoped to a row still holding this exact
    // `dispatchedAt` value (#392 review, Critical #3) — set it explicitly
    // here rather than trusting whatever an earlier test left on this shared
    // fixture row.
    const dispatchedAt = new Date();
    await prisma.invitation.update({
      where: { id: invitationId },
      data: { lastNotifiedAt: dispatchedAt, lastNotifiedEmail: invitationEmail },
    });

    // A bogus teacherId (not this fixture's real one) makes
    // `db.teacher.findUniqueOrThrow` throw before `notifyInvitee` is ever
    // called — the same trick the existing tests above use.
    const result = deliverInvitation(prisma, {
      teacherId: 'no-such-teacher-392d',
      email: 'nobody-392d@test.local',
      invitationId,
      source: 'create',
      dispatchedAt,    });
    expect(result).toBeUndefined();

    // Poll the row itself rather than trusting `log.error` as a proxy for
    // the background write's own completion — a single read timed off the
    // log call raced the write on a slow connection (#392 review, silent-
    // failure-hunter finding).
    await vi.waitFor(async () => {
      const after = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { lastNotifyFailedAt: true },
      });
      expect(after.lastNotifyFailedAt).not.toBeNull();
    });
  });

  it('a failure to record the failure itself does not become an unhandled rejection (#392)', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    // Persistent, not `Once`: this path now issues two best-effort writes
    // (the #622 cap-clear, then `lastNotifyFailedAt`) — failing only the
    // first would exercise just the new one and leave the pre-existing one
    // untested here.
    const writeSpy = vi
      .spyOn(prisma.invitation, 'updateMany')
      .mockRejectedValue(new Error('db down'));

    try {
      deliverInvitation(prisma, {
        teacherId: 'no-such-teacher-392e',
        email: 'nobody-392e@test.local',
        invitationId,
        source: 'create',
        dispatchedAt: new Date(),      });

      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(3));
      // The two best-effort writes below are order-independent by
      // construction (disjoint columns, independent promises, neither
      // touches `lastNotifiedAt`), so their own failure logs are asserted
      // as a set rather than by call index.
      const followUpCalls = error.mock.calls.slice(1);
      expect(followUpCalls.map(([, message]) => message).sort()).toEqual(
        ['failed to re-open teacher inbox dispatch cap', 'failed to record notify failure'].sort(),
      );
      for (const [context] of followUpCalls) {
        expect((context as Record<string, unknown>).invitationId).toBe(invitationId);
      }
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      writeSpy.mockRestore();
    }
  });

  it('suppresses the per-row write once recent failures look systemic (#392 review, Critical #1)', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const rowIds: string[] = [];

    try {
      for (let i = 0; i < 3; i++) {
        const dispatchedAt = new Date();
        const email = `deliver-suppress-${i}-${suffix}@test.local`;
        const row = await prisma.invitation.create({
          data: {
            teacherId, email, firstName: 'Deliver', lastName: 'Suppress',
            lastNotifiedAt: dispatchedAt, lastNotifiedEmail: email,
          },
          select: { id: true },
        });
        rowIds.push(row.id);

        const callsBefore = error.mock.calls.length;
        deliverInvitation(prisma, {
          teacherId: 'no-such-teacher-392-suppress',
          email: 'nobody-392-suppress@test.local',
          invitationId: row.id,
          source: 'create',
          dispatchedAt,        });
        // The outer log call and `recordDispatchFailure()` run in the same
        // synchronous tick (see deliverInvitation) — waiting for this
        // confirms this invocation's place in the failure count is settled
        // before the next iteration starts.
        await vi.waitFor(() => expect(error.mock.calls.length).toBeGreaterThan(callsBefore));

        if (i < 2) {
          // Not suppressed (1st, 2nd failure) — the write itself is async,
          // so wait for it to land before moving on.
          await vi.waitFor(async () => {
            const current = await prisma.invitation.findUniqueOrThrow({
              where: { id: row.id }, select: { lastNotifyFailedAt: true },
            });
            expect(current.lastNotifyFailedAt).not.toBeNull();
          });
        }
      }

      // The 3rd failure looked systemic — suppression returns before any
      // async write is even started, so this row's state is already settled.
      const suppressedRow = await prisma.invitation.findUniqueOrThrow({
        where: { id: rowIds[2]! }, select: { lastNotifyFailedAt: true },
      });
      expect(suppressedRow.lastNotifyFailedAt).toBeNull();
    } finally {
      await prisma.invitation.deleteMany({ where: { id: { in: rowIds } } });
    }
  });

  it('does not overwrite a newer attempt when the failing dispatch is superseded (#392 review, Critical #3)', async () => {
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const updateManySpy = vi.spyOn(prisma.invitation, 'updateMany');

    // Simulates attempt A's failure arriving after attempt B's own
    // synchronous pre-write already moved `lastNotifiedAt` on — the row's
    // CURRENT state belongs to B, not the stale `dispatchedAt` A is about
    // to fail with.
    const staleDispatchedAt = new Date('2020-01-01T00:00:00.000Z');
    const currentDispatchedAt = new Date();
    const email = `deliver-stale-${suffix}@test.local`;
    const row = await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Deliver', lastName: 'Stale',
        lastNotifiedAt: currentDispatchedAt, lastNotifiedEmail: email,
      },
      select: { id: true },
    });

    try {
      deliverInvitation(prisma, {
        teacherId: 'no-such-teacher-392-stale',
        email: 'nobody-392-stale@test.local',
        invitationId: row.id,
        source: 'create',
        dispatchedAt: staleDispatchedAt,      });

      // Wait for the (no-op, CAS-mismatched) write to have actually resolved,
      // not just started, before reading the row.
      await vi.waitFor(() => expect(updateManySpy).toHaveBeenCalled());
      await updateManySpy.mock.results[0]?.value;

      const after = await prisma.invitation.findUniqueOrThrow({
        where: { id: row.id }, select: { lastNotifiedAt: true, lastNotifyFailedAt: true },
      });
      expect(after.lastNotifiedAt).toEqual(currentDispatchedAt);
      expect(after.lastNotifyFailedAt).toBeNull();
    } finally {
      await prisma.invitation.deleteMany({ where: { id: row.id } });
    }
  });

  /** A teacher-only account plus a pending invitation to it from `teacherId`. */
  async function teacherOnlyInvitee(slug: string) {
    const email = `deliver-cap-${slug}-${suffix}@test.local`;
    const invitee = await prisma.teacher.create({
      data: {
        firstName: 'Cap', lastName: 'Invitee', email,
        account: { create: { email } },
        bio: '#622 teacher-inbox dispatch cap',
        pageSlug: `deliver-cap-${slug}-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Cap', lastName: 'Invitee' },
      select: { id: true },
    });
    return { email, inviteeTeacherId: invitee.id, accountId: invitee.accountId, invitationId: invitation.id };
  }

  async function cleanUpInvitee(f: { inviteeTeacherId: string; accountId: string; invitationId: string }) {
    await prisma.notification.deleteMany({
      where: { recipientType: 'teacher', recipientId: f.inviteeTeacherId },
    });
    await prisma.invitation.deleteMany({ where: { id: f.invitationId } });
    await teardownTeacher(prisma, f.inviteeTeacherId, f.accountId);
  }

  it('re-opens the cap when the teacher-branch insert fails (#622)', async () => {
    const f = await teacherOnlyInvitee('fail-ordinary');
    try {
      const dispatchedAt = new Date();
      await prisma.invitation.update({
        where: { id: f.invitationId },
        data: { lastNotifiedAt: dispatchedAt, lastNotifiedEmail: f.email },
      });
      const createSpy = vi.spyOn(prisma.notification, 'create')
        .mockRejectedValueOnce(new Error('insert failed'));
      const updateManySpy = vi.spyOn(prisma.invitation, 'updateMany');

      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt,
      });

      // The row's `teacherInboxNotifiedAt` starts null (the fixture never
      // sets it), so polling for that value directly is trivially satisfied
      // by its untouched initial state, before the claim has even run —
      // proving nothing about whether a claim was made and then cleared.
      // `lastNotifyFailedAt` is the last write this path issues here (this
      // test's lone failure never looks systemic), so waiting for its own
      // call to appear — by its distinct `data` shape, not by position —
      // means the claim and the clear under test have both already been
      // issued too; awaiting every captured call's own settled result is
      // what proves they have actually finished, not merely started.
      await waitFor(
        () => Promise.resolve(
          updateManySpy.mock.calls.some(([args]) => 'lastNotifyFailedAt' in args.data)
            ? true
            : null,
        ),
        { description: 'the failing dispatch has recorded its failure (#622)' },
      );
      await Promise.all(updateManySpy.mock.results.map((r) => r.value));

      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: f.invitationId }, select: { teacherInboxNotifiedAt: true },
      });
      expect(row.teacherInboxNotifiedAt).toBeNull();
      createSpy.mockRestore();
    } finally {
      await cleanUpInvitee(f);
    }
  });

  it('re-opens the cap even when the failure looks systemic (#622)', async () => {
    const f = await teacherOnlyInvitee('fail-outage');
    try {
      const dispatchedAt = new Date();
      await prisma.invitation.update({
        where: { id: f.invitationId },
        data: { lastNotifiedAt: dispatchedAt, lastNotifiedEmail: f.email },
      });
      // Drive the health window past its threshold, so `looksSystemic` is
      // true by the time this dispatch's own failure is handled.
      recordDispatchFailure();
      recordDispatchFailure();
      recordDispatchFailure();

      const createSpy = vi.spyOn(prisma.notification, 'create')
        .mockRejectedValueOnce(new Error('insert failed'));
      const updateManySpy = vi.spyOn(prisma.invitation, 'updateMany');

      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt,
      });

      // The systemic verdict suppresses the `lastNotifyFailedAt` write below
      // (#392), so — unlike the ordinary case above — that call never
      // appears here. The clear itself is the last write this path issues
      // in this scenario, so its own call, identified by its `data` value
      // rather than by position, is the settling signal instead.
      await waitFor(
        () => Promise.resolve(
          updateManySpy.mock.calls.some(
            ([args]) => 'teacherInboxNotifiedAt' in args.data && args.data.teacherInboxNotifiedAt === null,
          )
            ? true
            : null,
        ),
        { description: 'the failing dispatch has cleared the cap under a burst (#622)' },
      );
      await Promise.all(updateManySpy.mock.results.map((r) => r.value));

      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: f.invitationId },
        select: { teacherInboxNotifiedAt: true, lastNotifyFailedAt: true },
      });
      expect(row.teacherInboxNotifiedAt).toBeNull();
      // The teacher-visible half stays suppressed — that is #392's rule and
      // this change does not touch it.
      expect(row.lastNotifyFailedAt).toBeNull();
      createSpy.mockRestore();
    } finally {
      await cleanUpInvitee(f);
    }
  });

  it('does not re-open a cap a newer dispatch closed (#622)', async () => {
    const f = await teacherOnlyInvitee('fail-superseded');
    try {
      const staleDispatchedAt = new Date(Date.now() - 60_000);
      const currentDispatchedAt = new Date();
      // A later resend's own synchronous pre-write has already moved
      // `lastNotifiedAt` on by the time this stale attempt's own insert
      // fails — the row no longer holds the value this dispatch remembers.
      // `teacherInboxNotifiedAt` is left null here: the claim below must
      // itself succeed for `createNotification` — and therefore the mocked
      // rejection — to be reached at all; a claim starting from an
      // already-non-null marker returns before ever calling it, which would
      // make this test pass independently of anything the CAS clause does.
      await prisma.invitation.update({
        where: { id: f.invitationId },
        data: { lastNotifiedAt: currentDispatchedAt, lastNotifiedEmail: f.email },
      });
      const createSpy = vi.spyOn(prisma.notification, 'create')
        .mockRejectedValueOnce(new Error('insert failed'));
      const updateManySpy = vi.spyOn(prisma.invitation, 'updateMany');

      // A stale attempt: its own claim still succeeds (the cap was open when
      // it ran), but its insert then fails.
      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'create', dispatchedAt: staleDispatchedAt,
      });

      // The `lastNotifyFailedAt` write is unconditional here (this test's
      // lone failure never looks systemic) and is issued after every other
      // write this path can make from the same `.catch` tick — including
      // the claim above and the CAS-guarded clear under test — so its own
      // call appearing is a structural signal, not a count, that the whole
      // chain has been issued. `in` picks it out by its own `data` shape
      // rather than by position, so this holds whether or not the clear
      // above still runs, still comes first, or still carries its own CAS
      // clause. Awaiting every call's own settled result — not just its
      // appearance — is what proves each write actually finished before the
      // row is read below.
      await waitFor(
        () => Promise.resolve(
          updateManySpy.mock.calls.some(([args]) => 'lastNotifyFailedAt' in args.data)
            ? true
            : null,
        ),
        { description: 'the stale dispatch has recorded its failure (#622)' },
      );
      await Promise.all(updateManySpy.mock.results.map((r) => r.value));

      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: f.invitationId }, select: { teacherInboxNotifiedAt: true },
      });
      expect(row.teacherInboxNotifiedAt).not.toBeNull();
      createSpy.mockRestore();
    } finally {
      await cleanUpInvitee(f);
    }
  });
});
