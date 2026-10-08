import { NextRequest, NextResponse } from 'next/server';
import { respondError, withErrorHandler } from '@/lib/api-utils';
import { MAX_CSP_REPORT_BYTES, summariseCspReport } from '@/lib/csp-report';
import { log } from '@/lib/log';
import { checkIpRateLimit, clientIp, respondRateLimited } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// One broken page load sends a report per blocked script.
const PER_IP_LIMIT = 60;
const WINDOW_MS = 60 * 1000;

type RefusalReason = 'content-type' | 'content-length' | 'not-json' | 'not-a-report';

const lastRefusalLog = new Map<RefusalReason, number>();

/**
 * Refused reports are otherwise silent, and an operator who sees no
 * `csp violation` warns could not tell "no violations" from "every report is
 * being refused". At most one warn per reason per window; it names the
 * reason, the content-type token and the declared length, never the body.
 */
function noteRefusal(reason: RefusalReason, request: NextRequest): void {
  const now = Date.now();
  const last = lastRefusalLog.get(reason);
  if (last === undefined || now - last >= WINDOW_MS) {
    lastRefusalLog.set(reason, now);
    log.warn(
      {
        csp: {
          reason,
          contentType: (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase().slice(0, 64),
          declaredLength: (request.headers.get('content-length') ?? '').slice(0, 20),
        },
      },
      'csp report refused',
    );
  }
}

/**
 * Where the page CSP's `report-uri` sends violations: one `warn` per report,
 * reduced by `summariseCspReport`. Unauthenticated, so IP rate-limited first.
 * Reads its own body, because a browser sends `application/csp-report`, not
 * JSON.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const limit = checkIpRateLimit('csp-report:ip', clientIp(request), PER_IP_LIMIT, WINDOW_MS, 'csp-report');
  if (!limit.allowed) return respondRateLimited(limit, 'Too many reports.');

  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/csp-report') {
    noteRefusal('content-type', request);
    return respondError('Send this report as application/csp-report.', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  // A chunked body carries no Content-Length; refusing a missing header
  // refuses it before anything is read.
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_CSP_REPORT_BYTES) {
    noteRefusal('content-length', request);
    return respondError('This is not a CSP report.', 400);
  }

  const text = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
    // eslint-disable-next-line no-restricted-syntax -- a body that isn't JSON is a 400, not a fault
  } catch {
    noteRefusal('not-json', request);
    return respondError('This is not a CSP report.', 400);
  }
  const summary = summariseCspReport(body);
  if (summary === null) {
    noteRefusal('not-a-report', request);
    return respondError('This is not a CSP report.', 400);
  }

  log.warn({ csp: summary }, 'csp violation');
  return new NextResponse(null, { status: 204 });
});
