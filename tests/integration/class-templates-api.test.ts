import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
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
 * Schema convention (0=Monday, ..., 6=Sunday). The assertions below convert to
 * JS's getUTCDay() (0=Sunday) the same way class-generator.ts does:
 * jsDay = (dayOfWeek + 1) % 7.
 *
 * Derived rather than fixed, and this is load-bearing (#123's class-family
 * sibling). A fixed weekday fails on the day it names: the generator keeps
 * today's occurrence while its start time is still ahead, archive's `gt: today`
 * then spares that class, and `remaining`'s `gte: today` counts it — so
 * `expect(remaining).toBe(0)` saw 1 every Thursday before 09:30 in the
 * teacher's zone. The comment this replaces claimed "any fixed weekday works",
 * which is exactly the assumption that broke.
 *
 * Two days out, not one: the teacher's zone can be a calendar day ahead of
 * UTC's (Europe/Amsterdam is, after 22:00 UTC in summer), so "tomorrow in UTC"
 * is sometimes "today for the teacher" and would just move the failure to a
 * different window. Two clears any zone. `NEW_DAY_OF_WEEK` below derives from
 * this and lands another two out, so it is never today either.
 */
const DAY_OF_WEEK = (((new Date().getUTCDay() + 6) % 7) + 2) % 7;
const EXPECTED_JS_DAY = (DAY_OF_WEEK + 1) % 7;

// startTime is required, not defaulted — every call site below must state
// its own: ClassTemplate_teacher_slot_unique is (teacherId, dayOfWeek,
// startTime) WHERE isArchived = false, this file reuses one teacher and one
// dayOfWeek throughout, and most of these templates are never archived by
// the end of their test (that is what several of them are proving) — so the
// only way for later templates to coexist with earlier still-active ones is
// a startTime of their own. A default here would silently reopen the exact
// collision this file was repaired for, the moment a ninth inline caller
// forgot to pass one.
function templateBody(classType: string, startTime: string) {
  return {
    teacherRoomId,
    classType,
    dayOfWeek: DAY_OF_WEEK,
    startTime,
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

beforeEach(async () => {
  // Every template in this file now holds its own dayOfWeek/startTime slot —
  // `templateBody` takes `startTime` with no default, and every call site
  // below passes a distinct value, so a sibling test's window cannot starve
  // another's the way an earlier fixture shape did. What remains is cross-run
  // leftovers: this suite runs against the persistent dev DB, not a fresh one
  // per run, and a second run on the same day would regenerate the identical
  // candidate dates for the identical (teacherId, dayOfWeek, startTime)
  // combinations a previous run already filled — exactly the case #196's slot
  // pre-check now recognises as occupied and reports 0 created for. Clearing
  // both teachers' classes here keeps each run starting from the empty slate
  // the templates below assume. beforeAll seeds no classes, so clearing both
  // teachers' is sufficient.
  await prisma.class.deleteMany({ where: { teacherId: { in: [teacherId, otherTeacherId] } } });
});

describe('POST /api/class-templates', () => {
  it('creates the template and its four-week instance window in one request', async () => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Instant Flow', '09:30')),
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

  // #196. The create sits inside a $transaction that also generates the
  // four-week window, so a duplicate here is worse than a duplicate row: a
  // second identical template would have meant a second full four-week set
  // of bookable classes. '09:40' and '11:00' are the two slots left over in
  // this file's dense startTime sequence for DAY_OF_WEEK — see
  // templateBody's docblock above.
  describe('POST /api/class-templates is retry-safe on the slot key (#196)', () => {
    const post = (body: unknown) =>
      fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
        body: JSON.stringify(body),
      });

    it('answers a repeated identical create with 409 and leaves one template and one window', async () => {
      const body = templateBody('Slot Recurring', '09:40');

      const first = await post(body);
      expect(first.status).toBe(201);

      const second = await post(body);
      expect(second.status).toBe(409);
      expect((await second.json()).error.code).toBe('DUPLICATE_TEMPLATE_SLOT');

      const templates = await prisma.classTemplate.findMany({
        where: { teacherId, dayOfWeek: DAY_OF_WEEK, startTime: '09:40', isArchived: false },
      });
      expect(templates).toHaveLength(1);

      // The half the endpoint's severity actually lives in: a second
      // template would have generated a second full four-week set of
      // bookable classes.
      const generated = await prisma.class.findMany({
        where: { templateId: templates[0]!.id },
      });
      expect(generated).toHaveLength(4);
    });

    it('leaves one template and one window when two identical creates are in flight at once', async () => {
      const body = templateBody('Slot Recurring Concurrent', '11:00');

      const [a, b] = await Promise.all([post(body), post(body)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);

      const loser = a.status === 409 ? a : b;
      expect((await loser.json()).error.code).toBe('DUPLICATE_TEMPLATE_SLOT');

      const templates = await prisma.classTemplate.findMany({
        where: { teacherId, dayOfWeek: DAY_OF_WEEK, startTime: '11:00', isArchived: false },
      });
      expect(templates).toHaveLength(1);

      const generated = await prisma.class.findMany({
        where: { templateId: templates[0]!.id },
      });
      expect(generated).toHaveLength(4);
    });
  });
});

describe('PATCH /api/class-templates/[id]', () => {
  // `createTemplate` lives inside the `PUT` describe block further down this
  // file and is not visible here — this is the same POST-and-extract-id
  // shape, scoped locally rather than shared, matching this block's existing
  // cases (which each POST inline instead of reaching across describes).
  // startTime is required, not defaulted, so every call site below is
  // forced to pick its own slot — see templateBody's comment above.
  const newTemplate = async (classType: string, startTime: string): Promise<string> => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody(classType, startTime)),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };

  it('re-activation tops the window back up; archive and pause do not generate', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Toggle Flow', '09:31')),
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

    const toggle = (state: string) =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?state=${state}`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });

    // active → paused: no generation.
    const pause = await toggle('paused');
    expect(pause.status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(3);

    // paused → active: the missing instance comes back.
    const activate = await toggle('active');
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
    const archive = (state: string) =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?state=${state}`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });
    expect((await archive('archived')).status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(0);
    expect((await archive('unarchived')).status).toBe(200); // un-archive
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(0);

    // Explicit activation after un-archive is the "goes live" moment: the
    // window regenerates from scratch since nothing was left standing.
    expect((await toggle('active')).status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(4);
  });

  it('refuses to activate an archived template — no instant classes for shelved things', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Shelved Flow', '09:32')),
    });
    expect(create.status).toBe(201);
    const { data: template } = (await create.json()) as { data: { id: string } };

    const archive = await fetch(
      `${BASE_URL}/api/class-templates/${template.id}?state=archived`,
      { method: 'PATCH', headers: cookie(sessionToken) },
    );
    expect(archive.status).toBe(200);
    await prisma.class.deleteMany({ where: { templateId: template.id } });

    const toggle = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=active`, {
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

    const activate = await fetch(`${BASE_URL}/api/class-templates/${templateA.id}?state=active`, {
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
    const id = await newTemplate('Archive Counts', '09:33');
    // The POST generates a 4-week window; every class is unbooked.
    const before = await prisma.class.count({
      where: { templateId: id, date: { gt: new Date() } },
    });
    expect(before).toBeGreaterThan(0);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}?state=archived`, {
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
    const id = await newTemplate('No Longer Bookable', '09:34');

    await fetch(`${BASE_URL}/api/class-templates/${id}?state=archived`, {
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
    const id = await newTemplate('Pause Counts', '09:35');
    const before = await prisma.class.count({ where: { templateId: id } });

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}?state=paused`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { lastScheduled: { startTime: string } | null };
    };
    // `toBeNull()` alone also passes on `undefined` — assert the real value
    // the template's own `startTime` (passed to `newTemplate` above) would
    // produce.
    expect(data.lastScheduled?.startTime).toBe('09:35');
    expect(await prisma.class.count({ where: { templateId: id } })).toBe(before);
  });

  it('rejects a PATCH with no state parameter', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('No State', '09:36')),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(400);

    // The row is untouched — a rejected request must not have toggled anything.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.isActive).toBe(true);
  });

  it('rejects an unrecognised state value', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Bad State', '09:37')),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=sideways`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(400);

    // Same guarantee as the no-state case above — an unrecognised value is
    // rejected whole, not partially applied.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.isActive).toBe(true);
  });

  /**
   * The #98 case. Two identical requests must reach the same state, not
   * opposite ones — this is what the old `!current` toggle got wrong when a
   * response was lost and the teacher clicked again.
   */
  it('is idempotent: pausing twice leaves the template paused', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Twice Paused', '09:38')),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const pause = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?state=paused`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });

    const first = await pause();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: { action: string } }).data.action).toBe('paused');

    const second = await pause();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.isActive).toBe(false);
  });

  /**
   * The sharpest half of #98: archiving withdraws unbooked future classes, so a
   * second archive that fell through to un-archive would un-shelve the template.
   * It must be a no-op — and must NOT withdraw a second time.
   */
  it('is idempotent: archiving twice does not withdraw twice', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Twice Archived', '09:39')),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const archive = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?state=archived`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });

    const first = await archive();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { action: string; deleted: number } };
    expect(firstBody.data.action).toBe('archived');

    const survivors = await prisma.class.count({ where: { templateId: template.id } });

    const second = await archive();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(survivors);
  });

  // Same code path as the two idempotency cases above (both arms share one
  // `template.isActive === desiredActive` / `template.isArchived === archiving`
  // guard), but the spec asks for "the same request twice is idempotent"
  // without qualifying which of the four values — cheap insurance that the
  // other two reach it too.
  it('is idempotent: activating twice leaves the template active', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Twice Active', '09:41')),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    // Pause first so the template starts inactive — activating an
    // already-active template would be `unchanged` on the very first call.
    const pause = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=paused`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(pause.status).toBe(200);

    const activate = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?state=active`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });

    const first = await activate();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: { action: string } }).data.action).toBe('active');

    const second = await activate();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.isActive).toBe(true);
  });

  it('is idempotent: un-archiving twice leaves the template un-archived', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Twice Unarchived', '09:42')),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const archive = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=archived`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(archive.status).toBe(200);

    const unarchive = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?state=unarchived`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });

    const first = await unarchive();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: { action: string } }).data.action).toBe('unarchived');

    const second = await unarchive();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.isArchived).toBe(false);
  });

  // Task 6b (#196). `ClassTemplate_teacher_slot_unique` is (teacherId,
  // dayOfWeek, startTime) WHERE isArchived = false — un-archiving is the one
  // transition that re-enters that partial scope, so a shelved template can
  // now collide with a live one holding the same slot.
  it('refuses to un-archive into a slot another live template already holds', async () => {
    const live = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Unarchive Slot Live', '09:52')),
    });
    expect(live.status).toBe(201);

    const shelved = await prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Unarchive Slot Shelved',
        dayOfWeek: DAY_OF_WEEK,
        startTime: '09:52',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
        isArchived: true,
        isActive: false,
      },
    });

    const res = await fetch(`${BASE_URL}/api/class-templates/${shelved.id}?state=unarchived`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('DUPLICATE_TEMPLATE_SLOT');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: shelved.id } });
    expect(after.isArchived).toBe(true);
  });
});

/**
 * The `busy` arms, at the wire.
 *
 * Their *existence* is compile-forced — each route closes its reason chain
 * with `const unhandled: never = result`, so a new reason cannot be ignored.
 * That pins nothing about what the arm answers: a 503 typed as 500, the studio
 * code pasted into the class route, or an inverted
 * `state === 'archived' ? 'archive' : 'unarchive'` all compile clean, and all
 * three produce grammatical English. The sibling `slot_conflict` arm, three
 * lines up the same chain, has been pinned this way since it shipped.
 *
 * Holding the row `FOR UPDATE` from this process is what the hourly generation
 * sweep's claim does to the same row. The route's transaction opens with
 * `setLockTimeout`, so its compare-and-swap gives up after 2s instead of
 * waiting the holder out — which is the whole outcome under test.
 *
 * Covers PUT too, not just PATCH, despite the describe's original name
 * surviving from before PUT had a `busy` arm at all — the atomic-template-
 * update branch gave `updateClassTemplate` one (spec §3.2), and its own
 * `class-generator.test.ts:672` unit test pins the *service* outcome but
 * nothing at the wire pinned the status, code or copy the way both PATCH
 * siblings below already were. Same `holdTemplateRow` helper, same
 * contention shape — the PUT case is added alongside these two rather than
 * split into its own describe.
 */
describe('PATCH & PUT /api/class-templates/[id] — lock contention', () => {
  const holdTemplateRow = (id: string) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ClassTemplate" WHERE id = ${id} FOR UPDATE`;
        await held;
      },
      { timeout: 15_000 },
    );
    return { release, settled };
  };

  it(
    'answers 503 TEMPLATE_BUSY when an archive loses the row, and changes nothing',
    async () => {
      const t = await prisma.classTemplate.create({
        data: {
          teacherId,
          teacherRoomId,
          classType: 'Busy Archive',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:53',
          durationMinutes: 60,
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 8,
        },
      });

      const { release, settled } = holdTemplateRow(t.id);
      // Let the holder take the row before the request contends for it.
      await new Promise((r) => setTimeout(r, 100));

      try {
        const res = await fetch(`${BASE_URL}/api/class-templates/${t.id}?state=archived`, {
          method: 'PATCH',
          headers: cookie(sessionToken),
        });

        expect(res.status).toBe(503);
        const json = (await res.json()) as { error: { code: string; message: string } };
        expect(json.error.code).toBe('TEMPLATE_BUSY');
        expect(json.error.message).toContain('could not archive this recurring class');
        expect(json.error.message).toContain('Nothing was changed.');

        // That last sentence is a promise about the data, so it is read back
        // rather than trusted — and it is what makes the retry the copy
        // invites safe to offer.
        const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.isArchived).toBe(false);
        expect(after.archivedAt).toBeNull();
      } finally {
        release();
        await settled.catch(() => {});
      }
    },
    20_000,
  );

  it(
    'answers 503 TEMPLATE_BUSY when a pause loses the row',
    async () => {
      const t = await prisma.classTemplate.create({
        data: {
          teacherId,
          teacherRoomId,
          classType: 'Busy Pause',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:54',
          durationMinutes: 60,
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 8,
        },
      });

      const { release, settled } = holdTemplateRow(t.id);
      await new Promise((r) => setTimeout(r, 100));

      try {
        const res = await fetch(`${BASE_URL}/api/class-templates/${t.id}?state=paused`, {
          method: 'PATCH',
          headers: cookie(sessionToken),
        });

        expect(res.status).toBe(503);
        const json = (await res.json()) as { error: { code: string; message: string } };
        expect(json.error.code).toBe('TEMPLATE_BUSY');
        // "update", not "pause": this arm serves both directions, and the CAS
        // makes the transition itself the thing that did not happen.
        expect(json.error.message).toContain('could not update this recurring class');
        // Asserted on both arms, not just the archive ones: this sentence is
        // the rollback promise, and dropping it from either would otherwise go
        // unnoticed.
        expect(json.error.message).toContain('Nothing was changed.');

        const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.isActive).toBe(true);
      } finally {
        release();
        await settled.catch(() => {});
      }
    },
    20_000,
  );

  it(
    'answers 503 TEMPLATE_BUSY when a PUT edit loses the row, and changes nothing',
    async () => {
      const t = await prisma.classTemplate.create({
        data: {
          teacherId,
          teacherRoomId,
          classType: 'Busy PUT',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:55',
          durationMinutes: 60,
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 8,
        },
      });

      const { release, settled } = holdTemplateRow(t.id);
      // Let the holder take the row before the request contends for it.
      await new Promise((r) => setTimeout(r, 100));

      try {
        const res = await fetch(`${BASE_URL}/api/class-templates/${t.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
          body: JSON.stringify({ classType: 'Renamed While Busy' }),
        });

        expect(res.status).toBe(503);
        const json = (await res.json()) as { error: { code: string; message: string } };
        expect(json.error.code).toBe('TEMPLATE_BUSY');
        // Distinct copy from both PATCH busy branches above (spec §3.2's
        // requirement is specifically against the pause/resume wording,
        // "could not update this recurring class"; checked against the
        // archive wording too since both live in the same file): this is the
        // edit, those are the toggle.
        expect(json.error.message).toContain(
          'could not save your changes to this recurring class',
        );
        expect(json.error.message).not.toContain('could not update this recurring class');
        expect(json.error.message).not.toContain('could not archive this recurring class');
        // Asserted on all three arms, not just the PATCH ones: this sentence
        // is the rollback promise, and dropping it from any would otherwise
        // go unnoticed.
        expect(json.error.message).toContain('Nothing was changed.');

        // That last sentence is a promise about the data, so it is read back
        // rather than trusted, matching the archive case above.
        const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.classType).toBe('Busy PUT');
      } finally {
        release();
        await settled.catch(() => {});
      }
    },
    20_000,
  );
});

describe('PUT /api/class-templates/[id]', () => {
  // startTime is required, not defaulted, so every call site below is
  // forced to pick its own slot — see templateBody's comment above.
  const createTemplate = async (classType: string, startTime: string): Promise<string> => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody(classType, startTime)),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    return data.id;
  };

  it('updates the template and propagates to its still-mutable instances', async () => {
    const id = await createTemplate('Editable Flow', '09:43');

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
    const id = await createTemplate('No Fields', '09:44');

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
    const id = await createTemplate('Not Yours', '09:45');

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
    const id = await createTemplate('Strict Flow', '09:46');

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
    const id = await createTemplate('Room Guard', '09:47');

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
    const id = await createTemplate('Order Guard', '09:48');

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
    const id = await createTemplate('Day Shift', '09:49');

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
    const id = await createTemplate('Shelved Flow', '09:50');
    expect(await prisma.class.count({ where: { templateId: id } })).toBeGreaterThan(0);

    const archive = await fetch(`${BASE_URL}/api/class-templates/${id}?state=archived`, {
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

  // Task 6b (#196). `ClassTemplate_teacher_slot_unique` is (teacherId,
  // dayOfWeek, startTime) WHERE isArchived = false — the six indexes
  // constrain every write, not just creates, so moving a template's own
  // dayOfWeek/startTime onto a slot another of the teacher's live templates
  // already holds collides here exactly as a create into that slot does.
  it('refuses a dayOfWeek/startTime change onto a slot another live template already holds', async () => {
    await createTemplate('PUT Slot Occupant', '09:51');
    const moverId = await createTemplate('PUT Slot Mover', '11:16');

    const res = await fetch(`${BASE_URL}/api/class-templates/${moverId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ startTime: '09:51' }),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('DUPLICATE_TEMPLATE_SLOT');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: moverId } });
    expect(after.startTime).toBe('11:16');
  });

  // A second, independent way the same PUT can raise P2002: not the
  // template's own slot key, but `syncTemplateInstances`'s propagation of the
  // new `startTime` onto its still-mutable generated `Class` rows
  // (`template-sync.ts`), which can land one of those instances on a slot an
  // unrelated class already occupies (`Class_teacher_slot_unique`). The
  // template row and the sync are one transaction now (#83, #209), so this
  // collision rolls the whole write back — the template's own `startTime`
  // never commits either — asserted below rather than assumed.
  it('refuses a startTime change whose propagation to a generated instance would collide', async () => {
    const id = await createTemplate('Sync Slot Template', '11:17');
    const instances = await prisma.class.findMany({
      where: { templateId: id },
      orderBy: { date: 'asc' },
    });
    expect(instances.length).toBeGreaterThan(0);
    const targetDate = instances[0]!.date;

    // Unrelated to the template: a standalone class already sitting at the
    // (date, startTime) the template's startTime change will try to move its
    // own same-day instance onto.
    await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Sync Slot Blocker',
        date: targetDate,
        startTime: '11:18',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
        status: 'draft',
      },
    });

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ startTime: '11:18' }),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    // A distinct code from the plain slot collision (#209): this one is
    // raised by the generated instance's collision, not the template's own
    // slot, even though both now roll the whole write back with nothing
    // changed.
    expect(json.error.code).toBe('TEMPLATE_SYNC_SLOT_CONFLICT');
    // The message must describe what actually happened: nothing did, because
    // the template write and the sync are one transaction now (#83, #209)
    // and this collision rolled both back. It still has to name the remedy —
    // a teacher reading only "you already have a class at that time" has no
    // way to know what to do about it.
    expect(json.error.message).toBe(
      'Your scheduled classes could not be moved — you already have a class at that time. Nothing was changed. Move or cancel that class, then edit this recurring class again.',
    );

    // The template write is now in the same transaction as the sync that
    // failed, so it rolled back with it (#83, #209). This assertion is the
    // inverse of the one that stood here before: it asserted `'11:18'`,
    // pinning the half-applied write as intended behaviour.
    const template = await prisma.classTemplate.findUniqueOrThrow({ where: { id } });
    expect(template.startTime).toBe('11:17');

    const instance = await prisma.class.findUniqueOrThrow({ where: { id: instances[0]!.id } });
    expect(instance.startTime).toBe('11:17');
  });
});
