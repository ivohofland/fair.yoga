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
import { updateClassTemplateSchema, templateStateQuerySchema } from '@/lib/schemas';
import {
  updateClassTemplate,
  type ClassTemplateUpdateData,
  pauseOrResumeTemplate,
  archiveOrUnarchiveTemplate,
} from '@/services/class-template-lifecycle';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const template = await prisma.classTemplate.findUnique({
    where: { id },
    include: { teacherRoom: { include: { room: true } } },
  });
  if (!template) return respondError('Class template not found', 404);

  if (template.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  return respondOk(template);
});

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

  const result = await updateClassTemplate(prisma, id, session.teacherId, data);

  if (result.ok) return respondOk({ ...result.template, sync: result.sync });

  // Narrowed one reason at a time so each maps to the response this route
  // returned before the service existed.
  if (result.reason === 'not_found') return respondError('Class template not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
  if (result.reason === 'invalid_room') return respondError('Invalid teacher room', 400);
  // Door 5 of the room archive lifecycle (issue 76, fix round 2): moving an
  // active template onto an archived room. Symmetric with door 3's
  // `room_archived` branch on the PATCH handler below — same code, same
  // register, different verb.
  if (result.reason === 'room_archived') {
    return respondError(
      'This room is archived. Unarchive it to move this recurring class here.',
      409,
      'ROOM_ARCHIVED',
    );
  }
  // The template's own dayOfWeek/startTime moved into a slot another of this
  // teacher's live templates already holds (#196).
  if (result.reason === 'slot_conflict') {
    return respondError(
      'You already have a recurring class on that day at that time.',
      409,
      'DUPLICATE_TEMPLATE_SLOT',
    );
  }
  // The startTime change would propagate to a still-mutable generated
  // instance and land it on a slot a different class already occupies
  // (#196). `updateClassTemplate` now runs the write and the sync in one
  // transaction (#83, #209): this collision rolls the whole thing back, the
  // template's own `startTime` included, so the message can no longer say
  // the template moved. Still names the remedy, not just the state — "you
  // already have a class at that time" alone leaves the teacher with no next
  // step.
  //
  // A distinct code from the create/reschedule paths' `DUPLICATE_CLASS_SLOT`
  // and from `slot_conflict` above: the cause still differs — this is a
  // generated instance colliding with an unrelated class, not the template's
  // own slot — even though all three now decline the write the same way,
  // with nothing changed.
  if (result.reason === 'sync_conflict') {
    return respondError(
      'Your scheduled classes could not be moved — you already have a class at that time. Nothing was changed. Move or cancel that class, then edit this recurring class again.',
      409,
      'TEMPLATE_SYNC_SLOT_CONFLICT',
    );
  }
  // This transaction lost a contention race (#100/#209) — either a
  // generation claim, archive or pause/resume holding the template row, or
  // an ordinary booking holding one of this template's future classes, since
  // the edit's transaction now takes those too via `syncTemplateInstances`'s
  // ordered pre-lock. The copy names neither, which is correct: the service
  // cannot tell them apart and the teacher's next step is the same either
  // way. Distinct copy from the PATCH pause/resume branch below ("could not
  // update this recurring class"): this is the edit, that is the toggle.
  if (result.reason === 'busy') {
    return respondError(
      'The system was busy and could not save your changes to this recurring class. Nothing was changed. Wait a moment, then try again.',
      503,
      'TEMPLATE_BUSY',
    );
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
    // that re-enters `ClassTemplate_teacher_slot_unique`'s partial scope
    // (#196), and another live template can already hold that slot.
    if (result.reason === 'slot_conflict') {
      return respondError(
        'You already have a recurring class on that day at that time.',
        409,
        'DUPLICATE_TEMPLATE_SLOT',
      );
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

  const result = await pauseOrResumeTemplate(prisma, id, session.teacherId, state);

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
          blockedByCancelled: result.blockedByCancelled,
          slotTaken: result.slotTaken,
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
  // Door 3 of the room archive lifecycle (issue 76): the template's own room
  // has been archived. Symmetric with the `archived` branch above — a paused
  // template may sit on an archived room, but resuming it is refused.
  if (result.reason === 'room_archived') {
    return respondError(
      'This room is archived. Unarchive it to resume this recurring class.',
      409,
      'ROOM_ARCHIVED',
    );
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
