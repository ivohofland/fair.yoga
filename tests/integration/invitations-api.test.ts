import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let teacherAccountId: string;
let teacherToken: string;

// A second teacher who owns nothing in `teacherId`'s tests below — the
// non-owner fixture for the 404-not-403 ownership tests (#166).
let otherTeacherId: string;
let otherTeacherAccountId: string;
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
  // FK order: invitation -> session -> teacher. Scoped by `in: [...]` over
  // both teachers' ids/accountIds rather than one delete per known row, so
  // this also sweeps anything a single `it()` created inline (the
  // `student_block` tombstone, the declined rows) without that test needing
  // its own afterAll.
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
  await prisma.$disconnect();
});

describe('GET /api/invitations', () => {
  it('returns this teacher\'s contacts and never another teacher\'s', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations`, { headers: cookie(teacherToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { invitations: Array<{ email: string }>; total: number } };
    expect(json.data.invitations.map((i) => i.email)).toEqual([pendingEmail]);
    expect(json.data.total).toBe(1);
  });

  it('never returns a student_block row', async () => {
    // The tombstone a student writes by unlinking carries an address the
    // teacher may never have had — shareEmail defaults false.
    const blockedEmail = `inv-blocked-${suffix}@test.local`;
    const blocked = await prisma.invitation.create({
      data: {
        teacherId, email: blockedEmail, status: 'declined', origin: 'student_block',
      },
    });
    try {
      const res = await fetch(`${BASE_URL}/api/invitations`, { headers: cookie(teacherToken) });
      const body = await res.text();
      // Assert on the raw body, not the parsed row count: a future select
      // that leaks the address through some other field still fails here.
      expect(body).not.toContain(blockedEmail);
    } finally {
      await prisma.invitation.delete({ where: { id: blocked.id } });
    }
  });

  it('returns archived contacts only under ?archived=true', async () => {
    const archivedEmail = `inv-archived-${suffix}@test.local`;
    const archived = await prisma.invitation.create({
      data: { teacherId, email: archivedEmail, isArchived: true },
    });
    try {
      const res = await fetch(`${BASE_URL}/api/invitations?archived=true`, { headers: cookie(teacherToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { invitations: Array<{ email: string }> } };
      expect(json.data.invitations.map((i) => i.email)).toEqual([archivedEmail]);
    } finally {
      await prisma.invitation.delete({ where: { id: archived.id } });
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
    const res = await fetch(`${BASE_URL}/api/invitations/${otherTeacherInvitationId}`, {
      method: 'DELETE', headers: cookie(teacherToken),
    });
    expect(res.status).toBe(404);
    // And it truly wasn't touched — a 404 that quietly deleted the row
    // anyway would still pass a status-only assertion.
    expect(await prisma.invitation.findUnique({ where: { id: otherTeacherInvitationId } })).not.toBeNull();
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
    const declined = await prisma.invitation.create({
      data: { teacherId, email: putDeclinedEmail, status: 'declined', respondedAt: new Date() },
    });
    try {
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
      await prisma.invitation.delete({ where: { id: declined.id } });
    }
  });

  it('refuses another teacher\'s invitation', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations/${otherTeacherInvitationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Hijack' }),
    });
    expect(res.status).toBe(404);
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
    const res = await fetch(`${BASE_URL}/api/invitations/${otherTeacherInvitationId}?state=unarchived`, {
      method: 'PATCH', headers: cookie(teacherToken),
    });
    expect(res.status).toBe(404);
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
    const declined = await prisma.invitation.create({
      data: {
        teacherId,
        email: `inv-patch-declined-${suffix}@test.local`,
        status: 'declined',
        respondedAt: new Date(),
      },
    });
    try {
      const res = await fetch(`${BASE_URL}/api/invitations/${declined.id}?state=archived`, {
        method: 'PATCH', headers: cookie(teacherToken),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { isArchived: boolean; action: string } };
      expect(body.data.isArchived).toBe(true);
      expect(body.data.action).toBe('archived');
    } finally {
      await prisma.invitation.delete({ where: { id: declined.id } });
    }
  });
});
