import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { updateClassTemplateSchema } from '@/lib/schemas';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const template = await prisma.classTemplate.findUnique({ where: { id } });
  if (!template) return respondError('Class template not found', 404);

  if (template.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  return respondOk(template);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const updated = await prisma.classTemplate.update({
    where: { id },
    data: updateData,
  });

  return respondOk(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const template = await prisma.classTemplate.findUnique({ where: { id } });
  if (!template) return respondError('Class template not found', 404);

  if (template.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  // Soft delete — set isActive to false
  const updated = await prisma.classTemplate.update({
    where: { id },
    data: { isActive: false },
  });

  return respondOk(updated);
}
