import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, freshIp, cookie, seedSession, uniqueSuffix } from '../helpers';

describe('GET /manifest.webmanifest', () => {
  it('serves the install manifest', async () => {
    const res = await fetch(`${BASE_URL}/manifest.webmanifest`, { headers: freshIp() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/manifest+json');
    const body: unknown = await res.json();
    expect(body).toMatchObject({ start_url: '/start', display: 'standalone', theme_color: '#F7F4EF' });
  });
});

describe('the document head', () => {
  it('links the manifest and carries the theme colour', async () => {
    const res = await fetch(`${BASE_URL}/login`, { headers: freshIp() });
    const html = await res.text();
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toMatch(/<meta name="theme-color" content="#F7F4EF"/);
    expect(html).toMatch(/<meta name="apple-mobile-web-app-title" content="fair.yoga"/);
  });
});

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const teacherEmail = `pwa-start-teacher-${suffix}@test.local`;
const studentEmail = `pwa-start-student-${suffix}@test.local`;
const dualEmail = `pwa-start-dual-${suffix}@test.local`;
// Keyed by literal addresses, never by an id beforeAll assigns: a failed
// beforeAll must not leave a cleanup filter that matches every row.
const emails = [teacherEmail, studentEmail, dualEmail];

let teacherToken = '';
let studentToken = '';
let dualToken = '';

beforeAll(async () => {
  const teacherAccount = await prisma.account.create({
    data: {
      email: teacherEmail,
      teachers: { create: { firstName: 'Pwa', lastName: 'Teacher', email: teacherEmail, bio: '', pageSlug: `pwa-start-t-${suffix}` } },
    },
  });
  teacherToken = await seedSession(prisma, teacherAccount.id);

  const studentAccount = await prisma.account.create({
    data: {
      email: studentEmail,
      students: { create: { firstName: 'Pwa', lastName: 'Student', email: studentEmail, claimedAt: new Date() } },
    },
  });
  studentToken = await seedSession(prisma, studentAccount.id);

  const dualAccount = await prisma.account.create({
    data: {
      email: dualEmail,
      teachers: { create: { firstName: 'Pwa', lastName: 'Dual', email: dualEmail, bio: '', pageSlug: `pwa-start-d-${suffix}` } },
      students: { create: { firstName: 'Pwa', lastName: 'Dual', email: dualEmail, claimedAt: new Date() } },
    },
  });
  dualToken = await seedSession(prisma, dualAccount.id);
});

afterAll(async () => {
  // Session has no `account` relation (prisma/schema.prisma's Session model
  // carries only `accountId`), so cleanup filters by the ids read back from
  // the accounts this file created, not by a relation filter.
  const accounts = await prisma.account.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const accountIds = accounts.map((a) => a.id);
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { email: { in: emails } } });
  await prisma.student.deleteMany({ where: { email: { in: emails } } });
  await prisma.account.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

async function startDestination(token: string | null): Promise<string> {
  const res = await fetch(`${BASE_URL}/start`, {
    redirect: 'manual',
    headers: { ...(token ? cookie(token) : {}), ...freshIp() },
  });
  expect(res.status).toBe(307);
  return new URL(res.headers.get('location') ?? '', BASE_URL).pathname;
}

describe('GET /start', () => {
  it('sends a teacher to their schedule', async () => {
    expect(await startDestination(teacherToken)).toBe('/schedule');
  });

  it('sends a student-only account to their bookings', async () => {
    expect(await startDestination(studentToken)).toBe('/bookings');
  });

  it('sends a two-hat account to the teacher home', async () => {
    expect(await startDestination(dualToken)).toBe('/schedule');
  });

  it('sends a signed-out visitor to sign-in, not the public pitch', async () => {
    expect(await startDestination(null)).toBe('/login');
  });
});
