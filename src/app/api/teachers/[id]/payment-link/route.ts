import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import {
  respondTyped, respondUnchanged, respondError, requireTeacher, parseBody, isErrorResponse, withErrorHandler,
} from '@/lib/api-utils';
import { paymentLinkSchema } from '@/lib/schemas';
import { formatIssues } from '@/lib/validation-message';
import { PAYMENT_LINK_MESSAGES } from '@/lib/payment-link';
import { savePaymentLink, removePaymentLink } from '@/services/payment-link';

type Params = { params: Promise<{ id: string }> };

/** The session teacher's own id, or the refusal. */
async function authorise(request: NextRequest, { params }: Params): Promise<string | NextResponse> {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  if (session.teacherId !== id) return respondError('Access denied', 403);
  return id;
}

export const PUT = withErrorHandler(async (request: NextRequest, context: Params) => {
  const teacherId = await authorise(request, context);
  if (teacherId instanceof NextResponse) return teacherId;

  const body = await parseBody(request, paymentLinkSchema);
  if ('error' in body) return body.error;

  const outcome = await savePaymentLink(prisma, teacherId, body.data.paymentLink);
  switch (outcome.kind) {
    case 'saved':
      return respondTyped<{ paymentLink: string }>({ paymentLink: outcome.paymentLink });
    case 'unchanged':
      return respondUnchanged<{ paymentLink: string }>({ paymentLink: outcome.paymentLink });
    case 'invalid':
      return respondError(formatIssues([{ path: ['paymentLink'], message: PAYMENT_LINK_MESSAGES[outcome.error] }]), 400);
    case 'teacher_gone':
      log.info({ teacherId }, 'payment link save refused: the teacher was erased');
      return respondError('Teacher not found', 404);
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled payment link save outcome: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
});

export const DELETE = withErrorHandler(async (request: NextRequest, context: Params) => {
  const teacherId = await authorise(request, context);
  if (teacherId instanceof NextResponse) return teacherId;

  const outcome = await removePaymentLink(prisma, teacherId);
  switch (outcome.kind) {
    case 'removed':
      return respondTyped<{ paymentLink: null }>({ paymentLink: null });
    case 'absent':
      return respondUnchanged<{ paymentLink: null }>({ paymentLink: null });
    case 'teacher_gone':
      log.info({ teacherId }, 'payment link removal refused: the teacher was erased');
      return respondError('Teacher not found', 404);
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled payment link removal outcome: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
});
