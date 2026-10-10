import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';
import { signUnsubscribeToken, invitationSubject } from '@/lib/unsubscribe-token';
import { erasedAddress } from '@/lib/erased-address';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const studentIds: string[] = [];
const accountIds: string[] = [];

async function makeStudent(overrides: { deletedAt?: Date } = {}): Promise<string> {
  const email = `unsub-api-${uniqueSuffix()}@test.local`;
  const account = await prisma.account.create({ data: { email }, select: { id: true } });
  accountIds.push(account.id);
  const s = await prisma.student.create({
    data: { firstName: 'Un', lastName: 'Sub', email, accountId: account.id, claimedAt: new Date(), ...overrides },
    select: { id: true },
  });
  studentIds.push(s.id);
  return s.id;
}

async function makeTeacher(): Promise<string> {
  const s = uniqueSuffix();
  const email = `unsub-api-t-${s}@test.local`;
  const account = await prisma.account.create({ data: { email }, select: { id: true } });
  accountIds.push(account.id);
  const t = await prisma.teacher.create({
    data: { firstName: 'Un', lastName: 'Sub', email, bio: '', pageSlug: `unsub-api-${s}`, accountId: account.id },
    select: { id: true },
  });
  teacherIds.push(t.id);
  return t.id;
}

function mint(kind: 'student_notifications' | 'invitation', subjectId: string): string {
  const token = signUnsubscribeToken({ kind, subjectId });
  if (token === null) throw new Error('unsubscribe token could not be signed; is UNSUBSCRIBE_SECRET set in only one process?');
  return token;
}

const post = (t: string | null, init: { body?: BodyInit; headers?: Record<string, string> } = {}) =>
  fetch(`${BASE_URL}/api/unsubscribe${t === null ? '' : `?t=${encodeURIComponent(t)}`}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...freshIp(), ...init.headers },
    body: init.body ?? new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }),
  });

const studentFlag = async (id: string): Promise<boolean> =>
  (await prisma.student.findUniqueOrThrow({ where: { id }, select: { emailNotifications: true } })).emailNotifications;

afterAll(async () => {
  await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.invitation.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('POST /api/unsubscribe', () => {
  it('flips the preference with no session, and a repeat answers unchanged', async () => {
    const id = await makeStudent();
    const token = mint('student_notifications', id);

    expect(await expectApplied(await post(token))).toEqual({ unsubscribed: true });
    expect(await studentFlag(id)).toBe(false);

    expect(await expectUnchanged(await post(token))).toEqual({ unsubscribed: true });
  });

  it('accepts a multipart body', async () => {
    const id = await makeStudent();
    const form = new FormData();
    form.set('List-Unsubscribe', 'One-Click');
    await expectApplied(await post(mint('student_notifications', id), { body: form }));
    expect(await studentFlag(id)).toBe(false);
  });

  it('accepts a foreign Origin, since the token is the credential', async () => {
    const id = await makeStudent();
    const res = await post(mint('student_notifications', id), {
      headers: { Origin: 'https://mail.example.com', 'Sec-Fetch-Site': 'cross-site' },
    });
    await expectApplied(res);
    expect(await studentFlag(id)).toBe(false);
  });

  it('refuses a body that is not the one-click form, changing nothing', async () => {
    const id = await makeStudent();
    const token = mint('student_notifications', id);

    const json = await post(token, {
      body: JSON.stringify({ 'List-Unsubscribe': 'One-Click' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(json.status).toBe(400);
    const other = await post(token, { body: new URLSearchParams({ 'List-Unsubscribe': 'Other' }) });
    expect(other.status).toBe(400);
    expect(await studentFlag(id)).toBe(true);
  });

  it('answers every token that cannot act with the same 404 and body', async () => {
    const live = await makeStudent();
    const forged = mint('student_notifications', live).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    const unknown = mint('student_notifications', crypto.randomUUID());
    const erased = mint('student_notifications', await makeStudent({ deletedAt: new Date() }));
    const teacherId = await makeTeacher();
    const tomb = await prisma.invitation.create({
      data: { teacherId, email: erasedAddress(crypto.randomUUID()) },
      select: { id: true, email: true },
    });
    const tombstoned = mint('invitation', invitationSubject(tomb.id, tomb.email));
    const deleted = await prisma.invitation.create({
      data: { teacherId, email: `unsub-api-inv-${uniqueSuffix()}@test.local` },
      select: { id: true, email: true },
    });
    const deletedToken = mint('invitation', invitationSubject(deleted.id, deleted.email));
    await prisma.invitation.delete({ where: { id: deleted.id } });

    const responses = [
      await post(forged),
      await post(unknown),
      await post(erased),
      await post(tombstoned),
      await post(deletedToken),
      await post(null),
    ];
    const bodies: string[] = [];
    for (const res of responses) {
      bodies.push(await res.clone().text());
      await expectRefusal(res, 'UNSUBSCRIBE_LINK_INVALID');
    }
    expect(new Set(bodies).size).toBe(1);
    expect(await studentFlag(live)).toBe(true);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: tomb.id } })).status).toBe('pending');
  });

  it('is throttled per IP', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await post('garbage', { headers: ip })).status);
    expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe('GET /api/unsubscribe', () => {
  it('redirects to the confirm page and changes nothing', async () => {
    const id = await makeStudent();
    const token = mint('student_notifications', id);
    const res = await fetch(`${BASE_URL}/api/unsubscribe?t=${encodeURIComponent(token)}`, { redirect: 'manual', headers: freshIp() });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')?.endsWith(`/unsubscribe#t=${token}`)).toBe(true);
    expect(await studentFlag(id)).toBe(true);
  });

  it('redirects a garbage token too', async () => {
    const res = await fetch(`${BASE_URL}/api/unsubscribe?t=garbage`, { redirect: 'manual', headers: freshIp() });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')?.endsWith('/unsubscribe#t=garbage')).toBe(true);
  });
});
