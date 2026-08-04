import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let teacherAccountId: string;
let teacherToken: string;

// A second teacher who owns nothing in `teacherId`'s tests below.
let otherTeacherId: string;
let otherTeacherAccountId: string;

// This row exists purely so GET's isolation test has something under a
// different teacherId to prove it does NOT return. It is read-only for the
// rest of the file: DELETE/PUT/PATCH's own 404-not-403 ownership tests each
// create and clean up a dedicated row via `createOtherTeacherInvitation`
// below, rather than sharing this one. A shared row would make only the
// FIRST of those three describes to run a genuine proof against
// `ownedInvitation`'s guard — under a broken guard, that describe's own
// mutating call would consume the row for real, leaving the other two
// describes' "another teacher's invitation" tests passing for the mundane
// reason the row was already gone, not because their own call sites were
// exercised.
let otherTeacherInvitationId: string;

// A single pending contact, present for the whole file: the GET suite reads
// it, then the DELETE suite consumes it. Shared deliberately, the same way
// `declinedEmail` below is created by one test and read by the next.
let pendingId: string;
const pendingEmail = `inv-pending-${suffix}@test.local`;
const declinedEmail = `inv-declined-${suffix}@test.local`;

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Invitation',
      lastName: 'Teacher',
      email: `inv-teacher-${suffix}@test.local`,
      account: { create: { email: `inv-teacher-${suffix}@test.local` } },
      bio: 'Teacher for invitation management tests',
      pageSlug: `inv-teacher-${suffix}`,
    },
  });
  teacherId = teacher.id;
  teacherAccountId = teacher.accountId;

  const other = await prisma.teacher.create({
    data: {
      firstName: 'Other',
      lastName: 'Teacher',
      email: `inv-other-${suffix}@test.local`,
      account: { create: { email: `inv-other-${suffix}@test.local` } },
      bio: 'Non-owner fixture for invitation ownership tests',
      pageSlug: `inv-other-${suffix}`,
    },
  });
  otherTeacherId = other.id;
  otherTeacherAccountId = other.accountId;

  const pending = await prisma.invitation.create({
    data: { teacherId, email: pendingEmail, firstName: 'Pending', lastName: 'Contact' },
  });
  pendingId = pending.id;

  const otherInvitation = await prisma.invitation.create({
    data: {
      teacherId: otherTeacherId,
      email: `inv-other-contact-${suffix}@test.local`,
      firstName: 'Other',
      lastName: 'Contact',
    },
  });
  otherTeacherInvitationId = otherInvitation.id;

  teacherToken = await seedSession(prisma, teacherAccountId);
});

afterAll(async () => {
  // FK order: invitation -> session -> teacher -> account. Scoped by
  // `in: [...]` over both teachers' ids/accountIds rather than one delete
  // per known row, so this also sweeps anything a single `it()` created
  // inline (the `student_block` tombstone, the declined rows) without that
  // test needing its own afterAll.
  //
  // Account is included, unlike the primary fixture in
  // students-api.test.ts:1-73 which leaves it behind: `otherTeacherAccountId`
  // here plays the same role as the *nested* ownership fixtures in that file
  // (students-api.test.ts:508-517, :892-914), which do delete their account.
  // Omitting it was this file's own defect, not a precedent to follow.
  const teacherIds = [teacherId, otherTeacherId].filter(Boolean);
  const accountIds = [teacherAccountId, otherTeacherAccountId].filter(Boolean);
  if (teacherIds.length) {
    await prisma.invitation.deleteMany({ where: { teacherId: { in: teacherIds } } });
  }
  if (accountIds.length) {
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  }
  if (teacherIds.length) {
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  }
  if (accountIds.length) {
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
});

/**
 * A fresh invitation under `otherTeacherId`, for a single ownership test to
 * attempt a mutation against and expect 404. Each of DELETE/PUT/PATCH's
 * "refuses another teacher's invitation" tests calls this itself rather
 * than sharing one row — see the comment on `otherTeacherInvitationId`
 * above for why a shared row would only prove the guard for whichever
 * describe happens to run first.
 */
async function createOtherTeacherInvitation(label: string) {
  return prisma.invitation.create({
    data: {
      teacherId: otherTeacherId,
      email: `inv-other-${label}-${suffix}@test.local`,
      firstName: 'Other',
      lastName: 'Contact',
    },
    select: { id: true },
  });
}

describe('GET /api/invitations', () => {
  it('returns this teacher\'s contacts and never another teacher\'s', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations`, { headers: cookie(teacherToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { invitations: Array<{ id: string; email: string }>; total: number };
    };
    expect(json.data.invitations.map((i) => i.email)).toEqual([pendingEmail]);
    expect(json.data.total).toBe(1);
    // `otherTeacherInvitationId` exists in the database at this point
    // (created under `otherTeacherId` in beforeAll) — its absence above is
    // the teacherId filter working, not an empty table making the equality
    // check above vacuous.
    expect(json.data.invitations.some((i) => i.id === otherTeacherInvitationId)).toBe(false);
  });

  it('never returns a student_block row', async () => {
    // The tombstone a student writes by unlinking carries an address the
    // teacher may never have had — shareEmail defaults false.
    const blockedEmail = `inv-blocked-${suffix}@test.local`;
    let blocked: { id: string } | undefined;
    try {
      blocked = await prisma.invitation.create({
        data: {
          teacherId, email: blockedEmail, status: 'declined', origin: 'student_block',
        },
        select: { id: true },
      });

      const res = await fetch(`${BASE_URL}/api/invitations`, { headers: cookie(teacherToken) });
      const body = await res.text();
      // Assert on the raw body, not the parsed row count: a future select
      // that leaks the address through some other field still fails here.
      expect(body).not.toContain(blockedEmail);
    } finally {
      if (blocked) await prisma.invitation.delete({ where: { id: blocked.id } });
    }
  });

  it('returns archived contacts only under ?archived=true', async () => {
    const archivedEmail = `inv-archived-${suffix}@test.local`;
    let archived: { id: string } | undefined;
    try {
      archived = await prisma.invitation.create({
        data: { teacherId, email: archivedEmail, isArchived: true },
        select: { id: true },
      });

      const res = await fetch(`${BASE_URL}/api/invitations?archived=true`, { headers: cookie(teacherToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { invitations: Array<{ email: string }> } };
      expect(json.data.invitations.map((i) => i.email)).toEqual([archivedEmail]);
    } finally {
      if (archived) await prisma.invitation.delete({ where: { id: archived.id } });
    }
  });
});

describe('DELETE /api/invitations/[id]', () => {
  it('removes a pending contact', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations/${pendingId}`, {
      method: 'DELETE', headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    expect(await prisma.invitation.findUnique({ where: { id: pendingId } })).toBeNull();
  });

  it('refuses to delete a declined row, because that row is the tombstone', async () => {
    const declined = await prisma.invitation.create({
      data: { teacherId, email: declinedEmail, status: 'declined', respondedAt: new Date() },
    });
    const res = await fetch(`${BASE_URL}/api/invitations/${declined.id}`, {
      method: 'DELETE', headers: cookie(teacherToken),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DECLINED_IS_PERMANENT');
    expect(await prisma.invitation.findUnique({ where: { id: declined.id } })).not.toBeNull();
  });

  it('still refuses a re-invite after the declined row is archived', async () => {
    // The whole point: archiving hides it, it does not disarm it.
    await prisma.invitation.update({
      where: { teacherId_email: { teacherId, email: declinedEmail } },
      data: { isArchived: true },
    });
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Try', lastName: 'Again', email: declinedEmail }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DECLINED');
  });

  it('refuses another teacher\'s invitation', async () => {
    let other: { id: string } | undefined;
    try {
      other = await createOtherTeacherInvitation('delete-target');
      const res = await fetch(`${BASE_URL}/api/invitations/${other.id}`, {
        method: 'DELETE', headers: cookie(teacherToken),
      });
      expect(res.status).toBe(404);
      // And it truly wasn't touched — a 404 that quietly deleted the row
      // anyway would still pass a status-only assertion.
      expect(await prisma.invitation.findUnique({ where: { id: other.id } })).not.toBeNull();
    } finally {
      // `deleteMany`, not `delete`: under a broken ownership guard this
      // test's own DELETE call may already have removed the row for real,
      // and cleanup must not throw over that.
      if (other) await prisma.invitation.deleteMany({ where: { id: other.id } });
    }
  });
});

describe('PUT /api/invitations/[id]', () => {
  let putTargetId: string;
  const putEmail = `inv-put-${suffix}@test.local`;

  beforeAll(async () => {
    const target = await prisma.invitation.create({
      data: { teacherId, email: putEmail, firstName: 'Put', lastName: 'Target' },
    });
    putTargetId = target.id;
  });

  it('updates a pending contact and stores a changed email lowercased', async () => {
    // Mixed-case on the wire — inviteContact's own lowercasing test
    // (students-api.test.ts) does the same, and PUT must match it: this is
    // the same column, so a case slip here reopens the mismatch #166's
    // normalisation exists to prevent.
    const typed = `INV-PUT-UPDATED-${suffix}@Test.Local`;
    const res = await fetch(`${BASE_URL}/api/invitations/${putTargetId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Updated', email: typed }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string } };
    expect(json.data.id).toBe(putTargetId);

    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: putTargetId } });
    expect(row.firstName).toBe('Updated');
    expect(row.email).toBe(typed.toLowerCase());
  });

  it('refuses an unknown field with a 400, not a silent drop', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations/${putTargetId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ nickname: 'Nope' }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses to update a declined row with the same 409 DELETE uses, because an edited address would sidestep the tombstone', async () => {
    const putDeclinedEmail = `inv-put-declined-${suffix}@test.local`;
    let declined: { id: string } | undefined;
    try {
      declined = await prisma.invitation.create({
        data: { teacherId, email: putDeclinedEmail, status: 'declined', respondedAt: new Date() },
        select: { id: true },
      });

      const res = await fetch(`${BASE_URL}/api/invitations/${declined.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ email: `inv-put-escape-${suffix}@test.local` }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('DECLINED_IS_PERMANENT');

      // The address never moved — otherwise the tombstone's uniqueness key
      // (teacherId, email) would have freed `putDeclinedEmail` for a fresh
      // invite despite the 409.
      const row = await prisma.invitation.findUniqueOrThrow({ where: { id: declined.id } });
      expect(row.email).toBe(putDeclinedEmail);
    } finally {
      if (declined) await prisma.invitation.delete({ where: { id: declined.id } });
    }
  });

  it('refuses another teacher\'s invitation', async () => {
    let other: { id: string } | undefined;
    try {
      other = await createOtherTeacherInvitation('put-target');
      const res = await fetch(`${BASE_URL}/api/invitations/${other.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ firstName: 'Hijack' }),
      });
      expect(res.status).toBe(404);
      // And it truly wasn't touched.
      const row = await prisma.invitation.findUniqueOrThrow({ where: { id: other.id } });
      expect(row.firstName).toBe('Other');
    } finally {
      if (other) await prisma.invitation.deleteMany({ where: { id: other.id } });
    }
  });
});

describe('PATCH /api/invitations/[id]', () => {
  let patchTargetId: string;
  const patchEmail = `inv-patch-${suffix}@test.local`;

  beforeAll(async () => {
    const target = await prisma.invitation.create({
      data: { teacherId, email: patchEmail, firstName: 'Patch', lastName: 'Target' },
    });
    patchTargetId = target.id;
  });

  const patch = (query = '') =>
    fetch(`${BASE_URL}/api/invitations/${patchTargetId}${query}`, {
      method: 'PATCH',
      headers: cookie(teacherToken),
    });

  it('rejects a missing state rather than falling back to a toggle', async () => {
    const res = await patch();
    expect(res.status).toBe(400);
  });

  it('rejects an unrecognised state', async () => {
    const res = await patch('?state=nonsense');
    expect(res.status).toBe(400);
  });

  it("refuses another teacher's invitation, even for the state it's already in", async () => {
    let other: { id: string } | undefined;
    try {
      other = await createOtherTeacherInvitation('patch-target');
      const res = await fetch(`${BASE_URL}/api/invitations/${other.id}?state=unarchived`, {
        method: 'PATCH', headers: cookie(teacherToken),
      });
      expect(res.status).toBe(404);
      // And it truly wasn't touched.
      const row = await prisma.invitation.findUniqueOrThrow({ where: { id: other.id } });
      expect(row.isArchived).toBe(false);
    } finally {
      if (other) await prisma.invitation.deleteMany({ where: { id: other.id } });
    }
  });

  it('sets the state it names, and repeating it is a no-op that reports unchanged', async () => {
    const first = await patch('?state=archived');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { isArchived: boolean; action: string } };
    expect(firstBody.data.isArchived).toBe(true);
    expect(firstBody.data.action).toBe('archived');

    const second = await patch('?state=archived');
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { isArchived: boolean; action: string } };
    expect(secondBody.data.isArchived).toBe(true);
    expect(secondBody.data.action).toBe('unchanged');
  });

  it('un-archives, and repeating it is a no-op that reports unchanged', async () => {
    const first = await patch('?state=unarchived');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { isArchived: boolean; action: string } };
    expect(firstBody.data.isArchived).toBe(false);
    expect(firstBody.data.action).toBe('unarchived');

    const second = await patch('?state=unarchived');
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { isArchived: boolean; action: string } };
    expect(secondBody.data.isArchived).toBe(false);
    expect(secondBody.data.action).toBe('unchanged');
  });

  // Archiving is allowed on a declined row — that is the escape hatch DELETE
  // and PUT both point to instead of removing the tombstone outright.
  it('archives a declined row', async () => {
    let declined: { id: string } | undefined;
    try {
      declined = await prisma.invitation.create({
        data: {
          teacherId,
          email: `inv-patch-declined-${suffix}@test.local`,
          status: 'declined',
          respondedAt: new Date(),
        },
        select: { id: true },
      });

      const res = await fetch(`${BASE_URL}/api/invitations/${declined.id}?state=archived`, {
        method: 'PATCH', headers: cookie(teacherToken),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { isArchived: boolean; action: string } };
      expect(body.data.isArchived).toBe(true);
      expect(body.data.action).toBe('archived');
    } finally {
      if (declined) await prisma.invitation.delete({ where: { id: declined.id } });
    }
  });
});

describe('POST /api/invitations/[id]/respond', () => {
  // The account's own email is stored exactly as typed at sign-up, unlike
  // `Invitation.email`, which `inviteContact` and `PUT` both lowercase on
  // write (services/invitations.ts). Mixed case here is deliberate: it is
  // what proves `acceptInvitation`/`declineInvitation` lowercase before
  // matching, rather than merely happening to compare equal because both
  // fixtures used the same case.
  const acceptEmail = `Accept-Responder-${suffix}@Test.Local`;
  const declineEmail = `Decline-Responder-${suffix}@Test.Local`;

  let respondingStudentId: string;
  let respondingAccountId: string;
  let respondingToken: string;

  let decliningStudentId: string;
  let decliningAccountId: string;
  let decliningToken: string;

  let inviteId: string;
  let declineId: string;
  let otherPersonsInviteId: string;

  beforeAll(async () => {
    const responder = await prisma.student.create({
      data: {
        firstName: 'Accept', lastName: 'Responder',
        email: acceptEmail, claimedAt: new Date(),
        account: { create: { email: acceptEmail } },
      },
      select: { id: true, accountId: true },
    });
    respondingStudentId = responder.id;
    respondingAccountId = responder.accountId as string;
    respondingToken = await seedSession(prisma, respondingAccountId);

    const decliner = await prisma.student.create({
      data: {
        firstName: 'Decline', lastName: 'Responder',
        email: declineEmail, claimedAt: new Date(),
        account: { create: { email: declineEmail } },
      },
      select: { id: true, accountId: true },
    });
    decliningStudentId = decliner.id;
    decliningAccountId = decliner.accountId as string;
    decliningToken = await seedSession(prisma, decliningAccountId);

    const invite = await prisma.invitation.create({
      data: {
        teacherId, email: acceptEmail.toLowerCase(), firstName: 'Accept', lastName: 'Responder',
      },
    });
    inviteId = invite.id;

    const decline = await prisma.invitation.create({
      data: {
        teacherId, email: declineEmail.toLowerCase(), firstName: 'Decline', lastName: 'Responder',
      },
    });
    declineId = decline.id;

    // Addressed to neither responder — proves the guard rejects on the
    // ADDRESS mismatch, not merely because this teacher differs from theirs.
    const otherPersons = await prisma.invitation.create({
      data: {
        teacherId: otherTeacherId,
        email: `inv-stranger-${suffix}@test.local`,
        firstName: 'Stranger',
        lastName: 'Contact',
      },
    });
    otherPersonsInviteId = otherPersons.id;
  });

  afterAll(async () => {
    // The file's own afterAll (top of file) sweeps Invitation by teacherId
    // and Teacher/Account by the two teacher fixtures — it has never had a
    // Student fixture to clean up before this describe, so that sweep does
    // not reach these rows. Deleting a Student profile does not take its
    // Account with it, so both are swept here explicitly.
    const studentIds = [respondingStudentId, decliningStudentId].filter(Boolean);
    const studentAccountIds = [respondingAccountId, decliningAccountId].filter(Boolean);
    if (studentIds.length) {
      await prisma.teacherStudent.deleteMany({ where: { studentId: { in: studentIds } } });
    }
    if (studentAccountIds.length) {
      await prisma.session.deleteMany({ where: { accountId: { in: studentAccountIds } } });
    }
    if (studentIds.length) {
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    if (studentAccountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: studentAccountIds } } });
    }
  });

  const respond = (id: string, token: string, response: 'accept' | 'decline') =>
    fetch(`${BASE_URL}/api/invitations/${id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify({ response }),
    });

  it('accepting creates the link and stamps the row', async () => {
    const res = await respond(inviteId, respondingToken, 'accept');
    expect(res.status).toBe(200);

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: respondingStudentId } },
    });
    expect(link).not.toBeNull();
    const inv = await prisma.invitation.findUniqueOrThrow({ where: { id: inviteId } });
    expect(inv.status).toBe('accepted');
    expect(inv.respondedAt).not.toBeNull();
  });

  it('declining leaves no link and blocks a re-invite', async () => {
    const res = await respond(declineId, decliningToken, 'decline');
    expect(res.status).toBe(200);
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: decliningStudentId } },
    })).toBeNull();

    const reinvite = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'A', lastName: 'B', email: declineEmail }),
    });
    expect(reinvite.status).toBe(409);
    expect((await reinvite.json()).error.code).toBe('DECLINED');
  });

  it('refuses to accept an already-declined invitation, even by its rightful owner', async () => {
    // Without acceptInvitation's own pending check, its rightful owner could
    // re-POST accept on the same invitation after declining it, resurrecting
    // the link they refused and overwriting the tombstone that (per Task 4's
    // PUT/DELETE) is supposed to be permanent.
    const res = await respond(declineId, decliningToken, 'accept');
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('ALREADY_ANSWERED');
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: decliningStudentId } },
    })).toBeNull();
    const inv = await prisma.invitation.findUniqueOrThrow({ where: { id: declineId } });
    expect(inv.status).toBe('declined');
  });

  it('refuses an invitation addressed to someone else', async () => {
    // The id is the only thing the caller supplies; the address is what
    // authorizes them. This is gate 4 — without it, any signed-in student
    // who guesses or obtains an id accepts on a stranger's behalf.
    const res = await respond(otherPersonsInviteId, respondingToken, 'accept');
    expect(res.status).toBe(404);
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: otherTeacherId, studentId: respondingStudentId } },
    })).toBeNull();
  });

  it('refuses to decline an invitation addressed to someone else', async () => {
    // declineInvitation has its own copy of the email match — this is the
    // test that can actually fail it, since every other decline test in
    // this file uses the invitation's rightful owner. An unguarded decline
    // here would write a *permanent* tombstone (Task 4's PUT/DELETE both
    // refuse to touch a declined row) against an address the caller does
    // not own — a denial-of-service against whoever the invitation
    // actually belongs to.
    const res = await respond(otherPersonsInviteId, respondingToken, 'decline');
    expect(res.status).toBe(404);
    const inv = await prisma.invitation.findUniqueOrThrow({ where: { id: otherPersonsInviteId } });
    expect(inv.status).toBe('pending');
  });

  it('refuses a second response to the same invitation', async () => {
    const again = await respond(inviteId, respondingToken, 'decline');
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('ALREADY_ANSWERED');
  });

  it('refuses a teacher-only session', async () => {
    const res = await respond(inviteId, teacherToken, 'accept');
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/teacher-links/[teacherId]', () => {
  // The canonical, lowercase form of this student's address — the shape
  // `Invitation.email` is always stored in (inviteContact,
  // services/invitations.ts). Every DB lookup below, and the re-invite
  // POST body, use this literal string.
  const studentEmail = `unlink-student-${suffix}@test.local`;

  // The signed-in account's OWN email, typed as at sign-up per this app's
  // Account.email convention (never normalised) — deliberately a
  // DIFFERENT, mixed-case string from `studentEmail` above. `unlinkTeacher`
  // has its own `.toLowerCase()` call on this value, independent of
  // `acceptInvitation`/`declineInvitation`'s (respond describe, above).
  // A same-case fixture here would make that normalisation a no-op no test
  // could tell apart from its absence — this is what F1 in review caught.
  const studentAccountEmail = `Unlink-Student-${suffix}@Test.Local`;

  let studentId: string;
  let studentAccountId: string;
  let studentToken: string;

  // The link this student severs first, under the file's own `teacherId`
  // fixture. No Invitation row is ever created for (teacherId, studentEmail)
  // — this link exists purely because the student booked a class, which is
  // exactly the shape that must produce a `student_block` tombstone.
  //
  // A second teacher who separately typed this same address into their own
  // CRM before the student ever unlinked — this is what proves the
  // tombstone does NOT downgrade a row the teacher is entitled to.
  let invitingTeacherId: string;
  let invitingTeacherAccountId: string;

  // A registration (and its payment) the student holds under `teacherId` —
  // proof that unlinking never reaches these. Money may be owed.
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  let registrationId: string;

  beforeAll(async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'Unlink', lastName: 'Student',
        email: studentEmail, claimedAt: new Date(),
        account: { create: { email: studentAccountEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);

    await prisma.teacherStudent.create({ data: { teacherId, studentId } });

    const invitingTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Inviting', lastName: 'Teacher',
        email: `unlink-inviting-${suffix}@test.local`,
        account: { create: { email: `unlink-inviting-${suffix}@test.local` } },
        bio: 'Second-teacher fixture for the origin-preserving unlink test',
        pageSlug: `unlink-inviting-${suffix}`,
      },
    });
    invitingTeacherId = invitingTeacher.id;
    invitingTeacherAccountId = invitingTeacher.accountId;

    // A real, already-accepted Invitation — what an existing
    // (teacherId, email) row looks like when the teacher genuinely typed
    // the address themselves, as opposed to the tombstone `unlinkTeacher`
    // writes when no such row exists.
    await prisma.invitation.create({
      data: {
        teacherId: invitingTeacherId, email: studentEmail,
        firstName: 'Unlink', lastName: 'Student',
        status: 'accepted', origin: 'teacher_invite', respondedAt: new Date(),
      },
    });
    await prisma.teacherStudent.create({ data: { teacherId: invitingTeacherId, studentId } });

    const room = await prisma.room.create({
      data: {
        venueName: 'Unlink Studio', address: `${suffix} Unlink St`, city: 'Amsterdam',
        postcode: '1111UL', maxCapacity: 10, createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 10, rentalRate: 30 },
    });
    teacherRoomId = teacherRoom.id;
    const cls = await prisma.class.create({
      data: {
        teacherId, teacherRoomId: teacherRoom.id, classType: 'Vinyasa', date: new Date(),
        startTime: '09:00', durationMinutes: 60, roomCost: 30,
        minRate: 15, targetRate: 25, minStudents: 2, maxStudents: 10,
        status: 'completed', settingsLocked: true,
      },
    });
    classId = cls.id;
    const registration = await prisma.registration.create({
      data: {
        classId, studentId, status: 'attended', tierAtBooking: 3, price: 6.11, tierRatio: 1,
      },
    });
    registrationId = registration.id;
    await prisma.payment.create({ data: { registrationId, amount: 6.11, status: 'pending' } });
  });

  afterAll(async () => {
    // Child-to-parent order throughout, and `deleteMany` rather than
    // `delete` everywhere a mutation test above could plausibly have
    // already removed the row for real (the student.delete mutation in
    // particular) — cleanup must not throw over that.
    if (registrationId) await prisma.payment.deleteMany({ where: { registrationId } });
    if (classId) await prisma.registration.deleteMany({ where: { classId } });
    if (classId) await prisma.class.deleteMany({ where: { id: classId } });
    if (teacherRoomId) await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });

    // The file's top-level afterAll sweeps Invitation/Teacher/Account for
    // `teacherId` (this describe reuses that fixture), including whatever
    // tombstone this describe wrote under it. `invitingTeacherId` is local
    // to this describe, so its own Invitation/Teacher/Account rows are not
    // in that sweep and are cleaned up here instead.
    await prisma.teacherStudent.deleteMany({ where: { studentId } });
    await prisma.invitation.deleteMany({ where: { teacherId: invitingTeacherId } });
    if (studentAccountId) {
      await prisma.session.deleteMany({ where: { accountId: studentAccountId } });
    }
    if (studentId) await prisma.student.deleteMany({ where: { id: studentId } });
    if (studentAccountId) await prisma.account.deleteMany({ where: { id: studentAccountId } });

    if (invitingTeacherId) await prisma.teacher.deleteMany({ where: { id: invitingTeacherId } });
    if (invitingTeacherAccountId) {
      await prisma.account.deleteMany({ where: { id: invitingTeacherAccountId } });
    }
  });

  it('removes the link and leaves the student account intact', async () => {
    const res = await fetch(`${BASE_URL}/api/teacher-links/${teacherId}`, {
      method: 'DELETE', headers: cookie(studentToken),
    });
    expect(res.status).toBe(200);
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    })).toBeNull();

    // The account must survive. The route this replaces
    // (students/[id]/route.ts:201-206) deleted the Student row when its
    // last link went; nothing student-facing may ever do that.
    const student = await prisma.student.findUnique({ where: { id: studentId } });
    expect(student).not.toBeNull();
    expect(student!.deletedAt).toBeNull();
  });

  it('writes an invisible tombstone when the link came from a booking', async () => {
    // Raw body, not the parsed row list or a DB-level field read: a leak
    // through some other field (or a route that stops filtering by origin)
    // fails here, printing the address in the failure diff, where a
    // row-count or single-field assertion would not. This has to run
    // before the field-level checks below — a wrong `origin` on write would
    // otherwise be caught by the DB read first, which proves the write is
    // wrong but not that it leaked.
    const list = await fetch(`${BASE_URL}/api/invitations`, { headers: cookie(teacherToken) });
    expect(await list.text()).not.toContain(studentEmail);

    // Same ordering reason in the other direction: this has to run before
    // the DB read too, so a missing tombstone (no row at all, not just the
    // wrong origin) fails HERE with the re-invite wrongly succeeding,
    // rather than as a not-found error out of `findUniqueOrThrow` below.
    const reinvite = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'A', lastName: 'B', email: studentEmail }),
    });
    expect(reinvite.status).toBe(409);

    const tombstone = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email: studentEmail } },
    });
    expect(tombstone.status).toBe('declined');
    expect(tombstone.origin).toBe('student_block');
  });

  it('keeps the teacher_invite origin when one already existed', async () => {
    const res = await fetch(`${BASE_URL}/api/teacher-links/${invitingTeacherId}`, {
      method: 'DELETE', headers: cookie(studentToken),
    });
    expect(res.status).toBe(200);

    // The teacher typed that address; they already have it. Downgrading
    // the row to student_block would hide a contact they are entitled to.
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId: invitingTeacherId, email: studentEmail } },
    });
    expect(row.origin).toBe('teacher_invite');
    expect(row.status).toBe('declined');
  });

  it('leaves registrations and payments alone', async () => {
    expect(await prisma.registration.count({ where: { studentId } })).toBeGreaterThan(0);
  });

  it('404s when no link exists', async () => {
    const res = await fetch(`${BASE_URL}/api/teacher-links/${otherTeacherId}`, {
      method: 'DELETE', headers: cookie(studentToken),
    });
    expect(res.status).toBe(404);
  });
});
