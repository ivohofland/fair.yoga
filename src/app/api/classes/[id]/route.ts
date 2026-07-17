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

  const sentEconomicFields = ECONOMIC_FIELDS.filter(
    (f) => body[f] !== undefined,
  );

  // Friendly early rejection when we already know the lock is set
  if (cls.settingsLocked && sentEconomicFields.length > 0) {
    return respondError(
      `Cannot update economic fields when settings are locked: ${sentEconomicFields.join(', ')}`,
      409,
    );
  }

  if (Object.keys(body).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  // Enforce the lock in the update itself: a first registration landing
  // between our read and this write must still block economic edits.
  const result = await prisma.class.updateMany({
    where: sentEconomicFields.length > 0 ? { id, settingsLocked: false } : { id },
    data: body,
  });
  if (result.count === 0) {
    return respondError(
      `Cannot update economic fields when settings are locked: ${sentEconomicFields.join(', ')}`,
      409,
    );
  }

  const updated = await prisma.class.findUniqueOrThrow({ where: { id } });
  return respondOk(updated);
}
