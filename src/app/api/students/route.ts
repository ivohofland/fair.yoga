import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, requireTeacher, isErrorResponse, parseBody, withErrorHandler } from '@/lib/api-utils';
import { createInvitationSchema, studentListQuerySchema } from '@/lib/schemas';
import { checkStudentWriteLimit } from '@/lib/rate-limit';
import { inviteContact, notifyInvitee, REFUSAL_MESSAGES } from '@/services/invitations';
import { log } from '@/lib/log';
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';

/**
 * Loads the inviting teacher's display name and notifies the invitee — the
 * whole "decide + deliver" tail of a successful, unblocked invite.
 *
 * Deliberately never awaited by `POST` below (F1, #166 review): this SELECT
 * plus whatever `notifyInvitee` does — a plain INSERT for a registered
 * invitee, an HTTPS call to Resend for anyone else — must not sit on the
 * request's critical path. Awaited, it turns a Resend outage into a 500 for
 * an unregistered address while a registered one still answers 201, and even
 * with Resend healthy it is a timing channel (blocked: nothing, registered:
 * one query, stranger: one network round trip) — both carry the exact bit
 * `POST /api/students` exists to withhold. Fire-and-forget is safe here: this
 * is a long-lived Node process on a single VPS, not a serverless function
 * that could be frozen mid-request.
 */
async function deliverInvitation(teacherId: string, email: string): Promise<void> {
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { firstName: true, lastName: true },
  });
  await notifyInvitee(prisma, {
    teacherId,
    email,
    teacherName: `${teacher.firstName} ${teacher.lastName}`,
  });
}

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

  const result = students.map((s) => ({
    ...projectStudentForTeacher(s, session.teacherId),
    lastClassDate: s.registrations[0]?.class.date ?? null,
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

  // `result.value.delivered` is false when a `TeacherBlock` exists for this
  // address (services/invitations.ts) — the invitation row is still real,
  // only delivery is withheld. Gating on it here is one of two things that
  // stop this from emailing the exact person who unlinked to get away from
  // this teacher — `notifyInvitee` re-checks the same block itself (F3,
  // #166 review), belt and braces, so this gate only saves a query on the
  // common (unblocked) path rather than being the sole guard.
  //
  // Fire-and-forget, on purpose — see `deliverInvitation`'s docblock above.
  // The explicit `.catch` is required, not optional: without it, a rejection
  // here becomes an unhandled promise rejection instead of a log line.
  if (result.value.delivered) {
    // Same transform `inviteContact` applies before storing `Invitation.email`
    // — recomputed here rather than read back off `result`, since the
    // service returns only `{ id, delivered }` on the wire-shaped success path.
    void deliverInvitation(session.teacherId, parsed.data.email).catch((err) => {
      // `invitationId`, not just `teacherId` (F4, #166 review). A send that
      // fails leaves a row indistinguishable from one that went out — still
      // `pending`, still listed under Contacts — so without the id an operator
      // reading this line knows a delivery failed but not WHICH one, and a
      // busy teacher's invitations are the haystack.
      //
      // No email address on purpose: this pair finds the row, and the address
      // is the one field on it worth keeping out of the logs.
      //
      // There is no resend. The teacher's recovery is to remove the contact
      // and invite again — `DELETE /api/invitations/[id]` refuses only
      // `declined` rows, so a pending one can go — which is what
      // `REFUSAL_MESSAGES.ALREADY_INVITED` now names, since the refusal is the
      // only place they meet the dead end. A real resend affordance is filed
      // separately; do not grow one out of this catch.
      log.error(
        { err, teacherId: session.teacherId, invitationId: result.value.id },
        'failed to notify invitee',
      );
    });
  }

  return respondOk({ id: result.value.id }, 201);
});
