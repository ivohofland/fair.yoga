import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  pick,
} from '@/lib/api-utils';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: {
      _count: { select: { registrations: true } },
    },
  });

  if (!cls) return respondError('Class not found', 404);
  if (cls.teacherId !== session.userId) return respondError('Not your class', 403);

  return respondOk(cls);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) return respondError('Class not found', 404);
  if (cls.teacherId !== session.userId) return respondError('Not your class', 403);

  const body = await parseBody<Record<string, unknown>>(request);
  if (!body) return respondError('Invalid request body', 400);

  // Allowlist: only these fields can be updated
  const ALWAYS_ALLOWED = [
    'classType',
    'description',
    'date',
    'startTime',
    'durationMinutes',
  ] as const;

  const ECONOMIC_ALLOWED = [
    'roomCost',
    'minRate',
    'targetRate',
    'minStudents',
    'maxStudents',
  ] as const;

  const allowedFields = pick(body, ALWAYS_ALLOWED);

  // Only include economic fields if settings are NOT locked
  if (!cls.settingsLocked) {
    Object.assign(allowedFields, pick(body, ECONOMIC_ALLOWED));
  }

  if (Object.keys(allowedFields).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const updated = await prisma.class.update({
    where: { id },
    data: allowedFields,
  });

  return respondOk(updated);
}
