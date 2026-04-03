import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { ECONOMIC_FIELDS, type EconomicField } from '@/services/class-lifecycle';

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

  // If settings are locked, reject changes to economic fields
  if (cls.settingsLocked) {
    const attemptedEconomicFields = Object.keys(body).filter((key) =>
      (ECONOMIC_FIELDS as readonly string[]).includes(key),
    ) as EconomicField[];

    if (attemptedEconomicFields.length > 0) {
      return respondError(
        `Cannot modify locked economic fields: ${attemptedEconomicFields.join(', ')}`,
        409,
      );
    }
  }

  // Prevent changing teacherId or id
  const { teacherId: _t, id: _i, ...updateData } = body;

  const updated = await prisma.class.update({
    where: { id },
    data: updateData as Record<string, unknown>,
  });

  return respondOk(updated);
}
