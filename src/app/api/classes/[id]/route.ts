import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { updateClassSchema } from '@/lib/schemas';

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

const ECONOMIC_FIELDS = [
  'roomCost',
  'minRate',
  'targetRate',
  'minStudents',
  'maxStudents',
] as const;

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

  const parsed = await parseBody(request, updateClassSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // If settings are locked, reject economic fields with an error
  if (cls.settingsLocked) {
    const sentEconomicFields = ECONOMIC_FIELDS.filter(
      (f) => body[f] !== undefined,
    );
    if (sentEconomicFields.length > 0) {
      return respondError(
        `Cannot update economic fields when settings are locked: ${sentEconomicFields.join(', ')}`,
        409,
      );
    }
  }

  if (Object.keys(body).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const updated = await prisma.class.update({
    where: { id },
    data: body,
  });

  return respondOk(updated);
}
