import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { updateStudioClassSchema } from '@/lib/schemas';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    include: { template: true },
  });
  if (!studioClass) return respondError('Studio class not found', 404);
  if (studioClass.teacherId !== session.userId) return respondError('Access denied', 403);

  return respondOk(studioClass);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClass = await prisma.studioClass.findUnique({ where: { id } });
  if (!studioClass) return respondError('Studio class not found', 404);
  if (studioClass.teacherId !== session.userId) return respondError('Access denied', 403);

  const parsed = await parseBody(request, updateStudioClassSchema);
  if ('error' in parsed) return parsed.error;

  if (Object.keys(parsed.data).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const updated = await prisma.studioClass.update({
    where: { id },
    data: parsed.data,
  });

  return respondOk(updated);
}
