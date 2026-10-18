import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import { respondTyped, respondUnchanged, respondError, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { disconnect, revokeConnection } from '@/services/processor-connection';
import { forgetOfferedMethods } from '@/services/processor-methods-cache';
import { deliverPayoutChangedNotice } from '@/services/payout-notice';
import { mollieDeps } from '@/services/mollie-deps';

type Params = { params: Promise<{ id: string }> };

/** The session teacher's own id, or the refusal. */
async function authorise(request: NextRequest, { params }: Params): Promise<string | NextResponse> {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  if (session.teacherId !== id) return respondError('Access denied', 403);
  return id;
}

/**
 * Disconnects the teacher's Mollie account. Needs no Mollie call; with Mollie
 * configured, a connection with no attempt still open is revoked in the
 * background straight after, and otherwise the daily sweep revokes it.
 */
export const DELETE = withErrorHandler(async (request: NextRequest, context: Params) => {
  const teacherId = await authorise(request, context);
  if (teacherId instanceof NextResponse) return teacherId;

  const outcome = await disconnect(prisma, { teacherId });
  switch (outcome.kind) {
    case 'disconnected': {
      deliverPayoutChangedNotice(prisma, outcome.eventId);
      forgetOfferedMethods(outcome.connectionId);
      const deps = mollieDeps();
      if (outcome.revokeNow && deps !== null) revokeConnection(prisma, deps, outcome.connectionId);
      return respondTyped<{ connected: false }>({ connected: false });
    }
    case 'unchanged':
      return respondUnchanged<{ connected: false }>({ connected: false });
    case 'teacher_gone':
      log.info({ teacherId }, 'Mollie disconnect refused: the teacher was erased');
      return respondError('Teacher not found', 404);
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled disconnect outcome: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
});
