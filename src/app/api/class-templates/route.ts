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
import { isCrossFamilySlotConflict } from '@/lib/cross-family-conflict';
import { countSkipReasons, type GenerationResult } from '@/lib/generation';
import { log } from '@/lib/log';

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

  // Door 4 of the room archive lifecycle (issue 76). Unlike a class — always
  // born `draft` and caught at the publish door — a template is born
  // `isActive: true` (schema.prisma:336) and starts generating immediately,
  // so creation is itself the commitment and there is no later door to catch.
  if (teacherRoom.isArchived) {
    log.info(
      { teacherRoomId: body.teacherRoomId, teacherId: session.teacherId },
      'template create refused: the room is archived',
    );
    return respondError(
      'This room is archived. Unarchive it to add a recurring class here.',
      409,
      'ROOM_ARCHIVED',
    );
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
      // FOUR sequential statements on a 2GB VPS — the create, generation's two
      // reads (its date-scoped occupancy `findMany`, and the
      // `templateId`-scoped week read #194 added), and its one batched insert
      // — against Prisma's 5s default. Three until #194; the fourth is a
      // `findMany` riding `@@unique([templateId, date])`, so it moves the
      // arithmetic without moving the conclusion. An earlier draft of this
      // comment said nine, "one create, four candidate probes and four
      // inserts": that shape was replaced by #164/#192's generator work
      // (commit `a960f9e`), since when `generateInstancesForTemplate` has
      // issued its reads plus one `createManyAndReturn`, never a per-date
      // insert loop. The count mattered, not just the prose — at nine
      // statements with four separate inserts the arithmetic for a 2s
      // bound comes out at five waitable statements against a 10s budget, and
      // the conclusion flips.
      //
      // Nor does every peer transaction touching these rows decline the 5s
      // default, which this comment also claimed: `POST /api/registrations`;
      // `waitlist.ts`'s `addToWaitlist`, `promoteNext` and `claimSpot`;
      // `class-lifecycle.ts`'s `completeClass`; `class-transitions.ts`'s
      // `autoCancelClasses`; and `invitations.ts`'s `acceptInvitation` and
      // `unlinkTeacher` all open their `$transaction` with no options, so
      // every one of them locks `Class` rows under it too.
      //
      // `withdrawWaitingEntriesForTeacher` was on that list and does not
      // belong on it: it takes `tx: TransactionClientOnly` and opens no
      // transaction at all (`db-locks.ts` brands it for exactly that reason),
      // so it inherits whichever budget `acceptInvitation`/`unlinkTeacher`
      // set — which is the 5s default, so the point survives, but through a
      // caller rather than through itself.
      //
      // Sites that DO budget past 5s, stated as a list rather than as the
      // list: the SIX template lifecycle functions — `updateClassTemplate`,
      // `pauseOrResumeTemplate`, `archiveOrUnarchiveTemplate` and all three
      // studio twins (`updateStudioClassTemplate`,
      // `pauseOrResumeStudioTemplate`, `archiveOrUnarchiveStudioTemplate`),
      // every one of them now at a flat `{ timeout: 10_000 }` — both
      // generator sweeps (`generateClassInstances`,
      // `generateStudioClassInstances`), this route's own studio twin, and
      // **both GDPR erasures** — `deleteStudentAccount`'s flat
      // `{ timeout: 20_000 }` (sized until #240) and
      // `deleteTeacherAccount`'s flat `{ timeout: 10_000 }` (`gdpr.ts`), both
      // of which lock `Class` rows and the first of which is the counterparty
      // in the deadlock issue 180 closed. An earlier version of this sentence
      // said "the ones that do budget past it are" and omitted both, which is
      // the definite-article trap this whole comment is otherwise about.
      //
      // Six, and all six at 10s, only since #194 — this sentence said "five"
      // and singled `updateClassTemplate` out at `{ timeout: 15_000 }`. Two
      // separate corrections, recorded because the definite-article trap this
      // whole comment is about is exactly how both survived:
      //
      //   - `updateStudioClassTemplate` budgets 10s too and always did. It
      //     was simply missed; "their two studio twins" counted the pause and
      //     the archive and forgot the edit.
      //   - `updateClassTemplate` dropped 15s → 10s. #194 deleted
      //     `syncTemplateInstances`, which was four of the five statements
      //     that could each wait 2s in that transaction, leaving one.
      //
      // That deletion also takes the edit path off the counterparty list
      // above: `updateClassTemplate` takes no `Class` locks at all now, so it
      // can neither be waited on nor deadlock against anything this route
      // does. `syncTemplateInstances` used to be argued about on both lists
      // and is on neither, having ceased to exist.
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
      // by the 10s lifecycle functions' mutation records, where removing
      // their `setLockTimeout` leaves the blocked statement outliving that
      // budget rather than being aborted at it. A caveat stood here excluding
      // `updateClassTemplate` from that evidence, on the grounds that it
      // budgeted 15s so "the 10s budget" was never its measurement to cite.
      // #194 moved it to 10s and the exclusion is moot — deleted rather than
      // renumbered, because its reason is gone, not its arithmetic. What the
      // budget buys is room for the three statements' own runtime; the FK
      // wait itself is unbounded.
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
    // The OTHER family holds it (#296) — a `YG001` from the cross-family
    // trigger, which is not a P2002 and so passes straight through the branch
    // above. Same status, deliberately different sentence: that clash is fixed
    // within this family, this one sends the teacher to the other half of
    // their schedule.
    if (isCrossFamilySlotConflict(err)) {
      return respondError(
        'You already have a recurring studio class on that day at that time.',
        409,
        'CROSS_FAMILY_STUDIO_TEMPLATE_SLOT',
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
  // (`@/lib/generation`) is the one place both reductions live, so a SEVENTH
  // `SkipReason` fails the build here rather than vanishing silently. Seventh,
  // not sixth: the union has had six members since #296 added
  // `blocked_by_other_family`, and the number is `countSkipReasons`' own
  // docblock's — cited rather than recounted here, so the two do not drift.
  // This line said fifth after the #194 branch's own correction pass, because
  // the phrase WRAPS ACROSS A LINE BREAK: the line-oriented grep that found the
  // sibling in `class-template-lifecycle.ts` could not match it. It is wrapped
  // the same way now, so the grep that finds this one is
  // `grep -rn -A1 'SIXTH\|SEVENTH' src/` or a `tr -d '\n'` first — the hazard
  // did not go away by being written down.
  //
  // The create form reads these and stays on the page to say so when the
  // window isn't full (`template-form.tsx`); see the note at that read.
  return respondOk(
    {
      ...created,
      added: template.generation.created,
      // One field rather than a spread, matching the PATCH `active` arm. The
      // spread already carried a new count automatically; nesting means the
      // FORM that reads this payload does too, which the spread did not give.
      counts: countSkipReasons(template.generation.skipped),
    },
    201,
  );
});
