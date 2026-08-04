import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, requireTeacher, isErrorResponse, parseBody, withErrorHandler } from '@/lib/api-utils';
import { createInvitationSchema, studentListQuerySchema } from '@/lib/schemas';
import { checkStudentWriteLimit } from '@/lib/rate-limit';
import { inviteContact, REFUSAL_MESSAGES } from '@/services/invitations';
import { log } from '@/lib/log';

export const GET = withErrorHandler(async (request: NextRequest) => {
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
    teacherStudents: { some: { teacherId: session.teacherId, isArchived: archived } },
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
          where: { teacherId: session.teacherId },
          select: { shareFullName: true, shareEmail: true },
        },
        registrations: {
          where: { class: { teacherId: session.teacherId } },
          orderBy: { registeredAt: 'desc' },
          take: 1,
          select: { class: { select: { date: true } } },
        },
        _count: {
          select: {
            registrations: {
              where: { class: { teacherId: session.teacherId } },
            },
          },
        },
      },
    }),
    prisma.student.count({ where }),
  ]);

  const pageStudentIds = students.map((s) => s.id);
  const overdueGroups = pageStudentIds.length
    ? await prisma.registration.groupBy({
        by: ['studentId'],
        where: {
          studentId: { in: pageStudentIds },
          class: { teacherId: session.teacherId },
          payment: { status: 'overdue' },
        },
        _count: { _all: true },
      })
    : [];
  const overdueByStudent = new Map(
    overdueGroups.map((g) => [g.studentId, g._count._all]),
  );

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
      overduePayments: overdueByStudent.get(s.id) ?? 0,
    };
  });

  return respondOk({ students: result, total, page, pageSize });
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  // Keyed on the teacher, not the IP: the caller is authenticated, so an IP
  // key would be evadable by rotation and unfair to teachers behind one NAT.
  //
  // What it buys has changed. It is no longer standing in for a missing fix
  // to an enumeration oracle — #166 closed that by construction, since this
  // route no longer branches on whether the address exists. What remains is
  // that a teacher can cause an email to be sent to an arbitrary address, so
  // this is a spam brake. Issue #51 (bulk/CSV import) will exceed it by
  // design; raise the ceiling or exempt that path when it lands.
  const limit = checkStudentWriteLimit(session.teacherId);
  if (!limit.allowed) {
    log.warn({ teacherId: session.teacherId }, 'invitation refused: rate limit exceeded');
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return respondError(
      `Too many invitations. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      429,
    );
  }

  const parsed = await parseBody(request, createInvitationSchema);
  if ('error' in parsed) return parsed.error;

  const result = await inviteContact(prisma, {
    teacherId: session.teacherId,
    ...parsed.data,
  });
  if (!result.ok) {
    return respondError(REFUSAL_MESSAGES[result.reason], 409, result.reason);
  }

  return respondOk({ id: result.value.id }, 201);
});
