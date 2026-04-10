import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, requireTeacher, isErrorResponse, parseBody } from '@/lib/api-utils';
import { createStudentSchema, studentListQuerySchema } from '@/lib/schemas';

export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = studentListQuerySchema.safeParse(params);
  if (!parsed.success) {
    return respondError('Invalid query parameters', 400);
  }

  const { search, page, pageSize } = parsed.data;
  const archived = params.archived === 'true';

  const where = {
    teacherStudents: { some: { teacherId: session.userId, isArchived: archived } },
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [students, total] = await Promise.all([
    prisma.student.findMany({
      where,
      orderBy: { firstName: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        claimedAt: true,
        studentPrivacy: {
          where: { teacherId: session.userId },
          select: { shareFullName: true, shareEmail: true },
        },
        registrations: {
          where: { class: { teacherId: session.userId } },
          orderBy: { registeredAt: 'desc' },
          take: 1,
          select: { class: { select: { date: true } } },
        },
        _count: {
          select: {
            registrations: {
              where: { class: { teacherId: session.userId } },
            },
          },
        },
      },
    }),
    prisma.student.count({ where }),
  ]);

  const result = students.map((s) => {
    const privacy = s.studentPrivacy[0];
    const isUnclaimed = !s.claimedAt;
    const shareFullName = isUnclaimed || (privacy?.shareFullName ?? false);
    const shareEmail = isUnclaimed || (privacy?.shareEmail ?? false);
    return {
      id: s.id,
      firstName: s.firstName,
      lastName: shareFullName ? s.lastName : (s.lastName.charAt(0) || ''),
      email: shareEmail ? s.email : null,
      claimedAt: s.claimedAt,
      shareFullName,
      lastClassDate: s.registrations[0]?.class.date ?? null,
      classCount: s._count.registrations,
    };
  });

  return respondOk({ students: result, total, page, pageSize });
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createStudentSchema);
  if ('error' in parsed) return parsed.error;
  const { firstName, lastName, email } = parsed.data;

  const existing = await prisma.student.findUnique({ where: { email } });

  if (existing) {
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: session.userId, studentId: existing.id } },
    });
    if (link) {
      return respondError('Student already in your contacts', 409, 'ALREADY_LINKED');
    }
    await prisma.teacherStudent.create({
      data: { teacherId: session.userId, studentId: existing.id },
    });
    return respondOk(existing, 200);
  }

  const student = await prisma.$transaction(async (tx) => {
    const created = await tx.student.create({
      data: { firstName, lastName, email },
    });
    await tx.teacherStudent.create({
      data: { teacherId: session.userId, studentId: created.id },
    });
    return created;
  });

  return respondOk(student, 201);
}
