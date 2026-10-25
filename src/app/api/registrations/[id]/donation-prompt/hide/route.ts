import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  requireStudent,
  isErrorResponse,
  respondError,
  respondTyped,
  respondUnchanged,
  withErrorHandler,
} from '@/lib/api-utils';
import { hideDonationPrompt } from '@/services/donations';

type HiddenBody = { id: string; hiddenAt: string };

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const result = await hideDonationPrompt(prisma, session.studentId, id);
  switch (result.kind) {
    case 'hidden':
      return respondTyped<HiddenBody>({ id, hiddenAt: result.hiddenAt.toISOString() });
    case 'unchanged':
      return respondUnchanged<HiddenBody>({ id, hiddenAt: result.hiddenAt.toISOString() });
    case 'not_found':
      return respondError('This booking no longer exists.', 404, 'NOT_FOUND');
    case 'forbidden':
      return respondError('Access denied', 403);
    case 'not_invited':
      return respondError("There's nothing to hide for this booking.", 409, 'DONATION_NOT_INVITED');
    default: {
      const unhandled: never = result;
      throw new Error(`hide donation prompt: unhandled result ${JSON.stringify(unhandled)}`);
    }
  }
});
