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

  // Annotated, not inferred: this is what routes the payload through the
  // pinned type, so a field added to the schema has to clear the allowlist
  // in class-template-lifecycle.ts before it can reach Prisma.
  const data: ClassTemplateUpdateData = parsed.data;

  const result = await updateClassTemplate(prisma, id, session.teacherId, data);

  if (result.ok) return respondOk({ ...result.template, sync: result.sync });

  // Narrowed one reason at a time so each maps to the response this route
  // returned before the service existed.
  if (result.reason === 'not_found') return respondError('Class template not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
  return respondError('Invalid teacher room', 400);
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
