import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, requireTeacher, isErrorResponse, parseBody, withErrorHandler } from '@/lib/api-utils';
import { createInvitationSchema, studentListQuerySchema } from '@/lib/schemas';
import { checkStudentWriteLimit, respondRateLimited } from '@/lib/rate-limit';
import { inviteContact, deliverInvitation, REFUSAL_MESSAGES } from '@/services/invitations';
import { log } from '@/lib/log';
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';

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
        ...studentVisibilitySelect(session.teacherId),
        registrations: {
          where: { class: { calendarEntry: { teacherId: session.teacherId } } },
          orderBy: { registeredAt: 'desc' },
          take: 1,
          select: { class: { select: { calendarEntry: { select: { date: true } } } } },
        },
        _count: {
          select: {
            registrations: {
              where: { class: { calendarEntry: { teacherId: session.teacherId } } },
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
          class: { calendarEntry: { teacherId: session.teacherId } },
          payment: { status: 'overdue' },
        },
        _count: { _all: true },
      })
    : [];
  const overdueByStudent = new Map(
    overdueGroups.map((g) => [g.studentId, g._count._all]),
  );

  const result = students.map((s) => ({
    ...projectStudentForTeacher(s, session.teacherId),
    lastClassDate: s.registrations[0]?.class.calendarEntry.date ?? null,
    classCount: s._count.registrations,
    overduePayments: overdueByStudent.get(s.id) ?? 0,
  }));

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
    return respondRateLimited(limit, 'Too many invitations.');
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

  // Unconditional — written regardless of `result.value.delivered`, covering
  // both the create and revive paths inside `inviteContact` (#173). A
  // teacher must never be able to infer TeacherBlock status from whether
  // this timestamp advances, so this cannot be moved inside the `if` below.
  //
  // `updateMany`, not `update`: a concurrent delete of this just-created row
  // (DELETE /api/invitations/[id] from another tab) between `inviteContact`
  // above and here would make a plain `update` throw P2025, which
  // `classifyApiError` has no branch for and falls through to a bare 500
  // (src/lib/api-errors.ts). Nothing downstream reads this write's count —
  // the response below still echoes `result.value.id`, valid at the moment
  // it was created — so a zero-count match needs no branch, only a
  // statement shape that can't throw on one.
  //
  // `parsed.data.email` is already lowercase — normalised by
  // `createInvitationSchema`'s `emailField` at HTTP ingress — so this is not
  // a second normalisation, the same value `inviteContact` was already
  // called with above.
  await prisma.invitation.updateMany({
    where: { id: result.value.id },
    data: { lastNotifiedAt: new Date(), lastNotifiedEmail: parsed.data.email },
  });

  // `result.value.delivered` is false when a `TeacherBlock` exists for this
  // address (services/invitations.ts) — the invitation row is still real,
  // only delivery is withheld. Gating on it here is one of two things that
  // stop this from emailing the exact person who unlinked to get away from
  // this teacher — `notifyInvitee` re-checks the same block itself (F3,
  // #166 review), belt and braces, so this gate only saves a query on the
  // common (unblocked) path rather than being the sole guard.
  //
  // Fire-and-forget, on purpose — see `deliverInvitation`'s docblock
  // (services/invitations.ts). The explicit `.catch` is required, not
  // optional: without it, a rejection here becomes an unhandled promise
  // rejection instead of a log line.
  if (result.value.delivered) {
    void deliverInvitation(prisma, session.teacherId, parsed.data.email).catch((err) => {
      // `invitationId`, not just `teacherId` (F4, #166 review). A send that
      // fails leaves a row indistinguishable from one that went out — still
      // `pending`, still listed under Contacts — so without the id an operator
      // reading this line knows a delivery failed but not WHICH one, and a
      // busy teacher's invitations are the haystack.
      //
      // No email address on purpose: this pair finds the row, and the address
      // is the one field on it worth keeping out of the logs.
      //
      // This log line is the operator's only signal that a specific send
      // failed — the teacher's own recovery is now
      // `POST /api/invitations/[id]/resend` (#173), not delete-and-recreate.
      log.error(
        { err, teacherId: session.teacherId, invitationId: result.value.id },
        'failed to notify invitee',
      );
    });
  }

  return respondOk({ id: result.value.id }, 201);
});
