import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, requireTeacher, isErrorResponse, parseBody, withErrorHandler } from '@/lib/api-utils';
import { createInvitationSchema } from '@/lib/schemas';
import { checkStudentWriteLimit, respondRateLimited } from '@/lib/rate-limit';
import { inviteContact, deliverInvitation, REFUSAL_MESSAGES } from '@/services/invitations';
import { log } from '@/lib/log';
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  // Unpaginated and unsearchable, both deliberately (#176). A `where` that
  // filtered on `firstName`/`lastName`/`email` answered questions about
  // columns `projectStudentForTeacher` redacts: a teacher denied a surname
  // could binary-search it from hit/miss and `total`. Deleting the
  // parameter removes the question rather than gating it — there is no
  // predicate here left that has to stay mirrored with the projection.
  const archived = request.nextUrl.searchParams.get('archived') === 'true';

  const where = {
    teacherStudents: { some: { teacherId: session.teacherId, isArchived: archived } },
  };

  const students = await prisma.student.findMany({
    where,
    orderBy: { firstName: 'asc' },
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
  });

  const studentIds = students.map((s) => s.id);
  const overdueGroups = studentIds.length
    ? await prisma.registration.groupBy({
        by: ['studentId'],
        where: {
          studentId: { in: studentIds },
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

  return respondOk({ students: result });
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

  // `result.value.delivered` is false when delivery must be withheld: either
  // a `TeacherBlock` exists for this (teacher, email) pair (services/invitations.ts),
  // or the pair is already linked and #412's gate declined to say so. The
  // invitation row is still real, only delivery is withheld. Gating on it here
  // is one of two things that stop this from emailing the exact person who
  // unlinked to get away from this teacher — `notifyInvitee` re-checks both
  // conditions itself (F3, #166 review), belt and braces: this gate does
  // nothing extra on the ordinary (unblocked, unlinked) path — `deliverInvitation`
  // still runs — and it is what saves `notifyInvitee`'s own re-checks
  // entirely on the withheld (blocked-or-linked) path, by skipping the call.
  //
  // Fire-and-forget by signature, not by discipline: `deliverInvitation`
  // returns `FireAndForget` (`= void`), so this response's status and latency
  // cannot be coupled to a delivery that may take an HTTPS round trip — the
  // #166 oracle, shut by the type (#391). The failure path and its log line
  // live inside that function, since there is no promise here to catch on.
  if (result.value.delivered) {
    deliverInvitation(prisma, {
      teacherId: session.teacherId,
      email: parsed.data.email,
      invitationId: result.value.id,
      source: 'create',
    });
  }

  return respondOk({ id: result.value.id }, 201);
});
