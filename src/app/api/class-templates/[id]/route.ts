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
  // Left at `ClassTemplateUpdateData` rather than widened to match
  // `updateClassTemplate`'s actual (narrower) parameter type — the allowlist
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
    if (result.ok) {
      return result.action === 'archived'
        ? respondOk({
            ...result.template,
            action: result.action,
            deleted: result.deleted,
            remaining: result.remaining,
          })
        : respondOk({ ...result.template, action: result.action });
    }

    if (result.reason === 'not_found') return respondError('Class template not found', 404);
    if (result.reason === 'forbidden') return respondError('Access denied', 403);

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

  // Exhaustiveness: a new PauseTemplateResult reason becomes a compile error
  // here rather than being silently answered with the wrong status.
  const unhandled: never = result;
  return unhandled;
});
