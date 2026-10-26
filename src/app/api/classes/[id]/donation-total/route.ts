import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  requireTeacher,
  parseBody,
  isErrorResponse,
  respondError,
  respondRefusal,
  respondTyped,
  respondUnchanged,
  withErrorHandler,
} from '@/lib/api-utils';
import type { CodedRefusal } from '@/lib/api-error-codes';
import { donationTotalSchema } from '@/lib/schemas';
import { recordDonationTotal, type RecordDonationTotalResult } from '@/services/donations';
import { CLASS_CANCELLED, CLASS_GONE, CLASS_NOT_COMPLETED, DONATION_CLASS_REQUIRED } from '../shared';

type RefusalReason = Extract<RecordDonationTotalResult, { ok: false }>['reason'];

/** Every coded refusal; `forbidden` is answered before this map. */
const REFUSALS = {
  not_found: CLASS_GONE,
  cancelled: CLASS_CANCELLED,
  not_donation: DONATION_CLASS_REQUIRED,
  not_completed: CLASS_NOT_COMPLETED,
} as const satisfies Record<Exclude<RefusalReason, 'forbidden'>, CodedRefusal>;

type TotalBody = { classId: string; donationTotal: number | null };

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const parsed = await parseBody(request, donationTotalSchema);
  if ('error' in parsed) return parsed.error;

  const result = await recordDonationTotal(prisma, session.teacherId, id, parsed.data.amount);
  if (!result.ok) {
    if (result.reason === 'forbidden') return respondError('Not your class', 403);
    return respondRefusal(REFUSALS[result.reason]);
  }
  const body: TotalBody = { classId: id, donationTotal: result.donationTotal };
  return result.outcome === 'applied' ? respondTyped<TotalBody>(body) : respondUnchanged<TotalBody>(body);
});
