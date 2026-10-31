import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondError, withErrorHandler } from '@/lib/api-utils';
import { formatRoomLocation } from '@/lib/format';
import { buildIcs, type IcsEvent } from '@/lib/ics';
import { getCachedSchedule } from '@/lib/public-schedule-cache';
import { checkIpRateLimit, clientIp, respondRateLimited } from '@/lib/rate-limit';
import { listPublicSchedule, type PublicScheduleEntry } from '@/services/public-schedule';
import { teacherByShareKey } from '@/services/schedule-share';

export const dynamic = 'force-dynamic';

const PER_IP_LIMIT = 600;
const WINDOW_MS = 60 * 1000;
const FILE_PATTERN = /^([A-Za-z0-9_-]+)\.ics$/;

const PRICING_LABEL = { tiered: 'Income-based', donation: 'Pay what you can' } as const;

function toEvent(e: PublicScheduleEntry, pageSlug: string, origin: string): IcsEvent {
  const base = {
    uid: `${e.calendarEntryId}@fair.yoga`,
    start: e.start,
    durationMinutes: e.durationMinutes,
    summary: e.classType,
    cancelled: e.cancelled,
    sequence: Math.floor(e.updatedAt.getTime() / 1000),
    lastModified: e.updatedAt,
  };
  if (e.kind === 'studio') {
    return { ...base, location: e.location, description: '', url: e.bookingUrl };
  }
  return {
    ...base,
    location:
      e.location.format === 'online' ? 'Online' : formatRoomLocation(e.location.room.roomName, e.location.room.venueName),
    description: PRICING_LABEL[e.pricingMode],
    url: `${origin}/${pageSlug}/book/${e.id}`,
  };
}

const guarded = withErrorHandler(
  async (request: NextRequest, { params }: { params: Promise<{ file: string }> }) => {
    const { file } = await params;
    const match = FILE_PATTERN.exec(file);
    const key = match?.[1];
    if (key === undefined) return respondError('Not found.', 404);

    const now = Date.now();
    const ipLimit = checkIpRateLimit('schedule-feed:ip', clientIp(request), PER_IP_LIMIT, WINDOW_MS, 'schedule-feed', now);
    if (!ipLimit.allowed) {
      const res = respondRateLimited(ipLimit, 'Too many requests.');
      res.headers.set('Retry-After', String(ipLimit.retryAfterSeconds));
      return res;
    }

    const teacher = await teacherByShareKey(prisma, key);
    if (!teacher) return respondError('Not found.', 404);

    const weeks = teacher.scheduleShareWeeks;
    const includeStudio = teacher.scheduleShareStudio;
    const mode = { kind: 'calendar' as const, weeks };
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
    const body = buildIcs({
      calendarName: `${teacher.firstName}'s schedule`,
      events: entries.map((e) => toEvent(e, teacher.pageSlug, origin)),
      now: new Date(now),
    });
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      },
    });
  },
);

export async function GET(request: NextRequest, ctx: { params: Promise<{ file: string }> }): Promise<NextResponse> {
  return guarded(request, ctx);
}
