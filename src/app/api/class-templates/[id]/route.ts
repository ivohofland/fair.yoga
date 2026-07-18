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
import { syncTemplateInstances } from '@/services/template-sync';

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

  if (template.teacherId !== session.userId) {
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

  const template = await prisma.classTemplate.findUnique({ where: { id } });
  if (!template) return respondError('Class template not found', 404);

  if (template.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  const parsed = await parseBody(request, updateClassTemplateSchema);
  if ('error' in parsed) return parsed.error;
  const updateData = parsed.data;

  if (Object.keys(updateData).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  if (updateData.teacherRoomId) {
    const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id: updateData.teacherRoomId } });
    if (!teacherRoom || teacherRoom.teacherId !== session.userId) {
      return respondError('Invalid teacher room', 400);
    }
  }

  const updated = await prisma.classTemplate.update({
    where: { id },
    data: updateData,
  });

  // Propagate to still-mutable generated instances; anything with
  // bookings keeps its settings (see template-sync service).
  const sync = await syncTemplateInstances(prisma, id);

  return respondOk({ ...updated, sync });
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

  if (template.teacherId !== session.userId) {
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

  // Default: toggle active/paused
  const updated = await prisma.classTemplate.update({
    where: { id },
    data: { isActive: !template.isActive },
  });

  return respondOk(updated);
});
