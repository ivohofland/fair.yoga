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
import { isRestrictViolationOn } from '@/lib/api-errors';
import { isCheckViolationOn } from '@/lib/check-violation';
import { createClassTemplateSchema } from '@/lib/schemas';
import {
  withSlot,
  createClassTemplate,
  type CreateTemplateResult,
} from '@/services/class-template-lifecycle';
import type { RuleSlotHolder } from '@/lib/rule-slot-holder';
import { countSkipReasons } from '@/lib/generation';
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
  // `isActive: true` (`ScheduleRule.isActive`, `prisma/schema.prisma`) and
  // starts generating immediately,
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

  // The lock behavior for this create — what `setLockTimeout(tx)` bounds,
  // how many of `createClassTemplate`'s own transaction's statements can
  // wait on it, and what its 10s budget does and does not cover — is
  // documented beside that transaction in `class-template-lifecycle.ts`, not
  // here (issue 228).
  let result: CreateTemplateResult;
  try {
    result = await createClassTemplate(prisma, session.teacherId, body);
  } catch (e) {
    // The room archived between the pre-check above and the insert: the
    // service ASSERTS `roomArchived: false`, so the room mirror's foreign key
    // refuses the row (23503) without a re-read to race. Same 409 as the
    // pre-check — the probe is for the sentence, the constraint does the work.
    if (
      isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room') ||
      isRestrictViolationOn(e, ['ClassTemplate_teacherRoomId_roomArchived_fkey'])
    ) {
      log.warn(
        { teacherRoomId: body.teacherRoomId, teacherId: session.teacherId },
        'template create lost the room-archive race',
      );
      return respondError(
        'This room is archived. Unarchive it to add a recurring class here.',
        409,
        'ROOM_ARCHIVED',
      );
    }
    throw e;
  }

  if (!result.ok && result.reason === 'slot_conflict') {
    log.warn(
      { teacherId: session.teacherId, heldBy: result.heldBy },
      'recurring class create refused: that slot is taken',
    );
    const [message, code] = SLOT_TAKEN[result.heldBy];
    return respondError(message, 409, code);
  }
  if (!result.ok && result.reason === 'busy') {
    return respondError(
      'The system was busy and could not create this recurring class. Nothing was created. Wait a moment, then try again.',
      503,
      'TEMPLATE_BUSY',
    );
  }
  if (!result.ok) {
    // Exhaustiveness: a new CreateTemplateResult arm becomes a compile error
    // here rather than being answered as a success.
    const unhandled: never = result;
    return unhandled;
  }

  // Generation *succeeding* having created nothing is an ordinary outcome
  // since #196's slot pre-check: a teacher creating a second template on a
  // day and time they already occupy gets a live template whose every
  // candidate date is taken. That used to be impossible, so 201 with no
  // counts was a complete answer; it no longer is. The same counts the PATCH
  // `active` arm carries — `countSkipReasons` (`@/lib/generation`) is the one
  // place both reductions live, so a SEVENTH
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
      ...result.template,
      added: result.generation.created,
      // One field rather than a spread, matching the PATCH `active` arm. The
      // spread already carried a new count automatically; nesting means the
      // FORM that reads this payload does too, which the spread did not give.
      counts: countSkipReasons(result.generation.skipped),
    },
    201,
  );
});
