import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { completeConnect } from '@/services/processor-connection';
import { deliverPayoutChangedNotice } from '@/services/payout-notice';
import { mollieDeps } from '@/services/mollie-deps';
import type { MollieReturn } from '@/lib/mollie-return';

const SETTINGS_PATH = '/settings/profile';

/**
 * Where Mollie sends the teacher back after the consent screen. A GET that
 * writes, which is acceptable only because the state it consumes is single-use
 * and bound to the session that started the connect: a forged or replayed
 * link refuses without changing anything. Every answer is a redirect to the
 * profile settings, whose status line reads the `mollie` parameter; a visitor
 * without a teacher session signs in first and returns there.
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const deps = mollieDeps();
  const base = deps?.config.appUrl ?? (process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin);
  const back = (status: MollieReturn) => NextResponse.redirect(`${base}${SETTINGS_PATH}?mollie=${status}`, 303);

  const session = await requireTeacher(request);
  if (isErrorResponse(session)) {
    return NextResponse.redirect(`${base}/login?redirect=${encodeURIComponent(SETTINGS_PATH)}`, 303);
  }
  const params = request.nextUrl.searchParams;
  if (params.get('error') !== null) return back('cancelled');
  const code = params.get('code');
  const state = params.get('state');
  if (code === null || state === null) return back('expired');
  if (deps === null) return back('unavailable');

  const outcome = await completeConnect(prisma, deps, { state, code, sessionId: session.sessionId });
  switch (outcome.kind) {
    case 'connected':
      if (outcome.eventId !== null) deliverPayoutChangedNotice(prisma, outcome.eventId);
      return back('connected');
    case 'choose_profile':
      return back('choose');
    case 'refused':
      return back('expired');
    case 'unavailable':
      return back('unavailable');
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled connect outcome: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
});
