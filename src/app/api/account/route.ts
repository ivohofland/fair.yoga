import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import {
  respondOk,
  respondError,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { clearSessionCookie } from '@/lib/auth';
import { isTransientDbError } from '@/lib/api-errors';
import {
  AlreadyErasedError,
  deleteStudentAccount,
  deleteTeacherAccount,
  type ErasureHalf,
} from '@/services/gdpr';

/**
 * Turns an erasure failure into the answer that is actually true of it.
 *
 * The retry advice is the whole point, and it has to be conditional.
 * `isTransientDbError` is what separates "safe to retry" from "worth
 * retrying": a lock timeout, a deadlock, an expired transaction budget are
 * all lost races the next attempt can win, and this branch was added for
 * exactly one of them (`P2028` from `deleteStudentAccount`'s sized
 * `timeout`). Everything else that can escape those services will fail the
 * same way forever — `P2025` from the opening `findUniqueOrThrow` if the
 * profile is already gone, `P2003` from a foreign key, a `TypeError` from a
 * bug — and telling that caller to "press Delete again" sends them into a
 * loop that cannot terminate, while making the real failure invisible to
 * them. `P2024` is the sharpest case: it means the connection pool is
 * exhausted, so an immediate retry actively makes the outage worse, which is
 * why the retryable message asks for a moment first.
 *
 * `half` decides what the message may claim about state, and the two halves
 * are NOT symmetric — an earlier version of this docblock said "both erasures
 * are single transactions, so a throw out of either means nothing was
 * applied", which is false for the teacher half:
 *
 * - `deleteStudentAccount` IS one transaction. Its only work outside it is
 *   the post-commit `handleSpotFreed` loop, which logs and swallows its own
 *   errors, so nothing that escapes the function ran after the commit. "The
 *   rest of your data is unchanged" is exact here.
 * - `deleteTeacherAccount` is NOT. Before its `db.$transaction` opens it runs
 *   `completeClass(db, cls.id, { finishedEarly: true })` for every in-progress class, and each of
 *   those is its own committed transaction that prices the class, writes
 *   `Payment` rows and sends notifications. A failure anywhere after that
 *   loop leaves those completions standing. Telling that teacher "nothing was
 *   changed" would be a lie about money.
 *
 * `partial` is narrower and orthogonal: the student half committed and the
 * teacher half did not, on a dual account. That has to be said out loud
 * whichever kind of failure caused it — a caller who is not told will
 * reasonably assume nothing happened.
 *
 * Note what the previous behaviour was, so this is not read as a regression:
 * the teacher-only path used to `throw` into a generic 500 that claimed
 * NOTHING about state. Saying too much is the failure this wave introduced
 * and this split removes; saying nothing was the failure before it.
 */
function erasureFailure(err: unknown, opts: { half: ErasureHalf; partial: boolean }) {
  const transient = isTransientDbError(err);
  // The teacher erasure's committed-before-the-transaction exposure. Every
  // failure of that half carries it, `partial` included.
  const billed = 'Any class that was still in progress may already have been closed and billed.';
  if (opts.partial) {
    return transient
      ? respondError(
          `Your student data was removed. ${billed} The system was busy and could not remove the rest of your teaching data. Wait a moment, then press Delete again to finish.`,
          503,
          'PARTIAL_ERASURE_BUSY',
        )
      : respondError(
          `Your student data was removed. ${billed} Removing the rest of your teaching data failed. Pressing Delete again will not fix it — please contact support.`,
          500,
          'PARTIAL_ERASURE',
        );
  }
  // What the message may say about what survived. See the docblock: only the
  // student erasure is a single transaction.
  const stateNote =
    opts.half === 'student'
      ? 'Nothing was changed.'
      : `${billed} The rest of your data is unchanged.`;
  return transient
    ? respondError(
        `The system was busy and could not remove your account. ${stateNote} Wait a moment, then press Delete again.`,
        503,
        'ERASURE_BUSY',
      )
    : respondError(
        `Removing your account failed. ${stateNote} Pressing Delete again will not fix it — please contact support.`,
        500,
        'ERASURE_FAILED',
      );
}

/**
 * GDPR account erasure (Art. 17). Personal data is anonymized; financial
 * records the other party is entitled to keep stay behind, attributed to a
 * deleted account. Signs the caller out.
 */
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  // "Delete my account" erases every profile the account holds. The two
  // erasures are separate transactions: if the second fails after the first
  // committed, say exactly that — a bare 500 would hide that half the erasure
  // is already irreversible. What kind of failure it was decides what the
  // caller is told to do about it; see `erasureFailure` above.
  //
  // `level` follows the same split as the message: a lost lock race is not an
  // outage and must not page anyone, which is the same reading
  // `classifyApiError`'s transient branch takes. Anything else here is a real
  // defect — an erasure that cannot complete is a legally time-bound
  // operation failing — and stays at `error`.
  if (session.studentId) {
    try {
      await deleteStudentAccount(prisma, session.studentId);
    } catch (err) {
      // The erasure this request wanted has already happened — a concurrent
      // duplicate, whose transaction aborted whole rather than committing a
      // second time and re-running its post-commit `handleSpotFreed` loop.
      // The caller's question is "is this account gone?" and the honest
      // answer is yes, so this must NOT reach `erasureFailure`, which would
      // report a 500 for an outcome that succeeded. Caught per half so a
      // dual-role account whose student half is already erased still goes on
      // to erase its teacher half below.
      //
      // Only reachable concurrently: a sequential retry never gets here,
      // because `validateSession` (`lib/auth/session.ts`) resolves only LIVE
      // profiles, so `session.studentId` is already null by then.
      //
      // `err` in the payload, not just `half`: this line is the ONLY record
      // that the sentinel fired, and without the error object it carries no
      // stack — so an `AlreadyErasedError` thrown from somewhere nobody
      // expects looks identical here to the one this branch was written for.
      if (err instanceof AlreadyErasedError) {
        log.info(
          { err, accountId: session.accountId, half: err.half },
          'account erasure: half already erased',
        );
      } else {
        const transient = isTransientDbError(err);
        log[transient ? 'warn' : 'error'](
          { err, accountId: session.accountId, transient },
          'account erasure: student half failed',
        );
        return erasureFailure(err, { half: 'student', partial: false });
      }
    }
  }
  if (session.teacherId) {
    try {
      await deleteTeacherAccount(prisma, session.teacherId);
    } catch (err) {
      // Already erased by a concurrent duplicate — see the student half
      // above for why that is a success. Emphatically NOT `partial`: this
      // half's transaction rolled back whole, so nothing is half-applied,
      // and routing it through `erasureFailure` would tell a caller their
      // teaching data survived when the winning request had removed it.
      if (err instanceof AlreadyErasedError) {
        // `err` for the same reason as the student half above: a sentinel
        // logged without its stack cannot be told from a lookalike.
        log.info(
          { err, accountId: session.accountId, half: err.half },
          'account erasure: half already erased',
        );
      } else {
        // `partial` is `Boolean(session.studentId)`, which reads as "the
        // student half ran and committed" and no longer always means that:
        // since #196 the student half can throw `AlreadyErasedError`, roll
        // back whole, and still leave `session.studentId` truthy. The account
        // state the message describes is still true — the winning request
        // erased that half — but it is true about the other request, not this
        // one. Left as is because the caller-facing sentence stays accurate;
        // noted because the variable's name no longer explains itself.
        // Without a student profile this is a teacher-only erasure — which is
        // NOT the same as "nothing is half-applied": `deleteTeacherAccount`
        // commits a `completeClass` per in-progress class before its own
        // transaction opens, so a failure here can leave real billing behind.
        // `erasureFailure`'s `half` is what keeps the message honest about
        // that. This path used to bare-`throw` into `withErrorHandler`'s
        // generic 500 with no code at all, and it is the path #174 made MORE
        // likely to fail: `deleteTeacherAccount` now calls a `completeClass`
        // that opens with `lockClassRow`'s 2s bound.
        const partial = Boolean(session.studentId);
        const transient = isTransientDbError(err);
        log[transient ? 'warn' : 'error'](
          { err, accountId: session.accountId, partial, transient },
          partial
            ? 'partial account erasure: student half committed, teacher half failed'
            : 'account erasure: teacher half failed',
        );
        return erasureFailure(err, { half: 'teacher', partial });
      }
    }
  }

  const response = respondOk({ deleted: true });
  clearSessionCookie(response.headers);
  return response;
});
