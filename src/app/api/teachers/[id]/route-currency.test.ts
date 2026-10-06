/**
 * `PUT /api/teachers/[id]` with a `currency` (#758, spec A2), invoked
 * directly against the test database: the switch's counts in the body, the
 * unchanged answer, and the other fields written in the same transaction.
 * Which rows a switch relabels is `src/services/currency-switch.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import { fixtureRun, type RoomFixture } from '../../../../../tests/room-fixtures';
import { createClassFixture } from '../../../../../tests/class-fixtures';
import { cookie, seedSession } from '../../../../../tests/helpers';
import { expectRefusal } from '../../../../../tests/api-assertions';
import { hhmmToTime } from '@/lib/time-of-day';
import { PUT } from './route';

const prisma = new PrismaClient();
const fx = fixtureRun('curput');

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  const accounts = await prisma.teacher.findMany({
    where: { pageSlug: { startsWith: fx.suffix } },
    select: { accountId: true },
  });
  await prisma.session.deleteMany({ where: { accountId: { in: accounts.map((a) => a.accountId) } } });
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

async function teacherWithClass(): Promise<RoomFixture & { classId: string; token: string }> {
  const f = await fx.makeFixture(prisma);
  const teacher = await prisma.teacher.update({
    where: { id: f.teacherId },
    data: { defaultTimezone: 'UTC' },
    select: { accountId: true },
  });
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 10);
  const cls = await createClassFixture(prisma, {
    teacherId: f.teacherId,
    teacherRoomId: f.linkId,
    classType: 'Vinyasa',
    date,
    startTime: hhmmToTime('10:00'),
    durationMinutes: 60,
    roomCost: new Prisma.Decimal(20),
    minRate: new Prisma.Decimal(15),
    targetRate: new Prisma.Decimal(25),
    minStudents: 2,
    maxStudents: 10,
    status: 'open',
  });
  const token = await seedSession(prisma, teacher.accountId);
  return { ...f, classId: cls.id, token };
}

function put(t: { teacherId: string; token: string }, body: Record<string, unknown>): Promise<Response> {
  return PUT(
    new NextRequest(`http://localhost:3000/api/teachers/${t.teacherId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(t.token) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: t.teacherId }) },
  );
}

type Body = {
  data: { id: string; currency: string; bio: string; currencySwitch?: unknown };
  outcome?: string;
};

describe('PUT /api/teachers/[id] with a currency (#758)', () => {
  it('switches, and answers the teacher with the counts', async () => {
    const t = await teacherWithClass();

    const res = await put(t, { currency: 'GBP' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.outcome).toBeUndefined();
    expect(body.data.currency).toBe('GBP');
    expect(body.data.currencySwitch).toEqual({
      relabelled: { classes: 1, studioClasses: 0 },
      kept: { classes: 0, studioClasses: 0 },
    });
    expect(
      (await prisma.class.findUniqueOrThrow({ where: { id: t.classId }, select: { currency: true } })).currency,
    ).toBe('GBP');
  });

  it('answers unchanged for the stored currency alone and writes nothing', async () => {
    const t = await teacherWithClass();
    const before = await prisma.teacher.findUniqueOrThrow({ where: { id: t.teacherId } });

    const res = await put(t, { currency: 'EUR' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.outcome).toBe('unchanged');
    expect(body.data.id).toBe(t.teacherId);
    expect(body.data.currencySwitch).toBeUndefined();
    expect(await prisma.teacher.findUniqueOrThrow({ where: { id: t.teacherId } })).toEqual(before);
  });

  it('writes the other fields beside an unchanged currency, without counts', async () => {
    const t = await teacherWithClass();

    const res = await put(t, { currency: 'EUR', bio: 'A new bio' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.outcome).toBeUndefined();
    expect(body.data.bio).toBe('A new bio');
    expect(body.data.currencySwitch).toBeUndefined();
  });

  it('writes the other fields and the switch in one save', async () => {
    const t = await teacherWithClass();

    const res = await put(t, { currency: 'USD', bio: 'Moved' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.data).toMatchObject({ currency: 'USD', bio: 'Moved' });
    expect(body.data.currencySwitch).toEqual({
      relabelled: { classes: 1, studioClasses: 0 },
      kept: { classes: 0, studioClasses: 0 },
    });
  });

  it('switches nothing when another field in the same save is refused', async () => {
    const t = await teacherWithClass();
    const other = await fx.makeFixture(prisma);
    const { pageSlug: taken } = await prisma.teacher.findUniqueOrThrow({
      where: { id: other.teacherId },
      select: { pageSlug: true },
    });
    const own = await prisma.teacher.findUniqueOrThrow({ where: { id: t.teacherId }, select: { pageSlug: true } });

    const res = await put(t, { currency: 'GBP', pageSlug: taken });

    await expectRefusal(res, 'SLUG_TAKEN');
    expect(
      await prisma.teacher.findUniqueOrThrow({ where: { id: t.teacherId }, select: { currency: true, pageSlug: true } }),
    ).toEqual({ currency: 'EUR', pageSlug: own.pageSlug });
    expect(
      (await prisma.class.findUniqueOrThrow({ where: { id: t.classId }, select: { currency: true } })).currency,
    ).toBe('EUR');
  });
});
