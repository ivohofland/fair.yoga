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
import { deleteStudentAccount, deleteTeacherAccount } from '@/services/gdpr';

/**
 * Turns an erasure failure into the answer that is actually true of it.
 *
 * The retry advice is the whole point, and it has to be conditional. Both
 * erasures are single transactions, so a throw out of either means nothing
 * was applied and an identical retry is a byte-identical first attempt — but
 * "safe to retry" is not "worth retrying". `isTransientDbError` is what
 * separates the two: a lock timeout, a deadlock, an expired transaction
 * budget are all lost races the next attempt can win, and this branch was
 * added for exactly one of them (`P2028` from `deleteStudentAccount`'s sized
 * `timeout`). Everything else that can escape those services will fail the
 * same way forever — `P2025` from the opening `findUniqueOrThrow` if the
 * profile is already gone, `P2003` from a foreign key, a `TypeError` from a
 * bug — and telling that caller to "press Delete again" sends them into a
 * loop that cannot terminate, while making the real failure invisible to
 * them. `P2024` is the sharpest case: it means the connection pool is
 * exhausted, so an immediate retry actively makes the outage worse, which is
 * why the retryable message asks for a moment first.
 *
 * `partial` distinguishes the one state where the erasure is already half
 * irreversible: the student half committed and the teacher half did not. That
 * has to be said out loud whichever kind of failure caused it — a caller who
 * is not told will reasonably assume nothing happened.
 */
function erasureFailure(err: unknown, opts: { partial: boolean }) {
  const transient = isTransientDbError(err);
  if (opts.partial) {
    return transient
      ? respondError(
          'Your student data was removed, but the system was busy and could not remove your teaching data. Wait a moment, then press Delete again to finish.',
          503,
          'PARTIAL_ERASURE_BUSY',
        )
      : respondError(
          'Your student data was removed, but removing your teaching data failed. Pressing Delete again will not fix it — please contact support.',
          500,
          'PARTIAL_ERASURE',
        );
  }
  return transient
    ? respondError(
        'The system was busy and could not remove your account. Nothing was changed. Wait a moment, then press Delete again.',
        503,
        'ERASURE_BUSY',
      )
    : respondError(
        'Removing your account failed. Nothing was changed, and pressing Delete again will not fix it — please contact support.',
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
      const transient = isTransientDbError(err);
      log[transient ? 'warn' : 'error'](
        { err, accountId: session.accountId, transient },
        'account erasure: student half failed',
      );
      return erasureFailure(err, { partial: false });
    }
  }
  if (session.teacherId) {
    try {
      await deleteTeacherAccount(prisma, session.teacherId);
    } catch (err) {
      // `partial` only when the student half actually ran and committed.
      // Without a student profile this is a teacher-only erasure, so nothing
      // is half-applied — and this path used to bare-`throw` into
      // `withErrorHandler`'s generic 500 with no code at all, which is the
      // path #174 made MORE likely to fail: `deleteTeacherAccount` now calls
      // a `completeClass` that opens with `lockClassRow`'s 2s bound.
      const partial = Boolean(session.studentId);
      const transient = isTransientDbError(err);
      log[transient ? 'warn' : 'error'](
        { err, accountId: session.accountId, partial, transient },
        partial
          ? 'partial account erasure: student half committed, teacher half failed'
          : 'account erasure: teacher half failed',
      );
      return erasureFailure(err, { partial });
    }
  }

  const response = respondOk({ deleted: true });
  clearSessionCookie(response.headers);
  return response;
});
