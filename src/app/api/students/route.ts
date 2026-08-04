import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, requireTeacher, isErrorResponse, parseBody, withErrorHandler } from '@/lib/api-utils';
import { createStudentSchema, studentListQuerySchema } from '@/lib/schemas';
import { checkStudentWriteLimit } from '@/lib/rate-limit';
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

  // Keyed on the teacher, not the IP: the caller is authenticated, so an IP key
  // would be evadable by rotation, unfair to teachers behind one NAT, and would
  // need an `ip === 'unknown'` escape hatch that buys nothing.
  //
  // The ceiling — and the bucket this route shares with the teacher branch of
  // PUT /api/students/[id] — lives in `checkStudentWriteLimit`.
  //
  // Issue #51 (bulk/CSV student import) will exceed it by design — raise the
  // ceiling or exempt the import path when that lands; do not assume this
  // number still fits.
  //
  // What it buys: this route still tells a caller whether a Student row exists
  // for an address — 200 if one does, 201 if it did not. "Student row", not
  // "account": an unclaimed contact sitting in another teacher's CRM answers
  // 200 with no Account behind it, so the bit leaks CRM membership as well as
  // self-registration. A follow-up GET recovers the same bit through the
  // returned name, since this branch ignores the names the caller submitted.
  //
  // The limit meters bulk probing rather than stopping it: 50/hour is ~8.3 days
  // per 10,000 addresses. Treat that as an order of magnitude, not a guarantee
  // — the limiter is in-process, so a deploy or restart hands back a fresh
  // budget, and its shared 10,000-key map can evict a live bucket under
  // pressure. The wall is requiring the student's acceptance before a link
  // exists at all (#166); this holds until that lands.
  const limit = checkStudentWriteLimit(session.teacherId);
  if (!limit.allowed) {
    log.warn({ teacherId: session.teacherId }, 'student write refused: rate limit exceeded');
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return respondError(
      `Too many student requests. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      429,
    );
  }

  const parsed = await parseBody(request, createStudentSchema);
  if ('error' in parsed) return parsed.error;
  const { firstName, lastName, email } = parsed.data;

  // #162: select the id and nothing else. Narrowing here rather than at the
  // response is deliberate — `existing` is typed `{ id: string }`, so reading
  // any field beyond `.id` off it is a compile error, not something review
  // has to catch. (Returning more still compiles if a later edit also widens
  // the `select` — `respondOk` is generically typed, so nothing pins response
  // shape to query shape. The exhaustive key-set assertions in the
  // integration tests are the backstop for that case.) This route answered
  // any teacher who knew an email with the student's phone, birthday, home
  // address and income tier.
  const existing = await prisma.student.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: session.teacherId, studentId: existing.id } },
    });
    if (link) {
      return respondError('Student already in your contacts', 409, 'ALREADY_LINKED');
    }
    await prisma.teacherStudent.create({
      data: { teacherId: session.teacherId, studentId: existing.id },
    });
    return respondOk({ id: existing.id }, 200);
  }

  const student = await prisma.$transaction(async (tx) => {
    const created = await tx.student.create({
      data: { firstName, lastName, email },
      select: { id: true },
    });
    await tx.teacherStudent.create({
      data: { teacherId: session.teacherId, studentId: created.id },
    });
    return created;
  });

  return respondOk({ id: student.id }, 201);
});
