import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { withErrorHandler } from '@/lib/api-utils';
import { syncAttempt } from '@/services/processor-attempts';
import { mollieDeps } from '@/services/mollie-deps';

/** The id shape of a Mollie payment; anything else is answered without a lookup. */
const MOLLIE_PAYMENT_ID = /^tr_[A-Za-z0-9]+$/;

/**
 * Mollie's classic webhook: a form-encoded `id` and nothing else believed.
 * It is unauthenticated and not rate-limited because it trusts nothing it is
 * sent (spec §5): an id no attempt has costs one indexed read and answers 200
 * with no Mollie call, and a known one costs one Mollie GET, made with the
 * attempt's own teacher's token, whose answer is the only thing applied. The
 * body is read as text and parsed as a query string, so a body of another
 * type finds no `id` rather than throwing. 503 asks Mollie to retry.
 */
export const POST = withErrorHandler(async (request) => {
  const id = new URLSearchParams(await request.text()).get('id');
  if (id === null || !MOLLIE_PAYMENT_ID.test(id)) return new NextResponse(null, { status: 200 });
  const result = await syncAttempt(prisma, mollieDeps(), id);
  return new NextResponse(null, { status: result === 'unavailable' ? 503 : 200 });
});
