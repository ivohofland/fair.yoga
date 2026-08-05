import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { inviteContact, notifyInvitee, unlinkTeacher } from '@/services/invitations';
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

  it('refuses an empty update rather than reporting a write it never made', async () => {
    const before = await prisma.invitation.findUniqueOrThrow({ where: { id: putTargetId } });
    const res = await fetch(`${BASE_URL}/api/invitations/${putTargetId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    // Whole row, since `Invitation` carries no `updatedAt` to compare — an
    // empty `data` is a no-op write anyway, so this is really guarding
    // against a future edit that starts stamping something on the way past.
    const after = await prisma.invitation.findUniqueOrThrow({ where: { id: putTargetId } });
    expect(after).toEqual(before);
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

  it('refuses an email that another of this teacher\'s contacts already holds, in words a teacher can act on', async () => {
    // F9, #166 review. Retyping one contact's address as another's is an
    // ordinary mistake, not a race — but it violates
    // `@@unique([teacherId, email])`, and the P2002 used to escape to
    // `classifyApiError`'s fallback: Prisma's own "Resource already exists"
    // rendered in the form's error slot, plus a `warn` written for genuine
    // lost races.
    const occupiedEmail = `inv-put-occupied-${suffix}@test.local`;
    let occupier: { id: string } | undefined;
    try {
      occupier = await prisma.invitation.create({
        data: { teacherId, email: occupiedEmail, firstName: 'Already', lastName: 'Here' },
        select: { id: true },
      });

      const before = await prisma.invitation.findUniqueOrThrow({ where: { id: putTargetId } });

      const res = await fetch(`${BASE_URL}/api/invitations/${putTargetId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        // Mixed case: the route lowercases before writing, so the collision
        // has to be found on the normalised value, not the typed one.
        body: JSON.stringify({ email: occupiedEmail.toUpperCase() }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string; code?: string } };
      expect(body.error.code).toBe('ALREADY_INVITED');
      expect(body.error.message).toBe('Another of your contacts already uses this email address.');
      // The exact string this test exists to keep off a contact form.
      expect(body.error.message).not.toBe('Resource already exists');

      // A refused write is not a partial write.
      const after = await prisma.invitation.findUniqueOrThrow({ where: { id: putTargetId } });
      expect(after).toEqual(before);
    } finally {
      if (occupier) await prisma.invitation.deleteMany({ where: { id: occupier.id } });
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

  it('refuses to accept an invitation from a soft-deleted teacher, and creates no link', async () => {
    // F7, #166 review. Erasure (`deleteTeacherAccount`, services/gdpr.ts)
    // deletes every one of that teacher's `TeacherStudent` rows and leaves
    // their `Invitation` rows standing — so a pending invitation sent before
    // the erasure outlives it, and accepting it RECREATES a link erasure
    // deleted, pointing at an account that no longer exists.
    //
    // The fixture's starting state is the test: no `TeacherStudent` row for
    // this pair, which is exactly what erasure leaves behind and exactly
    // what the broken code moves away from. Seeded with a link, the
    // `expect(...).toBeNull()` below could not fail.
    const erasedEmail = `Inv-Erased-Responder-${suffix}@Test.Local`;
    let erasedTeacher: { id: string; accountId: string } | undefined;
    let erasedInvite: { id: string } | undefined;
    let erasedStudentId: string | undefined;
    let erasedStudentAccountId: string | undefined;
    try {
      erasedTeacher = await prisma.teacher.create({
        data: {
          // The names erasure itself writes — this is the card the student
          // would be shown if the guard were absent.
          firstName: 'Deleted', lastName: 'Teacher',
          email: `inv-erased-teacher-${suffix}@test.local`,
          account: { create: { email: `inv-erased-teacher-${suffix}@test.local` } },
          bio: '',
          pageSlug: `inv-erased-teacher-${suffix}`,
          deletedAt: new Date(),
        },
        select: { id: true, accountId: true },
      });

      const erasedStudent = await prisma.student.create({
        data: {
          firstName: 'Erased', lastName: 'Responder',
          email: erasedEmail, claimedAt: new Date(),
          account: { create: { email: erasedEmail } },
        },
        select: { id: true, accountId: true },
      });
      erasedStudentId = erasedStudent.id;
      erasedStudentAccountId = erasedStudent.accountId as string;
      const erasedToken = await seedSession(prisma, erasedStudentAccountId);

      // Lowercase on the invitation, mixed case on the account — the same
      // split every other test in this describe uses, so the guard being
      // added here cannot pass by accidentally short-circuiting the
      // lowercasing that already has to happen.
      erasedInvite = await prisma.invitation.create({
        data: {
          teacherId: erasedTeacher.id, email: erasedEmail.toLowerCase(),
          firstName: 'Erased', lastName: 'Responder',
        },
        select: { id: true },
      });

      // Same 404 as an unknown id: a distinct code would be a new bit on a
      // route whose whole design is that an id alone tells a caller nothing.
      const res = await respond(erasedInvite.id, erasedToken, 'accept');
      expect(res.status).toBe(404);

      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: erasedTeacher.id, studentId: erasedStudentId } },
      })).toBeNull();
      const inv = await prisma.invitation.findUniqueOrThrow({ where: { id: erasedInvite.id } });
      expect(inv.status).toBe('pending');
      expect(inv.respondedAt).toBeNull();
    } finally {
      if (erasedInvite) await prisma.invitation.deleteMany({ where: { id: erasedInvite.id } });
      if (erasedStudentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId: erasedStudentId } });
      }
      if (erasedStudentAccountId) {
        await prisma.session.deleteMany({ where: { accountId: erasedStudentAccountId } });
      }
      if (erasedStudentId) await prisma.student.deleteMany({ where: { id: erasedStudentId } });
      if (erasedStudentAccountId) {
        await prisma.account.deleteMany({ where: { id: erasedStudentAccountId } });
      }
      if (erasedTeacher) {
        await prisma.invitation.deleteMany({ where: { teacherId: erasedTeacher.id } });
        await prisma.teacherBlock.deleteMany({ where: { teacherId: erasedTeacher.id } });
        await prisma.teacher.deleteMany({ where: { id: erasedTeacher.id } });
        await prisma.account.deleteMany({ where: { id: erasedTeacher.accountId } });
      }
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

describe('POST /api/students — re-inviting once the link is gone (#166 review F8)', () => {
  // `ALREADY_LINKED` used to be read off `Invitation.status === 'accepted'`.
  // Erasing a student deletes their `TeacherStudent` rows and leaves the
  // `Invitation` row `accepted`, so the teacher was told "already one of
  // your students" forever about someone not on their roster — and
  // `@@unique([teacherId, email])` meant no second row could be created,
  // while `DELETE`/`PUT` offer no way out of an accepted row either.
  // Unrecoverable through the UI.
  const post = (email: string) =>
    fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Second', lastName: 'Attempt', email }),
    });

  // A distinctive, obviously-not-now timestamp: the ALREADY_LINKED contrast
  // test asserts this exact value survives, which it cannot do against
  // `new Date()`.
  const ACCEPTED_AT = new Date('2026-01-02T03:04:05.000Z');

  /**
   * The state erasure leaves behind: an `accepted` invitation with no
   * `TeacherStudent` row anywhere. Seeded at that state deliberately — it
   * is the state the broken code refuses to move away from, so a fixture
   * seeded any other way could not fail.
   */
  async function seedAcceptedWithoutLink(label: string) {
    const email = `inv-relink-${label}-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: {
        teacherId, email, status: 'accepted', respondedAt: ACCEPTED_AT,
        firstName: 'Was', lastName: 'Linked',
      },
      select: { id: true },
    });
    return { email, invitationId: invitation.id };
  }

  it('lets a teacher invite again when the accepted invitation has outlived its link', async () => {
    const { email, invitationId } = await seedAcceptedWithoutLink('erased');

    // The Student row still exists and is NOT on this teacher's roster —
    // the harder half of the fix. A check that stopped at "is there a
    // Student with this address" would refuse here just as the status read
    // did; only one that goes on to `TeacherStudent` lets this through.
    // Mixed case, so the case-insensitive match is doing real work.
    let strangerId: string | undefined;
    try {
      const stranger = await prisma.student.create({
        data: {
          firstName: 'Not', lastName: 'Linked',
          email: `Inv-Relink-Erased-Stranger-${suffix}@Test.Local`,
        },
        select: { id: true },
      });
      strangerId = stranger.id;

      const res = await post(email);
      expect(res.status).toBe(201);
      // The same row, returned to pending — not a second row, which
      // `@@unique([teacherId, email])` would refuse anyway.
      const json = (await res.json()) as { data: { id: string } };
      expect(json.data.id).toBe(invitationId);

      const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
      expect(row.status).toBe('pending');
      // Not merely tidiness: `Invitation_responded_at_status_check` rejects
      // a pending row that still carries a response time.
      expect(row.respondedAt).toBeNull();
      // The teacher typed a new name into the form; the contact shows it.
      expect(row.firstName).toBe('Second');
    } finally {
      await prisma.invitation.deleteMany({ where: { id: invitationId } });
      if (strangerId) await prisma.student.deleteMany({ where: { id: strangerId } });
    }
  });

  it('still refuses with ALREADY_LINKED when the link really is there, and leaves the accepted row alone', async () => {
    // The contrast case, and the reason this is not a blanket removal. The
    // fixture starts accepted-AND-linked, which is the state the
    // over-corrected code would move away from.
    const { email, invitationId } = await seedAcceptedWithoutLink('linked');
    let studentId: string | undefined;
    try {
      // Mixed case on `Student.email` — stored as typed everywhere in this
      // app, unlike `Invitation.email`. With the roster lookup's
      // `mode: 'insensitive'` dropped, this student is invisible, the guard
      // finds no link and the row is revived: this test is what notices.
      const student = await prisma.student.create({
        data: {
          firstName: 'Still', lastName: 'Linked',
          email: email.toUpperCase(),
          teacherStudents: { create: { teacherId } },
        },
        select: { id: true },
      });
      studentId = student.id;

      const res = await post(email);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('ALREADY_LINKED');

      const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
      expect(row.status).toBe('accepted');
      // The original acceptance moment, untouched — a revive would have
      // nulled it.
      expect(row.respondedAt).toEqual(ACCEPTED_AT);
    } finally {
      await prisma.invitation.deleteMany({ where: { id: invitationId } });
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.student.deleteMany({ where: { id: studentId } });
      }
    }
  });

  it('answers a blocked re-invite exactly as an unblocked one', async () => {
    // Requirement 3 of the fix: the new path must not become the fifth
    // place on this branch to leak whether a block exists. Both fixtures
    // are in the identical accepted-no-link state; only the `TeacherBlock`
    // differs.
    const blocked = await seedAcceptedWithoutLink('blocked');
    const open = await seedAcceptedWithoutLink('open');
    let block: { id: string } | undefined;
    try {
      block = await prisma.teacherBlock.create({
        data: { teacherId, email: blocked.email },
        select: { id: true },
      });

      const [blockedRes, openRes] = await Promise.all([post(blocked.email), post(open.email)]);
      expect(blockedRes.status).toBe(openRes.status);
      expect(blockedRes.status).toBe(201);

      // Body equality down to the key set and the value, which is each
      // row's own id — the only field either response carries.
      const blockedJson = (await blockedRes.json()) as { data: { id: string } };
      const openJson = (await openRes.json()) as { data: { id: string } };
      expect(blockedJson).toEqual({ data: { id: blocked.invitationId } });
      expect(openJson).toEqual({ data: { id: open.invitationId } });

      // And the rows are identical too, apart from the address and the name
      // the teacher typed: an ordinary pending invitation either way. The
      // block underneath the first one is untouched.
      const blockedRow = await prisma.invitation.findUniqueOrThrow({
        where: { id: blocked.invitationId },
      });
      const openRow = await prisma.invitation.findUniqueOrThrow({
        where: { id: open.invitationId },
      });
      expect(blockedRow.status).toBe(openRow.status);
      expect(blockedRow.status).toBe('pending');
      expect(blockedRow.isArchived).toBe(openRow.isArchived);
      expect(await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId, email: blocked.email } },
      })).not.toBeNull();
    } finally {
      if (block) await prisma.teacherBlock.deleteMany({ where: { id: block.id } });
      await prisma.invitation.deleteMany({
        where: { id: { in: [blocked.invitationId, open.invitationId] } },
      });
    }
  });

  it('marks a blocked re-invite undelivered and an unblocked one delivered', async () => {
    // The bit the wire never carries. `POST /api/students` gates
    // `notifyInvitee` on it, so this is what actually keeps a re-invite from
    // emailing the person who walked away — the HTTP test above can only
    // prove the two responses are indistinguishable, not that one of them
    // sends nothing.
    const blocked = await seedAcceptedWithoutLink('delivered-blocked');
    const open = await seedAcceptedWithoutLink('delivered-open');
    let block: { id: string } | undefined;
    try {
      block = await prisma.teacherBlock.create({
        data: { teacherId, email: blocked.email },
        select: { id: true },
      });

      const blockedResult = await inviteContact(prisma, {
        teacherId, email: blocked.email, firstName: 'Second', lastName: 'Attempt',
      });
      const openResult = await inviteContact(prisma, {
        teacherId, email: open.email, firstName: 'Second', lastName: 'Attempt',
      });

      if (!blockedResult.ok) throw new Error('expected the blocked re-invite to succeed');
      if (!openResult.ok) throw new Error('expected the unblocked re-invite to succeed');
      expect(blockedResult.value.delivered).toBe(false);
      expect(openResult.value.delivered).toBe(true);
    } finally {
      if (block) await prisma.teacherBlock.deleteMany({ where: { id: block.id } });
      await prisma.invitation.deleteMany({
        where: { id: { in: [blocked.invitationId, open.invitationId] } },
      });
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

  it('finds a Student row whose OWN address carries uppercase (whole-branch I2)', async () => {
    // The one test in this file that certifies `mode: 'insensitive'` on
    // `notifyInvitee`'s Student lookup, and the direction that was broken.
    // Its former partner — Student stored lowercase, mixed case passed in —
    // is gone: an insensitive lookup finds that row with or without the
    // leading `.toLowerCase()`, and an exact lookup finds it too once the
    // `.toLowerCase()` has run, so no single mutation could make it fail.
    // What that partner claimed to test now lives where it is observable,
    // against the case-SENSITIVE `TeacherBlock` re-check
    // (`invitations.notify.test.ts`). Here the STORED
    // address is mixed case — the shape `auth/student-signup` and
    // `account/student-profile` actually write, since neither normalises —
    // and the address handed in is the canonical lowercase one every caller
    // supplies. A case-sensitive lookup finds nothing, skips the
    // notification, and falls through to the stranger email: an existing
    // account holder told to go and sign up, with their own
    // `emailNotifications` preference never consulted.
    const storedMixedCase = `Notify-Stored-Mixed-${suffix}@Test.Local`;
    let student: { id: string } | undefined;
    try {
      student = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'StoredMixed', email: storedMixedCase },
        select: { id: true },
      });

      await notifyInvitee(prisma, {
        teacherId, email: storedMixedCase.toLowerCase(), teacherName: 'Some Teacher',
      });

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

  // Promoted off the waitlist with a PENDING invitation — resolved through
  // promoteNext instead of a direct booking.
  const promoteEmail = `resolve-promote-${suffix}@test.local`;
  let promoteStudentId: string;

  // The whole-branch C2 chain, in the order that makes it an exploit:
  // queues first, is invited second, declines third — then the teacher
  // frees a spot. Needs a session of its own, because the decline goes
  // through the real route rather than a direct row edit; that is what
  // proves declining withdraws no queue position and writes no block, which
  // is the precondition that leaves the lever in the teacher's hand.
  const promoteDeclineEmail = `resolve-promote-decline-${suffix}@test.local`;
  let promoteDeclineStudentId: string;
  let promoteDeclineAccountId: string;
  let promoteDeclineToken: string;
  let promoteDeclineInvitationId: string;

  // Joins the queue after declining, then claims the spot that frees — the
  // join is what reverses the decline; the claim is only allowed to inherit
  // it. Needs a session, because the join goes through the student's own
  // route, which is the whole point of the case.
  const claimEmail = `resolve-claim-${suffix}@test.local`;
  let claimStudentId: string;
  let claimAccountId: string;
  let claimToken: string;

  // Holds the claim class's single spot, so the student above has to queue
  // rather than book — `addToWaitlist` refuses a join into a class with room.
  // Cancelling this registration is what frees the spot to claim.
  let claimHolderStudentId: string;

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

    // No TeacherStudent link: joining a waitlist creates none, which is the
    // state this student is in when the invitation arrives.
    const promoteDeclineStudent = await prisma.student.create({
      data: {
        firstName: 'Resolve', lastName: 'PromoteDecline', email: promoteDeclineEmail,
        claimedAt: new Date(), account: { create: { email: promoteDeclineEmail } }, incomeTier: 3,
      },
      select: { id: true, accountId: true },
    });
    promoteDeclineStudentId = promoteDeclineStudent.id;
    promoteDeclineAccountId = promoteDeclineStudent.accountId as string;
    promoteDeclineToken = await seedSession(prisma, promoteDeclineAccountId);
    const promoteDeclineInvitation = await prisma.invitation.create({
      data: {
        teacherId: resolveTeacherId, email: promoteDeclineEmail,
        firstName: 'Resolve', lastName: 'PromoteDecline',
      },
      select: { id: true },
    });
    promoteDeclineInvitationId = promoteDeclineInvitation.id;

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

    const claimHolder = await prisma.student.create({
      data: {
        firstName: 'Resolve', lastName: 'ClaimHolder',
        email: `resolve-claim-holder-${suffix}@test.local`, incomeTier: 3,
      },
      select: { id: true },
    });
    claimHolderStudentId = claimHolder.id;
  });

  afterAll(async () => {
    const classIds = [openClassId, promoteClassId, claimClassId];
    const studentIds = [
      declineStudentId, rosterStudentId, unlinkStudentId, promoteStudentId,
      promoteDeclineStudentId, claimStudentId, claimHolderStudentId,
    ].filter(Boolean);
    const accountIds = [
      declineAccountId, unlinkAccountId, promoteDeclineAccountId, claimAccountId,
    ].filter(Boolean);

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

  it('promoting off the waitlist repairs a missing link and resolves nothing', async () => {
    // The link belongs to the JOIN now (`addToWaitlist`, services/waitlist.ts),
    // so the entry below is written by hand — which is both the only way left
    // to reach a promotion with no link, and exactly what a `waiting` row
    // written before that change looks like. `promoteNext` keeps its
    // `teacherStudent.upsert` as the backstop for those rows.
    //
    // `pending`, seeded as the state a resolving promotion would move AWAY
    // from: a fixture already `accepted` cannot tell the two apart.
    try {
      await prisma.invitation.update({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: promoteEmail } },
        data: { status: 'pending', respondedAt: null },
      });
      await prisma.waitlistEntry.create({
        data: { classId: promoteClassId, studentId: promoteStudentId, position: 1, status: 'waiting' },
      });

      const entry = await promoteNext(prisma, promoteClassId);
      expect(entry).not.toBeNull();

      // The backstop ran.
      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: resolveTeacherId, studentId: promoteStudentId } },
      })).not.toBeNull();

      // And nothing else did. A promotion fires when the TEACHER cancels some
      // other registration, so an invitation answered from in here is an
      // acceptance they timed and the student never gave.
      const inv = await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: promoteEmail } },
      });
      expect(inv.status).toBe('pending');
      expect(inv.respondedAt).toBeNull();
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

  it('a promotion cannot erase a decline the student made after joining the queue (whole-branch C2)', async () => {
    try {
      // The student's older act: a place in the queue. Written by hand, so
      // this models a row from before joining created the link — a real join
      // today would have accepted the invitation on the spot, and this
      // sequence could not arise. What the case still pins is the promotion
      // itself: it must not answer an invitation on anyone's behalf.
      await prisma.waitlistEntry.create({
        data: {
          classId: promoteClassId, studentId: promoteDeclineStudentId,
          position: 1, status: 'waiting',
        },
      });

      // Their newer act, through the real route: no.
      const declineRes = await fetch(
        `${BASE_URL}/api/invitations/${promoteDeclineInvitationId}/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie(promoteDeclineToken) },
          body: JSON.stringify({ response: 'decline' }),
        },
      );
      expect(declineRes.status).toBe(200);

      // Declining withdraws nothing, on purpose — refusing an invitation
      // must not cost a student their place in an unrelated queue. That is
      // exactly what leaves the entry available as a lever, and why the
      // guard has to live at the promotion rather than at the decline.
      expect((await prisma.waitlistEntry.findUniqueOrThrow({
        where: { classId_studentId: { classId: promoteClassId, studentId: promoteDeclineStudentId } },
      })).status).toBe('waiting');

      // The teacher's move, at a moment of their choosing.
      const entry = await promoteNext(prisma, promoteClassId);
      expect(entry).not.toBeNull();
      expect(entry!.studentId).toBe(promoteDeclineStudentId);

      // The promotion really ran and really did its other work — the roster
      // link is there, repaired by the upsert `promoteNext` keeps as a
      // backstop (#166 task 1). Without this the assertion below could pass
      // because nothing happened at all.
      expect(await prisma.teacherStudent.findUnique({
        where: {
          teacherId_studentId: { teacherId: resolveTeacherId, studentId: promoteDeclineStudentId },
        },
      })).not.toBeNull();

      // The property: the "no" stands. Flipped, this contact reappears in
      // the teacher's CRM as accepted, on the strength of a request the
      // student made before they refused.
      const inv = await prisma.invitation.findUniqueOrThrow({
        where: { id: promoteDeclineInvitationId },
      });
      expect(inv.status).toBe('declined');
    } finally {
      await prisma.waitlistEntry.deleteMany({
        where: { classId: promoteClassId, studentId: promoteDeclineStudentId },
      });
      await prisma.registration.deleteMany({
        where: { classId: promoteClassId, studentId: promoteDeclineStudentId },
      });
    }
  });

  it('joining the queue reverses a decline, and the later claim adds nothing to it', async () => {
    try {
      // The state the join has to move away from: refused, and unlinked.
      await prisma.invitation.update({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: claimEmail } },
        data: { status: 'declined', respondedAt: new Date() },
      });
      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: resolveTeacherId, studentId: claimStudentId } },
      })).toBeNull();

      // The holder takes the class's one spot, which is what makes the queue
      // the student's only way in.
      await prisma.registration.create({
        data: {
          classId: claimClassId, studentId: claimHolderStudentId,
          status: 'registered', tierAtBooking: 3,
        },
      });

      // Through the student's own session and the real route: this is the
      // consenting act, and the whole point of the correction is that it is
      // this request, not a later promotion, that the link hangs off.
      const joinRes = await fetch(`${BASE_URL}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(claimToken) },
        body: JSON.stringify({ classId: claimClassId }),
      });
      expect(joinRes.status).toBe(201);

      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: resolveTeacherId, studentId: claimStudentId } },
      })).not.toBeNull();
      expect((await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: claimEmail } },
      })).status).toBe('accepted');

      // Put the refusal back by hand. No real sequence produces this state
      // any more — declining needs a pending row, and the join above just
      // accepted it — but without it the assertion after the claim would be
      // `accepted` before and `accepted` after, which proves nothing about
      // whether `claimSpot` resolves. Seeded at what a resolving claim would
      // move away from, so re-adding `resolveInvitationOnLink` there fails
      // this case.
      await prisma.invitation.update({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: claimEmail } },
        data: { status: 'declined', respondedAt: new Date() },
      });

      await prisma.registration.update({
        where: {
          classId_studentId: { classId: claimClassId, studentId: claimHolderStudentId },
        },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });

      const res = await fetch(`${BASE_URL}/api/waitlist/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(claimToken) },
        body: JSON.stringify({ classId: claimClassId }),
      });
      expect(res.status).toBe(201);

      expect((await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId: resolveTeacherId, email: claimEmail } },
      })).status).toBe('declined');
    } finally {
      // Same convention as the promote test above.
      await prisma.waitlistEntry.deleteMany({ where: { classId: claimClassId } });
      await prisma.registration.deleteMany({ where: { classId: claimClassId } });
    }
  });
});

describe('unlinking silences the teacher and freezes the shares (#166 whole-branch C1)', () => {
  // Dedicated fixtures: this drives a full announce → unlink → announce
  // chain, and the file's shared `teacherId` has invitations, blocks and a
  // roster of its own by the time this runs.
  let c1TeacherId: string;
  let c1TeacherAccountId: string;
  let c1TeacherToken: string;
  let c1RoomId: string;
  let c1TeacherRoomId: string;
  let c1ClassId: string;

  const c1StudentEmail = `c1-student-${suffix}@test.local`;
  let c1StudentId: string;
  let c1StudentAccountId: string;
  let c1StudentToken: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'C1', lastName: 'Teacher',
        email: `c1-teacher-${suffix}@test.local`,
        account: { create: { email: `c1-teacher-${suffix}@test.local` } },
        bio: 'Whole-branch C1 fixtures', pageSlug: `c1-teacher-${suffix}`,
      },
    });
    c1TeacherId = teacher.id;
    c1TeacherAccountId = teacher.accountId;
    c1TeacherToken = await seedSession(prisma, c1TeacherAccountId);

    const student = await prisma.student.create({
      data: {
        firstName: 'C1', lastName: 'Student', email: c1StudentEmail, claimedAt: new Date(),
        account: { create: { email: c1StudentEmail } }, incomeTier: 3,
      },
      select: { id: true, accountId: true },
    });
    c1StudentId = student.id;
    c1StudentAccountId = student.accountId as string;
    c1StudentToken = await seedSession(prisma, c1StudentAccountId);

    await prisma.teacherStudent.create({
      data: { teacherId: c1TeacherId, studentId: c1StudentId },
    });

    // Sharing switched ON, and announcements ON — the state a student who
    // trusted this teacher leaves behind. Both must be false after the
    // unlink, and both are invisible to the student once the card is gone.
    await prisma.studentPrivacy.create({
      data: {
        studentId: c1StudentId, teacherId: c1TeacherId,
        shareFullName: true, shareEmail: true, receiveComms: true,
      },
    });

    const room = await prisma.room.create({
      data: {
        venueName: 'C1 Studio', address: `${suffix} C1 St`, city: 'Testville',
        postcode: '1234C1', maxCapacity: 10, createdById: c1TeacherId,
      },
    });
    c1RoomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: c1TeacherId, roomId: c1RoomId, capacityOverride: 10, rentalRate: 20 },
    });
    c1TeacherRoomId = teacherRoom.id;
    const cls = await prisma.class.create({
      data: {
        teacherId: c1TeacherId, teacherRoomId: c1TeacherRoomId, classType: 'C1 Class',
        date: new Date('2099-06-01'), startTime: '09:00', durationMinutes: 60,
        roomCost: 20, minRate: 15, targetRate: 25, minStudents: 1, maxStudents: 10,
        status: 'open',
      },
    });
    c1ClassId = cls.id;

    // The registration is the whole point: announcements pick recipients
    // from Registration, not from TeacherStudent, so this is what keeps the
    // student reachable after the link is gone.
    await prisma.registration.create({
      data: { classId: c1ClassId, studentId: c1StudentId, status: 'registered', tierAtBooking: 3 },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { recipientId: c1StudentId } });
    await prisma.announcement.deleteMany({ where: { teacherId: c1TeacherId } });
    await prisma.registration.deleteMany({ where: { classId: c1ClassId } });
    await prisma.class.deleteMany({ where: { id: c1ClassId } });
    await prisma.teacherRoom.deleteMany({ where: { id: c1TeacherRoomId } });
    await prisma.room.deleteMany({ where: { id: c1RoomId } });
    await prisma.studentPrivacy.deleteMany({ where: { teacherId: c1TeacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: c1TeacherId } });
    await prisma.invitation.deleteMany({ where: { teacherId: c1TeacherId } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: c1TeacherId } });

    await prisma.session.deleteMany({ where: { accountId: c1StudentAccountId } });
    await prisma.student.deleteMany({ where: { id: c1StudentId } });
    await prisma.account.deleteMany({ where: { id: c1StudentAccountId } });

    await prisma.session.deleteMany({ where: { accountId: c1TeacherAccountId } });
    await prisma.teacher.deleteMany({ where: { id: c1TeacherId } });
    await prisma.account.deleteMany({ where: { id: c1TeacherAccountId } });
  });

  const announce = () =>
    fetch(`${BASE_URL}/api/announcements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(c1TeacherToken) },
      body: JSON.stringify({ classId: c1ClassId, message: 'Bring a mat.' }),
    });

  // One test, not three: the announcement BEFORE the unlink is the control
  // that makes the silence afterwards mean something. Split across tests,
  // the second half would pass against a teacher who could never have
  // reached this student in the first place.
  it('an announcement that reaches the student before the unlink cannot reach them after it', async () => {
    const reachable = await announce();
    expect(reachable.status).toBe(201);
    expect(await prisma.notification.count({
      where: { recipientType: 'student', recipientId: c1StudentId, type: 'announcement' },
    })).toBe(1);

    const unlinkRes = await fetch(`${BASE_URL}/api/teacher-links/${c1TeacherId}`, {
      method: 'DELETE', headers: cookie(c1StudentToken),
    });
    expect(unlinkRes.status).toBe(200);

    // The registration — and so the teacher's route to this student — is
    // untouched, which is what makes the privacy row load-bearing rather
    // than incidental.
    expect(await prisma.registration.count({
      where: { classId: c1ClassId, studentId: c1StudentId, status: { not: 'cancelled' } },
    })).toBe(1);

    // Asserted before the row itself, deliberately: this is the property,
    // and it is the one whose failure message names the defect. A regression
    // reads "expected 201 to be 400" — the teacher still reached them —
    // rather than a bare boolean mismatch on a column.
    //
    // `receiveComms: false` filters this student out of the recipient list,
    // and they were the only registrant, so the route has nobody left to
    // notify.
    const silenced = await announce();
    expect(silenced.status).toBe(400);
    expect(await prisma.notification.count({
      where: { recipientType: 'student', recipientId: c1StudentId, type: 'announcement' },
    })).toBe(1);

    // The student can no longer reach this row: the privacy route 403s
    // without a link, and `/account/privacy` renders no card for a teacher
    // they are not linked to. Whatever it says now is permanent from their
    // side, so it has to say the most private thing. The share flags carry
    // no announcement consequence — they are what the teacher's own roster
    // keeps reading (`(teacher)/class/[id]/page.tsx`), with no link check,
    // so each needs asserting on its own.
    const privacy = await prisma.studentPrivacy.findUniqueOrThrow({
      where: { studentId_teacherId: { studentId: c1StudentId, teacherId: c1TeacherId } },
    });
    expect(privacy.receiveComms).toBe(false);
    expect(privacy.shareFullName).toBe(false);
    expect(privacy.shareEmail).toBe(false);
    expect(privacy.sharePhone).toBe(false);
    expect(privacy.shareBirthday).toBe(false);
    expect(privacy.shareAddress).toBe(false);
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
  // promoteNext promotes this student → the promotion's own
  // `teacherStudent.upsert` restores the very link the unlink just deleted)
  // with no further action from the student at all.
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

  it('unlinking withdraws the waiting entry, so a later cancel cannot promote the student back in and restore the link', async () => {
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

    // The property this whole test exists for: the link the student severed
    // is still severed after the teacher's cancel. `promoteNext` keeps a
    // `teacherStudent.upsert` as a backstop for linkless waiting rows, and
    // a surviving `waiting` entry is exactly what would aim that upsert at
    // this pair — so the withdrawal is what stands between the teacher and
    // a roster row the student deleted.
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    })).toBeNull();

    // The block still stands too. Weaker than the assertion above since
    // promotion stopped resolving invitations (nothing in `promoteNext`
    // clears a block any more), but it is the row the student's refusal
    // actually lives in, so it is worth pinning against a future writer.
    expect(await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId, email: studentEmail } },
    })).not.toBeNull();

    expect(
      await prisma.registration.findUnique({ where: { classId_studentId: { classId, studentId } } }),
    ).toBeNull();
  });
});

describe('the unlink withdrawal takes the class lock (#166 whole-branch I4)', () => {
  // Fixtures of its own rather than a second student inside the F3
  // withdrawal describe: this one holds a lock for over a second, and
  // sharing a class with a test that promotes off it would couple them
  // through the queue.
  let lockTeacherId: string;
  let lockTeacherAccountId: string;
  let lockRoomId: string;
  let lockTeacherRoomId: string;
  let lockClassId: string;

  const lockStudentEmail = `lock-student-${suffix}@test.local`;
  let lockStudentId: string;
  let lockStudentAccountId: string;

  // Long enough that `PROBE_MS` lands comfortably inside it; short enough
  // not to approach Prisma's own five-second interactive-transaction
  // timeout.
  const LOCK_HOLD_MS = 1500;
  // How long the unlink is given to prove it is NOT proceeding. Well clear
  // of both ends: an unlocked unlink returns in tens of milliseconds, and a
  // locked one cannot return for another ~750ms after this elapses.
  const PROBE_MS = 600;
  const SETTLE_MS = 150;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Lock', lastName: 'Teacher',
        email: `lock-teacher-${suffix}@test.local`,
        account: { create: { email: `lock-teacher-${suffix}@test.local` } },
        bio: 'Whole-branch I4 lock fixture', pageSlug: `lock-teacher-${suffix}`,
        defaultTimezone: 'UTC',
      },
    });
    lockTeacherId = teacher.id;
    lockTeacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Lock Studio', address: `${suffix} Lock St`, city: 'Testville',
        postcode: '1234LK', maxCapacity: 5, createdById: lockTeacherId,
      },
    });
    lockRoomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: lockTeacherId, roomId: lockRoomId, capacityOverride: 5, rentalRate: 20 },
    });
    lockTeacherRoomId = teacherRoom.id;
    const cls = await prisma.class.create({
      data: {
        teacherId: lockTeacherId, teacherRoomId: lockTeacherRoomId, classType: 'Lock Class',
        date: new Date('2099-06-01'), startTime: '09:00', durationMinutes: 60,
        roomCost: 20, minRate: 15, targetRate: 25, minStudents: 1, maxStudents: 1,
        status: 'open',
      },
    });
    lockClassId = cls.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Lock', lastName: 'Student', email: lockStudentEmail, claimedAt: new Date(),
        account: { create: { email: lockStudentEmail } }, incomeTier: 3,
      },
      select: { id: true, accountId: true },
    });
    lockStudentId = student.id;
    lockStudentAccountId = student.accountId as string;

    await prisma.teacherStudent.create({
      data: { teacherId: lockTeacherId, studentId: lockStudentId },
    });
    // The waiting entry is what makes the withdrawal reach for the lock at
    // all — with no entry to withdraw, nothing is locked and there is
    // nothing to observe.
    await prisma.waitlistEntry.create({
      data: { classId: lockClassId, studentId: lockStudentId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId: lockClassId } });
    await prisma.registration.deleteMany({ where: { classId: lockClassId } });
    await prisma.class.deleteMany({ where: { id: lockClassId } });
    await prisma.teacherRoom.deleteMany({ where: { id: lockTeacherRoomId } });
    await prisma.room.deleteMany({ where: { id: lockRoomId } });
    await prisma.studentPrivacy.deleteMany({ where: { teacherId: lockTeacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: lockTeacherId } });
    await prisma.invitation.deleteMany({ where: { teacherId: lockTeacherId } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: lockTeacherId } });
    await prisma.student.deleteMany({ where: { id: lockStudentId } });
    await prisma.account.deleteMany({ where: { id: lockStudentAccountId } });
    await prisma.teacher.deleteMany({ where: { id: lockTeacherId } });
    await prisma.account.deleteMany({ where: { id: lockTeacherAccountId } });
  });

  // A lock cannot be observed by looking at the rows afterwards — the
  // withdrawal produces the same final state either way. What CAN be
  // observed is that it waits: hold the class row in another transaction,
  // and an unlink that reaches for the same lock cannot get past it. Racing
  // a real `promoteNext` instead would test the same property with a
  // nondeterministic interleaving, which is how a lock test ends up passing
  // by luck.
  //
  // Called through the service rather than DELETE /api/teacher-links, since
  // the point is the timing of one call, not the route's own behaviour —
  // which this file's own unlink describe covers.
  it('waits for a class row another transaction holds, instead of writing through it', async () => {
    let holderReleased = false;
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${lockClassId} FOR UPDATE`;
        await sleep(LOCK_HOLD_MS);
        holderReleased = true;
      },
      { timeout: 10_000 },
    );
    await sleep(SETTLE_MS);

    const unlink = unlinkTeacher(prisma, {
      teacherId: lockTeacherId,
      studentId: lockStudentId,
      accountEmail: lockStudentEmail,
    }).then(() => 'returned' as const);

    const outcome = await Promise.race([unlink, sleep(PROBE_MS).then(() => 'waiting' as const)]);
    expect(outcome).toBe('waiting');
    expect(holderReleased).toBe(false);

    // And it is waiting rather than wedged: once the holder commits, the
    // unlink finishes and does what it always does.
    await holder;
    expect(await unlink).toBe('returned');
    expect((await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId: lockClassId, studentId: lockStudentId } },
    })).status).toBe('removed');
    expect(await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: lockTeacherId, email: lockStudentEmail } },
    })).not.toBeNull();
  });
});
