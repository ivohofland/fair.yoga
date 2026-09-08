import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { cookie, seedSession, uniqueSuffix } from '../../../../../tests/helpers';
import { inviteContact, unlinkTeacher } from '@/services/invitations';
import { PUT } from './route';

/**
 * #502 Fix #3 (task 4, added after the whole-branch review). Before this
 * fix, `PUT` wrote a new `email` without touching `delivered`, so a teacher
 * could build a genuinely-delivered invitation at an address they control,
 * `PUT` it onto a guessed student's real address, and leave `delivered`
 * stale at `true` — reopening #502's leak #2 (`unlinkTeacher`'s
 * `delivered: true`-scoped tombstone) through a second door Task 2 did not
 * anticipate.
 *
 * The `PUT` handler is invoked DIRECTLY, the pattern `api/classes/route.test.ts`
 * and `api/registrations/route.test.ts` established: `NextRequest` is a
 * plain Web-standard-based class Next.js exports, and `getSessionToken`
 * (`src/lib/auth/session.ts`) reads the session off the request's own cookie
 * jar rather than the request-scoped `cookies()` helper from `next/headers`
 * — so the real handler, its ownership check, its CAS write and now its
 * `delivered` reset all run against the real test database with no server
 * anywhere. This worktree has no dev server on `:3000`
 * (`BASE_URL`'s own docblock in `tests/helpers.ts` covers the override), so
 * this is also how these two scenarios can run and be verified here at all.
 */
const prisma = new PrismaClient();
const suffix = uniqueSuffix();

function put(id: string, body: unknown, token: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/invitations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/invitations/[id] resets delivered on every email change (#502 Fix #3)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let token: string;
  const studentIds: string[] = [];
  const studentAccountIds: string[] = [];

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Readdress', lastName: 'Teacher',
        email: `readdress-teacher-${suffix}@test.local`,
        account: { create: { email: `readdress-teacher-${suffix}@test.local` } },
        bio: '#502 task 4 PUT re-address fixture',
        pageSlug: `readdress-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    token = await seedSession(prisma, teacherAccountId);
  });

  afterAll(async () => {
    if (studentIds.length) {
      await prisma.teacherStudent.deleteMany({ where: { studentId: { in: studentIds } } });
      await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    if (studentAccountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: studentAccountIds } } });
    }
    await prisma.invitation.deleteMany({ where: { teacherId } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId } });
    await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: teacherAccountId } });
    await prisma.$disconnect();
  });

  // Acceptance criterion 7.
  it('closes the exact bypass: PUT-ing a delivered invitation onto a linked-but-unshared student resets delivered, so the tombstone that student\'s unlink writes never reaches this row', async () => {
    // A genuinely-delivered invitation the teacher built at an address they
    // actually control — ordinary, unblocked, unlinked, so `inviteContact`
    // takes its ordinary path and `delivered` comes back `true`.
    const sourceEmail = `readdress-src-${suffix}@test.local`;
    const invited = await inviteContact(prisma, {
      teacherId, email: sourceEmail, firstName: 'Decoy', lastName: 'Source',
    });
    if (!invited.ok) throw new Error(`expected an ordinary delivered invite, got ${invited.reason}`);
    expect(invited.value.delivered).toBe(true);

    // The guessed victim: linked to this teacher, claimed, no shared privacy
    // row — the same #417/#418 gate shape `invitations.gate.test.ts`
    // exercises through `inviteContact` itself, reproduced here by hand
    // because this test needs the student's own id to call `unlinkTeacher`
    // and never invites this address directly at all — the whole point is
    // that `PUT` reaches it without ever consulting the gate.
    const victimEmail = `readdress-victim-${suffix}@test.local`;
    const victim = await prisma.student.create({
      data: {
        firstName: 'Readdress', lastName: 'Victim', email: victimEmail,
        claimedAt: new Date(),
        account: { create: { email: victimEmail } },
        teacherStudents: { create: { teacherId } },
      },
      select: { id: true, accountId: true },
    });
    studentIds.push(victim.id);
    if (victim.accountId) studentAccountIds.push(victim.accountId);

    // The bypass itself: PUT re-addresses the genuinely-delivered row onto
    // the guessed victim's real address. Nothing about this call names the
    // victim as linked or unshared — `route.ts`'s own docblock on `PUT`
    // states there is no roster/block check on the incoming `email` at all,
    // which is exactly what makes the address swap possible.
    const res = await PUT(
      put(invited.value.id, { email: victimEmail }, token),
      { params: Promise.resolve({ id: invited.value.id }) },
    );
    expect(res.status).toBe(200);

    const afterPut = await prisma.invitation.findUniqueOrThrow({
      where: { id: invited.value.id },
      select: { email: true, delivered: true },
    });
    expect(afterPut.email).toBe(victimEmail);
    expect(afterPut.delivered).toBe(false);

    const result = await unlinkTeacher(prisma, {
      teacherId, studentId: victim.id, accountEmail: victimEmail,
    });
    expect(result).toEqual({ ok: true });

    // Pre-Fix-#3, `delivered` would have stayed stale at `true` from the
    // original invite, and `unlinkTeacher`'s `delivered: true`-scoped
    // tombstone write (`services/invitations.ts`) would have matched this
    // row and flipped it to `declined` — reproducing #502's leak #2 through
    // this second door. It must stay exactly where the PUT left it.
    const afterUnlink = await prisma.invitation.findUniqueOrThrow({
      where: { id: invited.value.id },
      select: { status: true, respondedAt: true },
    });
    expect(afterUnlink.status).toBe('pending');
    expect(afterUnlink.respondedAt).toBeNull();
  });

  // Acceptance criterion 8.
  it('an ordinary PUT re-address also resets delivered, unconditional on the new address\'s status', async () => {
    const originalEmail = `readdress-ordinary-src-${suffix}@test.local`;
    const invited = await inviteContact(prisma, {
      teacherId, email: originalEmail, firstName: 'Ordinary', lastName: 'Source',
    });
    if (!invited.ok) throw new Error(`expected an ordinary delivered invite, got ${invited.reason}`);
    expect(invited.value.delivered).toBe(true);

    // A plain stranger address — no Student row, no TeacherBlock, nothing
    // decoy-shaped about it at all — so a future gate that only reset
    // `delivered` when the new address looked blocked or linked would leave
    // this test red.
    const newEmail = `readdress-ordinary-dst-${suffix}@test.local`;
    const res = await PUT(
      put(invited.value.id, { email: newEmail }, token),
      { params: Promise.resolve({ id: invited.value.id }) },
    );
    expect(res.status).toBe(200);

    const row = await prisma.invitation.findUniqueOrThrow({
      where: { id: invited.value.id },
      select: { email: true, delivered: true },
    });
    expect(row.email).toBe(newEmail);
    expect(row.delivered).toBe(false);
  });
});
