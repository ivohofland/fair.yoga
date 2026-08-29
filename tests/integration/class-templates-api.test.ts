import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateInstancesForTemplate } from '@/services/class-generator';
import { getNextOccurrences } from '@/services/entry-generation';
// The production week key, used here as the assertion's own notion of "same
// week". Deliberately the real one rather than a local reimplementation: the
// claim under test is that the probe and the generator agree about weeks, and
// a second definition in the test could only weaken it.
import { mondayOf } from '@/lib/timezone';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

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

/**
 * Five weekdays with no meaning of their own — room for this file's many
 * single-purpose fixtures now that `ScheduleRule_teacher_slot_excl` (issue
 * 298) refuses any RANGE overlap within one `(teacherId, dayOfWeek)`, not
 * just an identical `startTime` string. This file creates more live
 * templates than DAY_OF_WEEK holds at 60-minute spacing, and most of them
 * have no stake in which weekday they land on — only a case that reads
 * `EXPECTED_JS_DAY` or shares `sameWeekDayPair()`'s pair does.
 *
 * Each is DAY_OF_WEEK plus a distinct, fixed, nonzero offset mod 7 (1, 3, 4,
 * 5, 6 — five of the six available; offset 2 is reserved, not free, see
 * below), so every one differs from DAY_OF_WEEK and from every other
 * ALT_DAY on every day of the week, by construction rather than by luck.
 *
 * That construction only proves mutual distinctness, not distinctness from
 * TODAY. DAY_OF_WEEK is itself today plus 2 (see above), so today is
 * DAY_OF_WEEK plus 5 mod 7 — exactly ALT_DAY_4's offset. Pigeonhole makes
 * this unavoidable: 7 weekdays, and DAY_OF_WEEK plus five ALT_DAYs already
 * name 6 of them, so the 7th (today) has nowhere left to be but one of the
 * six offsets already claimed — and offset 2 (today's own) is the one this
 * file reserves for `NEW_DAY_OF_WEEK` (`(DAY_OF_WEEK + 2) % 7`, used
 * wherever a case needs a day distinct from both DAY_OF_WEEK and today),
 * forcing today onto an ALT_DAY instead. ALT_DAY_4 is that one, every day
 * of the year. ALT_DAY_5, one offset over, is by the same arithmetic always
 * tomorrow — only one day out, which is not this file's own two-days-out
 * zone margin above; it reads as safely-in-the-future only because this
 * file's teacher is pinned to `defaultTimezone: 'UTC'` (`seedTeacher`), not
 * by construction. A fixture whose test cares whether its window is
 * strictly in the future — e.g. anything read against an archive's
 * `date > today` withdrawal — cannot use ALT_DAY_4 for that reason, should
 * not lean on ALT_DAY_5 without also depending on the UTC pin, and cannot
 * be fixed by picking a different offset for ALT_DAY_4 itself; some offset
 * is always today, by the same pigeonhole. ALT_DAY_1 (three days out) is
 * the one with no such dependency.
 */
const ALT_DAY_1 = (DAY_OF_WEEK + 1) % 7;
const ALT_DAY_2 = (DAY_OF_WEEK + 3) % 7;
const ALT_DAY_3 = (DAY_OF_WEEK + 4) % 7;
const ALT_DAY_4 = (DAY_OF_WEEK + 5) % 7;
const ALT_DAY_5 = (DAY_OF_WEEK + 6) % 7;

// startTime is required, not defaulted — every call site below must state
// its own: `ScheduleRule_teacher_slot_excl` (issue 298) refuses a RANGE
// overlap, not just an identical string, this file reuses one teacher
// throughout, and most of these templates are never archived by the end of
// their test (that is what several of them are proving) — so the only way
// for later templates to coexist with earlier still-active ones is a
// startTime (and, past this file's single-day budget, a dayOfWeek) of their
// own. A default startTime would silently reopen the exact collision this
// file was repaired for, the moment a ninth inline caller forgot to pass one.
//
// `dayOfWeek` DOES default, to `DAY_OF_WEEK` — unlike startTime, that default
// is the value most callers actually want (#123's weekday-derivation still
// has to hold for every template a test reads `EXPECTED_JS_DAY` against), so
// defaulting it is not the silent-collision trap the paragraph above warns
// against. A caller past this file's one-day budget states its own day
// instead, the same way it always had to state its own startTime.
function templateBody(classType: string, startTime: string, dayOfWeek: number = DAY_OF_WEEK) {
  return {
    teacherRoomId,
    classType,
    dayOfWeek,
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
 * Two weekdays whose next occurrences fall in the SAME Monday-week: the day a
 * template starts on and the day it is moved to, for #194's probe cases.
 *
 * `getNextOccurrences` counts from today, so a weekday at or after today's own
 * lands in this week and one before it lands in the next. Pick both from the
 * same side of that line and the four weeks the old schedule generated are
 * exactly the four the generator will next consider for the new day — which is
 * the premise both probe cases below rest on ("every week the generator can see
 * is held"). With the file's shared `(DAY_OF_WEEK + 2) % 7` that identity holds
 * on five days of the week and not on the other two, and on those two the
 * answer lands inside the generator's own window and the cases quietly stop
 * testing what they are named for.
 *
 * Neither day is ever today, so the generator's past-start filter never has an
 * occurrence to drop and cannot shift one window relative to the other.
 *
 * Returned in schema convention (0=Monday … 6=Sunday), like every other
 * `dayOfWeek` in this file.
 */
function sameWeekDayPair(): [number, number] {
  const todaySchemaDay = (new Date().getUTCDay() + 6) % 7;
  // Both at or after today (and neither today) while there is room for two;
  // otherwise both before it, where they share next week instead.
  return todaySchemaDay <= 4 ? [todaySchemaDay + 1, todaySchemaDay + 2] : [0, 1];
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
    await prisma.calendarEntry.deleteMany({ where: { teacherId: t } });
    // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue 298), so deleting the rules removes the templates with them.
    await prisma.scheduleRule.deleteMany({ where: { teacherId: t } });
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
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: [teacherId, otherTeacherId] } } });
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
    const instances = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(instances.length).toBe(4);
    for (const instance of instances) {
      expect(instance.status).toBe('open');
      expect(timeToHHmm(instance.calendarEntry.startTime)).toBe('09:30');
      expect(instance.calendarEntry.date.getUTCDay()).toBe(EXPECTED_JS_DAY);
    }
  });

  it('a generation failure rolls the whole create back — no template, no instances', async () => {
    const before = await prisma.classTemplate.count({ where: { scheduleRule: { teacherId } } });

    await expect(
      prisma.$transaction(async (tx) => {
        const created = await tx.classTemplate.create({
          data: {
            scheduleRule: {
              create: {
                teacherId, kind: 'regular', classType: 'Rollback', dayOfWeek: ALT_DAY_4,
                startTime: hhmmToTime('09:00'), durationMinutes: 60,
              },
            },
            teacherRoom: { connect: { id: teacherRoomId } },
            roomCost: 10, minRate: 10,
            targetRate: 20, minStudents: 1, maxStudents: 8,
            // cancelDeadline/autoCancelCheck are enums with schema defaults
            // (HOURS_24 / HOURS_2) — the brief's numeric 120 predates that;
            // omitted here to compile against the current schema.
          },
          include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
        });
        // Deterministic FK failure (P2003, not the swallowed P2002): bogus room.
        await generateInstancesForTemplate(tx, {
          ...created,
          teacherRoomId: '00000000-0000-4000-8000-000000000000',
        });
        return created;
      }),
    ).rejects.toThrow();

    const after = await prisma.classTemplate.count({ where: { scheduleRule: { teacherId } } });
    expect(after).toBe(before);
  });

  // #196. The create sits inside a $transaction that also generates the
  // four-week window, so a duplicate here is worse than a duplicate row: a
  // second identical template would have meant a second full four-week set
  // of bookable classes. Neither case reads the created template's weekday,
  // so both sit on `ALT_DAY_1` rather than the shared `DAY_OF_WEEK` — see
  // templateBody's docblock above.
  describe('POST /api/class-templates is retry-safe on the slot key (#196)', () => {
    const post = (body: unknown) =>
      fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
        body: JSON.stringify(body),
      });

    it('answers a repeated identical create with 409 and leaves one template and one window', async () => {
      const body = templateBody('Slot Recurring', '00:00', ALT_DAY_1);

      const first = await post(body);
      expect(first.status).toBe(201);

      const second = await post(body);
      expect(second.status).toBe(409);
      expect((await second.json()).error.code).toBe('DUPLICATE_TEMPLATE_SLOT');

      const templates = await prisma.classTemplate.findMany({
        where: { scheduleRule: { teacherId, dayOfWeek: ALT_DAY_1, startTime: hhmmToTime('00:00'), isArchived: false } },
      });
      expect(templates).toHaveLength(1);

      // The half the endpoint's severity actually lives in: a second
      // template would have generated a second full four-week set of
      // bookable classes.
      const generated = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templates[0]!.id } } } } }, include: { calendarEntry: true } });
      expect(generated).toHaveLength(4);
    });

    it('leaves one template and one window when two identical creates are in flight at once', async () => {
      // TEN RACES, NOT ONE (issue 331). Ten 45-minute slots at 14:00 … 23:00
      // do not overlap each other, so each race is independent of its
      // predecessors' leftover rows — the same shape as the studio family's
      // own race loop (`tests/integration/studio-api.test.ts`). Not any of
      // ALT_DAY_1/2/3 (dense with this file's other fixtures across most of
      // the day) and not ALT_DAY_5 (structurally the same weekday
      // `sameWeekDayPair()`'s `OLD_DAY` resolves to on every non-weekend run,
      // since both are `today + 1`). This uses the file's own reserved
      // `(DAY_OF_WEEK + 2) % 7` offset instead — the weekday the `PUT`
      // describe block's own `NEW_DAY_OF_WEEK` cases move templates onto —
      // whose only occupants are 06:00 (archived, so outside
      // `ScheduleRule_teacher_slot_excl`'s scope), 08:00 and 12:00, both well
      // clear of this loop's 14:00-23:45 span. The hazard runs the other
      // way from "moving this loop": a FUTURE `PUT` case that moves a
      // template onto `NEW_DAY_OF_WEEK` at or after 14:00 would collide with
      // one of these ten rows instead — grep first with
      // `grep -n "NEW_DAY_OF_WEEK" tests/integration/class-templates-api.test.ts`
      // before adding one.
      const RACE_DAY = (DAY_OF_WEEK + 2) % 7;
      for (let i = 0; i < 10; i++) {
        const body = {
          ...templateBody(`Slot Class Concurrent ${i}`, `${String(14 + i).padStart(2, '0')}:00`, RACE_DAY),
          durationMinutes: 45,
        };

        const [a, b] = await Promise.all([post(body), post(body)]);
        const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
        const outcomes = `${a.status}:${bodyA?.error?.code ?? '-'} ${b.status}:${bodyB?.error?.code ?? '-'}`;

        expect([a.status, b.status].sort(), `race ${i}: ${outcomes}`).toEqual([201, 409]);

        const loserBody = a.status === 409 ? bodyA : bodyB;
        expect(loserBody.error.code).toBe('DUPLICATE_TEMPLATE_SLOT');
      }

      // Checking every one of the ten races' shape would just repeat the
      // sequential sibling above ten times over — that case already pins "one
      // template, one four-week window" for a single race. This checks the
      // LAST race (i === 9, '23:00') only, enough to confirm the loop's
      // winner-per-slot outcome actually lands rather than merely answering
      // the right HTTP codes.
      const templates = await prisma.classTemplate.findMany({
        where: { scheduleRule: { teacherId, dayOfWeek: RACE_DAY, startTime: hhmmToTime('23:00'), isArchived: false } },
      });
      expect(templates).toHaveLength(1);

      const generated = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templates[0]!.id } } } } }, include: { calendarEntry: true } });
      expect(generated).toHaveLength(4);
    });
  });

  // Door 4 of the room archive lifecycle (issue 76). `ScheduleRule.isActive`
  // defaults true, so a template created on an archived room would start
  // generating instances immediately — unlike a class, which is always born
  // `draft` and is caught later at the publish door. A dedicated
  // `seedTeacher` fixture rather than the shared `teacherRoomId`/
  // `sessionToken` above: archiving the shared room here would affect every
  // other test in this file that reuses it.
  it('refuses to create a template on an archived room, and writes nothing', async () => {
    const owner = await seedTeacher('archived-room');
    try {
      await prisma.teacherRoom.update({
        where: { id: owner.teacherRoomId },
        data: { isArchived: true },
      });

      const res = await fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({
          teacherRoomId: owner.teacherRoomId,
          classType: 'Yin',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:30',
          durationMinutes: 60,
          roomCost: 20,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
        }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string; code?: string } };
      expect(body.error.code).toBe('ROOM_ARCHIVED');

      // A template born active on an archived room would generate into it at
      // once — nothing must have been written.
      expect(
        await prisma.classTemplate.count({ where: { teacherRoomId: owner.teacherRoomId } }),
      ).toBe(0);
    } finally {
      // Same FK-safe order as the file's own afterAll: class → classTemplate
      // → teacherRoom → room → session → teacher → account.
      await prisma.calendarEntry.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.room.delete({ where: { id: owner.roomId } });
      await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
      await prisma.teacher.delete({ where: { id: owner.teacherId } });
      await prisma.account.delete({ where: { id: owner.accountId } });
    }
  });

  // The behaviour change this branch exists to prove: `19:00 +90` against
  // `19:30 +60` is legal today (only an EXACT-start match was refused before
  // issue 298) and refused after. A dedicated `seedTeacher` fixture, like the
  // room-archive door above, so this doesn't have to find a free slot in the
  // shared teacher's already-dense namespace.
  describe('refuses an OVERLAP with the studio family, not just an exact match (issue 298)', () => {
    it('answers 409 naming the studio family when a new template OVERLAPS a studio template', async () => {
      const owner = await seedTeacher('overlap-studio');
      try {
        await prisma.studioClassTemplate.create({
          data: {
            scheduleRule: {
              create: {
                teacherId: owner.teacherId, kind: 'studio', classType: 'Overlap Studio',
                dayOfWeek: 2, startTime: hhmmToTime('19:00'), durationMinutes: 90,
              },
            },
            location: 'Overlap Venue', hourlyRate: 40,
          },
        });

        const res = await fetch(`${BASE_URL}/api/class-templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
          body: JSON.stringify({
            teacherRoomId: owner.teacherRoomId,
            classType: 'Overlap Class',
            dayOfWeek: 2,
            startTime: '19:30',
            durationMinutes: 60,
            roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
          }),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { message: string; code?: string } };
        expect(body.error.code).toBe('CROSS_FAMILY_STUDIO_TEMPLATE_SLOT');
        // "at that time" described the exact-start index this constraint
        // replaced; 19:00 and 19:30 are not the same time.
        expect(body.error.message).toMatch(/overlapping/i);
      } finally {
        await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
        await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
        await prisma.room.delete({ where: { id: owner.roomId } });
        await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
        await prisma.teacher.delete({ where: { id: owner.teacherId } });
        await prisma.account.delete({ where: { id: owner.accountId } });
      }
    });

    it('still answers 409 on an exact-start collision — unchanged behaviour', async () => {
      const owner = await seedTeacher('exact-studio');
      try {
        await prisma.studioClassTemplate.create({
          data: {
            scheduleRule: {
              create: {
                teacherId: owner.teacherId, kind: 'studio', classType: 'Exact Studio',
                dayOfWeek: 2, startTime: hhmmToTime('08:00'), durationMinutes: 60,
              },
            },
            location: 'Exact Venue', hourlyRate: 40,
          },
        });

        const res = await fetch(`${BASE_URL}/api/class-templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
          body: JSON.stringify({
            teacherRoomId: owner.teacherRoomId,
            classType: 'Exact Class',
            dayOfWeek: 2,
            startTime: '08:00',
            durationMinutes: 60,
            roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
          }),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code?: string } };
        expect(body.error.code).toBe('CROSS_FAMILY_STUDIO_TEMPLATE_SLOT');
      } finally {
        await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
        await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
        await prisma.room.delete({ where: { id: owner.roomId } });
        await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
        await prisma.teacher.delete({ where: { id: owner.teacherId } });
        await prisma.account.delete({ where: { id: owner.accountId } });
      }
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
  const newTemplate = async (
    classType: string,
    startTime: string,
    dayOfWeek: number = DAY_OF_WEEK,
  ): Promise<string> => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody(classType, startTime, dayOfWeek)),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };

  it('re-activation tops the window back up; archive and pause do not generate', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Toggle Flow', '04:00', ALT_DAY_1)),
    });
    expect(create.status).toBe(201);
    const { data: template } = (await create.json()) as { data: { id: string } };
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } } })).toBe(4);

    // Simulate window drift: one instance vanishes (e.g. teacher-cancelled
    // long ago and pruned). Regeneration is what heals it.
    const first = await prisma.class.findFirstOrThrow({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: first.id } } } });

    const toggle = (state: string) =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?state=${state}`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });

    // active → paused: no generation.
    const pause = await toggle('paused');
    expect(pause.status).toBe(200);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } } })).toBe(3);

    // paused → active: the missing instance comes back.
    const activate = await toggle('active');
    expect(activate.status).toBe(200);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } } })).toBe(4);

    // Archive (forces inactive) after removing another instance: no
    // generation, and — #86 — archiving withdraws whatever remains of the
    // future unbooked window, so the count drops to zero rather than
    // staying at 3. Un-archive leaves the template paused and does not
    // restore what archiving deleted — still zero.
    const next = await prisma.class.findFirstOrThrow({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: next.id } } } });
    const archive = (state: string) =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?state=${state}`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });
    expect((await archive('archived')).status).toBe(200);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } } })).toBe(0);
    expect((await archive('unarchived')).status).toBe(200); // un-archive
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } } })).toBe(0);

    // Explicit activation after un-archive is the "goes live" moment: the
    // window regenerates from scratch since nothing was left standing.
    expect((await toggle('active')).status).toBe(200);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } } })).toBe(4);
  });

  it('refuses to activate an archived template — no instant classes for shelved things', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Shelved Flow', '06:00', ALT_DAY_1)),
    });
    expect(create.status).toBe(201);
    const { data: template } = (await create.json()) as { data: { id: string } };

    const archive = await fetch(
      `${BASE_URL}/api/class-templates/${template.id}?state=archived`,
      { method: 'PATCH', headers: cookie(sessionToken) },
    );
    expect(archive.status).toBe(200);
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: template.id } } } },
    });

    const toggle = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=active`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(toggle.status).toBe(409);

    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: { scheduleRule: true },
    });
    expect(after.scheduleRule.isActive).toBe(false);
    expect(after.scheduleRule.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } } })).toBe(0);
  });

  it('re-activation generates only for the re-activated template, not teacher-wide', async () => {
    // Template A: paused, no instances — created directly (bypassing the
    // route) so its window starts empty.
    const templateA = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId, kind: 'regular', classType: 'Scope A', dayOfWeek: ALT_DAY_1,
            startTime: hhmmToTime('10:00'), durationMinutes: 60, isActive: false,
          },
        },
        teacherRoom: { connect: { id: teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });

    // Template B: already active, no instances — also created directly so
    // the old teacher-wide generator's "top up every active template"
    // behavior would have populated it; the new template-scoped generator
    // must leave it alone.
    const templateB = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId, kind: 'regular', classType: 'Scope B', dayOfWeek: ALT_DAY_2,
            startTime: hhmmToTime('10:00'), durationMinutes: 60, isActive: true,
          },
        },
        teacherRoom: { connect: { id: teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateB.id } } } } } })).toBe(0);

    const activate = await fetch(`${BASE_URL}/api/class-templates/${templateA.id}?state=active`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(activate.status).toBe(200);

    // A's window generated...
    expect(
      await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateA.id } } } } } }),
    ).toBeGreaterThanOrEqual(1);
    // ...but B — also active, untouched by this request — stays empty.
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateB.id } } } } } })).toBe(0);

    await prisma.calendarEntry.deleteMany({ where: { scheduleRule: { classTemplates: { some: { id: { in: [templateA.id, templateB.id] } } } } } });
    // `scheduleRule.deleteMany`, not `classTemplate.deleteMany`: deleting only
    // the child leaves its `ScheduleRule` row orphaned and still live, holding
    // `(teacherId, dayOfWeek, slot)` against `ScheduleRule_teacher_slot_excl`
    // (issue 298) for the rest of the file — pre-branch, deleting the child
    // released the slot directly. `ClassTemplate` is `onDelete: Cascade` from
    // `ScheduleRule`, so this removes both.
    await prisma.scheduleRule.deleteMany({
      where: { id: { in: [templateA.scheduleRuleId, templateB.scheduleRuleId] } },
    });
  });

  it('archiving deletes the unbooked future window and reports the counts', async () => {
    const id = await newTemplate('Archive Counts', '02:00', ALT_DAY_3);
    // The POST generates a 4-week window; every class is unbooked.
    const before = await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } }, date: { gt: new Date() } } } });
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
      await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } }, date: { gt: new Date() } } } }),
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
    const id = await newTemplate('No Longer Bookable', '04:00', ALT_DAY_3);

    await fetch(`${BASE_URL}/api/class-templates/${id}?state=archived`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const stillBookable = await prisma.class.findMany({ where: { status: 'open', calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } }, date: { gte: today } } }, select: { calendarEntry: { select: { date: true } } } });
    // Today is deliberately spared by the archive rule (`date > now`), so only
    // a survivor dated after today would mean the withdrawal failed.
    expect(stillBookable.filter((c) => c.calendarEntry.date.getTime() > today.getTime())).toEqual([]);
  });

  it('pausing deletes nothing and reports the last scheduled class', async () => {
    const id = await newTemplate('Pause Counts', '06:00', ALT_DAY_3);
    const before = await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } } });

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
    expect(data.lastScheduled?.startTime).toBe('06:00');
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } } })).toBe(before);
  });

  it('rejects a PATCH with no state parameter', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('No State', '08:00', ALT_DAY_1)),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(400);

    // The row is untouched — a rejected request must not have toggled anything.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(true);
  });

  it('rejects an unrecognised state value', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Bad State', '14:00', ALT_DAY_1)),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=sideways`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(400);

    // Same guarantee as the no-state case above — an unrecognised value is
    // rejected whole, not partially applied.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(true);
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
      body: JSON.stringify(templateBody('Twice Paused', '16:00', ALT_DAY_1)),
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

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(false);
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
      body: JSON.stringify(templateBody('Twice Archived', '00:00', ALT_DAY_2)),
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

    const survivors = await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } } });

    const second = await archive();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } } })).toBe(survivors);
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
      body: JSON.stringify(templateBody('Twice Active', '02:00', ALT_DAY_2)),
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

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(true);
  });

  it('is idempotent: un-archiving twice leaves the template un-archived', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Twice Unarchived', '04:00', ALT_DAY_2)),
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

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(false);
  });

  // Task 6b (#196). `ScheduleRule_teacher_slot_excl` refuses a live overlap
  // WHERE isArchived = false — un-archiving is the one transition that
  // re-enters that scope, so a shelved template can now collide with a live
  // one holding the same slot.
  it('refuses to un-archive into a slot another live template already holds', async () => {
    const live = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Unarchive Slot Live', '06:00', ALT_DAY_2)),
    });
    expect(live.status).toBe(201);

    const shelved = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId, kind: 'regular', classType: 'Unarchive Slot Shelved', dayOfWeek: ALT_DAY_2,
            startTime: hhmmToTime('06:00'), durationMinutes: 60, isArchived: true, isActive: false,
          },
        },
        teacherRoom: { connect: { id: teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });

    const res = await fetch(`${BASE_URL}/api/class-templates/${shelved.id}?state=unarchived`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('DUPLICATE_TEMPLATE_SLOT');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: shelved.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(true);
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
 * `class-generator.test.ts` unit test ("answers busy when the generation
 * claim holds the row past the lock timeout (template edit)") pins the
 * *service* outcome but
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
          scheduleRule: {
            create: {
              teacherId, kind: 'regular', classType: 'Busy Archive', dayOfWeek: ALT_DAY_2,
              startTime: hhmmToTime('08:00'), durationMinutes: 60,
            },
          },
          teacherRoom: { connect: { id: teacherRoomId } },
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
        const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
        expect(after.scheduleRule.isArchived).toBe(false);
        expect(after.scheduleRule.archivedAt).toBeNull();
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
          scheduleRule: {
            create: {
              teacherId, kind: 'regular', classType: 'Busy Pause', dayOfWeek: ALT_DAY_2,
              startTime: hhmmToTime('14:00'), durationMinutes: 60,
            },
          },
          teacherRoom: { connect: { id: teacherRoomId } },
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

        const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
        expect(after.scheduleRule.isActive).toBe(true);
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
          scheduleRule: {
            create: {
              teacherId, kind: 'regular', classType: 'Busy PUT', dayOfWeek: ALT_DAY_3,
              startTime: hhmmToTime('00:00'), durationMinutes: 60,
            },
          },
          teacherRoom: { connect: { id: teacherRoomId } },
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
        const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
        expect(after.scheduleRule.classType).toBe('Busy PUT');
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
  const createTemplate = async (
    classType: string,
    startTime: string,
    dayOfWeek: number = DAY_OF_WEEK,
  ): Promise<string> => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody(classType, startTime, dayOfWeek)),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    return data.id;
  };

  // Door 5's tests (below) need a *second* room for the same teacher — the
  // move target — and `seedTeacher` only ever creates one. Local rather than
  // folded into `seedTeacher` itself: every other case in this file needs
  // exactly one room, and a second would be dead weight there.
  const addSecondRoom = async (
    ownerTeacherId: string,
    label: string,
    isArchived: boolean,
  ): Promise<{ roomId: string; teacherRoomId: string }> => {
    const room = await prisma.room.create({
      data: {
        venueName: `${label} Venue 2`,
        address: `${suffix} ${label} St 2`,
        city: 'Testville',
        postcode: '1234TP',
        floor: '2',
        roomName: 'Attic',
        maxCapacity: 10,
        createdById: ownerTeacherId,
      },
    });
    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId: ownerTeacherId,
        roomId: room.id,
        capacityOverride: 8,
        rentalRate: 15,
        isArchived,
      },
    });
    return { roomId: room.id, teacherRoomId: teacherRoom.id };
  };

  // Rule 1 of #194, at the level a teacher experiences it: the template is a
  // stamp, so the edit lands on the template row and NOTHING else. This case
  // is the inverse of the one it replaces, which asserted every unbooked
  // future instance had been rewritten to match — the behaviour
  // `syncTemplateInstances` provided and #194 deleted.
  //
  // Asserted over ALL instances, not the `date > now` subset the old case
  // used. That filter existed because the sync only reached future rows; with
  // nothing propagating there is no boundary left to respect, and the wider
  // set is the stronger claim.
  it('updates the template and leaves every generated instance untouched', async () => {
    const id = await createTemplate('Editable Flow', '08:00', ALT_DAY_3);

    const before = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(before.length).toBeGreaterThan(0);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ classType: 'Renamed Flow', durationMinutes: 75 }),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { classType: string; durationMinutes: number };
    };
    expect(data.classType).toBe('Renamed Flow');
    expect(data.durationMinutes).toBe(75);
    // The success body is the bare template — no propagation report rides
    // along with it any more, and a re-added one fails here.
    expect(data).not.toHaveProperty('sync');

    const after = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(after.every((c) => c.calendarEntry.classType === 'Editable Flow')).toBe(true);
    expect(after.every((c) => c.calendarEntry.durationMinutes === 60)).toBe(true);
  });

  // Step 7 of #194's task 4, stated as the field-by-field identity claim
  // rather than as "nothing changed": one PUT carrying a schedule field
  // (`startTime`) and an economic one (`roomCost`) together, because the
  // deleted sync treated those two families differently — same-day instances
  // had their `startTime` rewritten, and unbooked ones had their economics
  // rewritten — and a partial revival would show up in only one of them.
  //
  // `roomCost` compared through `.toString()`: Prisma returns `Decimal`
  // objects, and `toEqual` on two of those passes on structural equality of
  // the internal representation rather than on the number, which is not the
  // claim being made here.
  it('a PUT changing startTime and roomCost leaves every generated class byte-identical', async () => {
    // '15:00' and '17:00' are BOTH this case's, and both must stay unused by
    // every sibling: it creates on the first and moves the template onto the
    // second, so a case that already holds '17:00' turns this into a
    // `slot_conflict` 409 rather than the 200 it is asserting. Both stay on
    // the shared DAY_OF_WEEK — nothing here reads the template's weekday —
    // spaced two hours past 'Instant Flow' (09:30) and 'Day Shift' (12:00),
    // the file's other two permanent DAY_OF_WEEK occupants.
    const id = await createTemplate('Stamp Not Link', '15:00');

    const before = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((c) => timeToHHmm(c.calendarEntry.startTime) === '15:00')).toBe(true);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ startTime: '17:00', roomCost: 99 }),
    });
    expect(res.status).toBe(200);

    const template = await prisma.classTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(timeToHHmm(template.scheduleRule.startTime)).toBe('17:00');
    expect(template.roomCost.toString()).toBe('99');

    const after = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(
      after.map((c) => ({
        id: c.id,
        startTime: c.calendarEntry.startTime,
        roomCost: c.roomCost.toString(),
        date: c.calendarEntry.date.toISOString(),
        teacherRoomId: c.teacherRoomId,
      })),
    ).toEqual(
      before.map((c) => ({
        id: c.id,
        startTime: c.calendarEntry.startTime,
        roomCost: c.roomCost.toString(),
        date: c.calendarEntry.date.toISOString(),
        teacherRoomId: c.teacherRoomId,
      })),
    );
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
    const id = await createTemplate('No Fields', '14:00', ALT_DAY_3);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.classType).toBe('No Fields');
  });

  it("refuses to edit another teacher's template", async () => {
    const id = await createTemplate('Not Yours', '16:00', ALT_DAY_3);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(otherSessionToken) },
      body: JSON.stringify({ classType: 'Hijacked' }),
    });
    expect(res.status).toBe(403);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.classType).toBe('Not Yours');
  });

  // This is the runtime behaviour every compile-time pin's reasoning rests on:
  // an undeclared key is a 400, so the ONLY way a forbidden column reaches
  // Prisma is by being declared in the schema — a source edit, which the pins
  // catch. If this test ever fails, the pins are guarding the wrong thing.
  it('rejects an undeclared key — the schema is strict', async () => {
    const id = await createTemplate('Strict Flow', '00:00', ALT_DAY_4);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ classType: 'Renamed', isActive: false }),
    });
    expect(res.status).toBe(400);

    // Rejected whole: the declared field is not written either.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.classType).toBe('Strict Flow');
    expect(after.scheduleRule.isActive).toBe(true);
  });

  it("refuses a teacherRoom belonging to another teacher", async () => {
    const id = await createTemplate('Room Guard', '02:00', ALT_DAY_4);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ teacherRoomId: otherTeacherRoomId }),
    });
    expect(res.status).toBe(400);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });

  // Body parsing now runs before the exists/ownership checks, because the
  // service owns those and needs typed data to be called at all. So a
  // malformed body against someone else's template is a 400, not the 403 the
  // pre-service handler returned. Deliberate, and not an information leak: the
  // cheap probe is `{}`, which parses fine and still yields 403 (see the case
  // above), so this ordering tells a prober strictly less, not more.
  it('rejects a malformed body before revealing that the template is not yours', async () => {
    const id = await createTemplate('Order Guard', '04:00', ALT_DAY_4);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(otherSessionToken) },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(400);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.classType).toBe('Order Guard');
    expect(after.scheduleRule.isActive).toBe(true);
  });

  // `dayOfWeek` was the most destructive field on the allowlist: changing it
  // made `syncTemplateInstances` DELETE the mutable instances sitting on the
  // superseded day — waitlists cascading with them — and refill on the new
  // one. #194 deleted that mechanism, and this case is the inverse of the one
  // that pinned it: the old day's classes stay exactly where they are.
  //
  // The most important single assertion in this file for #194. A teacher who
  // moves their Tuesday class to Thursday keeps every Tuesday class already
  // on the schedule; they cancel the ones they do not want, individually, and
  // the generator lays the Thursdays down from the next free week (task 5).
  // Nothing about that is reachable from this endpoint any more.
  it('a dayOfWeek change deletes nothing and moves nothing', async () => {
    const id = await createTemplate('Day Shift', '12:00');

    const before = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((c) => c.calendarEntry.date.getUTCDay() === EXPECTED_JS_DAY)).toBe(true);

    const NEW_DAY_OF_WEEK = (DAY_OF_WEEK + 2) % 7; // still schema convention, a different weekday

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ dayOfWeek: NEW_DAY_OF_WEEK }),
    });
    expect(res.status).toBe(200);

    const template = await prisma.classTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(template.scheduleRule.dayOfWeek).toBe(NEW_DAY_OF_WEEK);

    // Same rows, same ids, still on the OLD weekday. Asserted over every
    // instance rather than the `date > now` subset the deleted sync was
    // scoped to: with nothing propagating there is no boundary left to
    // respect. No refill either — the PUT does not generate, so the count is
    // unchanged rather than merely non-zero.
    const after = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(after.every((c) => c.calendarEntry.date.getUTCDay() === EXPECTED_JS_DAY)).toBe(true);
  });

  /**
   * The claim the whole probe exists to make (#194): the week the PUT's
   * confirmation names is the week the sweep actually fills. Asserted across
   * the seam — an HTTP PUT for the prediction, `generateInstancesForTemplate`
   * for the behaviour — because a unit test of either half can only prove that
   * half agrees with itself.
   *
   * `sameWeekDayPair` for the two weekdays, not the file's shared
   * `(DAY_OF_WEEK + 2) % 7`: this case's premise is that every week the
   * generator can see is already held, and that premise is false on two days
   * of the week with the shared pair. See that function.
   */
  it('names the week the generator then fills, and no earlier one', async () => {
    const [OLD_DAY, NEW_DAY] = sameWeekDayPair();

    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ ...templateBody('Effective Week', '01:00'), dayOfWeek: OLD_DAY }),
    });
    expect(create.status).toBe(201);
    const { data: created } = (await create.json()) as { data: { id: string } };
    const id = created.id;

    const before = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(before.length).toBe(4);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ dayOfWeek: NEW_DAY }),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as { data: { firstEffective: string | null } };
    // A week, not nothing: every week the generator can see is held, so the
    // honest answer is one the generator cannot see — which is the case a probe
    // sharing the generator's own four-week horizon gets wrong by answering
    // "no free week".
    // `typeof`, not `not.toBeNull()`: an absent field is `undefined`, which is
    // not null, so the weaker assertion passes on exactly the route this case
    // exists to catch and leaves the whole verdict to the lines below.
    expect(typeof data.firstEffective).toBe('string');
    const predicted = new Date(data.firstEffective as string);
    // A Monday, in UTC — the copy renders it as "the week starting <this>".
    expect(predicted.getUTCDay()).toBe(1);

    const template = await prisma.classTemplate.findUniqueOrThrow({
      where: { id },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    });

    // The sweep as it runs today. Its four-occurrence window is entirely held
    // by the superseded schedule, so it creates nothing — and the reason it
    // gives for each date is the one the copy layer surfaces.
    const today = await generateInstancesForTemplate(prisma, template);
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
    const later = await generateInstancesForTemplate(prisma, template, predicted);
    expect(later.created).toBeGreaterThan(0);

    const after = await prisma.class.findMany({ where: { id: { notIn: before.map((c) => c.id) }, calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
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

  /**
   * The probe's second half, and the reason it takes two reads: a week held by
   * this template is not the same fact as a single date whose SLOT is taken.
   *
   * `generateInstancesForTemplate` declines a date on five grounds (the
   * `SkipReason` union, `src/lib/generation.ts`), and three of them are the
   * template's own rows — `already_generated`, `blocked_by_cancelled` and
   * `already_this_week` all follow from a `templateId`-keyed read with no
   * status filter. `slot_taken` (#196) is somebody else's row entirely:
   * another non-cancelled class of the same teacher at the same
   * `(date, startTime)`. A probe that read only the template's own weeks
   * cannot see it, and gets the answer wrong in the DISHONEST direction — it
   * names a week EARLIER than the sweep will deliver. (The fifth, `raced`, is
   * a concurrent insert that has not happened yet at probe time; the probe's
   * docblock records why it is unreproducible and why erring later-than-
   * promised is the safe direction.)
   *
   * Reachable, and made more so by rule 1 of this very branch: template A
   * moves off Thursday 18:00 and leaves up to four Thursday 18:00 instances
   * standing, because an edit moves nothing. Template B is then edited onto
   * Thursday 18:00 — no `ClassTemplate` slot conflict, and B's own weeks are
   * empty — so an own-rows-only probe promises week 1 while the sweep skips
   * four weeks in a row. A single stray class in the slot does the same, and
   * is what this case builds.
   */
  it('skips a date another class already holds, exactly as the sweep does', async () => {
    const [OLD_DAY, NEW_DAY] = sameWeekDayPair();

    // The probe's own horizon, built with the probe's own function so the
    // arithmetic cannot drift: index 4 is week five, the date the previous
    // case proves would otherwise be named.
    const horizon = getNextOccurrences(NEW_DAY, new Date(), 8);
    const blocked = horizon[4]!;
    const nextAfterBlocked = horizon[5]!;

    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ ...templateBody('Slot Blocked Week', '03:00'), dayOfWeek: OLD_DAY }),
    });
    expect(create.status).toBe(201);
    const { data: created } = (await create.json()) as { data: { id: string } };
    const id = created.id;
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } } })).toBe(4);

    // Not this template's row — `templateId` stays null, which is the whole
    // point: it is invisible to a `scheduleRuleId`-keyed read and fatal to
    // the date all the same. Same teacher, overlapping span, not cancelled,
    // exactly the predicate `CalendarEntry_teacher_slot_excl` carries.
    await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Slot Blocker',
        date: blocked,
        startTime: hhmmToTime('03:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
        status: 'open',
      });

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ dayOfWeek: NEW_DAY }),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as { data: { firstEffective: string | null } };
    // `typeof`, not `not.toBeNull()`: an absent field is `undefined`, which is
    // not null, so the weaker assertion passes on exactly the route this case
    // exists to catch and leaves the whole verdict to the lines below.
    expect(typeof data.firstEffective).toBe('string');
    const predicted = new Date(data.firstEffective as string);

    // Week SIX, not week five. Stated as both halves — what it is and what it
    // is not — because the failure this guards against is off by exactly one
    // week and `not.toBe` alone would pass for any other wrong answer.
    expect(predicted.getTime()).toBe(mondayOf(nextAfterBlocked));
    expect(predicted.getTime()).not.toBe(mondayOf(blocked));

    const template = await prisma.classTemplate.findUniqueOrThrow({
      where: { id },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    });

    // The sweep, run from the week the probe passed over. It declines that
    // date for the reason the probe modelled, by name, and fills the one the
    // probe named instead — the two halves of "the sentence cannot disagree
    // with the sweep", asserted in a single run.
    const sweep = await generateInstancesForTemplate(prisma, template, new Date(mondayOf(blocked)));
    expect(sweep.skipped).toContainEqual({ date: blocked, reason: 'slot_taken' });

    const filled = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } }, date: { gte: new Date(mondayOf(blocked)) } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(filled.length).toBeGreaterThan(0);
    expect(mondayOf(filled[0]!.calendarEntry.date)).toBe(predicted.getTime());
  });

  /**
   * The FIRST read's ABSENT status filter, from the only direction that can
   * observe it: a cancelled class holds its week (#194, spec §3.2).
   *
   * The probe issues two reads a few lines apart and they disagree about
   * cancellation deliberately — the week read (keyed `scheduleRuleId`) carries
   * no liveness filter, the slot read (keyed `teacherId`, over the entry's
   * span) carries `cancelledAt: null`. Every other case in this file leaves
   * all four generated classes live, so neither half of that asymmetry is
   * observable anywhere: adding `cancelledAt: null` to the week read left the
   * whole suite green when it was mutated. This case is one missing half and
   * the case below is the other.
   *
   * Adding that filter is the likely future edit, because the two reads sit in
   * one `Promise.all` over one table and only one of them is filtered, so
   * "harmonising" them reads as tidying. It is the DISHONEST direction: the week it frees is one
   * the sweep still refuses — `already_this_week`, asserted below — so the PUT
   * would name a week no class ever lands in.
   *
   * Week ONE is the one cancelled, and weeks two to four are left live, so the
   * two answers are four weeks apart rather than adjacent. A failure here
   * therefore cannot be misread as an off-by-one in `mondayOf`, in
   * `getNextOccurrences`, or in the past-start filter.
   */
  it('holds a week whose only class is cancelled, exactly as the sweep does', async () => {
    const [OLD_DAY, NEW_DAY] = sameWeekDayPair();

    // The probe's own horizon, built with the probe's own function so the
    // arithmetic cannot drift: index 4 is week five, the first week the
    // superseded schedule does not reach.
    const horizon = getNextOccurrences(NEW_DAY, new Date(), 8);
    const weekFive = horizon[4]!;

    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({
        ...templateBody('Cancelled Holds Week', '19:00'),
        dayOfWeek: OLD_DAY,
      }),
    });
    expect(create.status).toBe(201);
    const { data: created } = (await create.json()) as { data: { id: string } };
    const id = created.id;

    const before = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(before.length).toBe(4);

    // Cancelled, not deleted, and cancelled through the one column the two
    // reads disagree about. `@@unique([scheduleRuleId, date])` carries no
    // liveness, so this row still holds its DATE for good (#192); what is
    // under test is that it also still holds its WEEK.
    const cancelled = before[0]!;
    await prisma.calendarEntry.updateMany({ where: { classes: { some: { id: cancelled.id } } }, data: { cancelledAt: new Date() } });

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ dayOfWeek: NEW_DAY }),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as { data: { firstEffective: string | null } };
    // `typeof`, not `not.toBeNull()`: an absent field is `undefined`, which is
    // not null, so the weaker assertion passes on exactly the route this case
    // exists to catch and leaves the whole verdict to the lines below.
    expect(typeof data.firstEffective).toBe('string');
    const predicted = new Date(data.firstEffective as string);

    // Both halves — what it is and what it is not — because a status-filtered
    // week read produces one specific wrong answer and `not.toBe` alone would
    // accept every other one.
    expect(predicted.getTime()).toBe(mondayOf(weekFive));
    expect(predicted.getTime()).not.toBe(mondayOf(cancelled.calendarEntry.date));

    const template = await prisma.classTemplate.findUniqueOrThrow({
      where: { id },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    });

    // The sweep as it runs today, over those same four weeks. Week one comes
    // back `already_this_week` and NOT `blocked_by_cancelled`: the cancelled
    // row sits on the OLD weekday, so it is not on the candidate DATE at all.
    // It is the WEEK it still holds, which is exactly the fact the probe's
    // first read has to reproduce.
    const today = await generateInstancesForTemplate(prisma, template);
    expect(today.created).toBe(0);
    expect(today.skipped.map((s) => s.reason)).toEqual([
      'already_this_week',
      'already_this_week',
      'already_this_week',
      'already_this_week',
    ]);

    // And the week the sentence named is the week the sweep then fills.
    const later = await generateInstancesForTemplate(prisma, template, predicted);
    expect(later.created).toBeGreaterThan(0);
    const after = await prisma.class.findMany({ where: { id: { notIn: before.map((c) => c.id) }, calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(mondayOf(after[0]!.calendarEntry.date)).toBe(predicted.getTime());
  });

  /**
   * The SECOND read's PRESENT status filter — the same asymmetry from the
   * other side, and the reason it is an asymmetry rather than an
   * inconsistency.
   *
   * `CalendarEntry_teacher_slot_excl` is PARTIAL (`WHERE "cancelledAt" IS
   * NULL`), so a cancelled entry takes no slot and the slot read mirrors that
   * predicate rather than the week read beside it. Delete
   * `cancelledAt: null` from it and the whole suite stays green — mutated and
   * measured — because the slot case above puts a LIVE class in the blocked
   * slot and nothing anywhere puts a cancelled one there.
   *
   * Wrong in the OPPOSITE direction to its sibling above, which is what makes
   * it look harmless: an unfiltered slot read names a LATER week than the
   * sweep delivers. That is the safe direction for a race, where the sweep
   * corrects itself an hour later, and the wrong answer for a fact — the class
   * arrives in week five, the teacher was told week six, and nothing ever
   * revisits the sentence.
   */
  it('leaves a slot whose only class is cancelled free, exactly as the sweep does', async () => {
    const [OLD_DAY, NEW_DAY] = sameWeekDayPair();

    const horizon = getNextOccurrences(NEW_DAY, new Date(), 8);
    const weekFive = horizon[4]!;
    const weekSix = horizon[5]!;

    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({
        ...templateBody('Cancelled Frees Slot', '21:00'),
        dayOfWeek: OLD_DAY,
      }),
    });
    expect(create.status).toBe(201);
    const { data: created } = (await create.json()) as { data: { id: string } };
    const id = created.id;
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } } })).toBe(4);

    // Somebody else's row in week five's slot: same teacher, same date, same
    // startTime, `templateId` null — every column the live blocker in the case
    // above has, differing only in the one the read filters on. The partial
    // index does not cover it, so it holds nothing.
    await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Cancelled Slot Blocker',
        date: weekFive,
        startTime: hhmmToTime('21:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
        status: 'open',
        cancelledAt: new Date(),
      });

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ dayOfWeek: NEW_DAY }),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as { data: { firstEffective: string | null } };
    // `typeof`, not `not.toBeNull()`: an absent field is `undefined`, which is
    // not null, so the weaker assertion passes on exactly the route this case
    // exists to catch and leaves the whole verdict to the lines below.
    expect(typeof data.firstEffective).toBe('string');
    const predicted = new Date(data.firstEffective as string);

    // Week five, not week six. Both halves again, and the wrong answer here is
    // the adjacent week, which is why the second assertion names it.
    expect(predicted.getTime()).toBe(mondayOf(weekFive));
    expect(predicted.getTime()).not.toBe(mondayOf(weekSix));

    const template = await prisma.classTemplate.findUniqueOrThrow({
      where: { id },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    });

    // The sweep, run from week five's Monday and NOT from `predicted` — this
    // half must stay true whatever the sentence said, since it is what makes a
    // sentence naming week six a lie. It declines nothing: the cancelled row
    // is invisible to the generator's own `status !== 'cancelled'` slot
    // pre-check for the same reason it is invisible to the probe's.
    const fromWeekFive = new Date(mondayOf(weekFive));
    const sweep = await generateInstancesForTemplate(prisma, template, fromWeekFive);
    expect(sweep.skipped).toEqual([]);
    expect(sweep.created).toBe(4);

    const filled = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } }, date: { gte: fromWeekFive } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(filled.length).toBeGreaterThan(0);
    expect(filled[0]!.calendarEntry.date.getTime()).toBe(weekFive.getTime());
  });

  // updateClassTemplate has no isArchived/isActive guard of its own, so
  // whether an archived template can be edited at all is current behaviour,
  // not a documented decision — pin it here rather than leave it assumed.
  //
  // The write below is a dayOfWeek change specifically, because that was the
  // one field whose sync could, in principle, materialize new bookable
  // classes, via a delete-then-refill this endpoint no longer performs at
  // all (#194). The guarantee this case exists for outlives the mechanism it
  // was written against and is now over-determined: editing a shelved
  // template cannot materialize classes, because no edit materializes
  // classes. Kept rather than deleted precisely for that reason — it fails
  // if the PUT ever starts generating again, from any direction.
  it('editing an archived template materializes no classes', async () => {
    // ALT_DAY_4 is unavoidably today (see the ALT_DAY docblock) and today's
    // occurrence survives archiving's `date > today` withdrawal by design —
    // that would make this case fail to prove what it claims on its own
    // fixture's day. ALT_DAY_5 is only one day out, which this file's own
    // top-of-file rule ("two clears any zone") says is not enough on its
    // own — it only reads as tomorrow-for-the-teacher because this file
    // pins `defaultTimezone: 'UTC'` (`seedTeacher`). ALT_DAY_1 is three days
    // out, clearing that margin outright with no dependency on the pin.
    const id = await createTemplate('Shelved Flow', '06:00', ALT_DAY_1);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } } })).toBeGreaterThan(0);

    const archive = await fetch(`${BASE_URL}/api/class-templates/${id}?state=archived`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(archive.status).toBe(200);
    // #86: archiving already withdrew the future unbooked window.
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } } })).toBe(0);

    const NEW_DAY_OF_WEEK = (DAY_OF_WEEK + 2) % 7;
    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ dayOfWeek: NEW_DAY_OF_WEEK }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } } })).toBe(0);

    // And the confirmation must not promise one either (#194). This is the
    // sharpest form of the ungated probe: archiving deleted the future window,
    // so nothing holds a week, so an ungated probe answers with the EARLIEST
    // date it has — this week's Monday — for the one template guaranteed to
    // generate nothing. `generationState` is what lets the copy say
    // "un-archive and resume", the only remedy that works: both archive
    // directions force `isActive: false`, so un-archiving alone puts nothing
    // back.
    const { data } = (await res.json()) as {
      data: { firstEffective: string | null; generationState: string };
    };
    expect(data.firstEffective).toBeNull();
    expect(data.generationState).toBe('archived');
  });

  /**
   * The paused half of the same gate, over HTTP (#194).
   *
   * `/settings/recurring/[id]` renders the edit form for a paused recurring
   * class exactly as for a live one — the only conditional on that page picks
   * which toggle button to show — and `template-list.tsx` links there from
   * both the paused and the archived sections. So this is not an exotic
   * request: it is what a teacher who paused for the summer and then moved
   * their class to Thursdays sends.
   *
   * The template keeps its four generated classes here, unlike the archived
   * case above, which is what makes the two worth separating: an ungated probe
   * reads those four held weeks and names week FIVE — a specific, plausible,
   * checkable date, for a week the sweep will never reach. Wrong in the
   * dishonest direction and impossible for the teacher to tell from a correct
   * answer.
   */
  it('names no week for a paused template, and says which state it is in', async () => {
    const id = await createTemplate('Paused Edit', '08:00', ALT_DAY_4);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } } })).toBe(4);

    const pause = await fetch(`${BASE_URL}/api/class-templates/${id}?state=paused`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(pause.status).toBe(200);
    // Pausing deletes nothing — the four weeks the ungated probe would read
    // are still held.
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } } })).toBe(4);

    const NEW_DAY_OF_WEEK = (DAY_OF_WEEK + 2) % 7;
    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ dayOfWeek: NEW_DAY_OF_WEEK }),
    });
    // The edit still succeeds. The gate is on the PREDICTION, not on the
    // write: this PUT is deliberately open to a paused template.
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { dayOfWeek: number; firstEffective: string | null; generationState: string };
    };
    expect(data.dayOfWeek).toBe(NEW_DAY_OF_WEEK);
    expect(data.firstEffective).toBeNull();
    expect(data.generationState).toBe('paused');
  });

  /**
   * `alreadyThisWeek` is only ever asserted at ZERO across the two hops that
   * carry it (#194), and that is the trap this repo has already paid for once.
   *
   * The count travels generator → `countSkipReasons` →
   * `pauseOrResumeTemplate`'s `active` arm → the PATCH body → `resumeMessage`.
   * Every resume fixture in the suite leaves it at 0 alongside a `slotTaken`
   * of 0, so mis-wiring `alreadyThisWeek: result.slotTaken` at either hop
   * passes `tsc` and every test — exactly the shape recorded at
   * `template-action-messages.ts`, where transposing two arguments at a call
   * site stayed green *because every fixture passed equal numbers*, and the
   * fix was to make at least one case use unequal ones. It reappeared one
   * count over, inside the branch that added the count.
   *
   * So this case drives an UNEQUAL, NON-ZERO value the whole way: four dates
   * declined for `already_this_week` and none for anything else. The counts
   * are asserted one at a time rather than as a shape, because it is their
   * differing from each other that carries the guarantee.
   *
   * `sameWeekDayPair()` for the two weekdays, not the file's shared
   * `(DAY_OF_WEEK + 2) % 7`: the premise is that the four weeks the old day
   * generated are exactly the four the generator next considers for the new
   * day, and the shared pair breaks that on two days of the week.
   *
   * The resume is what a teacher actually does after moving a paused class,
   * and the sentence it produces — "4 classes on your schedule. 4 dates are
   * still held by classes on your previous day." — is the whole reason the
   * count is carried: without it the same request read "4 classes on your
   * schedule. Nothing needed adding." about four classes on the weekday the
   * teacher had just abandoned.
   */
  it('carries a non-zero alreadyThisWeek, distinct from slotTaken, to the PATCH body', async () => {
    const [OLD_DAY, NEW_DAY] = sameWeekDayPair();

    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ ...templateBody('Week Held Resume', '23:00'), dayOfWeek: OLD_DAY }),
    });
    expect(create.status).toBe(201);
    const { data: created } = (await create.json()) as { data: { id: string } };
    const id = created.id;
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } } })).toBe(4);

    const pause = await fetch(`${BASE_URL}/api/class-templates/${id}?state=paused`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(pause.status).toBe(200);

    // The edit that makes the four standing classes wrong-day: it moves the
    // template and, since #194, moves nothing else.
    const put = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ dayOfWeek: NEW_DAY }),
    });
    expect(put.status).toBe(200);

    const resume = await fetch(`${BASE_URL}/api/class-templates/${id}?state=active`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(resume.status).toBe(200);
    const { data: resumed } = (await resume.json()) as {
      data: {
        scheduled: number;
        added: number;
        counts: { blockedByCancelled: number; slotTaken: number; alreadyThisWeek: number };
      };
    };

    // Non-zero, and different from every other count on the body. A hop wired
    // to `slotTaken`, `blockedByCancelled` or `added` reports 0 here.
    expect(resumed.counts.alreadyThisWeek).toBe(4);
    expect(resumed.counts.slotTaken).toBe(0);
    expect(resumed.counts.blockedByCancelled).toBe(0);
    // Nothing was created: all four candidate weeks are held by the old day's
    // classes, which is the state that produces the count above.
    expect(resumed.added).toBe(0);
    expect(resumed.scheduled).toBe(4);
    // And the classes really are still on the old weekday — the count means
    // what its clause says it means.
    const still = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, include: { calendarEntry: true } });
    expect(still.length).toBe(4);
    expect(still.every((c) => c.calendarEntry.date.getUTCDay() === (OLD_DAY + 1) % 7)).toBe(true);
  });

  // Task 6b (#196). `ScheduleRule_teacher_slot_excl` — a single exclusion
  // constraint spanning both class families now, in place of the partial
  // unique index this comment used to name — constrains every write, not
  // just creates, so moving a template's own dayOfWeek/startTime onto a slot
  // another of the teacher's live templates already holds collides here
  // exactly as a create into that slot does.
  it('refuses a dayOfWeek/startTime change onto a slot another live template already holds', async () => {
    await createTemplate('PUT Slot Occupant', '14:00', ALT_DAY_4);
    const moverId = await createTemplate('PUT Slot Mover', '16:00', ALT_DAY_4);

    const res = await fetch(`${BASE_URL}/api/class-templates/${moverId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ startTime: '14:00' }),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('DUPLICATE_TEMPLATE_SLOT');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: moverId }, include: { scheduleRule: true } });
    expect(timeToHHmm(after.scheduleRule.startTime)).toBe('16:00');
  });

  // The inverse of the `sync_conflict` case that stood here (#196, #209).
  // There used to be a second, independent way this PUT could raise P2002:
  // not the template's own slot key, but the sync's propagation of the new
  // `startTime` onto its still-mutable generated `Class` rows, landing one of
  // them on a slot an unrelated class already occupied
  // (`Class_teacher_slot_unique`). That collision refused the whole edit —
  // the template's own `startTime` included — and answered
  // `TEMPLATE_SYNC_SLOT_CONFLICT`.
  //
  // #194 deleted the propagation, so this PUT writes no `Class` row and that
  // index could not be reached from here; #327 then dropped the index itself,
  // its columns having left the table. The teacher's experience is the point
  // of keeping the fixture: an unrelated draft sitting at 01:00 on one of the
  // generated dates no longer blocks them from moving their recurring class
  // to 01:00. Their existing classes stay at 00:00 next to it, and they move
  // or cancel the ones they want moved.
  //
  // Deliberately NOT merged into the `slot_conflict` case above. That one is
  // the template's own `ScheduleRule_teacher_slot_excl` and still 409s; this
  // one is a `Class` row and now succeeds. Two different constraints, two
  // different outcomes — a single "startTime collision" test would hide that
  // one of the two stopped being a collision at all.
  it('allows a startTime change onto a slot only a generated instance would have collided with', async () => {
    const id = await createTemplate('Sync Slot Template', '00:00', ALT_DAY_5);
    const instances = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(instances.length).toBeGreaterThan(0);
    const targetDate = instances[0]!.calendarEntry.date;

    // Unrelated to the template: a standalone class already sitting at the
    // (date, startTime) the template's startTime change will try to move its
    // own same-day instance onto.
    await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Sync Slot Blocker',
        date: targetDate,
        startTime: hhmmToTime('01:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
        status: 'draft',
      });

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ startTime: '01:00' }),
    });
    expect(res.status).toBe(200);

    // The template moved, which is the half that used to be rolled back.
    const template = await prisma.classTemplate.findUniqueOrThrow({ where: { id }, include: { scheduleRule: true } });
    expect(timeToHHmm(template.scheduleRule.startTime)).toBe('01:00');

    // And the generated instance did not, which is why there was nothing to
    // collide with. Both halves asserted: "the PUT returned 200" alone would
    // also be satisfied by a propagation that happened to find the slot free.
    const instance = await prisma.class.findUniqueOrThrow({ where: { id: instances[0]!.id }, include: { calendarEntry: true } });
    expect(timeToHHmm(instance.calendarEntry.startTime)).toBe('00:00');
  });

  // Door 5 of the room archive lifecycle (issue 76, fix round 2):
  // `updateClassTemplate` validated only that the target room belonged to the
  // teacher, never whether it was archived. The door was written when this
  // PUT could relocate every future non-`settingsLocked` `draft`/`open`
  // instance onto a room the teacher had shelved; #194 deleted that
  // relocation, and the door still stands on the half that never depended on
  // it — the generator would keep producing new classes there. Issue 272
  // moved the refusal to the route's pre-check plus the constraint itself
  // (`ClassTemplate_live_needs_open_room`); the wire contract below is
  // unchanged and is what the pre-check is pinned against.
  // A dedicated `seedTeacher` fixture rather than the shared `teacherRoomId`
  // dozens of other tests in this file reuse: archiving it here would affect
  // them, and door 5 needs a second room besides.
  it('refuses to move an active template onto an archived room, and relocates nothing', async () => {
    const owner = await seedTeacher('move-archived');
    let archivedRoomId = '';
    try {
      const archived = await addSecondRoom(owner.teacherId, 'move-archived', true);
      archivedRoomId = archived.roomId;

      const create = await fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({
          teacherRoomId: owner.teacherRoomId,
          classType: 'Move Target',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:52',
          durationMinutes: 60,
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 8,
        }),
      });
      expect(create.status).toBe(201);
      const { data: template } = (await create.json()) as { data: { id: string } };
      const before = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } }, include: { calendarEntry: true } });
      expect(before.length).toBeGreaterThan(0);
      expect(before.every((c) => c.teacherRoomId === owner.teacherRoomId)).toBe(true);

      const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({ teacherRoomId: archived.teacherRoomId }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('ROOM_ARCHIVED');
      expect(body.error.message).toBe(
        'This room is archived. Unarchive it to move this recurring class here.',
      );

      // Not the 409 alone: the template's own room must be unchanged...
      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
      expect(after.teacherRoomId).toBe(owner.teacherRoomId);

      // ...and — the assertion a guard placed after the transaction, rather
      // than before it, would not catch — no future instance was relocated
      // onto the archived room either.
      const instancesAfter = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } }, include: { calendarEntry: true } });
      expect(instancesAfter.every((c) => c.teacherRoomId === owner.teacherRoomId)).toBe(true);
      expect(instancesAfter.some((c) => c.teacherRoomId === archived.teacherRoomId)).toBe(false);
    } finally {
      // Same FK-safe order as this file's own afterAll: class → classTemplate
      // → teacherRoom → room → session → teacher → account. One
      // `teacherRoom.deleteMany` clears both this teacher's rooms' links.
      await prisma.calendarEntry.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.room.delete({ where: { id: owner.roomId } });
      if (archivedRoomId) await prisma.room.delete({ where: { id: archivedRoomId } });
      await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
      await prisma.teacher.delete({ where: { id: owner.teacherId } });
      await prisma.account.delete({ where: { id: owner.accountId } });
    }
  });

  // 272 changed the active-half gate this case used to pin, and the change is
  // the test. The old door 5 refused EVERY move onto an archived room,
  // reasoning that a paused template is one resume away from generating. When
  // the move synced instances that reasoning was literal — the relocation
  // would carry four `open` classes onto a shelved room, and the case proved
  // it was refused. #194 deleted the sync; the gate stayed out of inertia.
  // Post-272 the refusal lives in `ClassTemplate_live_needs_open_room`, which
  // keys on `ruleLive`: a paused template has `ruleLive` false, so moving it
  // onto an archived room is a REPOINT of a generator that is not generating —
  // nothing is created there (door 3's resume-409 test below closes the one
  // way the commitment comes back). This is the safe direction and now answers
  // 200. What it must still never do is carry the generated instances: #194
  // guarantees that by absence, asserted below.
  it('allows moving a paused template onto an archived room, and still relocates nothing', async () => {
    const owner = await seedTeacher('move-archived-paused');
    let archivedRoomId = '';
    try {
      const archived = await addSecondRoom(owner.teacherId, 'move-archived-paused', true);
      archivedRoomId = archived.roomId;

      const create = await fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({
          teacherRoomId: owner.teacherRoomId,
          classType: 'Paused Move',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:53',
          durationMinutes: 60,
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 8,
        }),
      });
      expect(create.status).toBe(201);
      const { data: template } = (await create.json()) as { data: { id: string } };

      const pause = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=paused`, {
        method: 'PATCH',
        headers: cookie(owner.sessionToken),
      });
      expect(pause.status).toBe(200);

      const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({ teacherRoomId: archived.teacherRoomId }),
      });

      expect(res.status).toBe(200);

      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
      expect(after.teacherRoomId).toBe(archived.teacherRoomId);

      // The assertion whose absence hid the defect, carried forward from the
      // active-move sibling without the 409: the generator is stopped, so the
      // instances it generated before the pause stay where it made them.
      const instancesAfter = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } }, include: { calendarEntry: true } });
      expect(instancesAfter.length).toBeGreaterThan(0);
      expect(instancesAfter.some((c) => c.teacherRoomId === archived.teacherRoomId)).toBe(false);
    } finally {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.room.delete({ where: { id: owner.roomId } });
      if (archivedRoomId) await prisma.room.delete({ where: { id: archivedRoomId } });
      await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
      await prisma.teacher.delete({ where: { id: owner.teacherId } });
      await prisma.account.delete({ where: { id: owner.accountId } });
    }
  });

  // Door 3 of the room archive lifecycle (issue 76) at the wire. Issue 272
  // moved the refusal out of the service into the constraint, which the PATCH
  // handler's pre-check/catch translate back into the exact 409 this test
  // pins — same status, same code, same copy. The fixture has to pause the
  // template and THEN archive its room, because under the migration only a
  // PAUSED template may sit on an archived room at all: the resume-onto-
  // archived state is only reachable through the door-1b-legal sequence, which
  // is the one this test performs.
  it('still answers 409 ROOM_ARCHIVED when resuming onto an archived room', async () => {
    const owner = await seedTeacher('resume-archived');
    try {
      const create = await fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({
          teacherRoomId: owner.teacherRoomId,
          classType: 'Resume Refusal',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:55',
          durationMinutes: 60,
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 8,
        }),
      });
      expect(create.status).toBe(201);
      const { data: template } = (await create.json()) as { data: { id: string } };

      const pause = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=paused`, {
        method: 'PATCH',
        headers: cookie(owner.sessionToken),
      });
      expect(pause.status).toBe(200);

      await prisma.teacherRoom.update({
        where: { id: owner.teacherRoomId },
        data: { isArchived: true },
      });

      const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=active`, {
        method: 'PATCH',
        headers: cookie(owner.sessionToken),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('ROOM_ARCHIVED');
      expect(body.error.message).toBe(
        'This room is archived. Unarchive it to resume this recurring class.',
      );
    } finally {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.room.delete({ where: { id: owner.roomId } });
      await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
      await prisma.teacher.delete({ where: { id: owner.teacherId } });
      await prisma.account.delete({ where: { id: owner.accountId } });
    }
  });

  // OWNERSHIP OUTRANKS THE ARCHIVED STATE, on both verbs. Issue 272 hoisted
  // doors 3 and 5 out of the services and into route pre-checks, and the
  // services are where `forbidden` is decided — so a pre-check that answers
  // off a row it never checked ownership of reports another teacher's state.
  // Both cases below answered 409 before the probes learned to skip.
  //
  // What leaks without them is not the 409 itself but the discrimination: a
  // 409 means the id exists AND its room is archived, where 403 means only
  // "not yours". The service's own ordering was the guarantee; hoisting the
  // door copied the second half of it.
  it('answers 403, not ROOM_ARCHIVED, when the resumer does not own the template', async () => {
    const owner = await seedTeacher('resume-foreign');
    try {
      const create = await fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({
          teacherRoomId: owner.teacherRoomId,
          classType: 'Not Yours To Resume',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:57',
          durationMinutes: 60,
          roomCost: 15, minRate: 10, targetRate: 20, minStudents: 2, maxStudents: 8,
        }),
      });
      expect(create.status).toBe(201);
      const { data: template } = (await create.json()) as { data: { id: string } };

      const pause = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=paused`, {
        method: 'PATCH', headers: cookie(owner.sessionToken),
      });
      expect(pause.status).toBe(200);
      await prisma.teacherRoom.update({
        where: { id: owner.teacherRoomId }, data: { isArchived: true },
      });

      // The other teacher, against a template whose room IS archived — the
      // one state in which the pre-check has something to say.
      const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=active`, {
        method: 'PATCH', headers: cookie(otherSessionToken),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code?: string } };
      expect(body.error.code).not.toBe('ROOM_ARCHIVED');

      const after = await prisma.classTemplate.findUniqueOrThrow({
        where: { id: template.id }, include: { scheduleRule: true },
      });
      expect(after.scheduleRule.isActive).toBe(false);
    } finally {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.room.delete({ where: { id: owner.roomId } });
      await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
      await prisma.teacher.delete({ where: { id: owner.teacherId } });
      await prisma.account.delete({ where: { id: owner.accountId } });
    }
  });

  it('answers 403, not ROOM_ARCHIVED, when the mover does not own the template', async () => {
    const owner = await seedTeacher('move-foreign');
    let otherArchived: { roomId: string; teacherRoomId: string } | null = null;
    try {
      const create = await fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({
          teacherRoomId: owner.teacherRoomId,
          classType: 'Not Yours To Move',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:58',
          durationMinutes: 60,
          roomCost: 15, minRate: 10, targetRate: 20, minStudents: 2, maxStudents: 8,
        }),
      });
      expect(create.status).toBe(201);
      const { data: template } = (await create.json()) as { data: { id: string } };

      // The prober names a room they DO own and that IS archived, so the
      // target-room ownership check cannot be what refuses this — only the
      // template's own ownership can.
      otherArchived = await addSecondRoom(otherTeacherId, 'move-foreign-other', true);

      const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(otherSessionToken) },
        body: JSON.stringify({ teacherRoomId: otherArchived.teacherRoomId }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code?: string } };
      expect(body.error.code).not.toBe('ROOM_ARCHIVED');

      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
      expect(after.teacherRoomId).toBe(owner.teacherRoomId);
    } finally {
      if (otherArchived) {
        await prisma.teacherRoom.deleteMany({ where: { id: otherArchived.teacherRoomId } });
        await prisma.room.delete({ where: { id: otherArchived.roomId } });
      }
      await prisma.calendarEntry.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.room.delete({ where: { id: owner.roomId } });
      await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
      await prisma.teacher.delete({ where: { id: owner.teacherId } });
      await prisma.account.delete({ where: { id: owner.accountId } });
    }
  });

  // The ARCHIVED template's own refusal must outrank the room's. Both states
  // are true at once here, and only one of them names something the teacher
  // can act on: un-archiving the room leaves an archived template that still
  // will not resume. Reachable with no race at all — archive the template
  // first (door 1 counts only ACTIVE templates, so the room may then be
  // archived too), then ask to resume.
  it('names the archived template, not the archived room, when both are true', async () => {
    const owner = await seedTeacher('resume-both-archived');
    try {
      const create = await fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({
          teacherRoomId: owner.teacherRoomId,
          classType: 'Both Archived',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:59',
          durationMinutes: 60,
          roomCost: 15, minRate: 10, targetRate: 20, minStudents: 2, maxStudents: 8,
        }),
      });
      expect(create.status).toBe(201);
      const { data: template } = (await create.json()) as { data: { id: string } };

      const archiveTemplate = await fetch(
        `${BASE_URL}/api/class-templates/${template.id}?state=archived`,
        { method: 'PATCH', headers: cookie(owner.sessionToken) },
      );
      expect(archiveTemplate.status).toBe(200);

      await prisma.teacherRoom.update({
        where: { id: owner.teacherRoomId }, data: { isArchived: true },
      });

      const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=active`, {
        method: 'PATCH', headers: cookie(owner.sessionToken),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code?: string; message: string } };
      expect(body.error.message).toBe('Unarchive the template before activating it');
      expect(body.error.code).not.toBe('ROOM_ARCHIVED');
    } finally {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.room.delete({ where: { id: owner.roomId } });
      await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
      await prisma.teacher.delete({ where: { id: owner.teacherId } });
      await prisma.account.delete({ where: { id: owner.accountId } });
    }
  });

  // The `!== template.teacherRoomId` half of door 5, proven directly: without
  // it, this case 409s. `TemplateForm` posts the whole form on every edit, so
  // an unchanged `teacherRoomId` rides along with a pure description change —
  // and a template on an archived room (post-272 necessarily PAUSED — the
  // active-on-archived snapshot spec section 10 described is now refused by
  // the constraint itself, at the archive write) would otherwise answer this
  // 409 about a move the teacher did not make. The no-op must never write the
  // mirror either: the move gates on the CHANGE, so this edit touches only the
  // description, and it answers 200.
  it('allows a no-op room field on a template whose room is archived', async () => {
    const owner = await seedTeacher('move-archived-noop');
    try {
      const create = await fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({
          teacherRoomId: owner.teacherRoomId,
          classType: 'Noop Edit',
          dayOfWeek: DAY_OF_WEEK,
          startTime: '09:54',
          durationMinutes: 60,
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 8,
        }),
      });
      expect(create.status).toBe(201);
      const { data: template } = (await create.json()) as { data: { id: string } };

      // The same no-op-room shape with the room the teacher has actually
      // archived, reached the only way 272 allows: pause first, then archive.
      const pause = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=paused`, {
        method: 'PATCH',
        headers: cookie(owner.sessionToken),
      });
      expect(pause.status).toBe(200);

      await prisma.teacherRoom.update({
        where: { id: owner.teacherRoomId },
        data: { isArchived: true },
      });

      const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({
          teacherRoomId: owner.teacherRoomId,
          description: 'edited while the room is archived',
        }),
      });

      expect(res.status).toBe(200);
      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
      expect(after.description).toBe('edited while the room is archived');
      expect(after.teacherRoomId).toBe(owner.teacherRoomId);
    } finally {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.room.delete({ where: { id: owner.roomId } });
      await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
      await prisma.teacher.delete({ where: { id: owner.teacherId } });
      await prisma.account.delete({ where: { id: owner.accountId } });
    }
  });

  // The `[id]` route's own overlap case (issue 298) — the POST describe above
  // covers create; this covers the PUT that moves an existing template onto a
  // slot only overlapping, not matching, a studio template's.
  it('refuses a startTime change that OVERLAPS a studio template, not just an exact match', async () => {
    const owner = await seedTeacher('put-overlap-studio');
    try {
      await prisma.studioClassTemplate.create({
        data: {
          scheduleRule: {
            create: {
              teacherId: owner.teacherId, kind: 'studio', classType: 'PUT Overlap Studio',
              dayOfWeek: 4, startTime: hhmmToTime('10:00'), durationMinutes: 90,
            },
          },
          location: 'PUT Overlap Venue', hourlyRate: 40,
        },
      });
      const create = await fetch(`${BASE_URL}/api/class-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({
          teacherRoomId: owner.teacherRoomId,
          classType: 'PUT Overlap Class',
          dayOfWeek: 4,
          startTime: '13:00',
          durationMinutes: 60,
          roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
        }),
      });
      expect(create.status).toBe(201);
      const { data: template } = (await create.json()) as { data: { id: string } };

      // The studio template occupies [10:00, 11:30); this lands the mover's
      // start inside that range without matching it exactly.
      const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(owner.sessionToken) },
        body: JSON.stringify({ startTime: '10:30' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string; code?: string } };
      expect(body.error.code).toBe('CROSS_FAMILY_STUDIO_TEMPLATE_SLOT');
      expect(body.error.message).toMatch(/overlapping/i);

      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { scheduleRule: true } });
      expect(timeToHHmm(after.scheduleRule.startTime)).toBe('13:00');
    } finally {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: owner.teacherId } });
      await prisma.room.delete({ where: { id: owner.roomId } });
      await prisma.session.deleteMany({ where: { accountId: owner.accountId } });
      await prisma.teacher.delete({ where: { id: owner.teacherId } });
      await prisma.account.delete({ where: { id: owner.accountId } });
    }
  });
});
