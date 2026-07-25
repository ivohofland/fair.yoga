import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateInstancesForTemplate } from '@/services/class-generator';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let roomId: string;
let teacherRoomId: string;
let teacherAccountId: string;
let sessionToken: string;

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

/**
 * Creates one teacher plus the room/teacherRoom and signed-in session every
 * PUT case here needs — whether as the acting teacher or as the "someone
 * else's template/room" foil. Local, per-file, label-parameterized, per
 * docs/technical-architecture.md's testing-conventions note on why there is
 * no shared `makeTeacherWithSession` helper: `classes-api.test.ts`'s
 * `makeTeacher(tag)` is the pattern, and `class-template-lifecycle.test.ts`'s
 * own `seedTeacher(label)` is the sibling this mirrors — it just also needs
 * a session token, since this file drives the route over HTTP rather than
 * calling the service directly.
 */
async function seedTeacher(label: string): Promise<{
  teacherId: string;
  accountId: string;
  roomId: string;
  teacherRoomId: string;
  sessionToken: string;
}> {
  const email = `tmpl-${label}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: label,
      lastName: 'Teacher',
      email,
      account: { create: { email } },
      bio: `Teacher for ${label} template tests`,
      pageSlug: `tmpl-${label}-${suffix}`,
      defaultTimezone: 'UTC',
    },
  });
  const room = await prisma.room.create({
    data: {
      venueName: `${label} Venue`,
      address: `${suffix} ${label} St`,
      city: 'Testville',
      postcode: '1234TP',
      floor: '1',
      roomName: 'Loft',
      maxCapacity: 10,
      createdById: teacher.id,
    },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
  });
  const sessionToken = await seedSession(prisma, teacher.accountId);
  return {
    teacherId: teacher.id,
    accountId: teacher.accountId,
    roomId: room.id,
    teacherRoomId: teacherRoom.id,
    sessionToken,
  };
}

beforeAll(async () => {
  await prisma.$connect();
  const mine = await seedTeacher('teacher');
  teacherId = mine.teacherId;
  teacherAccountId = mine.accountId;
  roomId = mine.roomId;
  teacherRoomId = mine.teacherRoomId;
  sessionToken = mine.sessionToken;

  // A second teacher, for the two cross-teacher PUT cases: editing
  // someone else's template (403) and attaching to someone else's room
  // (400). Both guards live in the route today and move into the service
  // in Task 5 — these tests are what prove the move preserved them.
  const other = await seedTeacher('other');
  otherTeacherId = other.teacherId;
  otherTeacherAccountId = other.accountId;
  otherRoomId = other.roomId;
  otherTeacherRoomId = other.teacherRoomId;
  otherSessionToken = other.sessionToken;
});

afterAll(async () => {
  // By teacherId, not tracked instance ids: a test that dies between the
  // POST and its bookkeeping must not leak rows that abort the rest of the
  // cleanup chain (same pattern as the e2e suite). FK-safe order: class →
  // classTemplate → teacherRoom → room → session → teacher → account.
  for (const [t, r, a] of [
    [teacherId, roomId, teacherAccountId],
    [otherTeacherId, otherRoomId, otherTeacherAccountId],
  ] as const) {
    await prisma.class.deleteMany({ where: { teacherId: t } });
    await prisma.classTemplate.deleteMany({ where: { teacherId: t } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: t } });
    await prisma.room.delete({ where: { id: r } });
    await prisma.session.deleteMany({ where: { accountId: a } });
    await prisma.teacher.delete({ where: { id: t } });
    await prisma.account.delete({ where: { id: a } });
  }
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
  // `createTemplate` lives inside the `PUT` describe block further down this
  // file and is not visible here — this is the same POST-and-extract-id
  // shape, scoped locally rather than shared, matching this block's existing
  // cases (which each POST inline instead of reaching across describes).
  const newTemplate = async (classType: string): Promise<string> => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody(classType)),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };

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

    // Archive (forces inactive) after removing another instance: no
    // generation, and — #86 — archiving withdraws whatever remains of the
    // future unbooked window, so the count drops to zero rather than
    // staying at 3. Un-archive leaves the template paused and does not
    // restore what archiving deleted — still zero.
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
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(0);
    expect((await archive()).status).toBe(200); // un-archive
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(0);

    // Explicit activation after un-archive is the "goes live" moment: the
    // window regenerates from scratch since nothing was left standing.
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

  it('archiving deletes the unbooked future window and reports the counts', async () => {
    const id = await newTemplate('Archive Counts');
    // The POST generates a 4-week window; every class is unbooked.
    const before = await prisma.class.count({
      where: { templateId: id, date: { gt: new Date() } },
    });
    expect(before).toBeGreaterThan(0);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}?action=archive`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as { data: { deleted: number; remaining: number } };
    expect(data.deleted).toBe(before);
    expect(data.remaining).toBe(0);
    expect(
      await prisma.class.count({ where: { templateId: id, date: { gt: new Date() } } }),
    ).toBe(0);
  });

  // The bug #86 is actually about: after archiving, the classes must stop being
  // publicly bookable. The public page filters on `status: 'open'` and
  // `date >= today` (start-of-day) and never consults the template — mirrored
  // here, not the deletion predicate's `date: { gt: now }`, or this assertion
  // would be tautological with the code it guards and structurally blind to
  // the today case: the archive rule deliberately spares a class dated today,
  // so the page's own boundary is what a survivor must be checked against.
  it('archived templates leave nothing the public booking page would show', async () => {
    const id = await newTemplate('No Longer Bookable');

    await fetch(`${BASE_URL}/api/class-templates/${id}?action=archive`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const stillBookable = await prisma.class.findMany({
      where: { templateId: id, status: 'open', date: { gte: today } },
      select: { date: true },
    });
    // Today is deliberately spared by the archive rule (`date > now`), so only
    // a survivor dated after today would mean the withdrawal failed.
    expect(stillBookable.filter((c) => c.date.getTime() > today.getTime())).toEqual([]);
  });

  it('pausing deletes nothing and reports the last scheduled class', async () => {
    const id = await newTemplate('Pause Counts');
    const before = await prisma.class.count({ where: { templateId: id } });

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { lastScheduled: { startTime: string } | null };
    };
    // `toBeNull()` alone also passes on `undefined` — assert the real value
    // the template's own `startTime` (`templateBody`) would produce.
    expect(data.lastScheduled?.startTime).toBe('09:30');
    expect(await prisma.class.count({ where: { templateId: id } })).toBe(before);
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

  it('returns 404 for a well-formed id that does not exist', async () => {
    // The id must be well-formed (a real UUID) so the failure is genuinely
    // `not_found` — a malformed id would be rejected by route-level parsing
    // before the service ever looks the row up, which is a different case.
    const res = await fetch(
      `${BASE_URL}/api/class-templates/00000000-0000-0000-0000-000000000000`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
        body: JSON.stringify({ classType: 'Anything' }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for an empty payload, and writes nothing', async () => {
    const id = await createTemplate('No Fields');

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.classType).toBe('No Fields');
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

  // Body parsing now runs before the exists/ownership checks, because the
  // service owns those and needs typed data to be called at all. So a
  // malformed body against someone else's template is a 400, not the 403 the
  // pre-service handler returned. Deliberate, and not an information leak: the
  // cheap probe is `{}`, which parses fine and still yields 403 (see the case
  // above), so this ordering tells a prober strictly less, not more.
  it('rejects a malformed body before revealing that the template is not yours', async () => {
    const id = await createTemplate('Order Guard');

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(otherSessionToken) },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(400);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.classType).toBe('Order Guard');
    expect(after.isActive).toBe(true);
  });

  // `dayOfWeek` is the most destructive field on the allowlist
  // (class-template-lifecycle.ts): changing it makes syncTemplateInstances
  // DELETE mutable instances on the old day and refill on the new one. The
  // unit-level template-sync.test.ts deliberately sets `isActive: false` to
  // keep the generator out of its own tests, so this is the only place the
  // *active* refill path — the one that actually runs in production — gets
  // exercised end-to-end.
  it('a dayOfWeek change deletes the old-day instances and refills the new day', async () => {
    const id = await createTemplate('Day Shift');

    const before = await prisma.class.findMany({ where: { templateId: id } });
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((c) => c.date.getUTCDay() === EXPECTED_JS_DAY)).toBe(true);

    const NEW_DAY_OF_WEEK = (DAY_OF_WEEK + 2) % 7; // still schema convention, a different weekday
    const newExpectedJsDay = (NEW_DAY_OF_WEEK + 1) % 7;

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ dayOfWeek: NEW_DAY_OF_WEEK }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { sync: { regenerated: number } } };
    expect(data.sync.regenerated).toBeGreaterThan(0);

    // syncTemplateInstances only considers instances with `date > now`, so
    // assert over the future set rather than all instances, and avoid
    // pinning an exact count — same reasoning as the "propagates to its
    // still-mutable instances" case above.
    const future = await prisma.class.findMany({
      where: { templateId: id, date: { gt: new Date() } },
    });
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((c) => c.date.getUTCDay() === newExpectedJsDay)).toBe(true);
    expect(future.some((c) => c.date.getUTCDay() === EXPECTED_JS_DAY)).toBe(false);
  });

  // updateClassTemplate has no isArchived/isActive guard of its own, so
  // whether an archived template can be edited at all is current behaviour,
  // not a documented decision — pin it here rather than leave it assumed.
  //
  // The write below is a dayOfWeek change specifically, because that is the
  // one field whose sync could, in principle, materialize new bookable
  // classes (via the delete-then-refill path exercised by the case above).
  // Before #86, archiving didn't touch existing instances, so this used to
  // observe the PUT deleting the wrong-day instances itself (`regenerated >
  // 0`) with nothing replacing them, because an archived template is always
  // `isActive: false` and syncTemplateInstances only refills after a
  // day-of-week delete when the template is active. Now archiving already
  // withdraws the future unbooked window, so there is nothing left for the
  // PUT to find wrong-day or otherwise — `regenerated` is 0 because the
  // window is already empty, not because a refill was skipped. Either way
  // the guarantee holds: editing a shelved template cannot materialize
  // classes, it can only ever shrink or leave empty what already exists.
  it('an archived template accepts the PUT but the day-change refill never runs', async () => {
    const id = await createTemplate('Shelved Flow');
    expect(await prisma.class.count({ where: { templateId: id } })).toBeGreaterThan(0);

    const archive = await fetch(`${BASE_URL}/api/class-templates/${id}?action=archive`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(archive.status).toBe(200);
    // #86: archiving already withdrew the future unbooked window.
    expect(await prisma.class.count({ where: { templateId: id } })).toBe(0);

    const NEW_DAY_OF_WEEK = (DAY_OF_WEEK + 2) % 7;
    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ dayOfWeek: NEW_DAY_OF_WEEK }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { sync: { regenerated: number } } };
    expect(data.sync.regenerated).toBe(0);

    expect(await prisma.class.count({ where: { templateId: id } })).toBe(0);
  });
});
