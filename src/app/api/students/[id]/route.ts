import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) return respondError('Student not found', 404);

  // Student accessing own profile — return full data
  if (session.userType === 'student') {
    if (session.userId !== id) {
      return respondError('Access denied', 403);
    }
    return respondOk(student);
  }

  // Teacher accessing student profile — filter by privacy settings
  if (session.userType === 'teacher') {
    const privacy = await prisma.studentPrivacy.findUnique({
      where: {
        studentId_teacherId: {
          studentId: id,
          teacherId: session.userId,
        },
      },
    });

    const filtered: Record<string, unknown> = {
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      incomeTier: student.incomeTier,
      createdAt: student.createdAt,
      updatedAt: student.updatedAt,
    };

    if (privacy?.shareEmail) filtered.email = student.email;
    if (privacy?.sharePhone) filtered.phone = student.phone;
    if (privacy?.shareBirthday) filtered.birthday = student.birthday;
    if (privacy?.shareAddress) filtered.address = student.address;

    return respondOk(filtered);
  }

  return respondError('Access denied', 403);
}

interface UpdateStudentBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  incomeTier?: number;
  phone?: string;
  birthday?: string;
  address?: string;
  reminderPref?: 'eve' | 'morning' | 'one_hour' | 'off';
  emailNotifications?: boolean;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  if (session.userType !== 'student' || session.userId !== id) {
    return respondError('Access denied', 403);
  }

  const body = await parseBody<UpdateStudentBody>(request);
  if (!body) return respondError('Invalid request body', 400);

  // Check for email conflicts
  if (body.email) {
    const existing = await prisma.student.findUnique({
      where: { email: body.email },
    });
    if (existing && existing.id !== id) {
      return respondError('Email already in use', 409, 'EMAIL_TAKEN');
    }
  }

  const student = await prisma.student.update({
    where: { id },
    data: body,
  });

  return respondOk(student);
}
