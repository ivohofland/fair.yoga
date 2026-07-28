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

  const updated = await prisma.studioClassTemplate.update({
    where: { id },
    data: parsed.data,
  });

  return respondOk(updated);
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

    // Exhaustiveness: a new ArchiveStudioTemplateResult reason becomes a
    // compile error here rather than being silently answered with the wrong
    // status. Narrowed on `result.reason`, matching the class family's
    // route — the `ok: false` half is one object with a union-typed `reason`
    // rather than one member per reason.
    const unhandled: never = result.reason;
    return unhandled;
  }

  // active/paused. An archived template has no live half to toggle to —
  // activating one would put it back in the generator's sweep for something
  // the teacher shelved. Mirrors the same guard on `class-templates/[id]`;
  // this route was missing it (#53).
  const result = await pauseOrResumeStudioTemplate(prisma, id, session.teacherId, state);

  if (result.ok) {
    return result.action === 'paused'
      ? respondOk({ ...result.template, action: result.action, lastScheduled: result.lastScheduled })
      : respondOk({ ...result.template, action: result.action });
  }

  if (result.reason === 'not_found') return respondError('Studio class template not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  if (result.reason === 'archived') {
    return respondError('Unarchive the template before activating it', 409);
  }

  // Exhaustiveness: a new PauseStudioTemplateResult reason becomes a compile
  // error here rather than being silently answered with the wrong status.
  const unhandled: never = result.reason;
  return unhandled;
});
