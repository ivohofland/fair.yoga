/**
 * `/api/studio-class-templates` and `/api/studio-classes` — the second template
 * family #53 named, and the last of its route inventory.
 *
 * `StudioClass` is documented as "disconnected from Room/Student — pure
 * calendar + income tracking", so unlike the class family there is no booking,
 * no pricing engine and no cross-teacher surface. What that leaves worth
 * pinning, per `docs/technical-architecture.md`, is the bespoke ownership chain
 * (every row is scoped to one teacher) and the state guards on the toggles —
 * not a 401/403 ladder re-testing `requireTeacher` on six more verbs.
 *
 * The two template families were compared before writing this, per #53's own
 * advice. They share their shape but diverged in one place that mattered: the
 * class family refuses to activate an archived template AND filters archived
 * ones out of the generator, while the studio family did neither. That was a
 * live bug — a shelved studio template could be toggled active and the cron
 * sweep would materialise classes for it. Both guards now match; the
 * generator half is pinned in `src/services/studio-class-generator.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateStudioInstancesForTemplate } from '@/services/studio-class-generator';
import { startOfLocalDay, mondayOf } from '@/lib/timezone';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { createClassFixture, createStudioClassFixture } from '../class-fixtures';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let ownerId: string;
let ownerAccountId: string;
let ownerToken: string;
let otherId: string;
let otherAccountId: string;
let otherToken: string;

/** Owned by `owner` — the subject of the ownership cases. */
let templateId: string;
let studioClassId: string;

async function makeTeacher(tag: string) {
  const email = `studioapi-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Studio',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Studio API tests',
      pageSlug: `studioapi-${tag}-${suffix}`,
    },
  });
  return {
    id: teacher.id,
    accountId: teacher.accountId,
    token: await seedSession(prisma, teacher.accountId),
  };
}

const send = (method: string, token: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// dayOfWeek and startTime are both required, not defaulted — every call site
// below must state its own. `ScheduleRule_teacher_slot_excl` (issue 298)
// replaced `StudioClassTemplate_teacher_slot_unique`'s exact-string match with
// a RANGE-overlap exclusion, so an unarchived template for `ownerId` now needs
// a slot nothing else this teacher holds is overlapping, not merely a
// different string — one 60-minute-wide day no longer holds every fixture this
// file creates, which is why `dayOfWeek` is a parameter rather than the fixed
// 3 it used to be. 3 is still 'Owner Template' (beforeAll's '18:00'), so no
// other caller can safely reuse it without also picking a clear startTime; a
// caller past that day's budget states a day of its own instead. A default
// for either parameter would silently reopen the exact collision this
// signature exists to dodge — the class family's twin,
// `class-templates-api.test.ts`'s `templateBody`, made the same removal for
// the same reason.
const makeTemplate = (
  teacherId: string,
  classType: string,
  dayOfWeek: number,
  startTime: string,
  extra: { isArchived?: boolean; isActive?: boolean } = {},
) =>
  prisma.studioClassTemplate.create({
    data: {
      scheduleRule: {
        create: {
          teacherId,
          kind: 'studio',
          classType,
          dayOfWeek,
          startTime: hhmmToTime(startTime),
          durationMinutes: 60,
          ...extra,
        },
      },
      location: 'Community Studio',
      hourlyRate: 45,
    },
  });

/**
 * Two weekdays whose next occurrences fall in the SAME Monday-week: the day a
 * template starts on and the day it is moved to.
 *
 * `getNextOccurrences` counts from today, so a weekday at or after today's own
 * lands in this week and one before it lands in the next. Pick both from the
 * same side of that line and the four weeks the old schedule generated are
 * exactly the four the generator will next consider for the new day — which is
 * the premise the week-held resume case below rests on ("every week the
 * generator can see is held"). A fixed offset from a fixed day holds that
 * identity on some days of the week and not others, and on those the answer
 * lands inside the generator's own window and the case quietly stops testing
 * what it is named for.
 *
 * Neither day is ever today, so the generator's past-start filter never has an
 * occurrence to drop and cannot shift one window relative to the other.
 *
 * Returned in schema convention (0=Monday … 6=Sunday), like every other
 * `dayOfWeek` in this file. The class family's twin
 * (`class-templates-api.test.ts`) is the same function for the same reason;
 * it is copied rather than shared, per this repo's per-file test-helper
 * convention.
 */
function sameWeekDayPair(): [number, number] {
  const todaySchemaDay = (new Date().getUTCDay() + 6) % 7;
  // Both at or after today (and neither today) while there is room for two;
  // otherwise both before it, where they share next week instead.
  return todaySchemaDay <= 4 ? [todaySchemaDay + 1, todaySchemaDay + 2] : [0, 1];
}

beforeAll(async () => {
  await prisma.$connect();

  const owner = await makeTeacher('owner');
  ownerId = owner.id;
  ownerAccountId = owner.accountId;
  ownerToken = owner.token;

  const other = await makeTeacher('other');
  otherId = other.id;
  otherAccountId = other.accountId;
  otherToken = other.token;

  templateId = (await makeTemplate(ownerId, 'Owner Template', 3, '18:00')).id;

  studioClassId = (
    await createStudioClassFixture(prisma, {
        teacherId: ownerId,
        classType: 'Owner Studio Class',
        date: new Date('2099-06-03'),
        startTime: hhmmToTime('18:00'),
        durationMinutes: 60,
        location: 'Community Studio',
        hourlyRate: 45,
      })
  ).id;
});

afterAll(async () => {
  const teacherIds = [ownerId, otherId];
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
  // `StudioClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue
  // 298), so deleting the rules removes the templates with them.
  await prisma.scheduleRule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.session.deleteMany({
    where: { accountId: { in: [ownerAccountId, otherAccountId] } },
  });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: [ownerAccountId, otherAccountId] } } });
  await prisma.$disconnect();
});

// Template-generated studio classes occupy per-teacher slots under #196's
// occupancy rule, so the window one resume test generates would block a
// sibling resume. The beforeAll `studioClassId` row has `templateId: null`
// and is exempt. Clearing template-scoped rows before every test keeps this
// file order-independent and re-runnable against a dev DB that accumulates
// rows between runs.
beforeEach(async () => {
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: [ownerId, otherId] }, scheduleRuleId: { not: null } } });
});

describe('POST /api/studio-class-templates', () => {
  // Ride-along, not a ladder — the shared guard is covered in
  // src/lib/api-utils.test.ts.
  it('rejects an unauthenticated create', async () => {
    const res = await fetch(`${BASE_URL}/api/studio-class-templates`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('creates the template against the calling teacher, not a teacherId in the body', async () => {
    const res = await send('POST', ownerToken, '/api/studio-class-templates', {
      classType: 'Created Via API',
      dayOfWeek: 1,
      startTime: '09:00',
      durationMinutes: 90,
      location: 'Other Studio',
      hourlyRate: 60,
      // Ignored: the route takes the teacher from the session. `.strict()` is
      // absent on the create schema, so this is dropped rather than rejected —
      // either way it must not land.
      teacherId: otherId,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string; teacherId: string } };
    expect(data.teacherId).toBe(ownerId);
  });

  /**
   * #120. The class family's POST has generated inside its own transaction
   * since #56; the studio POST was a plain `create`, so a new template sat
   * `isActive: true` with an empty window until the next hourly sweep — up to
   * 60 minutes during which the only control the teacher can see ("Resume
   * studio class") answers `200 unchanged` and generates nothing.
   */
  it('fills the window, so a new template is not empty until the next sweep', async () => {
    const res = await send('POST', ownerToken, '/api/studio-class-templates', {
      classType: 'Generates On Create',
      dayOfWeek: 2,
      startTime: '11:00',
      durationMinutes: 60,
      location: 'Generating Studio',
      hourlyRate: 55,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: data.id } } } } } })).toBe(4);
  });

  /**
   * Atomicity, ported from the class family's proven pattern in
   * `class-templates-api.test.ts`: force a *deterministic* FK failure (P2003)
   * rather than the P2002 the generator hedges and swallows, and assert the
   * whole transaction rolled back. A template that persists while its window
   * does not is the state #56 removed for the class family.
   */
  it('rolls the template back when generation fails', async () => {
    const before = await prisma.studioClassTemplate.count({ where: { scheduleRule: { teacherId: ownerId } } });

    await expect(
      prisma.$transaction(async (tx) => {
        const created = await tx.studioClassTemplate.create({
          data: {
            scheduleRule: {
              create: {
                teacherId: ownerId,
                kind: 'studio',
                classType: 'Rolls Back',
                dayOfWeek: 4,
                startTime: hhmmToTime('12:00'),
                durationMinutes: 60,
              },
            },
            location: 'Doomed Studio',
            hourlyRate: 40,
          },
          include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
        });
        // A teacherId no Teacher row has: `studioClass.create` fails its FK
        // check with P2003, which nothing in the generator catches.
        await generateStudioInstancesForTemplate(tx, {
          ...created,
          scheduleRule: {
            ...created.scheduleRule,
            teacherId: '00000000-0000-0000-0000-000000000000',
          },
        });
      }),
    ).rejects.toThrow();

    expect(await prisma.studioClassTemplate.count({ where: { scheduleRule: { teacherId: ownerId } } })).toBe(before);
    expect(
      await prisma.studioClass.count({ where: { location: 'Doomed Studio' } }),
    ).toBe(0);
  });

  // #196. Same reasoning as the class family's sibling in
  // class-templates-api.test.ts: the create sits inside a $transaction that
  // also generates the four-week window, so a duplicate template would have
  // meant a second full four-week set of bookable studio classes, not just a
  // second row. Each case below picks a slot nothing else in this file holds
  // — `ScheduleRule_teacher_slot_excl` checks for a RANGE overlap anywhere in
  // `(teacherId, dayOfWeek)`, not just an identical string, which is why this
  // block no longer packs its two cases minute-apart on 'Owner Template''s own
  // weekday the way it did before that constraint replaced
  // `StudioClassTemplate_teacher_slot_unique`.
  describe('POST /api/studio-class-templates is retry-safe on the slot key (#196)', () => {
    const post = (body: unknown) => send('POST', ownerToken, '/api/studio-class-templates', body);

    it('answers a repeated identical create with 409 and leaves one template and one window', async () => {
      const body = {
        classType: 'Slot Studio Recurring', dayOfWeek: 0, startTime: '00:00',
        durationMinutes: 60, location: 'Some Studio', hourlyRate: 45,
      };

      const first = await post(body);
      expect(first.status).toBe(201);

      const second = await post(body);
      expect(second.status).toBe(409);
      expect((await second.json()).error.code).toBe('DUPLICATE_STUDIO_TEMPLATE_SLOT');

      const templates = await prisma.studioClassTemplate.findMany({
        where: { scheduleRule: { teacherId: ownerId, dayOfWeek: 0, startTime: hhmmToTime('00:00'), isArchived: false } },
      });
      expect(templates).toHaveLength(1);

      // The half the endpoint's severity actually lives in: a second
      // template would have generated a second full four-week set of
      // bookable studio classes.
      const generated = await prisma.studioClass.findMany({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: templates[0]!.id } } } } }, include: { calendarEntry: true } });
      expect(generated).toHaveLength(4);
    });

    it('leaves one template and one window when two identical creates are in flight at once', async () => {
      // TEN RACES, NOT ONE (issue 331). Ten 45-minute slots at 02:00 … 11:00
      // do not overlap each other, so each race is independent of its
      // predecessors' leftover rows — the hazard the sibling case in the
      // `POST /api/studio-classes` describe documents. dayOfWeek 6, not 0:
      // `makeTemplate`'s own comment says a caller past a day's budget states
      // one of its own, and this file's other `dayOfWeek: 0` fixtures already
      // spend every hour this loop needs — verify with `grep -n "dayOfWeek: 6"
      // tests/integration/studio-api.test.ts` before moving this loop again.
      for (let i = 0; i < 10; i++) {
        const body = {
          classType: `Slot Studio Concurrent ${i}`, dayOfWeek: 6,
          startTime: `${String(2 + i).padStart(2, '0')}:00`,
          durationMinutes: 45, location: 'Some Studio', hourlyRate: 45,
        };

        const [a, b] = await Promise.all([post(body), post(body)]);
        const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
        const outcomes = `${a.status}:${bodyA?.error?.code ?? '-'} ${b.status}:${bodyB?.error?.code ?? '-'}`;

        expect([a.status, b.status].sort(), `race ${i}: ${outcomes}`).toEqual([201, 409]);

        const loserBody = a.status === 409 ? bodyA : bodyB;
        expect(loserBody.error.code).toBe('DUPLICATE_STUDIO_TEMPLATE_SLOT');
      }

      // Checking every one of the ten races' shape would just repeat the
      // sequential sibling above ten times over — that case already pins "one
      // template, one four-week window" for a single race. This checks the
      // LAST race (i === 9, '11:00') only, enough to confirm the loop's
      // winner-per-slot outcome actually lands rather than merely answering
      // the right HTTP codes.
      const templates = await prisma.studioClassTemplate.findMany({
        where: { scheduleRule: { teacherId: ownerId, dayOfWeek: 6, startTime: hhmmToTime('11:00'), isArchived: false } },
      });
      expect(templates).toHaveLength(1);

      const generated = await prisma.studioClass.findMany({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: templates[0]!.id } } } } }, include: { calendarEntry: true } });
      expect(generated).toHaveLength(4);
    });
  });

  // The behaviour change this branch exists to prove: `19:00 +90` against
  // `19:30 +60` is legal today (only an EXACT-start match was refused before
  // issue 298) and refused after. A dedicated fresh teacher (mirroring the
  // class family's `seedTeacher` fixtures for the same reason), plus a
  // Room/TeacherRoom so a `ClassTemplate` can be planted directly — studio
  // templates need neither.
  describe('refuses an OVERLAP with the class family, not just an exact match (issue 298)', () => {
    async function seedClassOwner(tag: string) {
      const teacher = await makeTeacher(tag);
      const room = await prisma.room.create({
        data: {
          venueName: `${tag} Venue`, address: `${suffix} ${tag} St`, city: 'Amsterdam',
          postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
          isPublic: false, createdById: teacher.id,
        },
      });
      const teacherRoom = await prisma.teacherRoom.create({
        data: { teacherId: teacher.id, roomId: room.id, rentalRate: 20, capacityOverride: 12 },
      });
      return { ...teacher, roomId: room.id, teacherRoomId: teacherRoom.id };
    }

    async function cleanupClassOwner(owner: { id: string; accountId: string; roomId: string }) {
      await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.id } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.id } });
      await prisma.room.delete({ where: { id: owner.roomId } });
      await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
      await prisma.teacher.delete({ where: { id: owner.id } });
      await prisma.account.delete({ where: { id: owner.accountId } });
    }

    it('answers 409 naming the class family when a new template OVERLAPS a class template', async () => {
      const owner = await seedClassOwner('overlap-class');
      try {
        await prisma.classTemplate.create({
          data: {
            scheduleRule: {
              create: {
                teacherId: owner.id, kind: 'regular', classType: 'Overlap Class',
                dayOfWeek: 2, startTime: hhmmToTime('19:00'), durationMinutes: 90,
              },
            },
            teacherRoom: { connect: { id: owner.teacherRoomId } },
            roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
          },
        });

        const res = await send('POST', owner.token, '/api/studio-class-templates', {
          classType: 'Overlap Studio', dayOfWeek: 2, startTime: '19:30',
          durationMinutes: 60, location: 'Overlap Venue', hourlyRate: 40,
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { message: string; code?: string } };
        expect(body.error.code).toBe('CROSS_FAMILY_CLASS_TEMPLATE_SLOT');
        // "at that time" described the exact-start index this constraint
        // replaced; 19:00 and 19:30 are not the same time.
        expect(body.error.message).toMatch(/overlapping/i);
      } finally {
        await cleanupClassOwner(owner);
      }
    });

    it('still answers 409 on an exact-start collision — unchanged behaviour', async () => {
      const owner = await seedClassOwner('exact-class');
      try {
        await prisma.classTemplate.create({
          data: {
            scheduleRule: {
              create: {
                teacherId: owner.id, kind: 'regular', classType: 'Exact Class',
                dayOfWeek: 2, startTime: hhmmToTime('08:00'), durationMinutes: 60,
              },
            },
            teacherRoom: { connect: { id: owner.teacherRoomId } },
            roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
          },
        });

        const res = await send('POST', owner.token, '/api/studio-class-templates', {
          classType: 'Exact Studio', dayOfWeek: 2, startTime: '08:00',
          durationMinutes: 60, location: 'Exact Venue', hourlyRate: 40,
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code?: string } };
        expect(body.error.code).toBe('CROSS_FAMILY_CLASS_TEMPLATE_SLOT');
      } finally {
        await cleanupClassOwner(owner);
      }
    });

    it('PUT: refuses a startTime change that OVERLAPS a class template, not just an exact match', async () => {
      const owner = await seedClassOwner('put-overlap-class');
      try {
        await prisma.classTemplate.create({
          data: {
            scheduleRule: {
              create: {
                teacherId: owner.id, kind: 'regular', classType: 'PUT Overlap Class',
                dayOfWeek: 4, startTime: hhmmToTime('10:00'), durationMinutes: 90,
              },
            },
            teacherRoom: { connect: { id: owner.teacherRoomId } },
            roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
          },
        });
        const create = await send('POST', owner.token, '/api/studio-class-templates', {
          classType: 'PUT Overlap Studio', dayOfWeek: 4, startTime: '13:00',
          durationMinutes: 60, location: 'PUT Overlap Venue', hourlyRate: 40,
        });
        expect(create.status).toBe(201);
        const { data: template } = (await create.json()) as { data: { id: string } };

        // The class template occupies [10:00, 11:30); this lands the mover's
        // start inside that range without matching it exactly.
        const res = await send('PUT', owner.token, `/api/studio-class-templates/${template.id}`, {
          startTime: '10:30',
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { message: string; code?: string } };
        expect(body.error.code).toBe('CROSS_FAMILY_CLASS_TEMPLATE_SLOT');
        expect(body.error.message).toMatch(/overlapping/i);

        const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
        expect(timeToHHmm(after.scheduleRule.startTime)).toBe('13:00');
      } finally {
        await cleanupClassOwner(owner);
      }
    });
  });
});

describe('/api/studio-class-templates/[id] — ownership', () => {
  // One case, three verbs: a single bespoke guard repeated. Every studio row is
  // scoped to one teacher, so this chain is the whole authorization model here.
  it("another teacher cannot read, edit or toggle the owner's template", async () => {
    for (const [method, body, query] of [
      ['GET', undefined, ''],
      ['PUT', { hourlyRate: 1 }, ''],
      // A valid `state` is required so this reaches the service's ownership
      // check rather than tripping the query-schema's own 400 first — the
      // route validates `state` before it ever looks the template up.
      ['PATCH', undefined, '?state=paused'],
    ] as const) {
      const res = await send(
        method,
        otherToken,
        `/api/studio-class-templates/${templateId}${query}`,
        body,
      );
      expect(res.status, `${method} should be 403`).toBe(403);
    }

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId }, include: { scheduleRule: true } });
    expect(Number(after.hourlyRate)).toBe(45);
    expect(after.scheduleRule.isActive).toBe(true);
  });

  it('404s an id that does not exist', async () => {
    const res = await send(
      'GET',
      ownerToken,
      '/api/studio-class-templates/00000000-0000-0000-0000-000000000000',
    );
    expect(res.status).toBe(404);
  });

  it('rejects an empty PUT rather than issuing a no-op write', async () => {
    const res = await send('PUT', ownerToken, `/api/studio-class-templates/${templateId}`, {});
    expect(res.status).toBe(400);
  });
});

// Task 6b (#196). `ScheduleRule_teacher_slot_excl` — a single exclusion
// constraint spanning both class families now, in place of the partial unique
// index this comment used to name — refuses a plain edit that moves a live
// template onto a slot another of the teacher's live rules already holds, the
// same clash `POST` guards against on create.
describe('PUT /api/studio-class-templates/[id] collides on the slot key (#196)', () => {
  it('refuses a dayOfWeek/startTime change onto a slot another live template already holds', async () => {
    await makeTemplate(ownerId, 'PUT Slot Occupant', 0, '04:00');
    const mover = await makeTemplate(ownerId, 'PUT Slot Mover', 0, '06:00');

    const res = await send('PUT', ownerToken, `/api/studio-class-templates/${mover.id}`, {
      startTime: '04:00',
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('DUPLICATE_STUDIO_TEMPLATE_SLOT');

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: mover.id }, include: { scheduleRule: true } });
    expect(timeToHHmm(after.scheduleRule.startTime)).toBe('06:00');
  });
});

describe('PUT /api/studio-class-templates/[id] — the teacher-editable boundary', () => {
  it('writes the edited fields and answers 200', async () => {
    const t = await makeTemplate(ownerId, 'Boundary Edit', 0, '08:00');

    const res = await send('PUT', ownerToken, `/api/studio-class-templates/${t.id}`, {
      classType: 'Boundary Edited',
      hourlyRate: 71,
    });
    expect(res.status).toBe(200);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.classType).toBe('Boundary Edited');
    expect(Number(after.hourlyRate)).toBe(71);
    expect(after.location).toBe('Community Studio');
  });

  // This is the runtime behaviour every compile-time pin's reasoning rests on:
  // an undeclared key is a 400, so the ONLY way a forbidden column reaches
  // Prisma is by being declared in the schema — a source edit, which the pins
  // in studio-class-template-lifecycle.ts catch. If this test ever fails, the
  // pins are guarding the wrong thing. Ported from the class family's twin in
  // class-templates-api.test.ts, which the studio family never had (#114).
  it('rejects an undeclared key — the schema is strict', async () => {
    const t = await makeTemplate(ownerId, 'Strict Studio Flow', 0, '10:00');

    const res = await send('PUT', ownerToken, `/api/studio-class-templates/${t.id}`, {
      classType: 'Renamed',
      isActive: false,
    });
    expect(res.status).toBe(400);

    // Rejected whole: the declared field is not written either.
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.classType).toBe('Strict Studio Flow');
    expect(after.scheduleRule.isActive).toBe(true);
  });

  /**
   * The `not_found` → 404 mapping had no HTTP coverage: changing this arm to
   * 403 left all 36 studio integration tests green. The `never` guard at the
   * end of the handler cannot catch that — it fires on an UNHANDLED reason,
   * never a mishandled one — and the 404 case above this describe uses `GET`
   * only, while `PUT`'s 403 is already covered by the verb loop.
   */
  it('404s a PUT against an id that does not exist', async () => {
    const res = await send(
      'PUT',
      ownerToken,
      '/api/studio-class-templates/00000000-0000-0000-0000-000000000000',
      { classType: 'Ghost Edit' },
    );
    expect(res.status).toBe(404);
  });

  /**
   * The ordering this branch introduced, ported from the class family's
   * `class-templates-api.test.ts` twin. Body parsing now runs before the
   * exists/ownership checks, because the service owns those and needs typed
   * data to be called at all — so a malformed body against someone else's
   * template is a 400, not the 403 the pre-service handler returned.
   *
   * Deliberate, and not an information leak, which is the half this test
   * exists to hold: `{}` parses fine and still yields 403 (asserted below), so
   * a prober learns strictly less than before rather than more. Without this
   * case the route's comment cited the ownership test, which sends a valid
   * `{ hourlyRate: 1 }` and pins neither half.
   */
  it('rejects a malformed body before revealing that the template is not yours', async () => {
    const t = await makeTemplate(ownerId, 'Order Guard Studio', 0, '12:00');

    const malformed = await send('PUT', otherToken, `/api/studio-class-templates/${t.id}`, {
      hourlyRate: 'not a number',
    });
    expect(malformed.status).toBe(400);

    // The cheap probe still discriminates exactly as it did before, which is
    // what makes the 400 above a loss of information to the prober, not a gain.
    const empty = await send('PUT', otherToken, `/api/studio-class-templates/${t.id}`, {});
    expect(empty.status).toBe(403);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(Number(after.hourlyRate)).toBe(45);
  });

  it(
    'answers 503 STUDIO_TEMPLATE_BUSY when an edit loses the row, and changes nothing',
    async () => {
      const t = await makeTemplate(ownerId, 'Busy Studio Edit', 0, '14:00');

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const settled = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "StudioClassTemplate" WHERE id = ${t.id} FOR UPDATE`;
          await held;
        },
        { timeout: 15_000 },
      );
      await new Promise((r) => setTimeout(r, 100));

      try {
        const res = await send('PUT', ownerToken, `/api/studio-class-templates/${t.id}`, {
          classType: 'Blocked Edit',
        });

        expect(res.status).toBe(503);
        const json = (await res.json()) as { error: { code: string; message: string } };
        expect(json.error.code).toBe('STUDIO_TEMPLATE_BUSY');
        expect(json.error.message).toContain('could not edit this recurring studio class');
        expect(json.error.message).toContain('Nothing was changed.');

        const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
        expect(after.scheduleRule.classType).toBe('Busy Studio Edit');
      } finally {
        release();
        await settled.catch(() => {});
      }
    },
    20_000,
  );
});

/**
 * #284, the wire half. `updateStudioClassTemplate` computes `firstEffective`
 * and `generationState` on its success arm and
 * `studio-class-template-lifecycle.test.ts` owns what those two values MEAN —
 * which week, and why a paused or archived template gets none. What no service
 * test can see is whether the route carries them at all: the PUT reads
 * `result.template` and a handler that kept doing only that would compile
 * clean, answer 200, and drop both. That is the shape #93's wrong-shape bug
 * had, and the `never` guard at the end of the handler cannot catch it — it
 * closes the FAILURE half.
 *
 * Every case here takes its weekdays from `sameWeekDayPair()` rather than a
 * fixed pair, so each also needs a SPAN — a start AND a duration — that no
 * other live rule of this teacher overlaps on ANY weekday. A span, not "a free
 * hour", because a span is what the constraint compares:
 * `ScheduleRule_teacher_slot_excl` (issue 298) excludes on `teacherId` `=`,
 * `dayOfWeek` `=` and the generated `slot` column `&&`, where `slot` is an
 * `int4range` of minutes-since-midnight from `startTime` to
 * `startTime + durationMinutes`. So a neighbour at 14:30 for 90 minutes
 * spends no whole hour on the clock and still refuses a 15:00 create, and the
 * durations in this file are not uniformly 60 minutes. Live is
 * `isArchived = false` and nothing else — a PAUSED rule still holds its span.
 * These rules also outlive their test (only the generated entries are cleared
 * between tests), and a variable weekday cannot dodge a collision by sitting
 * on a different day, so the weekday buys nothing here.
 *
 * The one relief the constraint offers is that the range is half-open: a span
 * starting exactly where a neighbour ends is legal, which is what makes a
 * start on the hour a workable convention. It is not a guarantee that any
 * particular hour is free — check a new fixture's whole span against this
 * teacher's other rules before adding it.
 */
describe('PUT /api/studio-class-templates/[id] names the week the edit reaches (#284)', () => {
  it('answers a dayOfWeek move with the Monday of a week and the state that earned it', async () => {
    const [OLD_DAY, NEW_DAY] = sameWeekDayPair();

    const create = await send('POST', ownerToken, '/api/studio-class-templates', {
      classType: 'Effective Week Studio',
      dayOfWeek: OLD_DAY,
      startTime: '15:00',
      durationMinutes: 60,
      location: 'Community Studio',
      hourlyRate: 45,
    });
    expect(create.status).toBe(201);
    const { data: created } = (await create.json()) as { data: { id: string } };

    const res = await send('PUT', ownerToken, `/api/studio-class-templates/${created.id}`, {
      dayOfWeek: NEW_DAY,
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { dayOfWeek: number; firstEffective: string | null; generationState: string };
    };
    // Alongside the template row, not instead of it: the edited column is
    // still on the body, which is what the form's other readers depend on.
    expect(data.dayOfWeek).toBe(NEW_DAY);
    // `typeof`, not `not.toBeNull()`: an absent field is `undefined`, which is
    // not null, so the weaker assertion passes on exactly the route this case
    // exists to catch and leaves the whole verdict to the line below.
    expect(typeof data.firstEffective).toBe('string');
    // A MONDAY, in UTC — the copy renders it as "the week starting <this>", so
    // a candidate occurrence arriving here would put the wrong day in front of
    // a teacher. `respondOk`'s JSON encoding is what turns the service's
    // `Date` into this string, and the form turns it back.
    expect(new Date(data.firstEffective as string).getUTCDay()).toBe(1);
    expect(data.generationState).toBe('active');
  });

  /**
   * The gate is on the PREDICTION, not on the write: this PUT is deliberately
   * open to a paused template, and `/settings/studio-classes/[id]` renders the
   * edit form for one exactly as for a live one. So this is what a teacher who
   * paused for the summer and then moved their studio class sends.
   *
   * `generationState` is the half that cannot be inferred here. Pausing
   * deletes nothing, so the four generated weeks are still held and an ungated
   * probe would read them and name week five — a specific, plausible, checkable
   * date for a week the sweep never reaches.
   */
  it('names no week for a paused template, and says which state it is in', async () => {
    const [OLD_DAY, NEW_DAY] = sameWeekDayPair();

    const create = await send('POST', ownerToken, '/api/studio-class-templates', {
      classType: 'Paused Edit Studio',
      dayOfWeek: OLD_DAY,
      startTime: '17:00',
      durationMinutes: 60,
      location: 'Community Studio',
      hourlyRate: 45,
    });
    expect(create.status).toBe(201);
    const { data: created } = (await create.json()) as { data: { id: string } };

    const pause = await send('PATCH', ownerToken, `/api/studio-class-templates/${created.id}?state=paused`);
    expect(pause.status).toBe(200);
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: created.id } } } } } })).toBe(4);

    const res = await send('PUT', ownerToken, `/api/studio-class-templates/${created.id}`, {
      dayOfWeek: NEW_DAY,
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { dayOfWeek: number; firstEffective: string | null; generationState: string };
    };
    expect(data.dayOfWeek).toBe(NEW_DAY);
    expect(data.firstEffective).toBeNull();
    expect(data.generationState).toBe('paused');
  });

  /**
   * The studio twin of `class-templates-api.test.ts`'s "names the week the
   * generator then fills, and no earlier one", and the case that pins the
   * PREDICTION ITSELF on this side (#284).
   *
   * The two cases above cannot. Both assert a `firstEffective` that is merely
   * a string and merely a Monday, and against a template whose weeks are held
   * that pair of assertions is satisfied by any Monday at all — including the
   * one a probe that never read the held weeks would return. So the exact
   * date is asserted here, twice over and from both sides of the seam: once
   * arithmetically (the Monday AFTER the last week the four standing classes
   * hold) and once behaviourally, by handing the predicted date straight back
   * to `generateStudioInstancesForTemplate` and checking that the sweep lands
   * in that week and in no earlier one.
   *
   * Across the seam for the same reason the class twin is: the PUT for the
   * sentence, the generator for the behaviour. A unit test of either half can
   * only prove that half agrees with itself, and the claim the probe exists to
   * make is that the two agree with EACH OTHER — a probe sharing the
   * generator's own four-week horizon answers "no free week" here, and one
   * blind to the held weeks answers a week the sweep has already filled.
   */
  it('names the week the generator then fills, and no earlier one', async () => {
    const [OLD_DAY, NEW_DAY] = sameWeekDayPair();

    const create = await send('POST', ownerToken, '/api/studio-class-templates', {
      classType: 'Effective Week Fills Studio',
      dayOfWeek: OLD_DAY,
      startTime: '21:00',
      durationMinutes: 60,
      location: 'Community Studio',
      hourlyRate: 45,
    });
    expect(create.status).toBe(201);
    const { data: created } = (await create.json()) as { data: { id: string } };
    const id = created.id;
    const ownWhere = { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id } } } } };

    const before = await prisma.studioClass.findMany({
      where: ownWhere,
      orderBy: { calendarEntry: { date: 'asc' } },
      include: { calendarEntry: true },
    });
    expect(before.length).toBe(4);

    const res = await send('PUT', ownerToken, `/api/studio-class-templates/${id}`, {
      dayOfWeek: NEW_DAY,
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as { data: { firstEffective: string | null } };
    // A week, not nothing: every week the generator can see is held, so the
    // honest answer is one the generator cannot see — which is the case a
    // probe sharing the generator's own four-week horizon gets wrong by
    // answering "no free week".
    expect(typeof data.firstEffective).toBe('string');
    const predicted = new Date(data.firstEffective as string);
    expect(predicted.getUTCDay()).toBe(1);
    // The EXACT week, derived from the rows rather than restated: the four
    // standing classes are consecutive weekly occurrences, so the last one's
    // Monday plus seven days is the first week nothing of this template's
    // holds. A probe that read no held weeks names the FIRST horizon week
    // instead and fails here — the assertion neither case above can make,
    // because both are satisfied by any Monday.
    expect(predicted.getTime()).toBe(mondayOf(before[3]!.calendarEntry.date) + 7 * 24 * 60 * 60 * 1000);

    const template = await prisma.studioClassTemplate.findUniqueOrThrow({
      where: { id },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    });

    // The sweep as it runs today. Its four-occurrence window is entirely held
    // by the superseded schedule, so it creates nothing — and the reason it
    // gives for each date is the week key this branch brought to this family.
    const today = await generateStudioInstancesForTemplate(prisma, template);
    expect(today.created).toBe(0);
    expect(today.skipped.map((s) => s.reason)).toEqual([
      'already_this_week',
      'already_this_week',
      'already_this_week',
      'already_this_week',
    ]);

    // The same sweep once time has reached the week the teacher was told
    // about. `from` is the only way a four-occurrence window can see week
    // five, and it is what the hourly cron reaches by simply running later.
    const later = await generateStudioInstancesForTemplate(prisma, template, predicted);
    expect(later.created).toBeGreaterThan(0);

    const after = await prisma.studioClass.findMany({
      where: { ...ownWhere, id: { notIn: before.map((c) => c.id) } },
      orderBy: { calendarEntry: { date: 'asc' } },
      include: { calendarEntry: true },
    });
    expect(after.length).toBe(later.created);
    const first = after[0]!;
    // The week the sentence named, and the weekday the teacher moved to.
    expect(mondayOf(first.calendarEntry.date)).toBe(predicted.getTime());
    expect(first.calendarEntry.date.getUTCDay()).toBe((NEW_DAY + 1) % 7);

    // And nothing landed earlier than the sentence promised — the assertion a
    // probe that merely happened to agree on the first date would still pass,
    // but one that named a week the old schedule still holds would not.
    for (const c of after) {
      expect(mondayOf(c.calendarEntry.date)).toBeGreaterThanOrEqual(predicted.getTime());
    }
  });
});

describe('PATCH /api/studio-class-templates/[id]', () => {
  it('reaches paused then active as named, and archiving forces inactive', async () => {
    const id = (await makeTemplate(ownerId, 'Toggle Target', 0, '16:00')).id;

    const paused = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=paused`);
    expect(paused.status).toBe(200);
    expect(
      (await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } })).scheduleRule.isActive,
    ).toBe(false);

    const active = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=active`);
    expect(active.status).toBe(200);
    expect(
      (await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } })).scheduleRule.isActive,
    ).toBe(true);

    // Archiving is a distinct action and shelves the template outright.
    const archived = await send(
      'PATCH',
      ownerToken,
      `/api/studio-class-templates/${id}?state=archived`,
    );
    expect(archived.status).toBe(200);
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(true);
    expect(after.scheduleRule.isActive).toBe(false);
  });

  // The bug this coverage pass found. Without the guard, a teacher could
  // toggle a shelved template back to active — and `generateStudioClassInstances`
  // filtered on `isActive` alone, so the cron sweep would materialise classes
  // for something the teacher had deliberately put away. The class family
  // guards this in both places; the studio family guarded it in neither.
  it('refuses to activate an archived template — no classes for shelved things', async () => {
    const id = (
      await makeTemplate(ownerId, 'Shelved', 3, '18:00', { isArchived: true, isActive: false })
    ).id;

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=active`);
    expect(res.status).toBe(409);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(false);
    expect(after.scheduleRule.isArchived).toBe(true);
  });

  it('un-archiving is still possible, and leaves the template paused rather than live', async () => {
    // Distinct startTime: this row un-archives before the test ends, joining
    // the isArchived=false slot-uniqueness set alongside 'Owner Template'.
    const id = (
      await makeTemplate(ownerId, 'Unarchive Me', 4, '00:00', {
        isArchived: true,
        isActive: false,
      })
    ).id;

    const res = await send(
      'PATCH',
      ownerToken,
      `/api/studio-class-templates/${id}?state=unarchived`,
    );
    expect(res.status).toBe(200);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(false);
    // Explicit activation is the separate, deliberate step.
    expect(after.scheduleRule.isActive).toBe(false);
  });

  // Task 6b (#196). `ScheduleRule_teacher_slot_excl` refuses a live overlap
  // WHERE isArchived = false — un-archiving is the one transition that
  // re-enters that scope, so a shelved template can now collide with a live
  // one holding the same slot.
  it('refuses to un-archive into a slot another live template already holds', async () => {
    const live = (await makeTemplate(ownerId, 'Unarchive Slot Live', 4, '02:00')).id;
    const shelved = (
      await makeTemplate(ownerId, 'Unarchive Slot Shelved', 4, '02:00', {
        isArchived: true,
        isActive: false,
      })
    ).id;

    const res = await send(
      'PATCH',
      ownerToken,
      `/api/studio-class-templates/${shelved}?state=unarchived`,
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('DUPLICATE_STUDIO_TEMPLATE_SLOT');

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: shelved }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(true);

    // The test's premise is that `live` is the template occupying the slot
    // the un-archive collided on, and that it is untouched by the failed
    // transition — assert that rather than discarding the reference, so a
    // route that clobbered the wrong row would fail this test.
    const stillLive = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: live }, include: { scheduleRule: true } });
    expect(stillLive.scheduleRule.isArchived).toBe(false);
  });

  // #86, mirroring class-templates-api.test.ts's equivalent case: archiving
  // must withdraw the future window, not just flip the flag.
  it('archiving deletes the unbooked future window and reports the counts', async () => {
    const template = await makeTemplate(ownerId, 'Archive Window', 4, '04:00');
    const makeInstance = (date: string) =>
      createStudioClassFixture(prisma, {
          teacherId: ownerId,
          scheduleRuleId: template.scheduleRuleId,
          classType: 'Archive Window',
          date: new Date(date),
          startTime: hhmmToTime('18:00'),
          durationMinutes: 60,
          location: 'Community Studio',
          hourlyRate: 45,
        });
    await makeInstance('2099-08-05');
    await makeInstance('2099-08-12');

    const res = await send(
      'PATCH',
      ownerToken,
      `/api/studio-class-templates/${template.id}?state=archived`,
    );
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as { data: { deleted: number; remaining: number } };
    expect(data.deleted).toBe(2);
    expect(data.remaining).toBe(0);
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: template.id } } } } } })).toBe(0);
  });

  it('pausing removes nothing and reports the last scheduled class', async () => {
    const template = await makeTemplate(ownerId, 'Pause Window', 4, '06:00');
    const later = await createStudioClassFixture(prisma, {
        teacherId: ownerId,
        scheduleRuleId: template.scheduleRuleId,
        classType: 'Pause Window',
        date: new Date('2099-09-01'),
        startTime: hhmmToTime('19:00'),
        durationMinutes: 60,
        location: 'Community Studio',
        hourlyRate: 45,
      });

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${template.id}?state=paused`);
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { lastScheduled: { startTime: string } | null };
    };
    // `toBeNull()` alone also passes on `undefined` — assert the seeded value.
    expect(data.lastScheduled?.startTime).toBe('19:00');
    expect(await prisma.studioClass.count({ where: { id: later.id } })).toBe(1);
  });

  it('rejects a PATCH with no state parameter', async () => {
    const id = (await makeTemplate(ownerId, 'No State', 4, '08:00')).id;

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}`);
    expect(res.status).toBe(400);

    // The row is untouched — a rejected request must not have toggled anything.
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(true);
  });

  it('rejects an unrecognised state value', async () => {
    const id = (await makeTemplate(ownerId, 'Bad State', 4, '10:00')).id;

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=sideways`);
    expect(res.status).toBe(400);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(true);
  });

  /**
   * The #98 case, mirroring class-templates-api.test.ts's equivalent: two
   * identical requests must reach the same state, not opposite ones.
   */
  it('is idempotent: pausing twice leaves the template paused', async () => {
    const id = (await makeTemplate(ownerId, 'Twice Paused', 4, '14:00')).id;

    const pause = () =>
      send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=paused`);

    const first = await pause();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: { action: string } }).data.action).toBe('paused');

    const second = await pause();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(false);
  });

  /**
   * The sharpest half of #98: archiving withdraws unbooked future classes, so
   * a second archive that fell through to un-archive would un-shelve the
   * template. It must be a no-op — and must NOT withdraw a second time.
   */
  it('is idempotent: archiving twice does not withdraw twice', async () => {
    const template = await makeTemplate(ownerId, 'Twice Archived', 4, '16:00');
    await createStudioClassFixture(prisma, {
        teacherId: ownerId,
        scheduleRuleId: template.scheduleRuleId,
        classType: 'Twice Archived',
        date: new Date('2099-10-01'),
        startTime: hhmmToTime('18:00'),
        durationMinutes: 60,
        location: 'Community Studio',
        hourlyRate: 45,
      });

    const archive = () =>
      send('PATCH', ownerToken, `/api/studio-class-templates/${template.id}?state=archived`);

    const first = await archive();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { action: string; deleted: number } };
    expect(firstBody.data.action).toBe('archived');

    const survivors = await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: template.id } } } } } });

    const second = await archive();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: template.id } } } } } })).toBe(survivors);
  });

  /**
   * #94 end to end: the bug was a teacher resuming and finding an empty
   * schedule, so the assertion is on what the schedule holds afterwards, not
   * on the response body alone.
   */
  it('resuming fills the window rather than waiting for the hourly sweep', async () => {
    const id = (await makeTemplate(ownerId, 'Resume Fills Window', 4, '18:00')).id;

    await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=paused`);
    // Start from a genuinely empty window, so the count below can only come
    // from the resume itself and not from generation at some earlier step.
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { studioClassTemplates: { some: { id: id } } } },
    });

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=active`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { action: string } }).data.action).toBe('active');
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: id } } } } } })).toBe(4);
  });
});

/**
 * The studio family's `busy` arms at the wire — see the class family's
 * equivalent block for why the compile-time `never` guard does not cover this.
 *
 * The un-archive direction deliberately, where the class family covers the
 * archive one: the route interpolates
 * `state === 'archived' ? 'archive' : 'unarchive'` into the message, both
 * limbs read as ordinary English, and nothing else in either suite would
 * notice the ternary inverted.
 */
describe('PATCH /api/studio-class-templates/[id] — lock contention', () => {
  const holdTemplateRow = (id: string) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "StudioClassTemplate" WHERE id = ${id} FOR UPDATE`;
        await held;
      },
      { timeout: 15_000 },
    );
    return { release, settled };
  };

  it(
    'answers 503 STUDIO_TEMPLATE_BUSY when an un-archive loses the row, and changes nothing',
    async () => {
      const id = (
        await makeTemplate(ownerId, 'Busy Unarchive', 3, '18:31', {
          isArchived: true,
          isActive: false,
        })
      ).id;

      const { release, settled } = holdTemplateRow(id);
      await new Promise((r) => setTimeout(r, 100));

      try {
        const res = await send(
          'PATCH',
          ownerToken,
          `/api/studio-class-templates/${id}?state=unarchived`,
        );

        expect(res.status).toBe(503);
        const json = (await res.json()) as { error: { code: string; message: string } };
        expect(json.error.code).toBe('STUDIO_TEMPLATE_BUSY');
        expect(json.error.message).toContain('could not unarchive this recurring studio class');
        expect(json.error.message).toContain('Nothing was changed.');

        const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
        expect(after.scheduleRule.isArchived).toBe(true);
      } finally {
        release();
        await settled.catch(() => {});
      }
    },
    20_000,
  );

  it(
    'answers 503 STUDIO_TEMPLATE_BUSY when a pause loses the row',
    async () => {
      const id = (await makeTemplate(ownerId, 'Busy Studio Pause', 5, '00:00')).id;

      const { release, settled } = holdTemplateRow(id);
      await new Promise((r) => setTimeout(r, 100));

      try {
        const res = await send(
          'PATCH',
          ownerToken,
          `/api/studio-class-templates/${id}?state=paused`,
        );

        expect(res.status).toBe(503);
        const json = (await res.json()) as { error: { code: string; message: string } };
        expect(json.error.code).toBe('STUDIO_TEMPLATE_BUSY');
        expect(json.error.message).toContain('could not update this recurring studio class');
        // The rollback promise, asserted on the pause arms too — see the class
        // family's twin.
        expect(json.error.message).toContain('Nothing was changed.');

        const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
        expect(after.scheduleRule.isActive).toBe(true);
      } finally {
        release();
        await settled.catch(() => {});
      }
    },
    20_000,
  );
});

describe('PATCH /api/studio-class-templates/[id] — resume reporting', () => {
  /**
   * #119. The service produced this number and four layers dropped it, ending
   * at `setMessage('')`. This is the wire half of that chain.
   */
  it('carries what the window holds and what the resume added', async () => {
    const t = await makeTemplate(ownerId, 'Resume Reports', 5, '02:00');
    await prisma.scheduleRule.update({
      where: { id: t.scheduleRuleId },
      data: { isActive: false },
    });

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${t.id}?state=active`);
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { action: string; scheduled: number; added: number };
    };
    expect(data.action).toBe('active');
    expect(data.added).toBe(4);
    expect(data.scheduled).toBe(4);
  });

  /**
   * The studio twin of `class-templates-api.test.ts`'s week-held resume case,
   * and the branch's headline hop observed for the first time on this side
   * (#284).
   *
   * Until this case, every studio fixture that carries `alreadyThisWeek`
   * asserts it at ZERO — the value it structurally had before this branch, when
   * `studio-class-generator.ts` had no week predicate at all. A zero pins
   * nothing: the count travels generator → `countSkipReasons` →
   * `pauseOrResumeRule`'s `active` arm → the PATCH body → `resumeStudioMessage`,
   * and with every fixture at 0 alongside a `slotTaken` of 0, mis-wiring
   * `alreadyThisWeek: result.slotTaken` at either hop passes `tsc` and every
   * test. That is the shape recorded at `template-action-messages.ts`, where
   * transposing two arguments at a call site stayed green *because every
   * fixture passed equal numbers*.
   *
   * So this case drives an UNEQUAL, NON-ZERO value the whole way: four dates
   * declined for `already_this_week` and none for anything else. The counts are
   * asserted one at a time rather than as a shape, because it is their
   * differing from each other that carries the guarantee.
   *
   * 22:00 for the same reason every other fixture here picks its own hour:
   * `ScheduleRule_teacher_slot_excl` refuses a RANGE overlap in
   * `(teacherId, dayOfWeek)`, `sameWeekDayPair()` can land on any weekday, and
   * these rules outlive their test.
   *
   * The resume is what a teacher actually does after moving a paused studio
   * class, and the sentence it produces — "4 classes on your schedule. 4 dates
   * are still held by classes on your previous day." — is the whole reason the
   * count is carried: before the week key reached this family, the same request
   * laid four Thursdays down beside the four standing Tuesdays.
   */
  it('carries a non-zero alreadyThisWeek, distinct from slotTaken, to the PATCH body', async () => {
    const [OLD_DAY, NEW_DAY] = sameWeekDayPair();

    const create = await send('POST', ownerToken, '/api/studio-class-templates', {
      classType: 'Week Held Studio Resume',
      dayOfWeek: OLD_DAY,
      startTime: '22:00',
      durationMinutes: 60,
      location: 'Community Studio',
      hourlyRate: 45,
    });
    expect(create.status).toBe(201);
    const { data: created } = (await create.json()) as { data: { id: string } };
    const id = created.id;
    const ownWhere = { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id } } } } };
    expect(await prisma.studioClass.count({ where: ownWhere })).toBe(4);

    const pause = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=paused`);
    expect(pause.status).toBe(200);

    // The edit that makes the four standing classes wrong-day: it moves the
    // template and, since #194, moves nothing else.
    const put = await send('PUT', ownerToken, `/api/studio-class-templates/${id}`, {
      dayOfWeek: NEW_DAY,
    });
    expect(put.status).toBe(200);

    const resume = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=active`);
    expect(resume.status).toBe(200);
    const { data: resumed } = (await resume.json()) as {
      data: {
        scheduled: number;
        added: number;
        counts: {
          blockedByCancelled: number;
          slotTaken: number;
          alreadyThisWeek: number;
          blockedByOverlap: number;
        };
      };
    };

    // Non-zero, and different from every other count on the body. A hop wired
    // to `slotTaken`, `blockedByCancelled`, `blockedByOverlap` or `added`
    // reports 0 here.
    expect(resumed.counts.alreadyThisWeek).toBe(4);
    expect(resumed.counts.slotTaken).toBe(0);
    expect(resumed.counts.blockedByCancelled).toBe(0);
    expect(resumed.counts.blockedByOverlap).toBe(0);
    // Nothing was created: all four candidate weeks are held by the old day's
    // classes, which is the state that produces the count above.
    expect(resumed.added).toBe(0);
    expect(resumed.scheduled).toBe(4);
    // And the classes really are still on the old weekday — the count means
    // what its clause says it means, and #194's no-propagation rule holds for
    // this family too.
    const still = await prisma.studioClass.findMany({
      where: ownWhere,
      include: { calendarEntry: true },
    });
    expect(still.length).toBe(4);
    expect(still.every((c) => c.calendarEntry.date.getUTCDay() === (OLD_DAY + 1) % 7)).toBe(true);
  });
});

describe('/api/studio-classes', () => {
  it('creates against the calling teacher', async () => {
    const res = await send('POST', ownerToken, '/api/studio-classes', {
      classType: 'Cover Shift',
      date: '2099-07-01',
      startTime: '19:00',
      durationMinutes: 45,
      location: 'Guest Studio',
      hourlyRate: 55,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { teacherId: string } };
    expect(data.teacherId).toBe(ownerId);
  });

  // #327 stage B, Task 1: `startTime` becomes a `@db.Time` column. The wire
  // format is unchanged — this pins that boundary at the create route, and
  // reads the column directly to prove the type actually changed rather than
  // trusting the route's own round trip.
  it('accepts and returns startTime as "HH:MM" while the column is time', async () => {
    const res = await send('POST', ownerToken, '/api/studio-classes', {
      classType: 'Wire Format Studio',
      date: '2027-03-02',
      startTime: '19:30',
      durationMinutes: 60,
      location: 'Guest Studio',
      hourlyRate: 55,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; startTime: string } };
    expect(data.startTime).toBe('19:30');

    // The column, not the wire: a text column would come back as a string
    // here. On `CalendarEntry` since #327 — `StudioClass` has no `startTime`
    // of its own any more — reached through the child's `calendarEntryId`.
    const [row] = await prisma.$queryRaw<Array<{ t: Date }>>`
      SELECT e."startTime" AS t
        FROM "StudioClass" sc
        JOIN "CalendarEntry" e ON e.id = sc."calendarEntryId"
       WHERE sc.id = ${data.id}`;
    expect(row?.t).toBeInstanceOf(Date);
  });

  // The read direction of the same guarantee. The test above only pins the
  // create route's own round trip — GET /api/studio-classes/[id] carries its
  // own, separate `timeToHHmm(studioClass.startTime)` call, and nothing else
  // in this file reads a studio class back by id at all. Delete that call and
  // this fails with the stored column's own wire shape (an ISO timestamp)
  // while every other test in the suite stays green.
  it('returns startTime as "HH:MM" on GET /api/studio-classes/[id]', async () => {
    const created = await send('POST', ownerToken, '/api/studio-classes', {
      classType: 'Wire Format Read',
      date: '2027-03-04',
      startTime: '20:45',
      durationMinutes: 60,
      location: 'Guest Studio',
      hourlyRate: 55,
    });
    expect(created.status).toBe(201);
    const { data: createdData } = (await created.json()) as { data: { id: string } };

    const res = await send('GET', ownerToken, `/api/studio-classes/${createdData.id}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { startTime: string } };
    expect(data.startTime).toBe('20:45');
  });

  // #148. Both keys reached prisma.studioClass.create through a `{ date, ...rest }`
  // spread, so neither name appeared anywhere in the handler — a grep for the
  // key names found nothing, which is how this stayed hidden.
  it("ignores another teacher's templateId instead of attaching it", async () => {
    const victimTemplate = await makeTemplate(otherId, 'Victim Studio Template', 3, '18:00');

    const res = await send('POST', ownerToken, '/api/studio-classes', {
      classType: 'Squat Attempt',
      date: '2099-07-02',
      startTime: '19:00',
      durationMinutes: 45,
      location: 'Guest Studio',
      hourlyRate: 55,
      templateId: victimTemplate.id,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.studioClass.findUniqueOrThrow({ where: { id: data.id }, include: { calendarEntry: true } });
    expect(created.calendarEntry.scheduleRuleId).toBeNull();

    // Both assertions rest on an absence, and `CalendarEntry.scheduleRuleId`
    // is `onDelete: SetNull` — so a cascaded rule delete would produce the
    // same null and the same zero count. Not reachable today; this removes the
    // ambiguity anyway.
    expect(
      await prisma.studioClassTemplate.findUnique({ where: { id: victimTemplate.id } }),
    ).not.toBeNull();
    expect(
      await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: victimTemplate.id } } } } } }),
    ).toBe(0);
  });

  // Not a security gap — a teacher can set this on their own row via
  // PUT /api/studio-classes/[id]. It is dead surface at create time: the form
  // does not send it and student-count-editor.tsx sets it afterwards.
  it('ignores studentCount at create time', async () => {
    const res = await send('POST', ownerToken, '/api/studio-classes', {
      classType: 'Count At Create',
      date: '2099-07-03',
      startTime: '19:00',
      durationMinutes: 45,
      location: 'Guest Studio',
      hourlyRate: 55,
      studentCount: 12,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.studioClass.findUniqueOrThrow({ where: { id: data.id }, include: { calendarEntry: true } });
    expect(created.studentCount).toBeNull();
  });

  it("another teacher cannot read or edit the owner's studio class", async () => {
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { hourlyRate: 1 }],
    ] as const) {
      const res = await send(method, otherToken, `/api/studio-classes/${studioClassId}`, body);
      expect(res.status, `${method} should be 403`).toBe(403);
    }

    const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: studioClassId }, include: { calendarEntry: true } });
    expect(Number(after.hourlyRate)).toBe(45);
  });

  // `cancelledAt` is the one field the route transforms rather than passes
  // through — a string becomes a Date, and null clears it.
  it('sets and clears cancelledAt', async () => {
    const cancel = await send('PUT', ownerToken, `/api/studio-classes/${studioClassId}`, {
      cancelledAt: '2099-06-02T10:00:00.000Z',
    });
    expect(cancel.status).toBe(200);
    expect(
      (await prisma.studioClass.findUniqueOrThrow({ where: { id: studioClassId }, include: { calendarEntry: true } })).calendarEntry.cancelledAt,
    ).not.toBeNull();

    const restore = await send('PUT', ownerToken, `/api/studio-classes/${studioClassId}`, {
      cancelledAt: null,
    });
    expect(restore.status).toBe(200);
    expect(
      (await prisma.studioClass.findUniqueOrThrow({ where: { id: studioClassId }, include: { calendarEntry: true } })).calendarEntry.cancelledAt,
    ).toBeNull();
  });

  // #276's cheapest true claim, pinned before this branch changes anything:
  // `location`, `durationMinutes` and `hourlyRate` are all in
  // `updateStudioClassSchema` yet had no persistence test through this route
  // at all — validated, then offered to no one. One field per test so a
  // schema regression names its field, and the assertion is a Prisma
  // read-back, because a 200 alone proves nothing about persistence. These
  // must pass unchanged against main's behaviour — they record today's
  // contract, they do not add one.
  describe('PUT /api/studio-classes/[id] persists the fields it already accepts (#276)', () => {
    const PIN_DATE = new Date('2099-06-10');

    // Manual (templateId left null), future-dated fixtures built directly,
    // like the slot-conflict block below. Every value here — classType,
    // date, startTime, location, duration, rate — belongs to this block
    // alone, so the read-backs below cannot be satisfied by any other
    // fixture's leftover state.
    // Callers space themselves by HOURS rather than minutes, because
    // `CalendarEntry_teacher_slot_excl` refuses an OVERLAP since #327 and one
    // of the three cases below WIDENS its own row to 105 minutes. A gap
    // narrower than the widest duration any test writes is what would collide.
    const makeStudioClass = (startTime: string) =>
      createStudioClassFixture(prisma, {
          teacherId: ownerId,
          classType: 'PUT Persistence',
          date: PIN_DATE,
          startTime: hhmmToTime(startTime),
          durationMinutes: 75,
          location: 'Harbour Studio',
          hourlyRate: 80,
        });

    // Scoped to this block's own classType, mirroring the slot-conflict
    // block's teardown; it can run before the top-level afterAll without
    // touching studioClassId or any other fixture.
    afterAll(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: ownerId, classType: 'PUT Persistence' } });
    });

    it('persists a location change', async () => {
      const sc = await makeStudioClass('07:00');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        location: 'Lighthouse Studio',
      });
      expect(res.status).toBe(200);

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(after.location).toBe('Lighthouse Studio');
    });

    it('persists a durationMinutes change', async () => {
      const sc = await makeStudioClass('09:00');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        durationMinutes: 105,
      });
      expect(res.status).toBe(200);

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(after.calendarEntry.durationMinutes).toBe(105);
    });

    it('persists an hourlyRate change', async () => {
      const sc = await makeStudioClass('11:00');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        hourlyRate: 62.5,
      });
      expect(res.status).toBe(200);

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(Number(after.hourlyRate)).toBe(62.5);
    });
  });

  // `CalendarEntry_teacher_slot_excl` excludes overlapping spans per teacher
  // WHERE "cancelledAt" IS NULL, and constrains every write, not just creates
  // (Task 6b). This route's own entry update has two independent ways back
  // into that partial scope: changing `startTime` on an already-live row, or
  // clearing `cancelledAt` back to null on a row that was cancelled. Both cases below hold one fixed date and
  // vary only `startTime`/`cancelledAt`, so each isolates its own door; the
  // THIRD way in — a `date` move, opened by #276 — is exercised in that
  // issue's own block below.
  describe('PUT /api/studio-classes/[id] collides on the slot key (#196)', () => {
    const SLOT_DATE = new Date('2027-05-10');

    // 15 minutes, matching the spacing callers use below:
    // `CalendarEntry_teacher_slot_excl` refuses an OVERLAP since #327, so two
    // fixtures a quarter-hour apart must be a quarter-hour long. The moves
    // these tests make land on an IDENTICAL start time, so they still collide.
    const makeStudioClass = (startTime: string, over: Record<string, unknown> = {}) =>
      createStudioClassFixture(prisma, {
          teacherId: ownerId,
          classType: 'PUT Slot',
          date: SLOT_DATE,
          startTime: hhmmToTime(startTime),
          durationMinutes: 15,
          location: 'Some Studio',
          hourlyRate: 45,
          ...over,
        });

    // Scoped to this block's own classType, so it can run before the
    // top-level afterAll without touching studioClassId or any other fixture.
    afterAll(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: ownerId, classType: 'PUT Slot' } });
    });

    it('refuses a startTime change onto a slot another live studio class already holds', async () => {
      await makeStudioClass('12:00');
      const mover = await makeStudioClass('12:15');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${mover.id}`, {
        startTime: '12:00',
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe('DUPLICATE_STUDIO_SLOT');

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: mover.id }, include: { calendarEntry: true } });
      expect(timeToHHmm(after.calendarEntry.startTime)).toBe('12:15');
    });

    // The two rows can coexist at creation: `cancelled` starts outside the
    // partial index (`cancelledAt` is not null), so it never collided with
    // `occupied`. Clearing `cancelledAt` is what re-enters the index.
    it('refuses un-cancelling into a slot another live studio class already holds', async () => {
      await makeStudioClass('12:30');
      const cancelled = await makeStudioClass('12:30', { cancelledAt: new Date('2027-05-01') });

      const res = await send('PUT', ownerToken, `/api/studio-classes/${cancelled.id}`, {
        cancelledAt: null,
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe('DUPLICATE_STUDIO_SLOT');

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: cancelled.id }, include: { calendarEntry: true } });
      expect(after.calendarEntry.cancelledAt).not.toBeNull();
    });
  });

  /**
   * #276's stated policy at the wire. A studio class whose calendar date is
   * strictly past is an income record: only `studentCount` and `cancelledAt`
   * remain writable, and a payload carrying anything else is refused WHOLE —
   * never partially applied. `date` itself moves, but only on a manual
   * (`templateId: null`) not-yet-past row; moving it re-enters the same two
   * guards the startTime path always had, which is what the last two cases
   * here prove.
   *
   * Sits BELOW the #196 slot-collision block on purpose: that block's
   * afterAll releases 2027-05-10 12:00-12:30 before this one claims
   * 2027-05-10/11 at 12:00, so the two fixture sets can never hold each
   * other's slots regardless of run order.
   */
  describe('PUT /api/studio-classes/[id] — the editability policy (#276)', () => {
    // The class-family fixture planted by the cross-family test below. The
    // afterAll deletes exactly these ids, not every family row this teacher
    // owns — a future block above this one must not lose its fixtures here.
    const crossFamilyIds: { classId: string; teacherRoomId: string; roomId: string }[] = [];

    // 10 minutes, matching the spacing callers use below (08:30, 08:40,
    // 08:50 …): `CalendarEntry_teacher_slot_excl` refuses an OVERLAP since
    // #327. Nothing in this block reads the duration — it is about which
    // FIELDS the PUT accepts on which rows.
    const makePolicyRow = (date: Date, startTime: string, extra: Record<string, unknown> = {}) =>
      createStudioClassFixture(prisma, {
          teacherId: ownerId,
          classType: 'PUT Policy',
          date,
          startTime: hhmmToTime(startTime),
          durationMinutes: 10,
          location: 'Policy Studio',
          hourlyRate: 45,
          ...extra,
        });

    // Scoped to this block's own classType and the ids it actually planted,
    // like every sibling block above.
    afterAll(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: ownerId, classType: 'PUT Policy' } });
      for (const ids of crossFamilyIds) {
        await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: ids.classId } } } });
        await prisma.teacherRoom.delete({ where: { id: ids.teacherRoomId } });
        await prisma.room.delete({ where: { id: ids.roomId } });
      }
    });

    it('persists a classType change on a manual future row', async () => {
      const sc = await makePolicyRow(new Date('2099-06-20'), '08:10');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        classType: 'Renamed Via Policy',
      });
      expect(res.status).toBe(200);

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(after.calendarEntry.classType).toBe('Renamed Via Policy');
    });

    it('moves a manual row to another date', async () => {
      const sc = await makePolicyRow(new Date('2099-06-01'), '08:20');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        date: '2099-06-02',
      });
      expect(res.status).toBe(200);

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(after.calendarEntry.date.getTime()).toBe(new Date('2099-06-02').getTime());
    });

    it('refuses a schedule edit on a past row — it is an income record', async () => {
      const sc = await makePolicyRow(new Date('2020-01-01'), '08:30');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        hourlyRate: 99,
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('STUDIO_CLASS_INCOME_RECORD');
      expect(json.error.message).toContain('student count and cancellation');

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(Number(after.hourlyRate)).toBe(45);
    });

    it('refuses whole — studentCount in the same body must not partially apply', async () => {
      const sc = await makePolicyRow(new Date('2020-01-01'), '08:40');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        hourlyRate: 99,
        studentCount: 7,
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe('STUDIO_CLASS_INCOME_RECORD');

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(after.studentCount).toBeNull();
      expect(Number(after.hourlyRate)).toBe(45);
    });

    it('still writes the student count on a past row — the count IS the record', async () => {
      const sc = await makePolicyRow(new Date('2020-01-01'), '08:50');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        studentCount: 3,
      });
      expect(res.status).toBe(200);

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(after.studentCount).toBe(3);
    });

    it("refuses a date move on a generated row, naming cancel-plus-manual", async () => {
      const tpl = await makeTemplate(ownerId, 'Policy Generated', 5, '04:00');
      const sc = await makePolicyRow(new Date('2099-06-21'), '08:55', { scheduleRuleId: tpl.scheduleRuleId });

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        date: '2099-06-28',
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('STUDIO_CLASS_GENERATED_DATE');
      expect(json.error.message).toContain('recurring template');

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(after.calendarEntry.date.getTime()).toBe(new Date('2099-06-21').getTime());
    });

    it('refuses a date move onto a slot another live studio class already holds', async () => {
      await makePolicyRow(new Date('2027-05-10'), '12:00');
      const mover = await makePolicyRow(new Date('2027-05-11'), '12:00');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${mover.id}`, {
        date: '2027-05-10',
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe('DUPLICATE_STUDIO_SLOT');

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: mover.id }, include: { calendarEntry: true } });
      expect(after.calendarEntry.date.getTime()).toBe(new Date('2027-05-11').getTime());
    });

    // Fixture mirrors cross-family-slot-api.test.ts's "studio family refuses a
    // slot the class family holds" setup: a Room + TeacherRoom so a Class row
    // can be planted directly, then a pure `date` move onto it. The guard is a
    // constraint, so this fires through the DB, not through any pre-check the
    // route could have.
    //
    // THE MESSAGE NAMES THE HOLDING ROW, not this caller's own family (#327).
    // `CalendarEntry_teacher_slot_excl` raises a `23P01` carrying no family, so
    // the route probes for the live entry whose span overlaps and reports that
    // row's family, start time and date — here a CLASS at 09:00 on 6 May 2031,
    // where the mover is a studio class. The CODE stays this caller's
    // (`DUPLICATE_STUDIO_SLOT`): it says the slot is occupied, which is the
    // condition the caller hit.
    it('refuses a date move onto a slot the class family already holds', async () => {
      const room = await prisma.room.create({
        data: {
          venueName: 'Policy Cross Venue',
          address: `${suffix} Policy Cross Street`,
          city: 'Amsterdam',
          postcode: '1011AB',
          floor: '1',
          roomName: 'Main',
          maxCapacity: 12,
          createdById: ownerId,
        },
      });
      const teacherRoom = await prisma.teacherRoom.create({
        data: { teacherId: ownerId, roomId: room.id, rentalRate: 20, capacityOverride: 12 },
      });
      const holder = await createClassFixture(prisma, {
          teacherId: ownerId,
          teacherRoomId: teacherRoom.id,
          classType: 'Policy Cross Family Holder',
          date: new Date('2031-05-06'),
          startTime: hhmmToTime('09:00'),
          durationMinutes: 60,
          roomCost: 20,
          minRate: 30,
          targetRate: 60,
          minStudents: 3,
          maxStudents: 10,
        });
      crossFamilyIds.push({
        classId: holder.id,
        teacherRoomId: teacherRoom.id,
        roomId: room.id,
      });

      const mover = await makePolicyRow(new Date('2031-05-07'), '09:00');
      const res = await send('PUT', ownerToken, `/api/studio-classes/${mover.id}`, {
        date: '2031-05-06',
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('DUPLICATE_STUDIO_SLOT');
      expect(json.error.message).toBe('You already have a class at 09:00 on 6 May 2031.');

      // The row did not move — the half of this test the code change does not
      // touch, and the half that would matter if the refusal ever stopped
      // being enforced rather than merely stopped being specific.
      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: mover.id }, include: { calendarEntry: true } });
      expect(after.calendarEntry.date.getTime()).toBe(new Date('2031-05-07').getTime());
    });

    it('rejects an empty PUT rather than issuing a no-op write', async () => {
      const sc = await makePolicyRow(new Date('2099-06-22'), '08:58');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {});
      expect(res.status).toBe(400);
    });

    /**
     * PRESENCE, NOT DIFFERENCE. Gate 2 refuses any `date` on a row that may not
     * move one — the row's own unchanged date included. That asymmetry is the
     * only reason the edit form omits the key rather than sending it, so
     * narrowing this gate to a difference check would leave the form's omission
     * logic guarding nothing, with every other test in this block still green.
     */
    it('refuses a generated row its OWN date, unchanged — the gate reads presence', async () => {
      const tpl = await makeTemplate(ownerId, 'Policy Unchanged Date', 5, '06:00');
      const sc = await makePolicyRow(new Date('2099-06-23'), '09:05', { scheduleRuleId: tpl.scheduleRuleId });

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        date: '2099-06-23',
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('STUDIO_CLASS_GENERATED_DATE');
    });

    /**
     * The refusal must describe the row it refuses. A past MANUAL row fails
     * `dateEditable` by D1's invariant, not by template, and gate 1 does not
     * cover it — a body of `{ date }` alone leaves `gated` empty and falls
     * through to gate 2. Telling that teacher their hand-logged class comes
     * from a recurring template is a false sentence, rendered verbatim (#197).
     */
    it('tells a past manual row it is an income record, not a template child', async () => {
      const sc = await makePolicyRow(new Date('2020-02-01'), '09:10');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        date: '2020-02-02',
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('STUDIO_CLASS_INCOME_RECORD');
      expect(json.error.message).not.toMatch(/recurring template/);

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(after.calendarEntry.date.getTime()).toBe(new Date('2020-02-01').getTime());
    });

    /**
     * GATE 3 — the backdating trapdoor. The other two gates read the STORED
     * row, so neither can see a write that ends the row's own editability: the
     * move lands the class in the past, gate 1 freezes it on arrival, and the
     * mistyped year cannot be undone through this editor. Mirrors the `Class`
     * family's #249 rule. Logging a class that already happened stays open at
     * `/studio-class/new`, so nothing is taken away.
     */
    it('refuses a manual row a move into the past — it would freeze on arrival', async () => {
      const sc = await makePolicyRow(new Date('2099-06-24'), '09:15');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        date: '2020-06-24',
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('STUDIO_CLASS_PAST_DATE');
      expect(json.error.message).toMatch(/cannot move to a date in the past/i);

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(after.calendarEntry.date.getTime()).toBe(new Date('2099-06-24').getTime());
    });

    /**
     * Cancellation stays writable on an income record — the `income_record`
     * refusal PROMISES it ("only its student count and cancellation"), and
     * until now only the student-count half was pinned. Both directions, since
     * un-cancelling re-enters the partial slot index. A studio cancellation is
     * also what excludes a class from reporting, so a teacher who cannot cancel
     * a past class that did not happen overstates their income permanently.
     */
    it('still cancels and un-cancels a past row — the other half of the promise', async () => {
      const sc = await makePolicyRow(new Date('2020-03-01'), '09:20');

      const cancel = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        cancelledAt: '2020-03-02T10:00:00.000Z',
      });
      expect(cancel.status).toBe(200);
      expect(
        (await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } })).calendarEntry.cancelledAt,
      ).not.toBeNull();

      const restore = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        cancelledAt: null,
      });
      expect(restore.status).toBe(200);
      expect(
        (await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } })).calendarEntry.cancelledAt,
      ).toBeNull();
    });

    /**
     * THE CLOCK AND THE ZONE, WIRED. Every other fixture in this block is dated
     * 2020 or 2099 — unambiguous in every timezone, so hardcoding `'UTC'` or a
     * fixed instant at the route's verdict call leaves them all green. This one
     * is built from the real clock in the teacher's zone, and pins D1's central
     * decision: today is not past, because the count is logged after class.
     */
    it("keeps today's class editable, reading the teacher's zone and not UTC", async () => {
      const today = startOfLocalDay(new Date(), 'Europe/Amsterdam');
      const sc = await makePolicyRow(today, '09:25');

      const res = await send('PUT', ownerToken, `/api/studio-classes/${sc.id}`, {
        hourlyRate: 77,
      });
      expect(res.status).toBe(200);

      const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: sc.id }, include: { calendarEntry: true } });
      expect(Number(after.hourlyRate)).toBe(77);
    });
  });

  describe('POST /api/studio-classes is retry-safe on the slot key (#196)', () => {
    // '2027-04-12' is a date no fixture above touches, so ownerId's slot
    // exclusion (`CalendarEntry_teacher_slot_excl`, overlapping spans per
    // teacher WHERE "cancelledAt" IS NULL) has nothing to collide with. The top-level afterAll clears every StudioClass
    // row for ownerId regardless of classType, so these need no nested one.
    const slotBody = () => ({
      classType: 'Slot Studio', date: '2027-04-12', startTime: '11:00',
      durationMinutes: 60, location: 'Some Studio', hourlyRate: 45,
    });

    it('answers a repeated identical create with 409 and leaves exactly one row', async () => {
      const first = await send('POST', ownerToken, '/api/studio-classes', slotBody());
      expect(first.status).toBe(201);

      const second = await send('POST', ownerToken, '/api/studio-classes', slotBody());
      expect(second.status).toBe(409);
      expect((await second.json()).error.code).toBe('DUPLICATE_STUDIO_SLOT');

      const rows = await prisma.studioClass.findMany({ where: { calendarEntry: { teacherId: ownerId, date: new Date('2027-04-12'), startTime: hhmmToTime('11:00') } }, include: { calendarEntry: true } });
      expect(rows).toHaveLength(1);
    });

    it('leaves exactly one row when two identical creates are in flight at once', async () => {
      // 13:00, not 11:30: the case above leaves a 60-minute row standing at
      // 11:00, and `CalendarEntry_teacher_slot_excl` refuses an OVERLAP since
      // #327 — so at 11:30 BOTH creates lose to that leftover and the race
      // this test stages never happens. A start time clear of it is what keeps
      // the constraint answering about the two requests rather than about the
      // previous test.
      //
      // TEN RACES, NOT ONE (issue 331): a plain `INSERT` against that
      // exclusion constraint inserts its tuple and only then checks it, so two
      // concurrent conflicting inserts wait on each other and Postgres breaks
      // the cycle with `40P01` — the loser answering 503 where a 409 belongs.
      // One pair passes against that bug most of the time, so a single race
      // does not catch a regression here reliably — same shape as the
      // template families' own race loops (`tests/integration/class-templates-api.test.ts`,
      // this file's `POST /api/studio-class-templates` describe). Ten
      // non-overlapping 45-minute slots, 13:00 through 22:00, keep every
      // iteration clear of its predecessors' winners — the loop makes the
      // leftover-row hazard above sharper, not softer, since each race now
      // leaves a row of its own standing too.
      for (let i = 0; i < 10; i++) {
        const body = {
          ...slotBody(),
          startTime: `${String(13 + i).padStart(2, '0')}:00`,
          durationMinutes: 45,
        };
        const [a, b] = await Promise.all([
          send('POST', ownerToken, '/api/studio-classes', body),
          send('POST', ownerToken, '/api/studio-classes', body),
        ]);
        expect([a.status, b.status].sort(), `race ${i}`).toEqual([201, 409]);

        const loser = a.status === 409 ? a : b;
        expect((await loser.json()).error.code).toBe('DUPLICATE_STUDIO_SLOT');

        const rows = await prisma.studioClass.findMany({ where: { calendarEntry: { teacherId: ownerId, date: new Date('2027-04-12'), startTime: hhmmToTime(body.startTime) } }, include: { calendarEntry: true } });
        expect(rows, `race ${i}`).toHaveLength(1);
      }
    });
  });
});

describe('DELETE /api/studio-classes/[id]', () => {
  const makeClass = ({ startTime, ...data }: {
    // The RULE, not the template: a studio class hangs off a `CalendarEntry`
    // since #327, and the entry's `scheduleRuleId` is what
    // `studioClassDeletability` reads as "generated". Spread into the fixture
    // below, so the old name compiled cleanly and failed at runtime —
    // excess-property checking does not survive a spread.
    scheduleRuleId?: string | null;
    date: Date;
    startTime: string;
    cancelledAt?: Date | null;
  }) =>
    createStudioClassFixture(prisma, {
        teacherId: ownerId,
        classType: 'Removable',
        // Callers here space their fixtures 15 minutes apart, and
        // `CalendarEntry_teacher_slot_excl` refuses an OVERLAP since #327 —
        // so the duration has to be no wider than that gap. Nothing in this
        // block reads it.
        durationMinutes: 15,
        location: 'Community Studio',
        hourlyRate: 45,
        startTime: hhmmToTime(startTime),
        ...data,
      });

  const FUTURE = new Date('2099-07-01T00:00:00.000Z');
  const PAST = new Date('2020-07-01T00:00:00.000Z');

  it('refuses without a session', async () => {
    const sc = await makeClass({ date: PAST, startTime: '05:00' });
    const res = await fetch(`${BASE_URL}/api/studio-classes/${sc.id}`, { method: 'DELETE' });
    expect(res.status).toBe(401);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id }, include: { calendarEntry: true } })).not.toBeNull();
  });

  it("refuses another teacher's class with 403", async () => {
    const sc = await makeClass({ date: PAST, startTime: '05:15' });
    const res = await send('DELETE', otherToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(403);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id }, include: { calendarEntry: true } })).not.toBeNull();
  });

  it('answers 404 for an id that is not there', async () => {
    const res = await send(
      'DELETE',
      ownerToken,
      '/api/studio-classes/00000000-0000-4000-8000-000000000000',
    );
    expect(res.status).toBe(404);
  });

  it('refuses a future generated class, naming cancel and the code', async () => {
    const tpl = await makeTemplate(ownerId, 'Del Future', 5, '08:00');
    const sc = await makeClass({ scheduleRuleId: tpl.scheduleRuleId, date: FUTURE, startTime: '05:30' });

    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('STUDIO_CLASS_REGENERATES');
    expect(body.error.message).toContain('Cancel it instead.');
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id }, include: { calendarEntry: true } })).not.toBeNull();
  });

  /**
   * The behavioural half of the predicate's §4.2 guard. The parameter type
   * already makes reading `isArchived` a compile error; this case is what
   * catches someone who widens the type properly and then adds the read.
   * Template state is reversible — un-archive, resume, and the date is refilled.
   */
  it('still refuses a future generated class when its template is archived', async () => {
    const tpl = await makeTemplate(ownerId, 'Del Archived', 3, '05:45', {
      isArchived: true,
      isActive: false,
    });
    const sc = await makeClass({ scheduleRuleId: tpl.scheduleRuleId, date: FUTURE, startTime: '05:45' });

    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(409);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id }, include: { calendarEntry: true } })).not.toBeNull();
  });

  it('removes a future manual class, because nothing regenerates it', async () => {
    const sc = await makeClass({ scheduleRuleId: null, date: FUTURE, startTime: '06:00' });
    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(200);
    // respondOk wraps in `data` — the plan's predicted bare `{ deleted: true }`
    // did not match the helper's actual shape.
    expect(await res.json()).toEqual({ data: { deleted: true } });
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id }, include: { calendarEntry: true } })).toBeNull();
  });

  it('removes a past generated class', async () => {
    const tpl = await makeTemplate(ownerId, 'Del Past', 5, '10:00');
    const sc = await makeClass({ scheduleRuleId: tpl.scheduleRuleId, date: PAST, startTime: '06:15' });
    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id }, include: { calendarEntry: true } })).toBeNull();
  });

  /**
   * Cancellation is orthogonal to removability — the predicate cannot read it.
   *
   * GENERATED, deliberately. This case was written manual, which returns on the
   * first disjunct (`templateId === null`) and never reaches the date branch the
   * comment names — it proved nothing about cancellation. With a template it
   * exercises the real path, and its twin below covers the other direction.
   */
  it('removes a cancelled past generated class', async () => {
    const tpl = await makeTemplate(ownerId, 'Del Cancelled Past', 5, '12:00');
    const sc = await makeClass({
      scheduleRuleId: tpl.scheduleRuleId,
      date: PAST,
      startTime: '06:30',
      cancelledAt: new Date('2020-07-01T10:00:00.000Z'),
    });
    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id }, include: { calendarEntry: true } })).toBeNull();
  });

  /** The double-click. P2025 must read as 404, not as a 500. */
  /**
   * THE OTHER DIRECTION, and the one that was missing: cancellation must not
   * ENABLE a removal either. Add `if (cancelledAt !== null) return deletable`
   * to the predicate — "it is already cancelled, let them clear the litter",
   * a far more attractive edit than reading template state — and every other
   * case in this file still passes.
   *
   * What it would ship: removing a cancelled FUTURE generated class releases
   * its entry's `(scheduleRuleId, date)`, and that date is held only because
   * the cancelled row
   * occupies it (`studio-class-generator.ts`, `blocked_by_cancelled`). The
   * sweep recreates the class LIVE within the hour, so a teacher's cancellation
   * silently un-cancels itself on a class students were told was off.
   */
  it('refuses a cancelled future generated class, so cancelling cannot buy a removal', async () => {
    const tpl = await makeTemplate(ownerId, 'Del Cancelled Future', 5, '14:00');
    const sc = await makeClass({
      scheduleRuleId: tpl.scheduleRuleId,
      date: FUTURE,
      startTime: '05:45',
      cancelledAt: new Date('2020-07-01T10:00:00.000Z'),
    });

    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(409);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id }, include: { calendarEntry: true } })).not.toBeNull();
  });

  /**
   * THE REGRESSION PR #295's REVIEW FOUND. A generated class dated TODAY is
   * refused however long ago it started, because the class's `startTime` is a
   * stamp and the generator filters on the TEMPLATE's current one.
   *
   * Under the start-instant rule this answered 200: the class started at 00:01
   * and "cannot regenerate". But move the template to a later hour — an
   * ordinary edit, and one CLAUDE.md guarantees leaves the class untouched —
   * and the sweep finds that later instant still ahead, finds
   * `(scheduleRuleId, date)` released by the removal, and re-inserts on the
   * same date within the hour. A delete that undid itself.
   *
   * The template here is created at a LATER time than the class deliberately,
   * so the fixture is the divergence rather than merely a same-day class.
   */
  it('refuses a generated class dated today, however long ago it started', async () => {
    const today = new Date(
      `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date())}T00:00:00.000Z`,
    );
    const tpl = await makeTemplate(ownerId, 'Del Today Diverged', 6, '23:30');
    const sc = await makeClass({ scheduleRuleId: tpl.scheduleRuleId, date: today, startTime: '00:01' });

    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('STUDIO_CLASS_REGENERATES');
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id }, include: { calendarEntry: true } })).not.toBeNull();
  });

  /** The complement: one day earlier, the sweep cannot reach it and it goes. */
  it('removes a generated class dated before today', async () => {
    const todayMs = new Date(
      `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date())}T00:00:00.000Z`,
    ).getTime();
    const yesterday = new Date(todayMs - 24 * 60 * 60 * 1000);
    const tpl = await makeTemplate(ownerId, 'Del Yesterday', 5, '23:45');
    const sc = await makeClass({ scheduleRuleId: tpl.scheduleRuleId, date: yesterday, startTime: '00:01' });

    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id }, include: { calendarEntry: true } })).toBeNull();
  });

  it('answers the second removal with 404 rather than a 500', async () => {
    const sc = await makeClass({ date: PAST, startTime: '06:45' });
    expect((await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`)).status).toBe(200);
    expect((await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`)).status).toBe(404);
  });
});
