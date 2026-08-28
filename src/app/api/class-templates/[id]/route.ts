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
import { log } from '@/lib/log';
import { updateClassTemplateSchema, templateStateQuerySchema } from '@/lib/schemas';
import {
  updateClassTemplate,
  type ClassTemplateUpdateData,
  type UpdateClassTemplateResult,
  type PauseTemplateResult,
  pauseOrResumeTemplate,
  archiveOrUnarchiveTemplate,
  withSlot,
} from '@/services/class-template-lifecycle';
import type { RuleSlotHolder } from '@/lib/rule-slot-holder';

/**
 * The one `slot_conflict` reason (`class-template-lifecycle.ts`) carries a
 * `heldBy` rather than a status, because the exclusion constraint behind it
 * cannot say which family it refused — see that file's docblock on the
 * reason. This route knows its own family, so it carries the map: PUT and the
 * PATCH archive branch below both key off it.
 *
 * `satisfies Record<RuleSlotHolder, …>` is not decoration — a fourth holder
 * state cannot be added without every route wording it, the same tether
 * `COUNT_KEYS`/`ROOM_SEARCH_SELECT` use elsewhere (CLAUDE.md, Comment
 * Discipline).
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

/**
 * The 409 both room-archive doors in this file answer with. One function
 * because the two differ only in the verb, and they were measured drifting
 * apart in wording once already.
 */
function roomArchivedResponse(verb: 'resume' | 'move') {
  return respondError(
    verb === 'resume'
      ? 'This room is archived. Unarchive it to resume this recurring class.'
      : 'This room is archived. Unarchive it to move this recurring class here.',
    409,
    'ROOM_ARCHIVED',
  );
}

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const template = await prisma.classTemplate.findUnique({
    where: { id },
    include: { teacherRoom: { include: { room: true } }, scheduleRule: true },
  });
  if (!template) return respondError('Class template not found', 404);

  if (template.scheduleRule.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  const { scheduleRule, ...bare } = template;
  return respondOk(withSlot(bare, scheduleRule));
});

/**
 * The 503 the PUT path answers, from two arms: the service's own `busy`, and
 * the room-state race that resolves the other way (the room was un-archived
 * after the mirror was read). One function for the same reason
 * `roomArchivedResponse` is one — they were measured drifting apart in wording
 * once already.
 *
 * PUT-scoped deliberately. The PATCH pause/resume branch answers a different
 * sentence ("could not update this recurring class"): this is the edit, that
 * is the toggle.
 */
function templateEditBusyResponse() {
  return respondError(
    'The system was busy and could not save your changes to this recurring class. Nothing was changed. Wait a moment, then try again.',
    503,
    'TEMPLATE_BUSY',
  );
}

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, updateClassTemplateSchema);
  if ('error' in parsed) return parsed.error;

  // Annotated for insurance, not for wiring: `parsed.data` already has this
  // type, so this cannot fail today. It would start earning its keep if
  // `ClassTemplateUpdateData` ever stops being a bare `z.infer` of the schema.
  // `tsconfig.json` includes `**/*.ts`, so `class-template-lifecycle.ts` — and
  // the pins in it — are type-checked project-wide regardless of whether this
  // file imports it; the import is for the type, not to trigger the checking.
  //
  // Left at `ClassTemplateUpdateData` rather than narrowed to match
  // `updateClassTemplate`'s actual parameter type — the allowlist
  // intersected with the forbidden-field exclusions. That narrowing holds
  // only because the schema declares none of the forbidden keys, which is
  // exactly what the pins in class-template-lifecycle.ts already enforce;
  // restating it here would mean importing a type that module doesn't export,
  // to duplicate a check that already has an owner.
  const data: ClassTemplateUpdateData = parsed.data;

  // Door 5 of the room archive lifecycle (issue 76), as a PRE-CHECK rather
  // than enforcement (issue 272). What actually refuses an ACTIVE template
  // moving onto an archived room is `ClassTemplate_live_needs_open_room` — and
  // the room mirror's foreign key when the read is stale — either of which the
  // catch below turns into this same 409. The probe exists so the common case
  // gets a sentence a teacher can act on instead of a raced 409.
  //
  // Only a LIVE template is refused: a PAUSED template may legitimately move
  // onto an archived room (issue 272 — the CHECK keys on `ruleLive`). The
  // ownership read is repeated here so an unowned room still answers
  // `invalid_room` and cannot be outranked by the archived check, matching the
  // service's own ordering.
  //
  // Gated on a CHANGE of room, not mere presence: `TemplateForm` posts the
  // whole form on every edit, so an unchanged `teacherRoomId` rides along with
  // a pure description change — and an active template whose own room is
  // archived (a pre-branch snapshot, spec section 10) would otherwise answer
  // this 409 about a move the teacher did not make.
  if (data.teacherRoomId !== undefined) {
    const moving = await prisma.classTemplate.findUnique({
      where: { id },
      select: {
        ruleLive: true,
        teacherRoomId: true,
        // OWNERSHIP OF THE TEMPLATE, not just of the target room below. This
        // probe reads another teacher's row by id, and answering 409 off it
        // would tell an unowned caller that the row exists and what state its
        // room is in — the refusal `updateClassTemplate` answers 403 for. The
        // probe is skipped rather than refused: the service is what produces
        // `forbidden`, and it stays the single place that decides.
        scheduleRule: { select: { teacherId: true } },
      },
    });
    if (
      moving &&
      moving.scheduleRule.teacherId === session.teacherId &&
      moving.teacherRoomId !== data.teacherRoomId
    ) {
      const targetRoom = await prisma.teacherRoom.findUnique({
        where: { id: data.teacherRoomId },
        select: { isArchived: true, teacherId: true },
      });
      if (!targetRoom || targetRoom.teacherId !== session.teacherId) {
        return respondError('Invalid teacher room', 400);
      }
      if (targetRoom.isArchived && moving.ruleLive) {
        return roomArchivedResponse('move');
      }
    }
  }

  let result: UpdateClassTemplateResult;
  try {
    result = await updateClassTemplate(prisma, id, session.teacherId, data);
  } catch (e) {
    if (
      isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room') ||
      isRestrictViolationOn(e, ['ClassTemplate_teacherRoomId_roomArchived_fkey'])
    ) {
      // WHICH WAY THE MIRROR DISAGREED, because the constraint name does not
      // say. `updateClassTemplate` writes `roomArchived` from a room read taken
      // OUTSIDE its transaction, so the foreign key fires whichever direction
      // that read went stale in — the room was archived after it, or
      // un-archived after it. Only the first is "this room is archived", and
      // answering it for the second tells a teacher to unarchive a room that
      // is already open, with no action that satisfies the message and no hint
      // that a retry would simply work.
      //
      // The re-read is not raceable in a way that matters: it decides only
      // which true sentence to print, and both outcomes refuse the write.
      const room =
        data.teacherRoomId === undefined
          ? null
          : await prisma.teacherRoom.findUnique({
              where: { id: data.teacherRoomId },
              select: { isArchived: true },
            });
      if (room === null || room.isArchived) {
        log.warn({ err: e, templateId: id }, 'template move lost the room-archive race');
        return roomArchivedResponse('move');
      }
      log.warn(
        { err: e, templateId: id, teacherRoomId: data.teacherRoomId },
        'template move lost a room-state race the other way; the room is open again',
      );
      return templateEditBusyResponse();
    }
    throw e;
  }

  // `firstEffective` and `generationState` ride alongside the template row
  // rather than replacing it: `TemplateForm` reads nothing else from this
  // body, and the integration suite's "the success body is the bare template"
  // case pins that no propagation REPORT came back — two PREDICTION fields are
  // the opposite of that, and are what let the form say when the edit takes
  // hold (#194). `firstEffective` is serialized as an ISO string by
  // `respondOk`'s JSON encoding and the form converts it back;
  // `generationState` is already a string.
  //
  // `generationState` is not redundant with the `isActive`/`isArchived`
  // columns the spread carries. Those are the rule's inputs; this is the
  // service's own answer to it, taken from the row the write produced. The
  // form must not re-derive the sweep's eligibility gate — see
  // `templateGenerationState` (`@/lib/template-selection`).
  if (result.ok) {
    return respondOk({
      ...result.template,
      firstEffective: result.firstEffective,
      generationState: result.generationState,
    });
  }

  // Narrowed one reason at a time so each maps to the response this route
  // returned before the service existed.
  if (result.reason === 'not_found') return respondError('Class template not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
  if (result.reason === 'invalid_room') return respondError('Invalid teacher room', 400);
  // The template's own dayOfWeek/startTime moved into a slot another of this
  // teacher's live rules already holds — same family or the other (#196/#296).
  if (result.reason === 'slot_conflict') {
    const [message, code] = SLOT_TAKEN[result.heldBy];
    return respondError(message, 409, code);
  }
  // This transaction lost a contention race (#100/#209) on the `ClassTemplate`
  // row itself — a generation claim, an archive, or a pause/resume holding it.
  // It can no longer be lost on a `Class` row: #194 deleted the sync, so this
  // transaction takes no `Class` locks at all and the edit path has left the
  // deadlock graph. Distinct copy from the PATCH pause/resume branch below
  // ("could not update this recurring class"): this is the edit, that is the
  // toggle.
  if (result.reason === 'busy') {
    return templateEditBusyResponse();
  }

  // Exhaustiveness: a new UpdateClassTemplateResult variant becomes a compile
  // error here rather than being silently answered as "Invalid teacher room".
  const unhandled: never = result;
  return unhandled;
});


export const PATCH = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = templateStateQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return respondError('A state of active, paused, archived or unarchived is required', 400);
  }
  const { state } = parsed.data;

  if (state === 'archived' || state === 'unarchived') {
    const result = await archiveOrUnarchiveTemplate(prisma, id, session.teacherId, state);

    // Only the archiving direction reports counts. The other two arms deleted
    // nothing, and answering them with zeros would put two numbers on the wire
    // that mean "not applicable" while reading like "archived, nothing matched".
    //
    // A `switch` rather than the two-way ternary this replaces, for the reason
    // the pause/resume arm below already records against its own former
    // ternary: the `else` limb stays correct for the two actions it was
    // written for, so a NEW success action compiles clean, falls into it, and
    // is answered 200 with its own fields silently dropped. The `never` guard
    // closing the reason chain below cannot catch that — it only sees the
    // `ok: false` half of this union. This closes the `ok: true` half.
    if (result.ok) {
      switch (result.action) {
        case 'archived':
          return respondOk({
            ...result.template,
            action: result.action,
            deleted: result.deleted,
            remaining: result.remaining,
          });
        case 'unarchived':
        case 'unchanged':
          return respondOk({ ...result.template, action: result.action });
        default: {
          const unhandled: never = result;
          return unhandled;
        }
      }
    }

    if (result.reason === 'not_found') return respondError('Class template not found', 404);
    if (result.reason === 'forbidden') return respondError('Access denied', 403);
    // Only reachable un-archiving: `isArchived` flips false in the same CAS
    // that re-enters `ScheduleRule_teacher_slot_excl`'s scope (#196/#296), and
    // another live rule — same family or the other — can already hold that
    // slot.
    if (result.reason === 'slot_conflict') {
      const [message, code] = SLOT_TAKEN[result.heldBy];
      return respondError(message, 409, code);
    }
    if (result.reason === 'busy') {
      return respondError(
        `The system was busy and could not ${state === 'archived' ? 'archive' : 'unarchive'} this recurring class. Nothing was changed. Wait a moment, then try again.`,
        503,
        'TEMPLATE_BUSY',
      );
    }

    // Exhaustiveness: a new ArchiveTemplateResult reason becomes a compile
    // error here rather than being silently answered with the wrong status.
    const unhandled: never = result;
    return unhandled;
  }

  let result: PauseTemplateResult;
  if (state === 'active') {
    // Door 3 of the room archive lifecycle (issue 76), as a PRE-CHECK rather
    // than enforcement (issue 272). What actually refuses a resume onto an
    // archived room is `ClassTemplate_live_needs_open_room`; this read exists
    // so the common case gets a sentence a teacher can act on instead of a
    // raced 409. The mirror is read rather than a join to `TeacherRoom`: it is
    // the same value by construction and needs no join.
    //
    // THE PROBE ANSWERS ONLY FOR A ROW THIS TEACHER OWNS AND ONLY WHERE IT IS
    // THE OPERATIVE REFUSAL. Two conditions beyond `roomArchived`, and each
    // was a defect while it was missing:
    //
    //   - `teacherId` — this reads another teacher's row by id. Answering 409
    //     off it tells an unowned caller the row exists and what state its
    //     room is in, where `pauseOrResumeTemplate` answers 403. That service
    //     checks ownership before it reaches door 3; hoisting the door up here
    //     without the check left the ordering behind.
    //   - `isArchived` — an ARCHIVED template on an archived room is refused
    //     by `archiveOrUnarchiveRule`'s own `archived` branch, whose message
    //     ("Unarchive the template before activating it") is the one the
    //     teacher can act on. Un-archiving the room accomplishes nothing for
    //     it. The constraint cannot fire on that path either: the rule archive
    //     forces `isActive: false` in both directions, so `live` stays false.
    //
    // Skipped rather than refused in both cases: the service is what produces
    // `forbidden` and `archived`, and stays the single place that decides.
    const resume = await prisma.classTemplate.findUnique({
      where: { id },
      select: {
        roomArchived: true,
        scheduleRule: { select: { teacherId: true, isArchived: true } },
      },
    });
    if (
      resume?.roomArchived &&
      resume.scheduleRule.teacherId === session.teacherId &&
      !resume.scheduleRule.isArchived
    ) {
      return roomArchivedResponse('resume');
    }
  }

  try {
    result = await pauseOrResumeTemplate(prisma, id, session.teacherId, state);
  } catch (e) {
    if (isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room')) {
      log.warn({ err: e, templateId: id }, 'template resume lost the room-archive race');
      return roomArchivedResponse('resume');
    }
    throw e;
  }

  if (result.ok) {
    // A `switch` rather than the two-way ternary this replaces. `active` now
    // carries fields of its own (#164/#192/#196), and the ternary's `else`
    // limb would have dropped them silently while staying correct for
    // `unchanged` — the same accidental-exhaustiveness failure
    // `pauseOrResumeStudioTemplate` records for its own switch, where a new
    // arm compiled clean and was answered with the wrong action.
    switch (result.action) {
      case 'paused':
        return respondOk({
          ...result.template,
          action: result.action,
          lastScheduled: result.lastScheduled,
        });
      case 'active':
        return respondOk({
          ...result.template,
          action: result.action,
          templateKind: 'class' as const,
          scheduled: result.scheduled,
          added: result.added,
          // Passed whole, not mapped member by member (#296). This hop is where
          // `alreadyThisWeek` used to stop: without it the resume after a day
          // edit still reported "4 classes on your schedule. Nothing needed
          // adding." about four classes on the weekday the teacher had just
          // stopped using (#194). A count that travels as part of an object
          // cannot be dropped here by omission — only by someone rebuilding the
          // object, which is the edit this shape exists to make unnecessary.
          counts: result.counts,
        });
      case 'unchanged':
        return respondOk({ ...result.template, action: result.action });
      default: {
        const unhandled: never = result;
        return unhandled;
      }
    }
  }

  if (result.reason === 'not_found') return respondError('Class template not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  // An archived template has no live half to toggle to — activating one
  // would instantly materialize bookable classes for something the teacher
  // shelved.
  if (result.reason === 'archived') {
    return respondError('Unarchive the template before activating it', 409);
  }
  if (result.reason === 'busy') {
    return respondError(
      'The system was busy and could not update this recurring class. Nothing was changed. Wait a moment, then try again.',
      503,
      'TEMPLATE_BUSY',
    );
  }

  // Exhaustiveness: a new PauseTemplateResult reason becomes a compile error
  // here rather than being silently answered with the wrong status.
  const unhandled: never = result;
  return unhandled;
});
