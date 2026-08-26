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
import { withSlot } from '@/services/class-template-lifecycle';
import { hhmmToTime } from '@/lib/time-of-day';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { ruleSlotHolder, minutesSinceMidnight, type RuleSlotHolder } from '@/lib/rule-slot-holder';
import { isCrossFamilySlotConflict } from '@/lib/cross-family-conflict';
import { countSkipReasons, type GenerationResult } from '@/lib/generation';
import { log } from '@/lib/log';

/**
 * Mirrors `class-templates/[id]/route.ts`'s `SLOT_TAKEN` — see that file for
 * why `heldBy` replaces two reasons, and why the `satisfies` is load-bearing.
 */
const SLOT_TAKEN = {
  regular: [
    'You already have a recurring class at an overlapping time on that day.',
    'DUPLICATE_TEMPLATE_SLOT',
  ],
  studio: [
    'You already have a recurring studio class at an overlapping time on that day.',
    'CROSS_FAMILY_STUDIO_TEMPLATE_SLOT',
  ],
  unknown: [
    'You already have a recurring class or studio class at an overlapping time on that day.',
    'TEMPLATE_SLOT_CONFLICT',
  ],
} as const satisfies Record<RuleSlotHolder, readonly [string, string]>;

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const templates = await prisma.classTemplate.findMany({
    where: { scheduleRule: { teacherId: session.teacherId } },
    include: { teacherRoom: { include: { room: true } }, scheduleRule: true },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(
    templates.map(({ scheduleRule, ...bare }) => withSlot(bare, scheduleRule)),
  );
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
  // The catch sits OUTSIDE this call rather than inside it: a failed
  // statement aborts a Postgres transaction, so there is nothing to catch
  // from within — and rolling the whole thing back is correct anyway, since
  // a template that duplicates an existing one should not exist, and neither
  // should the window it would have generated.
  //
  // Only the template's own `23P01` can reach this catch. `tx.classTemplate
  // .create` runs first and, on conflict, throws before generation ever
  // starts — so `generateInstancesForTemplate`'s `createManyAndReturn`
  // (`skipDuplicates: true`, a bare `ON CONFLICT DO NOTHING`) never gets a
  // chance to raise anything here even though it shares this transaction.
  // No P2002 reaches this catch at all any more: the nested create's only
  // former source, the template's own partial unique index, is gone (issue
  // 298) — `ScheduleRule`'s auto-generated `id`/`kind` and the child's
  // auto-generated `scheduleRuleId` cannot collide.
  //
  // NO `YG001` reaches this catch either, and since #327 nothing raises one at
  // all — the entry-level cross-family triggers went the way the template-level
  // ones went in #298, replaced by an exclusion constraint. The census and its
  // re-derivation live in `docs/lock-order.md` ("One teacher, one slot" —
  // *`YG001` has no raiser left*); the branch below is what is left of that
  // arm and says so where it stands.
  //
  // Generation cannot reach this catch under the entry constraint either. Its
  // entry insert is `createManyAndReturn` with `skipDuplicates: true`, a bare
  // `ON CONFLICT DO NOTHING` — no conflict target, so it covers
  // `CalendarEntry_teacher_slot_excl` as well as the unique key — and the
  // `Class` rows that follow are keyed on the entry ids that landed.
  let template: {
    created: Prisma.ClassTemplateGetPayload<{
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } };
    }>;
    generation: GenerationResult;
  };
  try {
    template = await prisma.$transaction(async (tx) => {
      // Nested create (issue 298): `ScheduleRule` holds the slot now, so the
      // template and its rule are born together in one statement — the
      // checked `data` shape Prisma requires for a nested relation write,
      // `teacherRoom` included, rather than the unchecked `teacherRoomId`
      // scalar this used before the split.
      const created = await tx.classTemplate.create({
        data: {
          scheduleRule: {
            create: {
              teacherId: session.teacherId,
              kind: 'regular',
              classType: body.classType,
              dayOfWeek: body.dayOfWeek,
              startTime: hhmmToTime(body.startTime),
              durationMinutes: body.durationMinutes,
            },
          },
          teacherRoom: { connect: { id: body.teacherRoomId } },
          description: body.description,
          roomCost: body.roomCost,
          minRate: body.minRate,
          targetRate: body.targetRate,
          minStudents: body.minStudents,
          maxStudents: body.maxStudents,
          cancelDeadline: body.cancelDeadline,
          autoCancelCheck: body.autoCancelCheck,
        },
        include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
      });
      const generation = await generateInstancesForTemplate(tx, created);
      return { created, generation };
    },
      // FOUR sequential statements on a 2GB VPS — the create, generation's two
      // reads (its date-scoped occupancy `findMany`, and the
      // `scheduleRuleId`-scoped week read #194 added), and its batched insert
      // — against Prisma's 5s default. Three until #194; the fourth is a
      // `findMany` riding `@@unique([scheduleRuleId, date])`, so it moves the
      // arithmetic without moving the conclusion. #327 split the insert in
      // two (entry, then child), which moves it again and no further: five
      // sequential statements, still nowhere near the bound this paragraph
      // sizes. An earlier draft of this
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
    // The template's own slot, either family: `ScheduleRule_teacher_slot_excl`
    // (issue 298) spans both, since `kind` is not part of its key. Only the
    // template create can raise it here — generation's `Class` insert is a
    // different table under a different constraint.
    if (isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')) {
      const heldBy = await ruleSlotHolder(prisma, {
        teacherId: session.teacherId,
        dayOfWeek: body.dayOfWeek,
        startMinutes: minutesSinceMidnight(hhmmToTime(body.startTime)),
        durationMinutes: body.durationMinutes,
      });
      log.warn(
        { err, teacherId: session.teacherId, heldBy },
        'recurring class create refused: that slot is taken',
      );
      const [message, code] = SLOT_TAKEN[heldBy];
      return respondError(message, 409, code);
    }
    // DEAD ARM. It matches a `YG001` from the entry-level cross-family
    // triggers, and #327 replaced those with
    // `CalendarEntry_teacher_slot_excl`; nothing in the schema raises `YG001`
    // now. `docs/lock-order.md` ("One teacher, one slot") carries that census
    // and the query that re-derives it. Kept rather than deleted because
    // removing it changes what this endpoint answers, which is a decision to
    // take deliberately.
    if (isCrossFamilySlotConflict(err)) {
      log.warn(
        { err, teacherId: session.teacherId },
        'recurring class create refused: the studio family holds that slot',
      );
      return respondError(
        'You already have a studio class on one of those dates at that time.',
        409,
        'CROSS_FAMILY_STUDIO_SLOT',
      );
    }
    throw err;
  }

  const { scheduleRule, ...bare } = template.created;
  const created = withSlot(bare, scheduleRule);

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
  // `blocked_by_overlap`, and the number is `countSkipReasons`' own
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
