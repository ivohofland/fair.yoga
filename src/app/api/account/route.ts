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
import { deleteStudentAccount, deleteTeacherAccount } from '@/services/gdpr';

/**
 * GDPR account erasure (Art. 17). Personal data is anonymized; financial
 * records the other party is entitled to keep stay behind, attributed to a
 * deleted account. Signs the caller out.
 */
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  // "Delete my account" erases every profile the account holds. The two
  // erasures are separate transactions: if the second fails after the
  // first committed, say exactly that — a bare 500 would hide that half
  // the erasure is already irreversible. Both erasures are safely
  // re-runnable, so a retry finishes the job — but that only helps if the
  // caller is TOLD to retry. A failure here (e.g. the erasure transaction's
  // own `timeout` — see `gdpr.ts` — throwing P2028 under contention) used to
  // fall straight through to `withErrorHandler`'s generic classification,
  // which says nothing about retrying. Caught explicitly so the message
  // matches the teacher-half path below.
  if (session.studentId) {
    try {
      await deleteStudentAccount(prisma, session.studentId);
    } catch (err) {
      log.error({ err, accountId: session.accountId }, 'account erasure: student half failed');
      return respondError(
        'Removing your account failed. Press Delete again to finish.',
        500,
        'ERASURE_FAILED',
      );
    }
  }
  if (session.teacherId) {
    try {
      await deleteTeacherAccount(prisma, session.teacherId);
    } catch (err) {
      if (session.studentId) {
        log.error(
          { err, accountId: session.accountId },
          'partial account erasure: student half committed, teacher half failed',
        );
        return respondError(
          'Your student data was removed, but removing your teaching data failed. Press Delete again to finish.',
          500,
          'PARTIAL_ERASURE',
        );
      }
      throw err;
    }
  }

  const response = respondOk({ deleted: true });
  clearSessionCookie(response.headers);
  return response;
});
