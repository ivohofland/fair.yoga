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
  updateStudioClassTemplate,
  type StudioClassTemplateUpdateData,
  pauseOrResumeStudioTemplate,
  archiveOrUnarchiveStudioTemplate,
} from '@/services/studio-class-template-lifecycle';

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

  // Parsed before the exists/ownership checks, because the service owns those
  // and needs typed data to be called at all. So a malformed body against
  // another teacher's template is now a 400 where it used to be a 403 — the
  // same reordering `class-templates/[id]` accepted for the same reason, and
  // not an information leak: the cheap probe is `{}`, which parses fine and
  // still yields 403 (pinned by the ownership case in `studio-api.test.ts`).
  // This ordering tells a prober strictly less, not more.
  const parsed = await parseBody(request, updateStudioClassTemplateSchema);
  if ('error' in parsed) return parsed.error;

  // Annotated for insurance, not for wiring: `parsed.data` already has this
  // type. It would start earning its keep if `StudioClassTemplateUpdateData`
  // ever stops being a bare `z.infer` of the schema. Left at that type rather
  // than widened to `updateStudioClassTemplate`'s actual, narrower parameter
  // type — the allowlist intersected with the forbidden-field exclusions. That
  // narrowing holds only because the schema declares none of the forbidden
  // keys, which is exactly what the pins in `studio-class-template-lifecycle.ts`
  // already enforce; restating it here would duplicate a check that has an owner.
  const data: StudioClassTemplateUpdateData = parsed.data;

  const result = await updateStudioClassTemplate(prisma, id, session.teacherId, data);

  if (result.ok) return respondOk(result.template);

  // Narrowed one reason at a time so each maps to the response this route
  // returned before the service existed.
  if (result.reason === 'not_found') return respondError('Studio class template not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
  // `StudioClassTemplate_teacher_slot_unique` is (teacherId, dayOfWeek,
  // startTime) WHERE isArchived = false (#196). This route never touches
  // `isArchived` — `PATCH` owns that, and the forbidden list makes it a compile
  // error here — but `dayOfWeek`/`startTime` are both teacher-editable, so a
  // plain edit into a slot another of this teacher's live templates already
  // holds collides.
  if (result.reason === 'slot_conflict') {
    return respondError(
      'You already have a recurring studio class on that day at that time.',
      409,
      'DUPLICATE_STUDIO_TEMPLATE_SLOT',
    );
  }
  if (result.reason === 'busy') {
    return respondError(
      'The system was busy and could not edit this recurring studio class. Nothing was changed. Wait a moment, then try again.',
      503,
      'STUDIO_TEMPLATE_BUSY',
    );
  }

  // Exhaustiveness: a new UpdateStudioClassTemplateResult reason becomes a
  // compile error here rather than being silently answered with the wrong
  // status. The success half gets no `switch`, unlike PATCH's below: that
  // result carries an `action` discriminant with three arms, this one is a
  // single variant with nothing to switch on, and inventing a discriminant to
  // match the shape would be ceremony.
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
    const result = await archiveOrUnarchiveStudioTemplate(prisma, id, session.teacherId, state);

    // Only the archiving direction reports counts — same reasoning as the
    // class family's route.
    //
    // A `switch` rather than the two-way ternary this replaces — see the class
    // family's twin for why the ternary's `else` limb makes a new success
    // action a silent 200 rather than a compile error, and why the `never`
    // guard closing the reason chain below cannot catch it.
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
      'The system was busy and could not update this recurring studio class. Nothing was changed. Wait a moment, then try again.',
      503,
      'STUDIO_TEMPLATE_BUSY',
    );
  }

  // Exhaustiveness: a new PauseStudioTemplateResult reason becomes a compile
  // error here rather than being silently answered with the wrong status.
  const unhandled: never = result;
  return unhandled;
});
