import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { createStudioClassSchema } from '@/lib/schemas';
import { entryConflictMessage, probeConflictingEntry } from '@/lib/entry-conflict';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { log } from '@/lib/log';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClasses = await prisma.studioClass.findMany({
    where: { calendarEntry: { teacherId: session.teacherId } },
    include: { calendarEntry: true },
    orderBy: { calendarEntry: { date: 'desc' } },
  });

  // The wire shape is unchanged by #327: the entry's columns are flattened
  // back onto the studio class, so a client still reads `classType`, `date`,
  // `startTime`, `cancelledAt` and `teacherId` where it always did.
  return respondOk(
    studioClasses.map(({ calendarEntry, ...sc }) => ({
      ...sc,
      teacherId: calendarEntry.teacherId,
      classType: calendarEntry.classType,
      date: calendarEntry.date,
      startTime: timeToHHmm(calendarEntry.startTime),
      durationMinutes: calendarEntry.durationMinutes,
      cancelledAt: calendarEntry.cancelledAt,
    })),
  );
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createStudioClassSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // Fields are named rather than spread. The spread was not the vulnerability —
  // Zod strips undeclared keys, so only declared keys ever rode it — but it did
  // make the two server-set keys of the day invisible: neither name appeared in
  // this handler, so grepping for them found nothing (#148). One of the two,
  // `templateId`, is not a column at all any more; `scheduleRuleId` on the
  // entry is what replaced it, and this handler never sets it either.

  // Two Prisma calls, not one nested `create`. Prisma already wraps a single
  // nested write in its own implicit transaction — measured on this branch:
  // `BEGIN`, `INSERT CalendarEntry`, `INSERT StudioClass`, `SELECT`,
  // `COMMIT` — so this explicit `$transaction` PRESERVES that atomicity
  // across the two calls below rather than introducing it. Without it, each
  // call would open its own implicit transaction, leaving a window where a
  // `CalendarEntry` exists with no `StudioClass`. It does not add a
  // lock-holding path.
  //
  // No `setLockTimeout` here: issue 228 tracks that bound for the create
  // paths, and adding it alone would turn a wait that usually succeeds into a
  // generic 503 rather than a named one. An explicit `$transaction` also
  // imports Prisma's interactive-transaction defaults — `maxWait: 2000`,
  // `timeout: 5000` — that the implicit nested write it replaces did not
  // carry, so contention here can already surface that same generic,
  // code-less 503 before any `setLockTimeout` is added.
  const outcome = await prisma.$transaction(async (tx) => {
    // The ENTRY is inserted alone and first — it holds the slot constraint,
    // and `skipDuplicates` (`ON CONFLICT DO NOTHING`) makes it refuse with
    // zero rows rather than deadlock against a concurrent conflicting insert
    // (issue 331). `ON CONFLICT DO NOTHING` carries no conflict target, so a
    // zero-row skip could in principle be any constraint on `CalendarEntry`
    // — it can only be this slot exclusion here because this handler never
    // sets `scheduleRuleId`, leaving `@@unique([scheduleRuleId, date])`'s
    // column NULL, and Postgres treats NULLs as distinct. Parent before
    // child is forced by the composite `(calendarEntryId, kind)` foreign
    // key; this is a creation path, so `docs/lock-order.md`'s `Class`-then-
    // entry rule — which governs a write to two EXISTING rows — does not
    // apply. `kind` is set here on the parent, and `CalendarEntry.classType`
    // carries no `@default("")` — every studio write supplies one.
    const [entry] = await tx.calendarEntry.createManyAndReturn({
      data: [{
        teacherId: session.teacherId,
        kind: 'studio' as const,
        classType: body.classType,
        date: new Date(body.date),
        startTime: hhmmToTime(body.startTime),
        durationMinutes: body.durationMinutes,
      }],
      skipDuplicates: true,
    });
    if (!entry) return { ok: false as const };

    const studioClass = await tx.studioClass.create({
      data: {
        calendarEntryId: entry.id,
        kind: 'studio',
        location: body.location,
        hourlyRate: body.hourlyRate,
      },
    });
    return { ok: true as const, entry, studioClass };
  });

  if (!outcome.ok) {
    // WHICH entry, asked of the database, because a zero row count does not
    // say — and either family can be the answer, since both live in one
    // table now. On `prisma`, never on a transaction client: the one above
    // has closed.
    const conflict = await probeConflictingEntry(prisma, session.teacherId, {
      date: new Date(body.date),
      startTime: hhmmToTime(body.startTime),
      durationMinutes: body.durationMinutes,
    });
    // LOGGED before responding, for the reason every refusal returned from a
    // service carries: `respondError` does not log and `withErrorHandler`
    // never sees a response that was RETURNED rather than thrown, so this
    // line is what leaves a server-side record of the refusal.
    log.warn(
      { teacherId: session.teacherId, conflictEntryId: conflict?.id ?? null },
      'studio class create refused: another live entry holds that slot',
    );
    return respondError(entryConflictMessage(conflict, 'studio'), 409, 'DUPLICATE_STUDIO_SLOT');
  }
  const { entry, studioClass } = outcome;

  return respondOk(
    {
      ...studioClass,
      teacherId: entry.teacherId,
      classType: entry.classType,
      date: entry.date,
      startTime: timeToHHmm(entry.startTime),
      durationMinutes: entry.durationMinutes,
      cancelledAt: entry.cancelledAt,
    },
    201,
  );
});
