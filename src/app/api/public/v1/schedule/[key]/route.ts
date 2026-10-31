import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondError, withErrorHandler } from '@/lib/api-utils';
import { withCors } from '@/lib/cors';
import { checkDistinctKeyLimit } from '@/lib/distinct-key-limit';
import { getCachedSchedule } from '@/lib/public-schedule-cache';
import { toPublicScheduleJson } from '@/lib/public-schedule-json';
import { checkIpRateLimit, clientIp, respondRateLimited, type RateLimitResult } from '@/lib/rate-limit';
import { listPublicSchedule } from '@/services/public-schedule';
import { SHARE_KEY_PATTERN, teacherByShareKey } from '@/services/schedule-share';

export const dynamic = 'force-dynamic';

const PER_IP_LIMIT = 60;
const WINDOW_MS = 60 * 1000;

function refuseRateLimited(limit: RateLimitResult): NextResponse {
  const res = respondRateLimited(limit, 'Too many requests.');
  res.headers.set('Retry-After', String(limit.retryAfterSeconds));
  return res;
}

const guarded = withErrorHandler(
  async (request: NextRequest, { params }: { params: Promise<{ key: string }> }) => {
    const { key } = await params;
    const ip = clientIp(request);
    const now = Date.now();

    const ipLimit = checkIpRateLimit('public-schedule:ip', ip, PER_IP_LIMIT, WINDOW_MS, 'public-schedule', now);
    if (!ipLimit.allowed) return refuseRateLimited(ipLimit);
    if (!SHARE_KEY_PATTERN.test(key)) return respondError('Not found.', 404);
    const keyLimit = checkDistinctKeyLimit(ip, key, now);
    if (!keyLimit.allowed) return refuseRateLimited(keyLimit);

    const teacher = await teacherByShareKey(prisma, key);
    if (!teacher) return respondError('Not found.', 404);

    const weeks = teacher.scheduleShareWeeks;
    const includeStudio = teacher.scheduleShareStudio;
    const mode = { kind: 'bookable' as const, weeks };
    const entries = await getCachedSchedule(`${mode.kind}:${teacher.id}:${weeks}:${includeStudio}`, now, () =>
      listPublicSchedule(prisma, {
        teacherId: teacher.id,
        timeZone: teacher.defaultTimezone,
        now: new Date(now),
        mode,
        includeStudio,
      }),
    );

    const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const res = NextResponse.json(
      toPublicScheduleJson(entries, { pageSlug: teacher.pageSlug, timeZone: teacher.defaultTimezone }, origin),
    );
    res.headers.set('Cache-Control', 'public, max-age=60');
    return res;
  },
);

/** Every exit, the 404, 429 and 500 included, carries the CORS header, or the browser hides the refusal from the widget. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  return withCors(await guarded(request, ctx));
}
