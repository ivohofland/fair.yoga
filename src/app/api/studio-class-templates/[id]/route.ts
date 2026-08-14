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
import { updateStudioClassTemplateSchema, templateStateQuerySchema } from '@/lib/schemas';
import {
  pauseOrResumeStudioTemplate,
  archiveOrUnarchiveStudioTemplate,
} from '@/services/studio-class-template-lifecycle';
import { isUniqueConflictOn } from '@/lib/unique-conflict';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const template = await prisma.studioClassTemplate.findUnique({ where: { id } });
  if (!template) return respondError('Studio class template not found', 404);
  if (template.teacherId !== session.teacherId) return respondError('Access denied', 403);

  return respondOk(template);
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const template = await prisma.studioClassTemplate.findUnique({ where: { id } });
  if (!template) return respondError('Studio class template not found', 404);
  if (template.teacherId !== session.teacherId) return respondError('Access denied', 403);

  const parsed = await parseBody(request, updateStudioClassTemplateSchema);
  if ('error' in parsed) return parsed.error;

  if (Object.keys(parsed.data).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  // `StudioClassTemplate_teacher_slot_unique` is (teacherId, dayOfWeek,
  // startTime) WHERE isArchived = false (#196). This route never touches
  // `isArchived` (PATCH owns that), but `dayOfWeek`/`startTime` are both on
  // `updateStudioClassTemplateSchema`, so a plain edit into a slot another of
  // this teacher's live templates already holds collides here.
  try {
    const updated = await prisma.studioClassTemplate.update({
      where: { id },
      data: parsed.data,
    });
    return respondOk(updated);
  } catch (err) {
    if (isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime'])) {
      return respondError(
        'You already have a recurring studio class on that day at that time.',
        409,
        'DUPLICATE_STUDIO_TEMPLATE_SLOT',
      );
    }
    throw err;
  }
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
    const result = await archiveOrUnarchiveStudioTemplate(prisma, id, session.teacherId, state);

    // Only the archiving direction reports counts — same reasoning as the
    // class family's route.
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

    if (result.reason === 'not_found') return respondError('Studio class template not found', 404);
    if (result.reason === 'forbidden') return respondError('Access denied', 403);
    // Only reachable un-archiving: `isArchived` flips false in the same CAS
    // that re-enters `StudioClassTemplate_teacher_slot_unique`'s partial
    // scope (#196), and another live template can already hold that slot.
    if (result.reason === 'slot_conflict') {
      return respondError(
        'You already have a recurring studio class on that day at that time.',
        409,
        'DUPLICATE_STUDIO_TEMPLATE_SLOT',
      );
    }
    if (result.reason === 'busy') {
      return respondError(
        `The system was busy and could not ${state === 'archived' ? 'archive' : 'unarchive'} this recurring studio class. Nothing was changed. Wait a moment, then try again.`,
        503,
        'STUDIO_TEMPLATE_BUSY',
      );
    }

    // Exhaustiveness: a new ArchiveStudioTemplateResult reason becomes a
    // compile error here rather than being silently answered with the wrong
    // status.
    const unhandled: never = result;
    return unhandled;
  }

  const result = await pauseOrResumeStudioTemplate(prisma, id, session.teacherId, state);

  if (result.ok) {
    // A `switch` rather than the two-way ternary this replaces. `active` now
    // carries fields of its own (#119), and the ternary's `else` limb would
    // have dropped them silently while staying correct for `unchanged` — the
    // same accidental-exhaustiveness failure `pauseOrResumeStudioTemplate`
    // records for its own switch, where a new arm compiled clean and was
    // answered with the wrong action.
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
          templateKind: 'studio' as const,
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

  if (result.reason === 'not_found') return respondError('Studio class template not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  // An archived template has no live half to toggle to — activating one
  // would put it back in the generator's sweep for something the teacher
  // shelved. Mirrors the same guard on `class-templates/[id]`; this route was
  // missing it (#53). Only `state === 'active'` reaches this: `paused` on an
  // archived template is already true, so it is a 200 `unchanged` before this
  // reason is ever produced — pinned by
  // `studio-class-template-lifecycle.test.ts`.
  if (result.reason === 'archived') {
    return respondError('Unarchive the template before activating it', 409);
  }
  if (result.reason === 'busy') {
    return respondError(
      'The system was busy and could not update this studio class. Nothing was changed. Wait a moment, then try again.',
      503,
      'STUDIO_TEMPLATE_BUSY',
    );
  }

  // Exhaustiveness: a new PauseStudioTemplateResult reason becomes a compile
  // error here rather than being silently answered with the wrong status.
  const unhandled: never = result;
  return unhandled;
});
