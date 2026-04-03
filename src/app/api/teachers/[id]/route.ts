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

  if (session.userId !== id) {
    return respondError('Access denied', 403);
  }

  const teacher = await prisma.teacher.findUnique({ where: { id } });
  if (!teacher) return respondError('Teacher not found', 404);

  return respondOk(teacher);
}

interface UpdateTeacherBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  bio?: string;
  pageSlug?: string;
  photoUrl?: string;
  defaultCurrency?: string;
  defaultTimezone?: string;
  defaultReminder?: 'morning_of' | 'evening_before' | 'one_hour_before';
  bankIban?: string;
  bankAccountName?: string;
}

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

  const body = await parseBody<UpdateTeacherBody>(request);
  if (!body) return respondError('Invalid request body', 400);

  // Check for email conflicts
  if (body.email) {
    const existing = await prisma.teacher.findUnique({
      where: { email: body.email },
    });
    if (existing && existing.id !== id) {
      return respondError('Email already in use', 409, 'EMAIL_TAKEN');
    }
  }

  // Check for pageSlug conflicts
  if (body.pageSlug) {
    const existing = await prisma.teacher.findUnique({
      where: { pageSlug: body.pageSlug },
    });
    if (existing && existing.id !== id) {
      return respondError('Page slug already in use', 409, 'SLUG_TAKEN');
    }
  }

  const teacher = await prisma.teacher.update({
    where: { id },
    data: body,
  });

  return respondOk(teacher);
}
