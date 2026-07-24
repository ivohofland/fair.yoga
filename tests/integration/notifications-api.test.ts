import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, createSession } from './helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

const tokens: string[] = [];
const studentIds: string[] = [];
let notificationId: string;

function markRead(token: string, id: string) {
  return fetch(`${BASE_URL}/api/notifications/${id}/read`, {
    method: 'POST',
    headers: cookie(token),
  });
}

describe('POST /api/notifications/[id]/read — student recipients', () => {
  beforeAll(async () => {
    await prisma.$connect();
    for (let i = 0; i < 2; i++) {
      const student = await prisma.student.create({
        data: {
          firstName: `NotifStudent${i}`,
          lastName: 'Test',
          email: `notifapi-${suffix}-${i}@test.local`,
          incomeTier: 3,
          claimedAt: new Date(),
          account: { create: { email: `notifapi-${suffix}-${i}@test.local` } },
        },
      });
      studentIds.push(student.id);
      tokens.push(await createSession(prisma, student.accountId!));
    }
    const notification = await prisma.notification.create({
      data: {
        recipientType: 'student',
        recipientId: studentIds[0]!,
        type: 'waitlist_promoted',
        title: 'You are in',
        body: 'A spot opened and you moved off the waitlist.',
      },
    });
    notificationId = notification.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: { in: studentIds } },
    });
    const accounts = await prisma.student.findMany({
      where: { id: { in: studentIds } },
      select: { accountId: true },
    });
    await prisma.session.deleteMany({
      where: { accountId: { in: accounts.map((a) => a.accountId!) } },
    });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.$disconnect();
  });

  it("rejects another student's notification", async () => {
    const res = await markRead(tokens[1]!, notificationId);
    expect(res.status).toBe(403);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(row.isRead).toBe(false);
  });

  it('lets the recipient mark their own notification read', async () => {
    const res = await markRead(tokens[0]!, notificationId);
    expect(res.status).toBe(200);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(row.isRead).toBe(true);
  });
});
