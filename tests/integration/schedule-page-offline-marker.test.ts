/**
 * `/schedule` and the offline owner marker (#725): the worker stores the page
 * only when its body names exactly one owner, and the owner is the signed-in
 * account.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, teardownTeacher } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string | undefined;
let accountId: string | undefined;
let token: string;

const markers = (html: string) => html.match(/data-offline-owner="[^"]*"/g) ?? [];

beforeAll(async () => {
  await prisma.$connect();
  try {
    const email = `schedulepage-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Schedule',
        lastName: 'Page',
        email,
        account: { create: { email } },
        bio: 'Schedule page marker fixture',
        pageSlug: `schedulepage-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    token = await seedSession(prisma, teacher.accountId);
    // Warm the route: `next dev` compiles a page lazily on its first request.
    await fetch(`${BASE_URL}/schedule`, { headers: cookie(token) }).catch(() => {});
  } catch (err) {
    await teardownTeacher(prisma, teacherId);
    throw err;
  }
}, 30_000);

afterAll(async () => {
  await teardownTeacher(prisma, teacherId);
  await prisma.$disconnect();
});

describe('the schedule page: the offline owner marker', () => {
  it('carries exactly one marker, naming the signed-in account', async () => {
    const res = await fetch(`${BASE_URL}/schedule`, { headers: cookie(token), redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(markers(await res.text())).toEqual([`data-offline-owner="${accountId}"`]);
  });
});
