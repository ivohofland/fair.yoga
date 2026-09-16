import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { deliverInvitation } from './invitations';
import { __resetDispatchFailureTrackingForTests, recordDispatchFailure } from '@/lib/notify-health';
import { log } from '@/lib/log';
import { teardownTeacher, waitFor } from '../../tests/helpers';

// One test below needs a stranger-branch dispatch to actually fail, which
// means reaching the real send rather than the dry-run branch that logs and
// returns (src/lib/email.ts) — same technique `invitations.notify.test.ts`
// uses: mock the Resend SDK itself. Every other test in this file fails
// before any send is attempted, so this mock is inert for them.
const sendMock = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

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
      // sets it), so the `null` read below is ambiguous on its own: a
      // dispatch that never claimed leaves exactly the value one that
      // claimed and then cleared does. So wait for both of this dispatch's
      // own writes to that column to appear — the claim, carrying a `Date`,
      // and the clear, carrying `null` — each identified by its own `data`
      // value rather than by position, and then await every captured call's
      // settled result, which is what proves they finished rather than
      // merely started.
      await waitFor(
        () => Promise.resolve(
          updateManySpy.mock.calls.some(
            ([args]) => 'teacherInboxNotifiedAt' in args.data && args.data.teacherInboxNotifiedAt instanceof Date,
          )
            && updateManySpy.mock.calls.some(
              ([args]) => 'teacherInboxNotifiedAt' in args.data && args.data.teacherInboxNotifiedAt === null,
            )
            ? true
            : null,
        ),
        { description: 'the failing dispatch has claimed the cap and then cleared it (#622)' },
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

      // This test synchronises on the clear's own call — identified by its
      // `data` value, not by position — and then on every captured call's
      // settled result. The `lastNotifyFailedAt` assertion below is about
      // the state this scenario leaves behind, not about any write this
      // wait is holding for.
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

  it('leaves a marker it never wrote alone when a non-claiming dispatch fails (#622)', async () => {
    // The clear's CAS has a second job besides always re-opening a cap its
    // own dispatch closed: never clearing one it did not set. Only a
    // dispatch that took some other branch can reach the failure path while
    // another attempt's marker stands — a dispatch whose own claim is
    // REFUSED returns before anything can throw, so it never gets there at
    // all. Here that other branch is the stranger one: the address held a
    // teacher profile when the marker was set and holds none now, so the
    // same row that was capped through the teacher inbox now dispatches by
    // email — and Resend is down.
    const email = `deliver-cap-noclaim-${suffix}@test.local`;
    const dispatchedAt = new Date();
    // A round millisecond value, and an hour old, so the assertion below
    // cannot pass by accidentally matching anything this dispatch mints.
    const markerFromAnotherAttempt = new Date(Date.now() - 3_600_000);
    const row = await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Cap', lastName: 'NoClaim',
        // Set by hand: the address deliberately has no teacher profile left,
        // so the branch that writes this column cannot be reached to write
        // it here. `lastNotifiedAt` equals this dispatch's own
        // `dispatchedAt` because that is the state in which a CAS on the
        // wrong column would match and wrongly clear.
        lastNotifiedAt: dispatchedAt, lastNotifiedEmail: email,
        teacherInboxNotifiedAt: markerFromAnotherAttempt,
      },
      select: { id: true },
    });
    const savedApiKey = process.env.RESEND_API_KEY;
    const savedDryRun = process.env.EMAIL_DRY_RUN;

    try {
      vi.spyOn(log, 'error').mockImplementation(() => undefined);
      // Force the real-send path; dry-run logs and returns, and would never
      // reach the failure this test is about.
      process.env.RESEND_API_KEY = 're_test_dummy';
      delete process.env.EMAIL_DRY_RUN;
      sendMock.mockResolvedValueOnce({ error: { message: 'resend is down' } });
      const updateManySpy = vi.spyOn(prisma.invitation, 'updateMany');

      deliverInvitation(prisma, {
        teacherId, email, invitationId: row.id,
        source: 'resend', dispatchedAt,
      });

      // Synchronises on this dispatch's own cap-clear call — identified by
      // its `data` value, not by position — and then on every captured
      // call's settled result, so the row below is read after the clear has
      // finished rather than while it is still in flight.
      await waitFor(
        () => Promise.resolve(
          updateManySpy.mock.calls.some(
            ([args]) => 'teacherInboxNotifiedAt' in args.data && args.data.teacherInboxNotifiedAt === null,
          )
            ? true
            : null,
        ),
        { description: 'the non-claiming dispatch has issued its cap clear (#622)' },
      );
      await Promise.all(updateManySpy.mock.results.map((r) => r.value));

      const after = await prisma.invitation.findUniqueOrThrow({
        where: { id: row.id }, select: { teacherInboxNotifiedAt: true },
      });
      expect(after.teacherInboxNotifiedAt).toEqual(markerFromAnotherAttempt);
    } finally {
      if (savedApiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = savedApiKey;
      if (savedDryRun === undefined) delete process.env.EMAIL_DRY_RUN;
      else process.env.EMAIL_DRY_RUN = savedDryRun;
      sendMock.mockReset();
      await prisma.invitation.deleteMany({ where: { id: row.id } });
    }
  });
});
