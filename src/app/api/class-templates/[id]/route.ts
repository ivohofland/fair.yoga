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
import { updateClassTemplateSchema } from '@/lib/schemas';
import { generateInstancesForTemplate } from '@/services/class-generator';
import { updateClassTemplate, type ClassTemplateUpdateData } from '@/services/class-template-lifecycle';

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

  const template = await prisma.classTemplate.findUnique({ where: { id } });
  if (!template) return respondError('Class template not found', 404);

  if (template.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'archive') {
    const updated = await prisma.classTemplate.update({
      where: { id },
      data: { isArchived: !template.isArchived, isActive: false },
    });
    return respondOk(updated);
  }

  // Default: toggle active/paused. An archived template has no live
  // half to toggle to — activating one would instantly materialize
  // bookable classes for something the teacher shelved.
  if (template.isArchived) {
    return respondError('Unarchive the template before activating it', 409);
  }

  // Atomic: a generation failure rolls the toggle back rather than leaving
  // the template active with a stale window. Failure propagates (500).
  const updated = await prisma.$transaction(async (tx) => {
    const t = await tx.classTemplate.update({
      where: { id },
      data: { isActive: !template.isActive },
      include: { teacher: { select: { defaultTimezone: true } } },
    });
    if (t.isActive) await generateInstancesForTemplate(tx, t);
    return t;
  });

  const { teacher, ...result } = updated;
  void teacher;
  return respondOk(result);
});
