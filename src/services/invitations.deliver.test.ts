import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';
import type { MockInstance } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
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

// The teacher branch claims the cap and inserts the notification inside one
// `db.$transaction` (#622), so the insert runs against the transaction client
// — a different object from `prisma.notification`, which `vi.spyOn` cannot
// reach. The seam that does reach it is the function itself. A plain function
// rather than a `vi.fn`, so `vi.restoreAllMocks()` in `afterEach` cannot take
// the real implementation away from the tests that need it; the arming is
// one-shot, so no test can leak a failure into the next.
const teacherInboxInsert = vi.hoisted(() => ({ failNext: false }));
vi.mock('./notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notifications')>();
  return {
    ...actual,
    createNotification: (...args: Parameters<typeof actual.createNotification>) => {
      if (teacherInboxInsert.failNext) {
        teacherInboxInsert.failNext = false;
        return Promise.reject(new Error('insert failed'));
      }
      return actual.createNotification(...args);
    },
  };
});

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
    teacherInboxInsert.failNext = false;
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
      // Asserted as a set, because the order of the two logs is not a
      // property this test owns.
      const followUpCalls = error.mock.calls.slice(1);
      expect(followUpCalls.map(([, message]) => message).sort()).toEqual(
        [
          'could not re-open the teacher inbox dispatch cap: if this dispatch did claim it, only a readdress or a revive will lift the marker now',
          'failed to record notify failure',
        ].sort(),
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

      // Wait for the (no-op, CAS-mismatched) `lastNotifyFailedAt` write to
      // have actually resolved, not just started, before reading the row.
      // Identified by its own `data` payload rather than by call index: the
      // `.catch` issues the #622 cap clear on the same path, so an index
      // names whichever write happened to be first rather than the one this
      // assertion depends on.
      await waitFor(
        () => Promise.resolve(
          updateManySpy.mock.calls.some(([args]) => 'lastNotifyFailedAt' in args.data)
            ? true
            : null,
        ),
        { description: 'the superseded dispatch has issued its failure write (#392)' },
      );
      await Promise.all(updateManySpy.mock.results.map((r) => r.value));

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

  const countTeacherNotifications = (recipientId: string) =>
    prisma.notification.count({
      where: { recipientType: 'teacher', recipientId, type: 'teacher_invitation' },
    });

  /**
   * Waits for a failing dispatch to have issued its cap clear AND for every
   * `prisma.invitation.updateMany` it started to have settled — the clear is
   * identified by its own `data` value rather than by position, since the
   * `.catch` issues two writes and their order is not a property any test
   * here owns.
   *
   * The claim itself is deliberately not waited for: it runs on the
   * transaction client (`notifyInvitee`'s teacher branch), which this spy
   * cannot see, and it is rolled back with the insert in any case.
   */
  async function settleCapClear(
    spy: MockInstance<typeof prisma.invitation.updateMany>,
    description: string,
  ): Promise<void> {
    await waitFor(
      () => Promise.resolve(
        spy.mock.calls.some(
          ([args]) => 'teacherInboxNotifiedAt' in args.data && args.data.teacherInboxNotifiedAt === null,
        )
          ? true
          : null,
      ),
      { description },
    );
    await Promise.all(spy.mock.results.map((r) => r.value));
  }

  it('a failed teacher-branch insert leaves the invitation notifiable, not merely its column clear (#622)', async () => {
    const f = await teacherOnlyInvitee('fail-ordinary');
    try {
      vi.spyOn(log, 'error').mockImplementation(() => undefined);
      const dispatchedAt = new Date();
      await prisma.invitation.update({
        where: { id: f.invitationId },
        data: { lastNotifiedAt: dispatchedAt, lastNotifiedEmail: f.email },
      });
      teacherInboxInsert.failNext = true;
      const updateManySpy = vi.spyOn(prisma.invitation, 'updateMany');

      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt,
      });

      await settleCapClear(
        updateManySpy,
        'the failing dispatch has issued its cap clear (#622)',
      );

      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(0);
      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: f.invitationId }, select: { teacherInboxNotifiedAt: true },
      });
      expect(row.teacherInboxNotifiedAt).toBeNull();

      // Acceptance criterion 6a's second half, and the only assertion in this
      // test that a clear column actually buys anything: dispatch again and
      // watch a notification land. The column read above is satisfied just as
      // well by a row nothing ever claimed.
      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt: new Date(),
      });
      await waitFor(
        () => countTeacherNotifications(f.inviteeTeacherId).then((c) => (c > 0 ? c : null)),
        { description: 'the retry after a failed dispatch actually notifies (#622)' },
      );
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);
    } finally {
      await cleanUpInvitee(f);
    }
  });

  it('cannot strand the marker even when the clear itself fails too (#622)', async () => {
    // The pair that used to be able to strand an invitee forever: the
    // notification insert fails, and the compensating clear — issued against
    // the same client microseconds later — is refused for the same reason.
    // The claim and the insert now share a transaction, so there is no
    // separately committed marker for that clear to be the last defence for.
    //
    // The refusal below is selective, and that is the whole test. A blanket
    // rejection of `prisma.invitation.updateMany` would also refuse a claim
    // issued on the plain client — which is precisely what has to be allowed
    // to happen if the transaction is ever taken away again. The row would
    // then read clear for the wrong reason, and this test would certify the
    // bug rather than catch it.
    const f = await teacherOnlyInvitee('fail-clear-too');
    try {
      const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      teacherInboxInsert.failNext = true;
      const realUpdateMany = prisma.invitation.updateMany.bind(prisma.invitation);
      const writeSpy = vi
        .spyOn(prisma.invitation, 'updateMany')
        .mockImplementation((args: Prisma.InvitationUpdateManyArgs) => {
          // A `Date` in `teacherInboxNotifiedAt` identifies a claim; every
          // other write this path issues — the cap clear and the
          // `lastNotifyFailedAt` write — is refused. Cast rather than
          // constructed: nothing on this path reads a `PrismaPromise`'s brand,
          // it only attaches a `.catch`.
          const data = args.data as Record<string, unknown>;
          if (data.teacherInboxNotifiedAt instanceof Date) return realUpdateMany(args);
          return Promise.reject<Prisma.BatchPayload>(
            new Error('db down'),
          ) as Prisma.PrismaPromise<Prisma.BatchPayload>;
        });

      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt: new Date(),
      });

      // Three logs: the dispatch failure, then one per refused write.
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(3));
      writeSpy.mockRestore();

      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: f.invitationId }, select: { teacherInboxNotifiedAt: true },
      });
      expect(row.teacherInboxNotifiedAt).toBeNull();
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(0);
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

      vi.spyOn(log, 'error').mockImplementation(() => undefined);
      teacherInboxInsert.failNext = true;
      const updateManySpy = vi.spyOn(prisma.invitation, 'updateMany');

      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt,
      });

      // The `lastNotifyFailedAt` assertion below is about the state this
      // scenario leaves behind, not about any write this wait is holding for
      // — under a burst that write is never started at all.
      await settleCapClear(
        updateManySpy,
        'the failing dispatch has cleared the cap under a burst (#622)',
      );

      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: f.invitationId },
        select: { teacherInboxNotifiedAt: true, lastNotifyFailedAt: true },
      });
      expect(row.teacherInboxNotifiedAt).toBeNull();
      // The teacher-visible half stays suppressed — that is #392's rule and
      // this change does not touch it.
      expect(row.lastNotifyFailedAt).toBeNull();

      // Notifiability, not column state: the burst suppresses what the
      // teacher can see, never what the invitee can still be told.
      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt: new Date(),
      });
      await waitFor(
        () => countTeacherNotifications(f.inviteeTeacherId).then((c) => (c > 0 ? c : null)),
        { description: 'the retry after a suppressed failure still notifies (#622)' },
      );
    } finally {
      await cleanUpInvitee(f);
    }
  });

  it('leaves the invitation notifiable when a superseded dispatch fails (#622)', async () => {
    const f = await teacherOnlyInvitee('fail-moved-on');
    try {
      // A resend landing while this dispatch is still failing: its own
      // synchronous pre-write has already moved `lastNotifiedAt` past the
      // value this dispatch carries. Nothing on this path consults that
      // column for the cap — not the claim's rollback, not the clear's CAS —
      // so the invitee stays notifiable whichever attempt the row's
      // `lastNotifiedAt` currently belongs to.
      vi.spyOn(log, 'error').mockImplementation(() => undefined);
      const dispatchedAt = new Date(Date.now() - 60_000);
      await prisma.invitation.update({
        where: { id: f.invitationId },
        data: { lastNotifiedAt: new Date(), lastNotifiedEmail: f.email },
      });
      teacherInboxInsert.failNext = true;
      const updateManySpy = vi.spyOn(prisma.invitation, 'updateMany');

      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt,
      });

      await settleCapClear(
        updateManySpy,
        'the superseded dispatch has issued its cap clear (#622)',
      );

      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: f.invitationId }, select: { teacherInboxNotifiedAt: true },
      });
      expect(row.teacherInboxNotifiedAt).toBeNull();

      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt: new Date(),
      });
      await waitFor(
        () => countTeacherNotifications(f.inviteeTeacherId).then((c) => (c > 0 ? c : null)),
        { description: 'the retry after a superseded failure still notifies (#622)' },
      );
    } finally {
      await cleanUpInvitee(f);
    }
  });

  it('leaves a marker it never wrote alone when a non-claiming dispatch fails (#622)', async () => {
    // The half of the clear's CAS that is load-bearing: never clearing a
    // marker this dispatch did not set. Only a dispatch that took some other
    // branch can reach the failure path while another attempt's marker
    // stands — a dispatch whose own claim is REFUSED returns before anything
    // can throw, so it never gets there at all. The scenario modelled here is
    // the stranger branch: the address
    // held a teacher profile when an earlier dispatch capped this row and
    // holds none by the time of this one, which therefore dispatches by
    // email — and Resend is down.
    const email = `deliver-cap-noclaim-${suffix}@test.local`;
    const dispatchedAt = new Date();
    // An hour old, so the assertion below cannot pass by coincidentally
    // matching a value this dispatch mints for itself.
    const markerFromAnotherAttempt = new Date(Date.now() - 3_600_000);
    const row = await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Cap', lastName: 'NoClaim',
        // Set by hand: this address has no teacher profile, so the branch
        // that writes this column cannot be reached to write it here.
        // `lastNotifiedAt` equals this dispatch's own `dispatchedAt` because
        // that is the state in which a CAS on the wrong column would match
        // and wrongly clear.
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

      await settleCapClear(
        updateManySpy,
        'the non-claiming dispatch has issued its cap clear (#622)',
      );

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
