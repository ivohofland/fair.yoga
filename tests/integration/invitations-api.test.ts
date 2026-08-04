import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { inviteContact, notifyInvitee } from '@/services/invitations';
import { promoteNext } from '@/services/waitlist';
import { BASE_URL, cookie, uniqueSuffix, seedSession, waitFor } from '../helpers';

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
  // FK order: invitation/teacherBlock -> session -> teacher -> account.
  // Scoped by `in: [...]` over both teachers' ids/accountIds rather than one
  // delete per known row, so this also sweeps anything a single `it()`
  // created inline (declined rows, blocks) without that test needing its
  // own afterAll.
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
    await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
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

  it('lists an invitation for a blocked address exactly like any other', async () => {
    // The block lives in `TeacherBlock` now, not on this row (#166 task
    // 6c) — there is no filter left in GET to prove absent. What is left to
    // prove is the point of moving it, so this needs a control: a second,
    // unblocked invitation with the same names, to show the blocked row's
    // list entry isn't merely present but field-for-field indistinguishable
    // from one with no block behind it.
    const blockedEmail = `inv-blocked-${suffix}@test.local`;
    const controlEmail = `inv-blocked-control-${suffix}@test.local`;
    let block: { id: string } | undefined;
    let invitation: { id: string } | undefined;
    let control: { id: string } | undefined;
    try {
      block = await prisma.teacherBlock.create({
        data: { teacherId, email: blockedEmail },
        select: { id: true },
      });
      invitation = await prisma.invitation.create({
        data: { teacherId, email: blockedEmail, firstName: 'Blocked', lastName: 'Contact' },
        select: { id: true },
      });
      control = await prisma.invitation.create({
        data: { teacherId, email: controlEmail, firstName: 'Blocked', lastName: 'Contact' },
        select: { id: true },
      });

      const res = await fetch(`${BASE_URL}/api/invitations`, { headers: cookie(teacherToken) });
      const json = (await res.json()) as {
        data: {
          invitations: Array<{
            id: string; email: string; firstName: string; lastName: string;
            status: string; isArchived: boolean;
          }>;
        };
      };
      const blockedRow = json.data.invitations.find((i) => i.email === blockedEmail);
      const controlRow = json.data.invitations.find((i) => i.email === controlEmail);
      expect(blockedRow).toBeDefined();
      expect(controlRow).toBeDefined();

      // Same shape (no extra field leaking the block). Values compared below
      // skip only fields that were never going to match regardless of any
      // block: `id`/`email` are per-row lookup keys, `createdAt` is
      // wall-clock and these two rows were created moments apart.
      expect(Object.keys(blockedRow!).sort()).toEqual(Object.keys(controlRow!).sort());
      expect(blockedRow!.firstName).toBe(controlRow!.firstName);
      expect(blockedRow!.lastName).toBe(controlRow!.lastName);
      expect(blockedRow!.status).toBe(controlRow!.status);
      expect(blockedRow!.isArchived).toBe(controlRow!.isArchived);
    } finally {
      if (invitation) await prisma.invitation.delete({ where: { id: invitation.id } });
      if (control) await prisma.invitation.delete({ where: { id: control.id } });
      if (block) await prisma.teacherBlock.delete({ where: { id: block.id } });
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

  it('refuses to accept when a block exists for the address, even with a valid id and the rightful account', async () => {
    // Defence in depth (#166 task 6c): Task 11's student-side pending query
    // is supposed to keep a blocked pair off this student's list entirely,
    // so this id should never reach a real caller this way. But the id
    // travels in a URL, not a secret, and this proves `acceptInvitation`
    // refuses on its own — same 404 as an unknown id, so a probing caller
    // learns nothing a stranger's id wouldn't also tell them.
    const blockedRespondEmail = `inv-respond-blocked-${suffix}@test.local`;
    let blockedInvite: { id: string } | undefined;
    let block: { id: string } | undefined;
    let blockedStudentId: string | undefined;
    let blockedAccountId: string | undefined;
    try {
      const blockedStudent = await prisma.student.create({
        data: {
          firstName: 'Blocked', lastName: 'Responder',
          email: blockedRespondEmail, claimedAt: new Date(),
          account: { create: { email: blockedRespondEmail } },
        },
        select: { id: true, accountId: true },
      });
      blockedStudentId = blockedStudent.id;
      blockedAccountId = blockedStudent.accountId as string;
      const blockedToken = await seedSession(prisma, blockedAccountId);

      block = await prisma.teacherBlock.create({
        data: { teacherId, email: blockedRespondEmail },
        select: { id: true },
      });
      blockedInvite = await prisma.invitation.create({
        data: { teacherId, email: blockedRespondEmail, firstName: 'Blocked', lastName: 'Responder' },
        select: { id: true },
      });

      const res = await respond(blockedInvite.id, blockedToken, 'accept');
      expect(res.status).toBe(404);
      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId, studentId: blockedStudentId } },
      })).toBeNull();
      const inv = await prisma.invitation.findUniqueOrThrow({ where: { id: blockedInvite.id } });
      expect(inv.status).toBe('pending');
    } finally {
      if (blockedInvite) await prisma.invitation.deleteMany({ where: { id: blockedInvite.id } });
      if (block) await prisma.teacherBlock.deleteMany({ where: { id: block.id } });
      if (blockedStudentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId: blockedStudentId } });
      }
      if (blockedAccountId) {
        await prisma.session.deleteMany({ where: { accountId: blockedAccountId } });
      }
      if (blockedStudentId) await prisma.student.deleteMany({ where: { id: blockedStudentId } });
      if (blockedAccountId) await prisma.account.deleteMany({ where: { id: blockedAccountId } });
    }
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
  // the shape `unlinkTeacher` must turn into a `TeacherBlock` with no
  // Invitation side effect at all.
  //
  // A second teacher who separately typed this same address into their own
  // CRM before the student ever unlinked — this is what proves an existing
  // invitation is marked honestly declined rather than left untouched.
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
        bio: 'Second-teacher fixture for the existing-invitation unlink test',
        pageSlug: `unlink-inviting-${suffix}`,
      },
    });
    invitingTeacherId = invitingTeacher.id;
    invitingTeacherAccountId = invitingTeacher.accountId;

    // A real, already-accepted Invitation — what an existing
    // (teacherId, email) row looks like when the teacher genuinely typed
    // the address themselves, as opposed to the booking-only link under
    // `teacherId` above, which has no Invitation row at all.
    await prisma.invitation.create({
      data: {
        teacherId: invitingTeacherId, email: studentEmail,
        firstName: 'Unlink', lastName: 'Student',
        status: 'accepted', respondedAt: new Date(),
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

    // The file's top-level afterAll sweeps Invitation/TeacherBlock/Teacher/
    // Account for `teacherId` (this describe reuses that fixture), including
    // whatever block this describe wrote under it. `invitingTeacherId` is
    // local to this describe, so its own rows are not in that sweep and are
    // cleaned up here instead.
    await prisma.teacherStudent.deleteMany({ where: { studentId } });
    await prisma.invitation.deleteMany({ where: { teacherId: invitingTeacherId } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: invitingTeacherId } });
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

  it('blocks a booking-only unlink without writing an Invitation row, and a re-invite is a normal, undelivered one', async () => {
    // This link came from a booking — no Invitation row was ever created for
    // (teacherId, studentEmail) — so `unlinkTeacher`'s `updateMany` matched
    // nothing above. The block it wrote is the only trace this unlink left.
    expect(await prisma.invitation.findUnique({
      where: { teacherId_email: { teacherId, email: studentEmail } },
    })).toBeNull();
    expect(await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId, email: studentEmail } },
    })).not.toBeNull();

    // Through the service directly, not the HTTP route, so the re-invite
    // this unlink is supposed to silently defang can be checked end to
    // end — `delivered` never reaches the wire (POST /api/students returns
    // only `id`), so this is the only way to prove the chain from a REAL
    // unlink through to an undelivered re-invite, rather than from a block
    // fabricated directly via Prisma the way the block-oracle describe does.
    const reinvite = await inviteContact(prisma, {
      teacherId, email: studentEmail, firstName: 'A', lastName: 'B',
    });
    if (!reinvite.ok) throw new Error('expected the re-invite to succeed');
    expect(reinvite.value.delivered).toBe(false);

    // Unlike the design this replaces, the row this creates is completely
    // ordinary — listed, not a tombstone — because the block that makes it
    // undeliverable no longer lives inside it.
    const list = await fetch(`${BASE_URL}/api/invitations`, { headers: cookie(teacherToken) });
    const json = (await list.json()) as { data: { invitations: Array<{ email: string }> } };
    expect(json.data.invitations.map((i) => i.email)).toContain(studentEmail);

    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: reinvite.value.id } });
    expect(row.status).toBe('pending');

    // And the block itself is untouched — this is what actually withholds
    // delivery.
    expect(await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId, email: studentEmail } },
    })).not.toBeNull();
  });

  it('marks an existing invitation honestly declined, and blocks it too', async () => {
    const res = await fetch(`${BASE_URL}/api/teacher-links/${invitingTeacherId}`, {
      method: 'DELETE', headers: cookie(studentToken),
    });
    expect(res.status).toBe(200);

    // The teacher typed that address; their own invitation stays theirs to
    // see, now honestly declined. There is no origin left to preserve or
    // downgrade — every Invitation row behaves the same way now.
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId: invitingTeacherId, email: studentEmail } },
    });
    expect(row.status).toBe('declined');

    // The block is written regardless of whether an invitation existed —
    // it is what actually stops a re-invite, invitation or not.
    expect(await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: invitingTeacherId, email: studentEmail } },
    })).not.toBeNull();
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

describe('POST /api/students — the block oracle (#166 task 6b, mechanism moved in 6c)', () => {
  // Stateless, so shared by the tests below rather than redefined per test —
  // each supplies its own target address and its own fixture.
  const post = (email: string) =>
    fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Zzz', lastName: 'Qqq', email }),
    });

  it('answers a blocked address exactly as a fresh one, including on a repeat POST', async () => {
    // The block now lives in `TeacherBlock`, not as a row shape to simulate
    // in Invitation — there is no tombstone to construct here, only the
    // block itself. Created directly via Prisma rather than through
    // DELETE /api/teacher-links/[teacherId]: that route's own block-write
    // behaviour is already exercised end-to-end above.
    const blockedEmail = `inv-silent-blocked-${suffix}@test.local`;
    const freshEmail = `inv-silent-fresh-${suffix}@test.local`;
    let block: { id: string } | undefined;
    try {
      block = await prisma.teacherBlock.create({
        data: { teacherId, email: blockedEmail },
        select: { id: true },
      });

      const [blockedRes, freshRes] = await Promise.all([post(blockedEmail), post(freshEmail)]);

      expect(blockedRes.status).toBe(freshRes.status);
      expect(blockedRes.status).toBe(201);
      const blockedJson = (await blockedRes.json()) as { data: { id: string } };
      const freshJson = (await freshRes.json()) as { data: { id: string } };
      expect(Object.keys(blockedJson.data)).toEqual(Object.keys(freshJson.data));

      // Unlike the design this replaces, the first POST to a blocked address
      // really does create a row — so a second POST to either address now
      // refuses the same way, for the same reason: both are already invited.
      const [blockedAgain, freshAgain] = await Promise.all([post(blockedEmail), post(freshEmail)]);
      expect(blockedAgain.status).toBe(freshAgain.status);
      expect(blockedAgain.status).toBe(409);
      expect((await blockedAgain.json()).error.code).toBe('ALREADY_INVITED');
      expect((await freshAgain.json()).error.code).toBe('ALREADY_INVITED');

      // The row the first POST created is real and ordinary — pending —
      // and the block that makes it undeliverable sits beside it, untouched.
      const created = await prisma.invitation.findUniqueOrThrow({
        where: { id: blockedJson.data.id },
      });
      expect(created.status).toBe('pending');
      expect(await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId, email: blockedEmail } },
      })).not.toBeNull();
    } finally {
      if (block) await prisma.teacherBlock.deleteMany({ where: { id: block.id } });
      await prisma.invitation.deleteMany({
        where: { teacherId, email: { in: [blockedEmail, freshEmail] } },
      });
    }
  });

  it('still refuses a declined invitation honestly', async () => {
    // Contrast case, and the reason this is not a blanket change: the
    // teacher typed THIS address themselves, so 409 discloses nothing new —
    // and a teacher deserves to know their invitation is dead rather than
    // re-sending into silence. No block involved at all.
    const declinedInviteEmail = `inv-silent-honest-${suffix}@test.local`;
    let declined: { id: string } | undefined;
    try {
      declined = await prisma.invitation.create({
        data: { teacherId, email: declinedInviteEmail, status: 'declined', respondedAt: new Date() },
        select: { id: true },
      });

      const res = await post(declinedInviteEmail);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('DECLINED');
    } finally {
      if (declined) await prisma.invitation.deleteMany({ where: { id: declined.id } });
    }
  });

  it('marks a blocked address undelivered and a fresh one delivered', async () => {
    // `delivered` is not on the HTTP wire (POST /api/students returns only
    // `id`) — it exists for `notifyInvitee`'s caller (route.ts), which
    // gates its send on this after `inviteContact` succeeds (#166 task 8).
    // So this calls the service directly rather than through `post` above:
    // that is where the field this guards actually lives.
    const blockedEmail = `inv-delivered-blocked-${suffix}@test.local`;
    const freshEmail = `inv-delivered-fresh-${suffix}@test.local`;
    let block: { id: string } | undefined;
    try {
      block = await prisma.teacherBlock.create({
        data: { teacherId, email: blockedEmail },
        select: { id: true },
      });

      const blockedResult = await inviteContact(prisma, {
        teacherId, email: blockedEmail, firstName: 'Zzz', lastName: 'Qqq',
      });
      const freshResult = await inviteContact(prisma, {
        teacherId, email: freshEmail, firstName: 'Zzz', lastName: 'Qqq',
      });

      if (!blockedResult.ok) throw new Error('expected the blocked address to succeed');
      if (!freshResult.ok) throw new Error('expected a fresh invite to succeed');
      expect(blockedResult.value.delivered).toBe(false);
      expect(freshResult.value.delivered).toBe(true);
    } finally {
      if (block) await prisma.teacherBlock.deleteMany({ where: { id: block.id } });
      await prisma.invitation.deleteMany({
        where: { teacherId, email: { in: [blockedEmail, freshEmail] } },
      });
    }
  });

  it('survives deleting the invitation it made: re-inviting a blocked address after deletion is still undelivered', async () => {
    // The case the old design's four special cases would have existed to
    // handle: under it, `inviteContact` never created a real row for a
    // blocked address, so there was nothing here to delete and re-create.
    // With the block held separately, deleting the invitation is just
    // deleting a row — the block underneath it is a different table and
    // does not move.
    const blockedEmail = `inv-block-survives-delete-${suffix}@test.local`;
    let block: { id: string } | undefined;
    try {
      block = await prisma.teacherBlock.create({
        data: { teacherId, email: blockedEmail },
        select: { id: true },
      });

      const first = await inviteContact(prisma, {
        teacherId, email: blockedEmail, firstName: 'Zzz', lastName: 'Qqq',
      });
      if (!first.ok) throw new Error('expected the first invite to succeed');
      expect(first.value.delivered).toBe(false);

      const res = await fetch(`${BASE_URL}/api/invitations/${first.value.id}`, {
        method: 'DELETE', headers: cookie(teacherToken),
      });
      expect(res.status).toBe(200);
      expect(await prisma.invitation.findUnique({ where: { id: first.value.id } })).toBeNull();

      const second = await inviteContact(prisma, {
        teacherId, email: blockedEmail, firstName: 'Zzz', lastName: 'Qqq',
      });
      if (!second.ok) throw new Error('expected the re-invite to succeed');
      expect(second.value.id).not.toBe(first.value.id);
      expect(second.value.delivered).toBe(false);
    } finally {
      if (block) await prisma.teacherBlock.deleteMany({ where: { id: block.id } });
      await prisma.invitation.deleteMany({ where: { teacherId, email: blockedEmail } });
    }
  });
});

describe('POST /api/students notifies the invitee (#166 task 8)', () => {
  it('creates an in-app notification for a registered invitee', async () => {
    const registeredEmail = `notify-registered-${suffix}@test.local`;
    let student: { id: string } | undefined;
    try {
      student = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'Registered', email: registeredEmail },
        select: { id: true },
      });

      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ firstName: 'A', lastName: 'B', email: registeredEmail }),
      });
      expect(res.status).toBe(201);

      // The route calls `notifyInvitee` fire-and-forget (F1, #166 review) —
      // it is not on the request's critical path on purpose, so the write
      // below can still be in flight when `fetch` above resolves. `waitFor`
      // polls with `findFirst` (null until the row lands, unlike `findMany`,
      // which would return a truthy `[]` on the very first check and defeat
      // the poll) rather than asserting immediately — the same way this
      // would have to work if it were driving the real app instead of
      // calling it in-process.
      await waitFor(
        () =>
          prisma.notification.findFirst({
            where: { recipientType: 'student', recipientId: student!.id, type: 'teacher_invitation' },
          }),
        { description: 'registered invitee teacher_invitation notification (#166 task 8 delivery)' },
      );
      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.title).toBe('A teacher would like to connect');
    } finally {
      await prisma.invitation.deleteMany({ where: { teacherId, email: registeredEmail } });
      if (student) {
        await prisma.notification.deleteMany({ where: { recipientId: student.id } });
        await prisma.student.delete({ where: { id: student.id } });
      }
    }
  });

  it('creates no notification for an address with no Student row, and still answers 201', async () => {
    const strangerEmail = `notify-stranger-${suffix}@test.local`;
    // No `recipientId` exists for a stranger to check an absence against
    // directly, so this can only prove "no notification" via a bracketing
    // count — and a count read immediately after `fetch` resolves proved
    // nothing on its own (F6, review): delivery is fire-and-forget (F1), so
    // a stray write, if a regression produced one, could simply not have
    // landed by the time the count is re-read.
    //
    // Fix: invite a second, CONTROL address with its own Student row, issued
    // strictly after the stranger's, and `waitFor` the control's own
    // notification before taking the final count. Delivery runs
    // sequentially from this single process, so once the later-issued
    // control's write is confirmed, the stranger's — if it existed — would
    // have landed too.
    const controlEmail = `notify-stranger-control-${suffix}@test.local`;
    const before = await prisma.notification.count({ where: { type: 'teacher_invitation' } });
    let controlStudent: { id: string } | undefined;
    try {
      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ firstName: 'A', lastName: 'B', email: strangerEmail }),
      });
      expect(res.status).toBe(201);

      controlStudent = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'StrangerControl', email: controlEmail },
        select: { id: true },
      });
      const controlRes = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ firstName: 'A', lastName: 'B', email: controlEmail }),
      });
      expect(controlRes.status).toBe(201);
      await waitFor(
        () =>
          prisma.notification.findFirst({
            where: {
              recipientType: 'student',
              recipientId: controlStudent!.id,
              type: 'teacher_invitation',
            },
          }),
        { description: "stranger test's control teacher_invitation notification (#166 task 8 F6)" },
      );

      // Only the control's own row exists — the stranger contributed none,
      // even though a stray write from it has now had at least as long to
      // land as the control's confirmed one did.
      const after = await prisma.notification.count({ where: { type: 'teacher_invitation' } });
      expect(after).toBe(before + 1);
    } finally {
      await prisma.invitation.deleteMany({
        where: { teacherId, email: { in: [strangerEmail, controlEmail] } },
      });
      if (controlStudent) {
        await prisma.notification.deleteMany({ where: { recipientId: controlStudent.id } });
        await prisma.student.delete({ where: { id: controlStudent.id } });
      }
    }
  });

  it('withholds delivery entirely from a blocked address, even when it belongs to a registered student', async () => {
    // The strongest fixture for this guard: a blocked address that ALSO has
    // a Student row — the one case that can leave a Notification row behind
    // to prove a dropped guard, since a stranger address has no recipientId
    // to attach one to either way.
    //
    // Reading `notifications` immediately after `fetch` resolves proved
    // nothing on its own (F6, review): delivery is fire-and-forget (F1), so
    // a dropped guard's write would very likely still be in flight at that
    // point, passing this test by accident.
    //
    // Fix: invite a second, CONTROL address with its own Student row and no
    // block, issued strictly after the blocked one, and `waitFor` the
    // control's own notification before asserting the blocked one's
    // absence. Delivery runs sequentially from this single process, so once
    // the control's write is confirmed, the blocked one's would have landed
    // too, if it were ever going to.
    //
    // Two independent gates stand between a blocked address and a send now
    // (F3, review): route.ts's `if (result.value.delivered)` and
    // `notifyInvitee`'s own `TeacherBlock` re-check. Both must be removed
    // together for this test to fail — see this branch's mutation record
    // (task-8-report.md) for the confirmed failure.
    const blockedRegisteredEmail = `notify-blocked-registered-${suffix}@test.local`;
    const controlEmail = `notify-blocked-control-${suffix}@test.local`;
    let student: { id: string } | undefined;
    let block: { id: string } | undefined;
    let controlStudent: { id: string } | undefined;
    try {
      student = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'BlockedRegistered', email: blockedRegisteredEmail },
        select: { id: true },
      });
      block = await prisma.teacherBlock.create({
        data: { teacherId, email: blockedRegisteredEmail },
        select: { id: true },
      });

      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ firstName: 'A', lastName: 'B', email: blockedRegisteredEmail }),
      });
      // Same 201 as any other address — the block withholds delivery, not
      // the invitation's creation (inviteContact, services/invitations.ts).
      expect(res.status).toBe(201);

      controlStudent = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'BlockedControl', email: controlEmail },
        select: { id: true },
      });
      const controlRes = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ firstName: 'A', lastName: 'B', email: controlEmail }),
      });
      expect(controlRes.status).toBe(201);
      await waitFor(
        () =>
          prisma.notification.findFirst({
            where: {
              recipientType: 'student',
              recipientId: controlStudent!.id,
              type: 'teacher_invitation',
            },
          }),
        { description: "blocked-address test's control teacher_invitation notification (#166 task 8 F6)" },
      );

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(0);
    } finally {
      if (block) await prisma.teacherBlock.deleteMany({ where: { id: block.id } });
      await prisma.invitation.deleteMany({
        where: { teacherId, email: { in: [blockedRegisteredEmail, controlEmail] } },
      });
      if (student) {
        await prisma.notification.deleteMany({ where: { recipientId: student.id } });
        await prisma.student.delete({ where: { id: student.id } });
      }
      if (controlStudent) {
        await prisma.notification.deleteMany({ where: { recipientId: controlStudent.id } });
        await prisma.student.delete({ where: { id: controlStudent.id } });
      }
    }
  });

  it('lowercases the address before matching a Student row, so a mixed-case invitee is still found', async () => {
    // `Student.email` is never normalised (unlike `Invitation.email` —
    // notifyInvitee's own docblock, services/invitations.ts), so this calls
    // notifyInvitee directly rather than through the route: the route
    // always hands it an already-lowercased address (route.ts lowercases
    // before calling), which would make notifyInvitee's own
    // `.toLowerCase()` a no-op no HTTP-level test could tell apart from its
    // absence — the exact mistake flagged twice already on this branch. The
    // Student row is created lowercase; the address handed to
    // `notifyInvitee` is deliberately mixed case for the same account.
    const mixedCaseEmail = `Notify-Mixed-${suffix}@Test.Local`;
    const canonicalEmail = mixedCaseEmail.toLowerCase();
    let student: { id: string } | undefined;
    try {
      student = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'Mixed', email: canonicalEmail },
        select: { id: true },
      });

      await notifyInvitee(prisma, { teacherId, email: mixedCaseEmail, teacherName: 'Some Teacher' });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(1);
    } finally {
      if (student) {
        await prisma.notification.deleteMany({ where: { recipientId: student.id } });
        await prisma.student.delete({ where: { id: student.id } });
      }
    }
  });
});

describe('Booking and waitlisting resolve invitations (#166 task 7)', () => {
  // A dedicated teacher rather than the file's top-level `teacherId`: the
  // waitlist claim fixture below needs a pinned `defaultTimezone` so its
  // window math is plain UTC arithmetic — same convention as
  // waitlist-api.test.ts.
  let resolveTeacherId: string;
  let resolveTeacherAccountId: string;
  let resolveTeacherToken: string;
  let roomId: string;
  let teacherRoomId: string;

  let openClassId: string;
  let promoteClassId: string;
  let claimClassId: string;

  // Booked directly by the student, after their invitation was declined —
  // the exact shape resolveInvitationOnLink exists to reverse. Mixed case,
  // exactly as this student's own address sits on `Student.email` and
  // `Account.email` — this is what proves resolveInvitationOnLink's own
  // `.toLowerCase()` does real work rather than comparing an already-lower
  // string to itself. The file's unlink describe established the same
  // pattern at :713-720 with `Unlink-Student-...@Test.Local` (this is F1
  // from review: every fixture in this describe used to be all-lowercase by
  // construction via `uniqueSuffix()`, which made the normalisation a no-op
  // no test could tell apart from its absence). `Invitation.email` is always
  // stored lowercase — `declineEmailLower` is that canonical form, used
  // everywhere this file queries or writes an Invitation row directly.
  const declineEmail = `Resolve-Decline-${suffix}@Test.Local`;
  const declineEmailLower = declineEmail.toLowerCase();
  let declineStudentId: string;
  let declineAccountId: string;
  let declineToken: string;

  // An ordinary roster student the teacher registers themselves — proves a
  // teacher-initiated registration leaves the invitation alone.
  const rosterEmail = `resolve-roster-${suffix}@test.local`;
  let rosterStudentId: string;

  // Unlinks (writing a TeacherBlock, per unlinkTeacher above), then re-books
  // — proves the block is what gets cleared, not just the invitation.
  const unlinkEmail = `resolve-unlink-${suffix}@test.local`;
  let unlinkStudentId: string;
  let unlinkAccountId: string;
  let unlinkToken: string;

  // Promoted off the waitlist after declining — same tombstone shape as
  // `declineEmail`, resolved through promoteNext instead of a direct booking.
  const promoteEmail = `resolve-promote-${suffix}@test.local`;
  let promoteStudentId: string;

  // Claims a spot after declining — same shape again, resolved through
  // claimSpot.
  const claimEmail = `resolve-claim-${suffix}@test.local`;
  let claimStudentId: string;
  let claimAccountId: string;
  let claimToken: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Resolve', lastName: 'Teacher',
        email: `resolve-teacher-${suffix}@test.local`,
        account: { create: { email: `resolve-teacher-${suffix}@test.local` } },
        bio: 'Task 7 resolution tests',
        pageSlug: `resolve-teacher-${suffix}`,
        defaultTimezone: 'UTC',
      },
    });
    resolveTeacherId = teacher.id;
    resolveTeacherAccountId = teacher.accountId;
    resolveTeacherToken = await seedSession(prisma, resolveTeacherAccountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Resolve Studio', address: `${suffix} Resolve St`, city: 'Testville',
        postcode: '1234RS', maxCapacity: 10, createdById: resolveTeacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: resolveTeacherId, roomId, capacityOverride: 8, rentalRate: 20 },
    });
    teacherRoomId = teacherRoom.id;

    const openClass = await prisma.class.create({
      data: {
        teacherId: resolveTeacherId, teacherRoomId, classType: 'Resolve Open',
        date: new Date('2099-06-01'), startTime: '09:00', durationMinutes: 60,
        roomCost: 20, minRate: 15, targetRate: 25, minStudents: 1, maxStudents: 10,
        status: 'open',
      },
    });
    openClassId = openClass.id;

    // auto_promote window: far enough out that promoteNext's own window
    // check never trips — same trick as waitlist-api.test.ts's
    // `promoteClassId`.
    const promoteClass = await prisma.class.create({
      data: {
        teacherId: resolveTeacherId, teacherRoomId, classType: 'Resolve Promote',
        date: new Date('2099-06-01'), startTime: '09:00', durationMinutes: 60,
        roomCost: 20, minRate: 15, targetRate: 25, minStudents: 1, maxStudents: 2,
        status: 'open',
      },
    });
    promoteClassId = promoteClass.id;

    // first_come_first_claimed window: same derivation as
    // waitlist-api.test.ts's `freedSpotClassId` — 6h50m out with a HOURS_6
    // deadline puts cutoff at now−10m and deadline at now+50m.
    const now = new Date();
    const classStart = new Date(now.getTime() + (6 * 60 + 50) * 60 * 1000);
    const claimDate = new Date(
      Date.UTC(classStart.getUTCFullYear(), classStart.getUTCMonth(), classStart.getUTCDate()),
    );
    const claimStartTime = `${String(classStart.getUTCHours()).padStart(2, '0')}:${String(
      classStart.getUTCMinutes(),
    ).padStart(2, '0')}`;
    const claimClass = await prisma.class.create({
      data: {
        teacherId: resolveTeacherId, teacherRoomId, classType: 'Resolve Claim',
        date: claimDate, startTime: claimStartTime, durationMinutes: 60,
        roomCost: 20, minRate: 15, targetRate: 25, minStudents: 1, maxStudents: 1,
        cancelDeadline: 'HOURS_6', status: 'open',
      },
    });
    claimClassId = claimClass.id;

    const declineStudent = await prisma.student.create({
      data: {
        firstName: 'Resolve', lastName: 'Decline', email: declineEmail, claimedAt: new Date(),
        account: { create: { email: declineEmail } }, incomeTier: 3,
      },
      select: { id: true, accountId: true },
    });
    declineStudentId = declineStudent.id;
    declineAccountId = declineStudent.accountId as string;
    declineToken = await seedSession(prisma, declineAccountId);
    await prisma.invitation.create({
      data: {
        teacherId: resolveTeacherId, email: declineEmailLower,
        firstName: 'Resolve', lastName: 'Decline',
        status: 'accepted', respondedAt: new Date(),
      },
    });
    await prisma.teacherStudent.create({
      data: { teacherId: resolveTeacherId, studentId: declineStudentId },
    });

    // A CRM-only row — no account, the way a teacher-typed roster contact
    // looks before anyone ever signs in.
    const rosterStudent = await prisma.student.create({
      data: { firstName: 'Resolve', lastName: 'Roster', email: rosterEmail, incomeTier: 3 },
      select: { id: true },
    });
    rosterStudentId = rosterStudent.id;
    // Declined, not accepted: this is the status a broken guard would flip
    // to 'accepted' if it ran on a teacher-initiated registration — the
    // exact resurrection-of-a-tombstone the isTeacher guard exists to
    // prevent. A fixture that starts already 'accepted' can't tell a broken
    // guard from a correct one, since neither leaves an observable change.
    await prisma.invitation.create({
      data: {
        teacherId: resolveTeacherId, email: rosterEmail, firstName: 'Resolve', lastName: 'Roster',
        status: 'declined', respondedAt: new Date(),
      },
    });
    await prisma.teacherStudent.create({
      data: { teacherId: resolveTeacherId, studentId: rosterStudentId },
    });

    const unlinkStudent = await prisma.student.create({
      data: {
        firstName: 'Resolve', lastName: 'Unlink', email: unlinkEmail, claimedAt: new Date(),
        account: { create: { email: unlinkEmail } }, incomeTier: 3,
      },
      select: { id: true, accountId: true },
    });
    unlinkStudentId = unlinkStudent.id;
    unlinkAccountId = unlinkStudent.accountId as string;
    unlinkToken = await seedSession(prisma, unlinkAccountId);
    await prisma.teacherStudent.create({
      data: { teacherId: resolveTeacherId, studentId: unlinkStudentId },
    });

    // No account: promoteNext is called directly below, never through the
    // student's own session.
    const promoteStudent = await prisma.student.create({
      data: { firstName: 'Resolve', lastName: 'Promote', email: promoteEmail, incomeTier: 3 },
      select: { id: true },
    });
    promoteStudentId = promoteStudent.id;
    await prisma.invitation.create({
      data: {
        teacherId: resolveTeacherId, email: promoteEmail, firstName: 'Resolve', lastName: 'Promote',
        status: 'accepted', respondedAt: new Date(),
      },
    });

    const claimStudent = await prisma.student.create({
      data: {
        firstName: 'Resolve', lastName: 'Claim', email: claimEmail, claimedAt: new Date(),
        account: { create: { email: claimEmail } }, incomeTier: 3,
      },
      select: { id: true, accountId: true },
    });
    claimStudentId = claimStudent.id;
    claimAccountId = claimStudent.accountId as string;
    claimToken = await seedSession(prisma, claimAccountId);
    await prisma.invitation.create({
      data: {
        teacherId: resolveTeacherId, email: claimEmail, firstName: 'Resolve', lastName: 'Claim',
        status: 'accepted', respondedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    const classIds = [openClassId, promoteClassId, claimClassId];
    const studentIds = [
      declineStudentId, rosterStudentId, unlinkStudentId, promoteStudentId, claimStudentId,
    ].filter(Boolean);
    const accountIds = [declineAccountId, unlinkAccountId, claimAccountId].filter(Boolean);

    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.payment.deleteMany({ where: { registration: { classId: { in: classIds } } } });
    await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.class.deleteMany({ where: { id: { in: classIds } } });
    if (teacherRoomId) await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });

    // Bookings and promotions each write a notification with no FK to
    // recipientId — same reasoning as waitlist-api.test.ts's afterAll.
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [...studentIds, resolveTeacherId] } },
    });
    await prisma.studentPrivacy.deleteMany({ where: { teacherId: resolveTeacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: resolveTeacherId } });
    await prisma.invitation.deleteMany({ where: { teacherId: resolveTeacherId } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: resolveTeacherId } });

    if (accountIds.length) {
      await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    if (studentIds.length) {
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    if (accountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }

    await prisma.session.deleteMany({ where: { accountId: resolveTeacherAccountId } });
    await prisma.teacher.deleteMany({ where: { id: resolveTeacherId } });
    await prisma.account.deleteMany({ where: { id: resolveTeacherAccountId } });
  });

  it("booking a declined teacher's class re-establishes the link and clears the tombstone", async () => {
    try {
      // Decline first.
      await prisma.invitation.update({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: declineEmailLower } },
        data: { status: 'declined', respondedAt: new Date() },
      });
      await prisma.teacherStudent.deleteMany({
        where: { teacherId: resolveTeacherId, studentId: declineStudentId },
      });

      const res = await fetch(`${BASE_URL}/api/registrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(declineToken) },
        body: JSON.stringify({ classId: openClassId }),
      });
      expect(res.status).toBe(201);

      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: resolveTeacherId, studentId: declineStudentId } },
      })).not.toBeNull();

      // The write this test is really about: `Student.email` above is mixed
      // case, `Invitation.email` is queried here by its canonical lowercase
      // form — a dropped `.toLowerCase()` in resolveInvitationOnLink would
      // leave this row stuck at `declined` even though the booking above
      // succeeded (#166 F1).
      const inv = await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: declineEmailLower } },
      });
      expect(inv.status).toBe('accepted');
    } finally {
      // Restores the fixture to the state the describe's other tests expect
      // to find `declineStudentId` in, and matches this file's own
      // try/finally convention — the describe's `afterAll` would sweep both
      // rows regardless (by `resolveTeacherId`/`declineStudentId`), so this
      // is a safety net rather than the only thing standing between this
      // test and debris.
      await prisma.teacherStudent.upsert({
        where: { teacherId_studentId: { teacherId: resolveTeacherId, studentId: declineStudentId } },
        update: {},
        create: { teacherId: resolveTeacherId, studentId: declineStudentId },
      });
    }
  });

  it('a teacher-initiated registration does not resolve anything', async () => {
    // Only the student's OWN act is consent. A roster add or a walk-in must
    // not launder itself into acceptance.
    const before = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId: resolveTeacherId, email: rosterEmail } },
    });
    const res = await fetch(`${BASE_URL}/api/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(resolveTeacherToken) },
      body: JSON.stringify({ classId: openClassId, studentId: rosterStudentId }),
    });
    expect(res.status).toBe(201);
    const after = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId: resolveTeacherId, email: rosterEmail } },
    });
    expect(after.status).toBe(before.status);
  });

  it('re-booking after unlinking clears the TeacherBlock, restoring deliverability', async () => {
    try {
      const unlinkRes = await fetch(`${BASE_URL}/api/teacher-links/${resolveTeacherId}`, {
        method: 'DELETE', headers: cookie(unlinkToken),
      });
      expect(unlinkRes.status).toBe(200);
      expect(await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: unlinkEmail } },
      })).not.toBeNull();

      // Confirm the block genuinely withholds delivery before the re-book —
      // without this, an assertion of `delivered: true` afterward would prove
      // nothing about what changed.
      const blocked = await inviteContact(prisma, {
        teacherId: resolveTeacherId, email: unlinkEmail, firstName: 'A', lastName: 'B',
      });
      if (!blocked.ok) throw new Error('expected the pre-rebook invite to succeed');
      expect(blocked.value.delivered).toBe(false);
      // That call created a real, ordinary row (#166 task 6c) — remove it so
      // the re-book below meets `inviteContact`'s "no existing row" path
      // again, the same as a teacher who never re-invited in between. Not
      // deferred to `finally`: the row must be gone before the re-book
      // below, not merely by test end — this is a correctness step, not
      // cleanup. `finally` below is a second, address-scoped sweep in case
      // an assertion above threw before this line ran.
      await prisma.invitation.deleteMany({ where: { id: blocked.value.id } });

      const res = await fetch(`${BASE_URL}/api/registrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(unlinkToken) },
        body: JSON.stringify({ classId: openClassId }),
      });
      expect(res.status).toBe(201);

      // The property this test exists for: the block itself is gone, not just
      // an invitation row — `delivered` is the only signal `notifyInvitee`'s
      // caller (route.ts, #166 task 8) ever gets, so checking the
      // invitation's status here would pass even if the block never cleared.
      expect(await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: unlinkEmail } },
      })).toBeNull();

      // The booking above also recreated the TeacherStudent link, and
      // inviteContact refuses ALREADY_LINKED before it ever reaches the block
      // check — so calling it on the still-linked pair would prove nothing
      // about the block. Removing the link here isolates the one thing this
      // test is about: whether `inviteContact` would still find the block if
      // asked, independent of roster state.
      await prisma.teacherStudent.deleteMany({
        where: { teacherId: resolveTeacherId, studentId: unlinkStudentId },
      });
      const reinvite = await inviteContact(prisma, {
        teacherId: resolveTeacherId, email: unlinkEmail, firstName: 'A', lastName: 'B',
      });
      if (!reinvite.ok) throw new Error('expected the re-invite to succeed');
      expect(reinvite.value.delivered).toBe(true);
    } finally {
      // Both `inviteContact` calls above create a real Invitation row
      // whenever none exists yet for the address — swept here by address
      // rather than by id, so it also catches the first row if an assertion
      // threw before its own inline delete ran. The describe's own
      // `afterAll` sweeps every Invitation under `resolveTeacherId`
      // regardless; this is the same per-test convention the rest of the
      // file follows, not the only backstop.
      await prisma.invitation.deleteMany({
        where: { teacherId: resolveTeacherId, email: unlinkEmail },
      });
    }
  });

  it("promoting off the waitlist resolves the student's invitation the same way a direct booking does", async () => {
    try {
      await prisma.invitation.update({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: promoteEmail } },
        data: { status: 'declined', respondedAt: new Date() },
      });
      await prisma.waitlistEntry.create({
        data: { classId: promoteClassId, studentId: promoteStudentId, position: 1, status: 'waiting' },
      });

      const entry = await promoteNext(prisma, promoteClassId);
      expect(entry).not.toBeNull();

      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: resolveTeacherId, studentId: promoteStudentId } },
      })).not.toBeNull();
      const inv = await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: promoteEmail } },
      });
      expect(inv.status).toBe('accepted');
    } finally {
      // The describe's own `afterAll` sweeps `waitlistEntry`/`registration`
      // by `promoteClassId` regardless — this is the same per-test
      // try/finally convention the rest of the file follows, not the only
      // backstop against debris.
      await prisma.waitlistEntry.deleteMany({
        where: { classId: promoteClassId, studentId: promoteStudentId },
      });
      await prisma.registration.deleteMany({
        where: { classId: promoteClassId, studentId: promoteStudentId },
      });
    }
  });

  it("claiming a spot resolves the student's invitation the same way a direct booking does", async () => {
    try {
      await prisma.invitation.update({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: claimEmail } },
        data: { status: 'declined', respondedAt: new Date() },
      });
      await prisma.waitlistEntry.create({
        data: { classId: claimClassId, studentId: claimStudentId, position: 1, status: 'waiting' },
      });

      const res = await fetch(`${BASE_URL}/api/waitlist/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(claimToken) },
        body: JSON.stringify({ classId: claimClassId }),
      });
      expect(res.status).toBe(201);

      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: resolveTeacherId, studentId: claimStudentId } },
      })).not.toBeNull();
      const inv = await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: claimEmail } },
      });
      expect(inv.status).toBe('accepted');
    } finally {
      // Same convention as the promote test above.
      await prisma.waitlistEntry.deleteMany({
        where: { classId: claimClassId, studentId: claimStudentId },
      });
      await prisma.registration.deleteMany({
        where: { classId: claimClassId, studentId: claimStudentId },
      });
    }
  });
});

describe('unlinking withdraws waiting entries for the teacher (#166 F3)', () => {
  // A dedicated teacher, dedicated from `resolveTeacherId` above: that
  // describe's own `afterAll` has already torn its fixtures down by the time
  // this one runs. `defaultTimezone: 'UTC'` for the same reason as above —
  // the class needs a deterministic auto_promote window.
  let teacherId: string;
  let teacherAccountId: string;
  let teacherToken: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;

  // The student under test: joins the waitlist, then unlinks. The exploit
  // this closes: without withdrawal, this student's `waiting` entry survives
  // the unlink, and the teacher — not the student — can later reach back
  // through it (cancel the other registration below → handleSpotFreed →
  // promoteNext promotes this student → resolveInvitationOnLink clears the
  // block just written) with no further action from the student at all.
  const studentEmail = `f3-student-${suffix}@test.local`;
  let studentId: string;
  let studentAccountId: string;
  let studentToken: string;

  // Occupies the class's one spot, so the student under test has to
  // waitlist rather than book directly. Cancelling this registration is
  // the "teacher cancels any other registration" step of the exploit.
  let holderStudentId: string;
  let holderRegistrationId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'F3', lastName: 'Teacher',
        email: `f3-teacher-${suffix}@test.local`,
        account: { create: { email: `f3-teacher-${suffix}@test.local` } },
        bio: 'Task 7 review F3 tests', pageSlug: `f3-teacher-${suffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    teacherToken = await seedSession(prisma, teacherAccountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'F3 Studio', address: `${suffix} F3 St`, city: 'Testville',
        postcode: '1234F3', maxCapacity: 5, createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 5, rentalRate: 20 },
    });
    teacherRoomId = teacherRoom.id;

    // auto_promote window: far enough out that promoteNext's own window
    // check never trips — same trick used throughout this file.
    const cls = await prisma.class.create({
      data: {
        teacherId, teacherRoomId, classType: 'F3 Class',
        date: new Date('2099-06-01'), startTime: '09:00', durationMinutes: 60,
        roomCost: 20, minRate: 15, targetRate: 25, minStudents: 1, maxStudents: 1,
        status: 'open',
      },
    });
    classId = cls.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'F3', lastName: 'Student', email: studentEmail, claimedAt: new Date(),
        account: { create: { email: studentEmail } }, incomeTier: 3,
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);
    await prisma.teacherStudent.create({ data: { teacherId, studentId } });

    const holder = await prisma.student.create({
      data: {
        firstName: 'F3', lastName: 'Holder', email: `f3-holder-${suffix}@test.local`, incomeTier: 3,
      },
      select: { id: true },
    });
    holderStudentId = holder.id;
    await prisma.teacherStudent.create({ data: { teacherId, studentId: holderStudentId } });
    const registration = await prisma.registration.create({
      data: { classId, studentId: holderStudentId, status: 'registered', tierAtBooking: 3 },
    });
    holderRegistrationId = registration.id;

    // The student under test waitlists behind the holder — the class's one
    // spot is already taken.
    await prisma.waitlistEntry.create({
      data: { classId, studentId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.notification.deleteMany({ where: { recipientId: { in: [studentId, teacherId] } } });
    await prisma.class.deleteMany({ where: { id: classId } });
    await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
    await prisma.room.deleteMany({ where: { id: roomId } });

    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.invitation.deleteMany({ where: { teacherId } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId } });

    await prisma.session.deleteMany({ where: { accountId: studentAccountId } });
    await prisma.student.deleteMany({ where: { id: { in: [studentId, holderStudentId] } } });
    await prisma.account.deleteMany({ where: { id: studentAccountId } });

    await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: teacherAccountId } });
  });

  it('unlinking withdraws the waiting entry, so a later cancel cannot promote the student back in and clear the block', async () => {
    const unlinkRes = await fetch(`${BASE_URL}/api/teacher-links/${teacherId}`, {
      method: 'DELETE', headers: cookie(studentToken),
    });
    expect(unlinkRes.status).toBe(200);

    // The direct proof of the fix: the entry is withdrawn by the unlink
    // itself, before any cancel ever happens.
    const entryAfterUnlink = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId } },
    });
    expect(entryAfterUnlink.status).toBe('removed');

    expect(await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId, email: studentEmail } },
    })).not.toBeNull();

    // The exploit's second step: the teacher cancels the OTHER student's
    // registration, freeing the class's only spot and triggering
    // handleSpotFreed → promoteNext through the real cancel route.
    const cancelRes = await fetch(`${BASE_URL}/api/registrations/${holderRegistrationId}`, {
      method: 'DELETE', headers: cookie(teacherToken),
    });
    expect(cancelRes.status).toBe(200);

    // Withdrawn, not promoted: promoteNext's queue search only ever looks at
    // `status: 'waiting'`, so the removed entry is invisible to it — the
    // freed spot goes unfilled rather than going to this student.
    const entryAfterCancel = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId } },
    });
    expect(entryAfterCancel.status).toBe('removed');
    expect(entryAfterCancel.registrationId).toBeNull();

    // The property this whole test exists for: the block the student set by
    // unlinking is still standing after the teacher's cancel — the teacher
    // never got a lever back to it.
    expect(await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId, email: studentEmail } },
    })).not.toBeNull();

    expect(
      await prisma.registration.findUnique({ where: { classId_studentId: { classId, studentId } } }),
    ).toBeNull();
  });
});
