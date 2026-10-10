import { NextRequest, NextResponse } from 'next/server';
import { respondTyped, respondError, respondUnchanged, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { checkIpRateLimit, clientIp, respondRateLimited } from '@/lib/rate-limit';
import { verifyUnsubscribeToken } from '@/lib/unsubscribe-token';
import { unsubscribe } from '@/services/unsubscribe';

const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_LIMIT = 60;
const INVALID = 'This unsubscribe link no longer works. You can change your email settings after signing in.';
const BAD_BODY = 'Send List-Unsubscribe=One-Click as a form body.';

/**
 * RFC 8058 one-click unsubscribe. Needs no session: the signed token is the
 * credential and can flip one preference. Mailbox providers POST here
 * server-side, webmail clients from the browser, hence the cross-origin
 * exemption. One 404 for every token that cannot act.
 */
export const POST = withErrorHandler(
  async (request: NextRequest) => {
    const limit = checkIpRateLimit('unsubscribe', clientIp(request), PER_IP_LIMIT, WINDOW_MS, 'unsubscribe');
    if (!limit.allowed) return respondRateLimited(limit, 'Too many attempts.');

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return respondError(BAD_BODY, 400);
    }
    if (form.get('List-Unsubscribe') !== 'One-Click') return respondError(BAD_BODY, 400);

    const target = verifyUnsubscribeToken(request.nextUrl.searchParams.get('t') ?? '');
    if (target === null) return respondError(INVALID, 404, 'UNSUBSCRIBE_LINK_INVALID');

    const outcome = await unsubscribe(prisma, target);
    switch (outcome.status) {
      case 'done':
        return respondTyped<{ unsubscribed: true }>({ unsubscribed: true });
      case 'unchanged':
        return respondUnchanged<{ unsubscribed: true }>({ unsubscribed: true });
      case 'invalid':
        return respondError(INVALID, 404, 'UNSUBSCRIBE_LINK_INVALID');
      default: {
        const unhandled: never = outcome;
        throw new Error(`unhandled unsubscribe outcome: ${String((unhandled as { status?: unknown }).status)}`);
      }
    }
  },
  { crossOrigin: 'token-authorised' },
);

/** A client that opens the header link in a browser lands on the confirm page; nothing changes on GET. */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const token = request.nextUrl.searchParams.get('t') ?? '';
  const base = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
  return NextResponse.redirect(`${base}/unsubscribe#t=${encodeURIComponent(token)}`, 303);
});
