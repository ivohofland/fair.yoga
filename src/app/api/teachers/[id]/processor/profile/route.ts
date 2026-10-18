import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondTyped, respondUnchanged, respondError, requireTeacher, parseBody, isErrorResponse, withErrorHandler,
} from '@/lib/api-utils';
import { processorProfileSchema } from '@/lib/schemas';
import { chooseProfile } from '@/services/processor-connection';
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

/** Chooses, or switches, the Mollie profile students' payments go to. */
export const PUT = withErrorHandler(async (request: NextRequest, context: Params) => {
  const teacherId = await authorise(request, context);
  if (teacherId instanceof NextResponse) return teacherId;
  const deps = mollieDeps();
  if (deps === null) return respondError('Mollie isn’t available right now.', 503, 'PROCESSOR_UNAVAILABLE');

  const body = await parseBody(request, processorProfileSchema);
  if ('error' in body) return body.error;
  const { profileId } = body.data;

  const outcome = await chooseProfile(prisma, deps, { teacherId, profileId });
  switch (outcome.kind) {
    case 'chosen':
      deliverPayoutChangedNotice(prisma, outcome.eventId);
      return respondTyped<{ profileId: string }>({ profileId });
    case 'unchanged':
      return respondUnchanged<{ profileId: string }>({ profileId });
    case 'not_connected':
      return respondError('Mollie isn’t connected. Connect it again from Settings.', 409, 'PROCESSOR_NOT_CONNECTED');
    case 'unknown_profile':
      return respondError('That profile isn’t in your Mollie account.', 400);
    case 'unavailable':
      return respondError('Mollie isn’t available right now.', 503, 'PROCESSOR_UNAVAILABLE');
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled profile choice outcome: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
});
