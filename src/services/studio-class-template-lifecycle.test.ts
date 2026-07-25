import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  archiveOrUnarchiveStudioTemplate,
  pauseOrResumeStudioTemplate,
} from './studio-class-template-lifecycle';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

// Hoisted to module scope, mirroring class-template-lifecycle.test.ts: a pure
// function of `label` (plus the module-scope `prisma`/`uniqueSuffix` above),
// so both describe blocks below can seed their own, separate teacher
// fixtures from it. No room/teacherRoom fixture is needed here — unlike
// `ClassTemplate`, `StudioClassTemplate` has no room relation at all.
const seedTeacher = async (label: string) => {
  const email = `studio-tpl-${label}-${uniqueSuffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: label,
      lastName: 'Teacher',
      email,
      account: { create: { email } },
      bio: `Teacher for ${label} studio template tests`,
      pageSlug: `studio-tpl-${label}-${uniqueSuffix}`,
    },
  });
  return { teacherId: teacher.id, accountId: teacher.accountId };
};

describe('archiveOrUnarchiveStudioTemplate (DB)', () => {
  // Every case below is one row of the deletion rule. They are separate tests
  // rather than one sweep because when this breaks, which row broke is the
  // whole diagnosis.
  const DAY = 24 * 60 * 60 * 1000;
  const future = () => new Date(Date.now() + 5 * DAY);
  const past = () => new Date(Date.now() - 5 * DAY);
  const today = () => new Date();
  // `date` truncates to a calendar day and carries `@@unique([templateId,
  // date])`, so tests that put more than one class on the same template need
  // distinct days — plain `future()` called twice would collide.
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let otherTeacherId: string;
  let otherAccountId: string;

  const makeTemplate = (classType: string) =>
    prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType,
        dayOfWeek: 3,
        startTime: '09:30',
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
      },
    });

  // Closes over the block's own teacherId, like the sibling block's
  // makeTemplate does. `cancelledAt` stands in for the class family's
  // `status`: `StudioClass` has no status column at all.
  const makeClass = (templateId: string, opts: { date: Date; cancelledAt?: Date | null }) =>
    prisma.studioClass.create({
      data: {
        teacherId,
        templateId,
        classType: 'Archive Rule',
        date: opts.date,
        startTime: '09:00',
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
        cancelledAt: opts.cancelledAt ?? null,
      },
    });

  beforeAll(async () => {
    await prisma.$connect();
    const seeded = await seedTeacher('archive');
    teacherId = seeded.teacherId;
    accountId = seeded.accountId;

    const other = await seedTeacher('archive-other');
    otherTeacherId = other.teacherId;
    otherAccountId = other.accountId;
  });

  afterAll(async () => {
    for (const [t, a] of [
      [teacherId, accountId],
      [otherTeacherId, otherAccountId],
    ] as const) {
      await prisma.studioClass.deleteMany({ where: { teacherId: t } });
      await prisma.studioClassTemplate.deleteMany({ where: { teacherId: t } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('returns not_found for a template that does not exist', async () => {
    const result = await archiveOrUnarchiveStudioTemplate(
      prisma,
      '00000000-0000-0000-0000-000000000000',
      teacherId,
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("returns forbidden for another teacher's template, and leaves it and its classes untouched", async () => {
    const t = await makeTemplate('Not Yours');
    const c = await makeClass(t.id, { date: future() });

    // The ownership check is the only thing stopping teacher B from
    // destroying teacher A's schedule — this is the function that deletes
    // rows, so it must refuse before touching anything.
    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, otherTeacherId);

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isArchived).toBe(false);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
  });

  it('deletes a future uncancelled studio class', async () => {
    const t = await makeTemplate('Del Unbooked');
    const c = await makeClass(t.id, { date: future() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId);

    expect(result.ok).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(0);
  });

  it('keeps an already-cancelled future class — it is an income record, not an offer', async () => {
    const t = await makeTemplate('Keep Cancelled');
    const c = await makeClass(t.id, { date: future(), cancelledAt: new Date() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
  });

  it("keeps today's class — the date > now boundary", async () => {
    const t = await makeTemplate('Keep Today');
    const c = await makeClass(t.id, { date: today() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
  });

  it('keeps past classes', async () => {
    const t = await makeTemplate('Keep Past');
    const c = await makeClass(t.id, { date: past() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
  });

  it('reports deleted and remaining counts — remaining is always 0', async () => {
    const t = await makeTemplate('Counts');
    const unbooked1 = await makeClass(t.id, { date: futureOn(5) });
    const unbooked2 = await makeClass(t.id, { date: futureOn(6) });
    const pastClass = await makeClass(t.id, { date: past() });
    // Future, uncancelled classes have no registrations to consult at all —
    // there is no charged-status filter, so every one of them is deletable
    // and `remaining` can never be anything but 0.
    const alreadyCancelled = await makeClass(t.id, {
      date: futureOn(7),
      cancelledAt: new Date(),
    });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.deleted).toBe(2);
    expect(result.remaining).toBe(0);
    expect(await prisma.studioClass.count({ where: { id: unbooked1.id } })).toBe(0);
    expect(await prisma.studioClass.count({ where: { id: unbooked2.id } })).toBe(0);
    expect(await prisma.studioClass.count({ where: { id: pastClass.id } })).toBe(1);
    expect(await prisma.studioClass.count({ where: { id: alreadyCancelled.id } })).toBe(1);
  });

  it('leaves the window untouched when un-archiving', async () => {
    const t = await makeTemplate('Archive Then Resume');
    const unbooked = await makeClass(t.id, { date: futureOn(5) });
    const cancelled = await makeClass(t.id, { date: futureOn(6), cancelledAt: new Date() });

    const archived = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error('expected ok');
    expect(archived.deleted).toBe(1);
    expect(archived.remaining).toBe(0);

    const resumed = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    expect(resumed.deleted).toBe(0);
    expect(resumed.remaining).toBe(0);
    expect(resumed.template.isArchived).toBe(false);

    expect(await prisma.studioClass.count({ where: { id: unbooked.id } })).toBe(0);
    expect(await prisma.studioClass.count({ where: { id: cancelled.id } })).toBe(1);
  });
});

describe('pauseOrResumeStudioTemplate (DB)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;

  const makeTemplate = (classType: string) =>
    prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType,
        dayOfWeek: 3,
        startTime: '09:30',
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
      },
    });

  const makeClass = (templateId: string, date: Date, startTime: string) =>
    prisma.studioClass.create({
      data: {
        teacherId,
        templateId,
        classType: 'Pause Rule',
        date,
        startTime,
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
      },
    });

  beforeAll(async () => {
    await prisma.$connect();
    const seeded = await seedTeacher('pause');
    teacherId = seeded.teacherId;
    accountId = seeded.accountId;
  });

  afterAll(async () => {
    await prisma.studioClass.deleteMany({ where: { teacherId } });
    await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('pausing deletes nothing and reports the furthest-out scheduled class', async () => {
    const t = await makeTemplate('Pause Active');
    const soon = await makeClass(t.id, futureOn(3), '08:00');
    const later = await makeClass(t.id, futureOn(10), '19:00');

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isActive).toBe(false);
    expect(result.lastScheduled).not.toBeNull();
    if (!result.lastScheduled) throw new Error('expected lastScheduled');
    expect(result.lastScheduled.date.toISOString().slice(0, 10)).toBe(
      later.date.toISOString().slice(0, 10),
    );
    expect(result.lastScheduled.startTime).toBe('19:00');
    // Deletes nothing: pausing withdraws no already-generated class — that is
    // archiving's job, not pausing's.
    expect(await prisma.studioClass.count({ where: { id: soon.id } })).toBe(1);
    expect(await prisma.studioClass.count({ where: { id: later.id } })).toBe(1);
  });

  it('resuming toggles isActive back on without deleting or generating anything', async () => {
    const t = await makeTemplate('Resume Simple');
    const c = await makeClass(t.id, futureOn(3), '08:00');

    const paused = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId);
    expect(paused.ok).toBe(true);
    if (!paused.ok) throw new Error('expected ok');
    expect(paused.template.isActive).toBe(false);

    const resumed = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    expect(resumed.template.isActive).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
  });

  it('pausing a template with no scheduled classes reports lastScheduled: null', async () => {
    const t = await makeTemplate('Pause Empty');

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.lastScheduled).toBeNull();
  });

  it("returns 'archived' for an archived template rather than toggling", async () => {
    const t = await makeTemplate('Pause Archived');
    const archived = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId);
    expect(archived.ok).toBe(true);

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId);

    expect(result).toEqual({ ok: false, reason: 'archived' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(false);
  });
});
