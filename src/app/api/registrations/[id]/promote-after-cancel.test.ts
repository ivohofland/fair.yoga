import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { SpotFreedError } from '@/services/waitlist';

/**
 * What `promoteAfterCancel` LOGS when the spot-freed hook fails, and that a
 * failure there still answers 200.
 *
 * `deleteStudentAccount`'s identical catch has had a test since the same
 * change added the `branch` field to both (`gdpr.test.ts`, "names the broadcast
 * branch when the spot-freed hook fails after erasure"); this side had none.
 * The `spotFreedLoss` `Record` keeps the WORDING from drifting between the two
 * — a compile error at one place if a window member is added — but it says
 * nothing about whether this caller reads `err.window` at all, or which level
 * it logs at, or whether it swallows. A `branch: 'unknown'` here and the
 * roster would still be perfectly consistent.
 *
 * WHY THIS IS MOCKED, following `api/class-templates/[id]/unknown-slot-holder.test.ts`
 * and `api/cron/daily-cleanup/route.test.ts`: the integration tier drives the
 * app over HTTP in a separate `next dev` process, so it can neither inject a
 * fault into that process's `handleSpotFreed` nor observe its `log` calls. The
 * plan for this branch recorded "the route's line gets no test of its own,
 * deliberately" on the strength of that cost. It is not that expensive at this
 * level: the hook is one mocked import, and the handler underneath it is real —
 * `withErrorHandler`, the ownership checks and the cancel write all run.
 *
 * The route's own database work is stubbed rather than seeded because none of
 * it is under test here. What is under test is the four fields of one log
 * payload and the status code beside it.
 */

const handleSpotFreed = vi.fn();
const findUnique = vi.fn();
const updateMany = vi.fn();
const waitlistCount = vi.fn();

vi.mock('@/services/waitlist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/waitlist')>();
  // Everything but the hook stays real — `SpotFreedError`, `spotFreedLoss` and
  // its `Record` especially, since the message this file asserts on has to be
  // the one production builds, not a copy of it.
  return { ...actual, handleSpotFreed: (...args: unknown[]) => handleSpotFreed(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return {
    ...actual,
    requireSession: async () => ({
      sessionId: 'sess-1',
      accountId: 'acct-1',
      teacherId: 'teacher-1',
      defaultTimezone: 'Europe/Amsterdam',
      studentId: null,
    }),
  };
});
// The three calls the DELETE path makes. A teacher session skips the
// cancel-deadline branch, so this is the whole surface.
vi.mock('@/lib/db', () => ({
  prisma: {
    registration: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
    waitlistEntry: { count: (...args: unknown[]) => waitlistCount(...args) },
  },
}));

const { DELETE } = await import('./route');

const CLASS_ID = 'class-1';

/** A `55P03`-class failure: what `isTransientDbError` calls a lost race. */
function transientCause(): Error {
  return new Prisma.PrismaClientKnownRequestError('pool timeout', {
    code: 'P2024',
    clientVersion: Prisma.prismaVersion.client,
  });
}

function registrationRow() {
  return {
    id: 'reg-1',
    classId: CLASS_ID,
    studentId: 'student-1',
    status: 'registered',
    class: {
      id: CLASS_ID,
      status: 'open',
      maxStudents: 10,
      cancelDeadline: 'HOURS_24',
      calendarEntry: {
        teacherId: 'teacher-1',
        date: new Date('2099-06-01T00:00:00Z'),
        startTime: new Date('1970-01-01T10:00:00Z'),
        cancelledAt: null,
        teacher: { defaultTimezone: 'Europe/Amsterdam' },
      },
    },
  };
}

function del(): NextRequest {
  return new NextRequest('http://localhost:3000/api/registrations/reg-1', { method: 'DELETE' });
}

function cancel(): Promise<Response> {
  return DELETE(del(), { params: Promise.resolve({ id: 'reg-1' }) });
}

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(registrationRow());
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  waitlistCount.mockReset().mockResolvedValue(3);
  handleSpotFreed.mockReset();
});

describe('DELETE /api/registrations/[id] — the loss its spot-freed hook records', () => {
  it('names the broadcast branch and keeps the cancel a 200', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    handleSpotFreed.mockRejectedValue(
      new SpotFreedError(CLASS_ID, 'first_come_first_claimed', transientCause()),
    );

    const res = await cancel();

    // The cancel committed before the hook ran; a dropped notification must not
    // rewrite that into a failure the caller can act on.
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      classId: CLASS_ID,
      waiting: 3,
      transient: true,
      branch: 'first_come_first_claimed',
    });
    expect(warn.mock.calls[0]?.[1]).toContain('the waiting students were not told the seat is free');
  });

  /**
   * The other branch and the other level in one case, because they move
   * together here: `getWaitlistWindow` returns `auto_promote` for everything up
   * to (cancel deadline − 1h), and a failure that will not clear by retrying is
   * the one this route logs at `error`.
   */
  it('names the auto-promote branch, at error level, for a failure that will not clear', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());

    handleSpotFreed.mockRejectedValue(
      new SpotFreedError(CLASS_ID, 'auto_promote', new Error('promotion write failed')),
    );

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      classId: CLASS_ID,
      transient: false,
      branch: 'auto_promote',
    });
    expect(error.mock.calls[0]?.[1]).toContain('the queue head was not promoted into the freed seat');
  });

  /**
   * The backstop, mirroring `deleteStudentAccount`'s: the diagnostic read
   * guards itself with `.catch()`, but the `log` call after it did not. An
   * uncaught throw there reaches `withErrorHandler` and answers 500 for a
   * cancellation that already committed — the exact outcome this catch exists
   * to prevent, reintroduced by the code handling it.
   */
  it('still answers 200 when the diagnostic logging itself throws', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {
      throw new Error('log transport exploded');
    });
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => {
      warn.mockRestore();
      error.mockRestore();
    });

    handleSpotFreed.mockRejectedValue(
      new SpotFreedError(CLASS_ID, 'first_come_first_claimed', transientCause()),
    );

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(error.mock.calls.at(-1)?.[0]).toMatchObject({ classId: CLASS_ID });
    expect(error.mock.calls.at(-1)?.[1]).toBe(
      'waitlist spot-freed hook diagnostic failed unexpectedly',
    );
  });
});
