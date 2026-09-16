import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { cookie, seedSession, uniqueSuffix } from '../../../../../tests/helpers';
import { inviteContact, unlinkTeacher } from '@/services/invitations';
import { PUT } from './route';

/**
 * #502 Fix #3 (task 4, added after the whole-branch review). `PUT` resets
 * `delivered` on every `email` change so that `unlinkTeacher`'s
 * `delivered: true` scope cannot match a row whose current address was
 * never told anything. Without that reset a teacher could re-address a
 * genuinely-delivered invitation onto a guessed victim and read the
 * tombstone as confirmation (#502 leak #2).
 *
 * The `PUT` handler is invoked DIRECTLY, the pattern `api/classes/route.test.ts`
 * and `api/registrations/route.test.ts` established: `NextRequest` is a
 * plain Web-standard-based class Next.js exports, and `getSessionToken`
 * (`src/lib/auth/session.ts`) reads the session off the request's own cookie
 * jar rather than the request-scoped `cookies()` helper from `next/headers`
 * — so the real handler, its ownership check, its CAS write and now its
 * `delivered` reset all run against the real test database with no server
 * anywhere. This file exists because the alternative (the integration tier)
 * cannot run in a worktree with no dev server on `:3000`, and these three
 * scenarios need to actually run somewhere.
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
    if (teacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId } });
      await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
      await prisma.teacher.delete({ where: { id: teacherId } });
      await prisma.account.delete({ where: { id: teacherAccountId } });
    }
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

    // The PUT above already reset `delivered` to `false`, so
    // `unlinkTeacher`'s `delivered: true`-scoped tombstone write
    // (`services/invitations.ts`) cannot match this row — it must stay
    // exactly where the PUT left it, not flipped to `declined` on a stale
    // `delivered: true` inherited from the original invite (#502 leak #2).
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

  it('a PUT that resends the row\'s own current email leaves delivered unchanged', async () => {
    // `contact-form.tsx` (the only client that calls this route) sends
    // `firstName`, `lastName` and `email` on every save, changed or not —
    // this reproduces that shape exactly: `email` present in the body,
    // equal to the row's own stored value. A comparison against field
    // PRESENCE alone (`email !== undefined`) would flip `delivered` here
    // even though the address never moved — the bug this test exists to
    // pin shut.
    const email = `readdress-unchanged-${suffix}@test.local`;
    const invited = await inviteContact(prisma, {
      teacherId, email, firstName: 'Unchanged', lastName: 'Source',
    });
    if (!invited.ok) throw new Error(`expected an ordinary delivered invite, got ${invited.reason}`);
    expect(invited.value.delivered).toBe(true);

    const res = await PUT(
      put(invited.value.id, { email, firstName: 'Corrected' }, token),
      { params: Promise.resolve({ id: invited.value.id }) },
    );
    expect(res.status).toBe(200);

    const row = await prisma.invitation.findUniqueOrThrow({
      where: { id: invited.value.id },
      select: { email: true, firstName: true, delivered: true },
    });
    expect(row.email).toBe(email);
    expect(row.firstName).toBe('Corrected');
    expect(row.delivered).toBe(true);
  });

  // #622, and here for the same reason the tests above are: this route's
  // `teacherInboxNotifiedAt` reset rides the same `readdressed` branch
  // `delivered` does, and nothing else pins that it stays there. Moved into
  // the unconditional `data`, every contact-form Save would lift the
  // teacher-inbox cap, and Save-then-Resend would nudge a teacher-only
  // invitee without bound.
  it('a PUT that does not move the address leaves the teacher-inbox cap marker standing (#622)', async () => {
    const email = `readdress-cap-${suffix}@test.local`;
    const invited = await inviteContact(prisma, {
      teacherId, email, firstName: 'Capped', lastName: 'Contact',
    });
    if (!invited.ok) throw new Error(`expected an ordinary delivered invite, got ${invited.reason}`);

    // Hand-set: this test drives the route, and the column's own writer is
    // `notifyInvitee`'s teacher branch, covered in
    // `src/services/invitations.notify.test.ts`. An hour-old value, so a
    // reset to anything this request mints would read as a difference.
    const marker = new Date(Date.now() - 3_600_000);
    await prisma.invitation.update({
      where: { id: invited.value.id },
      data: { teacherInboxNotifiedAt: marker },
    });

    // The contact form's own save shape: `email` present and equal to the
    // stored value, a name changed beside it (`contact-form.tsx` sends all
    // three fields whether or not they moved).
    const save = await PUT(
      put(invited.value.id, { email, firstName: 'Corrected' }, token),
      { params: Promise.resolve({ id: invited.value.id }) },
    );
    expect(save.status).toBe(200);

    const afterSave = await prisma.invitation.findUniqueOrThrow({
      where: { id: invited.value.id },
      select: { firstName: true, teacherInboxNotifiedAt: true },
    });
    expect(afterSave.firstName).toBe('Corrected');
    expect(afterSave.teacherInboxNotifiedAt).toEqual(marker);

    // And a body carrying no `email` key at all — `updateInvitationSchema`
    // (src/lib/schemas.ts) makes every field optional, so this is a shape
    // the route must answer too, and it takes the same branch.
    const nameOnly = await PUT(
      put(invited.value.id, { firstName: 'Corrected again' }, token),
      { params: Promise.resolve({ id: invited.value.id }) },
    );
    expect(nameOnly.status).toBe(200);

    const afterNameOnly = await prisma.invitation.findUniqueOrThrow({
      where: { id: invited.value.id },
      select: { firstName: true, teacherInboxNotifiedAt: true },
    });
    expect(afterNameOnly.firstName).toBe('Corrected again');
    expect(afterNameOnly.teacherInboxNotifiedAt).toEqual(marker);
  });

  // The other direction of the same branch, here rather than only in
  // `tests/integration/invitations-api.test.ts` for the reason this whole
  // file exists: the integration tier cannot run in a worktree with no dev
  // server, and a reset whose positive case only runs there is a reset that
  // does not run everywhere. The route's own readdress reset is what keeps a
  // cap claimed for one person from silencing the next.
  it('a PUT that moves the address clears the teacher-inbox cap marker (#622)', async () => {
    const originalEmail = `readdress-cap-src-${suffix}@test.local`;
    const invited = await inviteContact(prisma, {
      teacherId, email: originalEmail, firstName: 'Capped', lastName: 'Moved',
    });
    if (!invited.ok) throw new Error(`expected an ordinary delivered invite, got ${invited.reason}`);

    // Hand-set for the same reason the negative case above hand-sets it: the
    // column's own writer is `notifyInvitee`'s teacher branch, which this
    // test does not drive.
    const marker = new Date(Date.now() - 3_600_000);
    await prisma.invitation.update({
      where: { id: invited.value.id },
      data: { teacherInboxNotifiedAt: marker },
    });

    const newEmail = `readdress-cap-dst-${suffix}@test.local`;
    const res = await PUT(
      put(invited.value.id, { email: newEmail }, token),
      { params: Promise.resolve({ id: invited.value.id }) },
    );
    expect(res.status).toBe(200);

    const row = await prisma.invitation.findUniqueOrThrow({
      where: { id: invited.value.id },
      select: { email: true, delivered: true, teacherInboxNotifiedAt: true },
    });
    expect(row.email).toBe(newEmail);
    expect(row.delivered).toBe(false);
    expect(row.teacherInboxNotifiedAt).toBeNull();
  });
});
