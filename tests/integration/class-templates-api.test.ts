import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateInstancesForTemplate } from '@/services/class-generator';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from './helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const teacherEmail = `tmpl-teacher-${suffix}@test.local`;

let teacherId: string;
let roomId: string;
let teacherRoomId: string;
let teacherAccountId: string;
let sessionToken: string;

const otherEmail = `tmpl-other-${suffix}@test.local`;
let otherTeacherId: string;
let otherTeacherAccountId: string;
let otherRoomId: string;
let otherTeacherRoomId: string;
let otherSessionToken: string;

/**
 * Schema convention (0=Monday, ..., 6=Sunday) — 3 is Thursday. Any fixed
 * weekday works; the assertion below converts to JS's getUTCDay() (0=Sunday)
 * the same way class-generator.ts does: jsDay = (dayOfWeek + 1) % 7.
 */
const DAY_OF_WEEK = 3;
const EXPECTED_JS_DAY = (DAY_OF_WEEK + 1) % 7;

function templateBody(classType: string) {
  return {
    teacherRoomId,
    classType,
    dayOfWeek: DAY_OF_WEEK,
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 15,
    minRate: 10,
    targetRate: 20,
    minStudents: 2,
    maxStudents: 8,
  };
}

beforeAll(async () => {
  await prisma.$connect();
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Template',
      lastName: 'Teacher',
      email: teacherEmail,
      account: { create: { email: teacherEmail } },
      bio: 'Teacher for template API tests',
      pageSlug: `tmpl-teacher-${suffix}`,
      defaultTimezone: 'UTC',
    },
  });
  teacherId = teacher.id;
  teacherAccountId = teacher.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Template Venue',
      address: `${suffix} Template St`,
      city: 'Testville',
      postcode: '1234TP',
      floor: '1',
      roomName: 'Loft',
      maxCapacity: 10,
      createdById: teacherId,
    },
  });
  roomId = room.id;
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
  });
  teacherRoomId = teacherRoom.id;

  sessionToken = await seedSession(prisma, teacher.accountId);

  // A second teacher, for the two cross-teacher PUT cases: editing
  // someone else's template (403) and attaching to someone else's room
  // (400). Both guards live in the route today and move into the service
  // in Task 5 — these tests are what prove the move preserved them.
  const other = await prisma.teacher.create({
    data: {
      firstName: 'Other',
      lastName: 'Teacher',
      email: otherEmail,
      account: { create: { email: otherEmail } },
      bio: 'Second teacher for template API tests',
      pageSlug: `tmpl-other-${suffix}`,
      defaultTimezone: 'UTC',
    },
  });
  otherTeacherId = other.id;
  otherTeacherAccountId = other.accountId;

  const otherRoom = await prisma.room.create({
    data: {
      venueName: 'Other Venue',
      address: `${suffix} Other St`,
      city: 'Testville',
      postcode: '5678TP',
      floor: '2',
      roomName: 'Studio',
      maxCapacity: 10,
      createdById: otherTeacherId,
    },
  });
  otherRoomId = otherRoom.id;
  const otherTeacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: otherTeacherId, roomId: otherRoomId, capacityOverride: 8, rentalRate: 15 },
  });
  otherTeacherRoomId = otherTeacherRoom.id;
  otherSessionToken = await seedSession(prisma, other.accountId);
});

afterAll(async () => {
  await prisma.class.deleteMany({ where: { teacherId: otherTeacherId } });
  await prisma.classTemplate.deleteMany({ where: { teacherId: otherTeacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: otherTeacherId } });
  await prisma.room.delete({ where: { id: otherRoomId } });
  if (otherTeacherAccountId) {
    await prisma.session.deleteMany({ where: { accountId: otherTeacherAccountId } });
  }
  await prisma.teacher.delete({ where: { id: otherTeacherId } });
  await prisma.account.deleteMany({ where: { email: otherEmail } });

  // By teacherId, not tracked ids: a test that dies between the POST
  // and its bookkeeping must not leak rows that abort the rest of the
  // cleanup chain (same pattern as the e2e suite).
  await prisma.class.deleteMany({ where: { teacherId } });
  await prisma.classTemplate.deleteMany({ where: { teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.delete({ where: { id: roomId } });
  if (teacherAccountId) {
    await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
  }
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { email: teacherEmail } });
  await prisma.$disconnect();
});

describe('POST /api/class-templates', () => {
  it('creates the template and its four-week instance window in one request', async () => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Instant Flow')),
    });
    expect(res.status).toBe(201);
    const { data: template } = (await res.json()) as { data: { id: string } };

    // The whole point: no cron ran, yet the schedule is populated.
    const instances = await prisma.class.findMany({
      where: { templateId: template.id },
      orderBy: { date: 'asc' },
    });
    expect(instances.length).toBe(4);
    for (const instance of instances) {
      expect(instance.status).toBe('open');
      expect(instance.startTime).toBe('09:30');
      expect(instance.date.getUTCDay()).toBe(EXPECTED_JS_DAY);
    }
  });

  it('a generation failure rolls the whole create back — no template, no instances', async () => {
    const before = await prisma.classTemplate.count({ where: { teacherId } });

    await expect(
      prisma.$transaction(async (tx) => {
        const created = await tx.classTemplate.create({
          data: {
            teacherId, teacherRoomId, classType: 'Rollback', dayOfWeek: 2,
            startTime: '09:00', durationMinutes: 60, roomCost: 10, minRate: 10,
            targetRate: 20, minStudents: 1, maxStudents: 8,
            // cancelDeadline/autoCancelCheck are enums with schema defaults
            // (HOURS_24 / HOURS_2) — the brief's numeric 120 predates that;
            // omitted here to compile against the current schema.
          },
          include: { teacher: { select: { defaultTimezone: true } } },
        });
        // Deterministic FK failure (P2003, not the swallowed P2002): bogus room.
        await generateInstancesForTemplate(tx, {
          ...created,
          teacherRoomId: '00000000-0000-4000-8000-000000000000',
        });
        return created;
      }),
    ).rejects.toThrow();

    const after = await prisma.classTemplate.count({ where: { teacherId } });
    expect(after).toBe(before);
  });
});

describe('PATCH /api/class-templates/[id]', () => {
  it('re-activation tops the window back up; archive and pause do not generate', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Toggle Flow')),
    });
    expect(create.status).toBe(201);
    const { data: template } = (await create.json()) as { data: { id: string } };
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(4);

    // Simulate window drift: one instance vanishes (e.g. teacher-cancelled
    // long ago and pruned). Regeneration is what heals it.
    const first = await prisma.class.findFirstOrThrow({
      where: { templateId: template.id },
      orderBy: { date: 'asc' },
    });
    await prisma.class.delete({ where: { id: first.id } });

    const toggle = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });

    // active → paused: no generation.
    const pause = await toggle();
    expect(pause.status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(3);

    // paused → active: the missing instance comes back.
    const activate = await toggle();
    expect(activate.status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(4);

    // Archive (forces inactive) after removing another instance: no generation,
    // and un-archive leaves the template paused — still no generation.
    const next = await prisma.class.findFirstOrThrow({
      where: { templateId: template.id },
      orderBy: { date: 'asc' },
    });
    await prisma.class.delete({ where: { id: next.id } });
    const archive = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?action=archive`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });
    expect((await archive()).status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(3);
    expect((await archive()).status).toBe(200); // un-archive
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(3);

    // Explicit activation after un-archive is the "goes live" moment.
    expect((await toggle()).status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(4);
  });

  it('refuses to toggle an archived template — no instant classes for shelved things', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Shelved Flow')),
    });
    expect(create.status).toBe(201);
    const { data: template } = (await create.json()) as { data: { id: string } };

    const archive = await fetch(
      `${BASE_URL}/api/class-templates/${template.id}?action=archive`,
      { method: 'PATCH', headers: cookie(sessionToken) },
    );
    expect(archive.status).toBe(200);
    await prisma.class.deleteMany({ where: { templateId: template.id } });

    const toggle = await fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(toggle.status).toBe(409);

    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(after.isActive).toBe(false);
    expect(after.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(0);
  });

  it('re-activation generates only for the re-activated template, not teacher-wide', async () => {
    // Template A: paused, no instances — created directly (bypassing the
    // route) so its window starts empty.
    const templateA = await prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Scope A',
        dayOfWeek: 4,
        startTime: '10:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
        isActive: false,
      },
    });

    // Template B: already active, no instances — also created directly so
    // the old teacher-wide generator's "top up every active template"
    // behavior would have populated it; the new template-scoped generator
    // must leave it alone.
    const templateB = await prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Scope B',
        dayOfWeek: 5,
        startTime: '10:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
        isActive: true,
      },
    });
    expect(await prisma.class.count({ where: { templateId: templateB.id } })).toBe(0);

    const activate = await fetch(`${BASE_URL}/api/class-templates/${templateA.id}`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(activate.status).toBe(200);

    // A's window generated...
    expect(
      await prisma.class.count({ where: { templateId: templateA.id } }),
    ).toBeGreaterThanOrEqual(1);
    // ...but B — also active, untouched by this request — stays empty.
    expect(await prisma.class.count({ where: { templateId: templateB.id } })).toBe(0);

    await prisma.class.deleteMany({ where: { templateId: { in: [templateA.id, templateB.id] } } });
    await prisma.classTemplate.deleteMany({ where: { id: { in: [templateA.id, templateB.id] } } });
  });
});

describe('PUT /api/class-templates/[id]', () => {
  const createTemplate = async (classType: string): Promise<string> => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody(classType)),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    return data.id;
  };

  it('updates the template and propagates to its still-mutable instances', async () => {
    const id = await createTemplate('Editable Flow');

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ classType: 'Renamed Flow', durationMinutes: 75 }),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { classType: string; durationMinutes: number; sync: { synced: number } };
    };
    expect(data.classType).toBe('Renamed Flow');
    expect(data.durationMinutes).toBe(75);

    // Nothing is booked, so every future instance is still mutable. Asserted
    // on the future set rather than a fixed count: syncTemplateInstances uses
    // `date > now`, so whether today's instance is in scope depends on the
    // clock, and pinning "4" here would be flaky by construction.
    expect(data.sync.synced).toBeGreaterThan(0);
    const future = await prisma.class.findMany({
      where: { templateId: id, date: { gt: new Date() } },
    });
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((c) => c.classType === 'Renamed Flow')).toBe(true);
    expect(future.every((c) => c.durationMinutes === 75)).toBe(true);
  });

  it("refuses to edit another teacher's template", async () => {
    const id = await createTemplate('Not Yours');

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(otherSessionToken) },
      body: JSON.stringify({ classType: 'Hijacked' }),
    });
    expect(res.status).toBe(403);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.classType).toBe('Not Yours');
  });

  // This is the runtime behaviour every compile-time pin's reasoning rests on:
  // an undeclared key is a 400, so the ONLY way a forbidden column reaches
  // Prisma is by being declared in the schema — a source edit, which the pins
  // catch. If this test ever fails, the pins are guarding the wrong thing.
  it('rejects an undeclared key — the schema is strict', async () => {
    const id = await createTemplate('Strict Flow');

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ classType: 'Renamed', isActive: false }),
    });
    expect(res.status).toBe(400);

    // Rejected whole: the declared field is not written either.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.classType).toBe('Strict Flow');
    expect(after.isActive).toBe(true);
  });

  it("refuses a teacherRoom belonging to another teacher", async () => {
    const id = await createTemplate('Room Guard');

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ teacherRoomId: otherTeacherRoomId }),
    });
    expect(res.status).toBe(400);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });
});
