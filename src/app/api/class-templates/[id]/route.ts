import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';

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

interface UpdateClassTemplateBody {
  teacherRoomId?: string;
  classType?: string;
  description?: string;
  dayOfWeek?: number;
  startTime?: string;
  durationMinutes?: number;
  roomCost?: number;
  minRate?: number;
  targetRate?: number;
  minStudents?: number;
  maxStudents?: number;
  cancelDeadline?: 'HOURS_48' | 'HOURS_24' | 'HOURS_12' | 'HOURS_6';
  autoCancelCheck?: 'HOURS_4' | 'HOURS_2' | 'HOURS_1';
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

  const body = await parseBody<UpdateClassTemplateBody>(request);
  if (!body) return respondError('Invalid request body', 400);

  const updated = await prisma.classTemplate.update({
    where: { id },
    data: body,
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
