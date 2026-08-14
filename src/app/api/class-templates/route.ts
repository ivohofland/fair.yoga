import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { createClassTemplateSchema } from '@/lib/schemas';
import { generateInstancesForTemplate } from '@/services/class-generator';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { countSkipReasons, type GenerationResult } from '@/lib/generation';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const templates = await prisma.classTemplate.findMany({
    where: { teacherId: session.teacherId },
    include: { teacherRoom: { include: { room: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(templates);
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createClassTemplateSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // Verify teacherRoomId belongs to this teacher
  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id: body.teacherRoomId } });
  if (!teacherRoom || teacherRoom.teacherId !== session.teacherId) {
    return respondError('Invalid teacher room', 400);
  }

  // Atomic: a generation failure rolls the template create back rather than
  // leaving a template that produces no classes. Failure propagates (500).
  //
  // The catch sits OUTSIDE this call rather than inside it: a P2002 raised
  // inside a Postgres transaction aborts that transaction, so there is
  // nothing to catch from within — and rolling the whole thing back is
  // correct anyway, since a template that duplicates an existing one should
  // not exist, and neither should the window it would have generated.
  //
  // Only the template's own P2002 can reach this catch. `tx.classTemplate
  // .create` runs first and, on conflict, throws before generation ever
  // starts — so `generateInstancesForTemplate`'s `createManyAndReturn`
  // (`skipDuplicates: true`, a bare `ON CONFLICT DO NOTHING`) never gets a
  // chance to raise anything here even though it shares this transaction.
  let template: {
    created: Prisma.ClassTemplateGetPayload<{
      include: { teacher: { select: { defaultTimezone: true } } };
    }>;
    generation: GenerationResult;
  };
  try {
    template = await prisma.$transaction(async (tx) => {
      const created = await tx.classTemplate.create({
        data: {
          teacherId: session.teacherId,
          teacherRoomId: body.teacherRoomId,
          classType: body.classType,
          description: body.description,
          dayOfWeek: body.dayOfWeek,
          startTime: body.startTime,
          durationMinutes: body.durationMinutes,
          roomCost: body.roomCost,
          minRate: body.minRate,
          targetRate: body.targetRate,
          minStudents: body.minStudents,
          maxStudents: body.maxStudents,
          cancelDeadline: body.cancelDeadline,
          autoCancelCheck: body.autoCancelCheck,
        },
        include: { teacher: { select: { defaultTimezone: true } } },
      });
      const generation = await generateInstancesForTemplate(tx, created);
      return { created, generation };
    },
      // Three sequential statements on a 2GB VPS — the create, generation's
      // single occupancy read and its single batched insert — against Prisma's
      // 5s default. An earlier draft of this comment said nine, "one create,
      // four candidate probes and four inserts": that shape was replaced by
      // #164/#192's generator work (commit `a960f9e`), since when
      // `generateInstancesForTemplate` has issued one `findMany` plus one
      // `createManyAndReturn`. The count mattered, not just the prose —
      // at nine statements with four separate inserts the arithmetic for a 2s
      // bound comes out at five waitable statements against a 10s budget, and
      // the conclusion flips.
      //
      // Nor does every peer transaction touching these rows decline the 5s
      // default, which this comment also claimed: `POST /api/registrations`;
      // `waitlist.ts`'s `addToWaitlist`, `promoteNext`, `claimSpot` and
      // `withdrawWaitingEntriesForTeacher`; `class-lifecycle.ts`'s
      // `completeClass`; `class-transitions.ts`'s `autoCancelClasses`; and
      // `invitations.ts`'s `acceptInvitation` and `unlinkTeacher` all open
      // their `$transaction` with no options, so every one of them locks
      // `Class` rows under it too. The ones that do budget past it are the
      // five template lifecycle functions (`updateClassTemplate`,
      // `pauseOrResumeTemplate`, `archiveOrUnarchiveTemplate` and their two
      // studio twins — `updateClassTemplate` is the fifth, since the
      // atomic-template-update branch gave its transaction its own
      // `{ timeout: 15_000 }`), both generator sweeps (`generateClassInstances`,
      // `generateStudioClassInstances`) and this route's own studio twin —
      // "most", not "every", and not "the five".
      //
      // `syncTemplateInstances` (`template-sync.ts`) no longer belongs on
      // either list: since the atomic-template-update branch (issue 83) it
      // opens no transaction of its own, so it runs under whatever budget its
      // one production caller sets — `updateClassTemplate`'s
      // `{ timeout: 15_000 }` (`class-template-lifecycle.ts`) — not under
      // Prisma's 5s default the way it used to.
      //
      // No claim is taken here (the row is brand-new inside this transaction, so
      // nothing can race the insert), which also means no claim `lock_timeout`
      // bounds the FK waits: each generated class needs `FOR KEY SHARE` on the
      // `Teacher` row, and `email`/`pageSlug`/`accountId` are all `@unique`, so
      // a teacher changing their page slug in another tab takes `FOR UPDATE`
      // there and conflicts.
      //
      // What this budget does NOT do is bound that wait, and an earlier draft
      // of this comment claimed it did. Prisma checks the budget at statement
      // boundaries, so it "cannot roll back a statement already blocked inside
      // Postgres, only refuse to start a new one" (`db-locks.ts`) — measured
      // by the five lifecycle functions' mutation records, where removing
      // their `setLockTimeout` leaves the blocked statement outliving the 10s
      // budget rather than being aborted at it. What the budget buys is room
      // for the three statements' own runtime; the FK wait itself is unbounded.
      //
      // No `setLockTimeout` here, and that is a scope decision rather than an
      // oversight — tracked as issue 228, which moves this transaction into a
      // service so it can carry the bound AND a `busy` arm together. Alone,
      // the bound would turn a wait that usually succeeds into the generic
      // `classifyApiError` 503 instead of a named one.
      { timeout: 10_000 },
    );
  } catch (err) {
    // The template's slot key, not `Class`'s. Both models share this
    // transaction, but only the template can raise P2002 here (see above),
    // so there is no need to disambiguate by modelName even though
    // (teacherId, dayOfWeek, startTime) and (teacherId, date, startTime) are
    // different column sets by coincidence rather than guarantee — see
    // isUniqueConflictOn's docblock.
    if (isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime'])) {
      return respondError(
        'You already have a recurring class on that day at that time.',
        409,
        'DUPLICATE_TEMPLATE_SLOT',
      );
    }
    throw err;
  }

  const { teacher, ...created } = template.created;
  void teacher;

  // The atomicity note above guarantees a generation *failure* rolls the
  // template back. It does not cover generation *succeeding* having created
  // nothing, which #196's slot pre-check made an ordinary outcome: a teacher
  // creating a second template on a day and time they already occupy gets a
  // live template whose every candidate date is taken. That used to be
  // impossible, so 201 with no counts was a complete answer; it no longer is.
  // The same counts the PATCH `active` arm carries — `countSkipReasons`
  // (`@/lib/generation`) is the one place both reductions live, so a fifth
  // `SkipReason` fails the build here rather than vanishing silently. The
  // create form reads these and stays on the page to say so when the window
  // isn't full (`template-form.tsx`); see the note at that read.
  return respondOk(
    {
      ...created,
      added: template.generation.created,
      ...countSkipReasons(template.generation.skipped),
    },
    201,
  );
});
