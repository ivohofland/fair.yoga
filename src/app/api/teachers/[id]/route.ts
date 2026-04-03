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
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  if (session.userId !== id) {
    return respondError('Access denied', 403);
  }

  const teacher = await prisma.teacher.findUnique({ where: { id } });
  if (!teacher) return respondError('Teacher not found', 404);

  return respondOk(teacher);
}

const TEACHER_ALLOWED_FIELDS = [
  'firstName',
  'lastName',
  'photoUrl',
  'bio',
  'pageSlug',
  'defaultCurrency',
  'defaultTimezone',
  'defaultReminder',
  'bankIban',
  'bankAccountName',
] as const;

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  if (session.userId !== id) {
    return respondError('Access denied', 403);
  }

  const body = await parseBody<Record<string, unknown>>(request);
  if (!body) return respondError('Invalid request body', 400);

  const updateData = pick(body, TEACHER_ALLOWED_FIELDS);

  // Check for pageSlug conflicts
  if (typeof updateData.pageSlug === 'string') {
    const existing = await prisma.teacher.findUnique({
      where: { pageSlug: updateData.pageSlug as string },
    });
    if (existing && existing.id !== id) {
      return respondError('Page slug already in use', 409, 'SLUG_TAKEN');
    }
  }

  if (Object.keys(updateData).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const teacher = await prisma.teacher.update({
    where: { id },
    data: updateData,
  });

  return respondOk(teacher);
}
