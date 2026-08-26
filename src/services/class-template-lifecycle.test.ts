import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { RegistrationStatus } from '@prisma/client';
import {
  updateClassTemplate,
  archiveOrUnarchiveTemplate,
  pauseOrResumeTemplate,
} from './class-template-lifecycle';
import { startOfLocalDay, classStartInstant, mondayOf } from '@/lib/timezone';
import { getNextOccurrences } from './class-generator';
import { formatDayHeader } from '@/lib/format';
import { setLockTimeout } from '@/lib/db-locks';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { log } from '@/lib/log';
import { createClassFixture, createStudioClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`
 * once a block's fixture counter crosses 30. `totalMinutes % 60` is always
 * 0-59 by construction, so the assertion below is a cheap, self-checking
 * proof of that invariant rather than a defence this formula can actually
 * fail — but a fixed-width literal (`` `09:${30 + counter}` ``) can't make
 * the same guarantee: Task 6d's review found `archiveOrUnarchiveTemplate`'s
 * `makeTemplate` counter reaching its old ceiling at exactly its own call
 * count (29 calls, `'09:59'`), one call short of `'09:60'`. `Class.startTime`
 * is `@db.Time` and would now refuse such a value outright at the DB, which
 * is a less useful failure here than this guard's message naming the fixture
 * counter that produced it.
 */
function slotTime(totalMinutesFrom9am: number): string {
  const hour = 9 + Math.floor(totalMinutesFrom9am / 60);
  const minute = totalMinutesFrom9am % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (!/^\d{2}:[0-5]\d$/.test(startTime)) {
    throw new Error(`slotTime produced an invalid startTime: ${startTime}`);
  }
  return startTime;
}

// Hoisted to module scope: a pure function of `label` (plus the module-scope
// `prisma`/`uniqueSuffix` above), so both describe blocks below can seed their
// own, separate teacher/room/teacherRoom fixtures from it.
const seedTeacher = async (label: string, defaultTimezone = 'UTC') => {
  const email = `tpl-${label}-${uniqueSuffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: label,
      lastName: 'Teacher',
      email,
      account: { create: { email } },
      bio: `Teacher for ${label} template tests`,
      pageSlug: `tpl-${label}-${uniqueSuffix}`,
      defaultTimezone,
    },
  });
  const room = await prisma.room.create({
    data: {
      venueName: `${label} Venue`,
      address: `${uniqueSuffix} ${label} St`,
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
  return {
    teacherId: teacher.id,
    accountId: teacher.accountId,
    roomId: room.id,
    teacherRoomId: teacherRoom.id,
  };
};

describe('updateClassTemplate (DB)', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let otherRoomId: string;
  let otherTeacherRoomId: string;

  // Counter-derived startTime: this block calls makeTemplate 11 times for one
  // teacher/dayOfWeek, and none of its tests read or assert the created
  // template's literal startTime — so a slot per call, spaced wider than any
  // one call's own `durationMinutes` (60), is enough to keep every create
  // legal under `ScheduleRule_teacher_slot_excl` (issue 298), which excludes
  // on RANGE overlap rather than exact `startTime` match. 75, not 60: "applies
  // the update and returns just the template" widens its own row to
  // `durationMinutes: 75` without moving it, and 60-wide spacing would let
  // that widened range reach into the next counter slot. Counted off the
  // call sites when #194's fix wave added two of them, not incremented from
  // the number that was here.
  //
  // One of those two, "Archived Edit", IS archived — which FREES its slot
  // rather than taking one, since the index is partial (WHERE isArchived =
  // false). That direction is always safe here: a freed slot can only make a
  // later create legal, never illegal. It is worth naming because the sentence
  // this replaces said no template in this block is ever archived, which was
  // true when it was written and stopped being true when that case arrived.
  //
  // "Stamp Only" is the exception to the no-assertion half: it MOVES its
  // template's dayOfWeek and startTime, which frees this one's slot rather
  // than taking another — still legal, and it lands on a (dayOfWeek,
  // startTime) pair no sibling holds.
  //
  // The past-start case further down builds its template inline instead,
  // under its own teacher: it needs a specific dayOfWeek and startTime, which
  // is exactly what this helper does not offer. The two `slot_conflict` cases
  // (I4) below do the same, for the same reason — each needs a deliberate
  // collision, which is exactly what this counter's spacing exists to avoid.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string) => {
    makeTemplateCounter += 1;
    return prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'regular',
            classType,
            dayOfWeek: 3,
            startTime: hhmmToTime(slotTime(30 + makeTemplateCounter * 75)),
            durationMinutes: 60,
          },
        },
        teacherRoom: { connect: { id: teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
      include: { scheduleRule: true },
    });
  };

  beforeAll(async () => {
    await prisma.$connect();
    const mine = await seedTeacher('owner');
    teacherId = mine.teacherId;
    accountId = mine.accountId;
    roomId = mine.roomId;
    teacherRoomId = mine.teacherRoomId;

    const theirs = await seedTeacher('other');
    otherTeacherId = theirs.teacherId;
    otherAccountId = theirs.accountId;
    otherRoomId = theirs.roomId;
    otherTeacherRoomId = theirs.teacherRoomId;
  });

  afterAll(async () => {
    for (const [t, r, a] of [
      [teacherId, roomId, accountId],
      [otherTeacherId, otherRoomId, otherAccountId],
    ] as const) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: t } });
      // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue
      // 298), so deleting the rule removes the template with it.
      await prisma.scheduleRule.deleteMany({ where: { teacherId: t } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: t } });
      await prisma.room.delete({ where: { id: r } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('returns not_found for a template that does not exist', async () => {
    const result = await updateClassTemplate(
      prisma,
      '00000000-0000-0000-0000-000000000000',
      teacherId,
      { classType: 'Anything' },
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("returns forbidden for another teacher's template, and writes nothing", async () => {
    const template = await makeTemplate('Not Yours');

    const result = await updateClassTemplate(prisma, template.id, otherTeacherId, {
      classType: 'Hijacked',
    });

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: { scheduleRule: true },
    });
    expect(after.scheduleRule.classType).toBe('Not Yours');
  });

  it('returns no_fields for an empty payload, and writes nothing', async () => {
    const template = await makeTemplate('Empty Payload');
    const result = await updateClassTemplate(prisma, template.id, teacherId, {});
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: { scheduleRule: true },
    });
    expect(after.scheduleRule.classType).toBe('Empty Payload');
  });

  // Defined-value scan (`updateClassTemplate`'s own `hasEdit` check,
  // `class-template-lifecycle.ts`): a key present with value `undefined` is
  // not an edit, unlike the key-count check this replaced, which would have
  // let this through as `ok: true` and run a no-op update — taking the
  // template row's lock — for nothing.
  it('returns no_fields for a payload of only undefined values, and writes nothing', async () => {
    const template = await makeTemplate('Undefined Only');
    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      description: undefined,
    });
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: { scheduleRule: true },
    });
    expect(after.scheduleRule.classType).toBe('Undefined Only');
  });

  it('returns invalid_room for a room that does not exist', async () => {
    const template = await makeTemplate('Ghost Room');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      teacherRoomId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_room' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });

  it("returns invalid_room for another teacher's room, and writes nothing", async () => {
    const template = await makeTemplate('Someone Elses Room');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      teacherRoomId: otherTeacherRoomId,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_room' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });

  it('applies the update and returns just the template', async () => {
    const template = await makeTemplate('Editable');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      classType: 'Edited',
      durationMinutes: 75,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.classType).toBe('Edited');
    expect(result.template.durationMinutes).toBe(75);
    // Exhaustive on the success arm's own keys, and that exhaustiveness is
    // inherited, not new. A whole-shape `toEqual` stood here against
    // `TemplateSyncResult`'s six counts — `synced`, `regenerated`, `refilled`,
    // `blockedByCancelled`, `slotTaken`, `kept`, counted off the deleted
    // declaration at `5db8dca:src/services/template-sync.ts` rather than
    // remembered — and it is what caught the three fields #204's review added,
    // the reason the form could not silently keep reading a stale shape. #194
    // removed the propagation, so the same assertion now guards the opposite
    // property: the success arm carries the template and nothing else, and a
    // re-added propagation report fails here rather than reaching the client
    // unnoticed. `Object.keys`, not `toEqual` on the whole result, because the
    // template row's own fields are asserted above and re-listing all twenty
    // here would make this case fail on every unrelated schema change.
    //
    // Four keys, not two, since #194: `firstEffective` and `generationState`
    // are both PREDICTIONS about the sweep, not reports of work this call did,
    // and the distinction is exactly what this assertion is here to keep. A
    // key that counted rows this call touched would be the propagation coming
    // back. Re-derived from the arm's own declaration when `generationState`
    // was added rather than incremented, which is how the counts on this
    // branch drifted in the first place.
    expect(Object.keys(result).sort()).toEqual([
      'firstEffective',
      'generationState',
      'ok',
      'template',
    ]);
    // A live template, so the state is `active` and the week is a real
    // prediction rather than the absence of one.
    expect(result.generationState).toBe('active');
    // And it is a week, not a class date: `null` or a Monday, never a Thursday.
    // The copy renders it as "the week starting …", so a candidate occurrence
    // left unconverted would put the wrong weekday in front of a teacher.
    if (result.firstEffective !== null) {
      expect(result.firstEffective.getUTCDay()).toBe(1);
    }
  });

  // I4: the service-internal mirror of
  // `studio-class-template-lifecycle.test.ts`'s "returns slot_conflict with
  // heldBy: studio/regular" pair for `updateStudioClassTemplate` — this file
  // had no `slot_conflict` assertion at all before these two, across every
  // `ok: false` case `updateClassTemplate` can return. Route-level 409s are
  // already pinned by the integration suite; these prove the service's own
  // wiring — which fields feed `ruleSlotHolder` and what gets logged.
  //
  // Both build inline, under their own teacher, exactly as the past-start
  // case above them does and for the identical reason: each needs a
  // deliberate collision at a specific `(dayOfWeek, startTime)`, which is
  // what `makeTemplate`'s counter-derived spacing exists to avoid.
  it('returns slot_conflict with heldBy: regular when the edit lands on a live sibling slot, and logs it', async () => {
    const solo = await seedTeacher('slot-conflict-regular');
    const makeSoloTemplate = (classType: string, startTime: string) =>
      prisma.classTemplate.create({
        data: {
          scheduleRule: {
            create: {
              teacherId: solo.teacherId,
              kind: 'regular',
              classType,
              dayOfWeek: 5,
              startTime: hhmmToTime(startTime),
              durationMinutes: 60,
            },
          },
          teacherRoom: { connect: { id: solo.teacherRoomId } },
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 8,
        },
        include: { scheduleRule: true },
      });
    const occupant = await makeSoloTemplate('Slot Occupant', '09:00');
    const mover = await makeSoloTemplate('Slot Mover', '11:00');

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const result = await updateClassTemplate(prisma, mover.id, solo.teacherId, {
        startTime: timeToHHmm(occupant.scheduleRule.startTime),
      });

      expect(result).toEqual({ ok: false, reason: 'slot_conflict', heldBy: 'regular' });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: mover.id, teacherId: solo.teacherId, heldBy: 'regular' }),
        'recurring class edit refused: that slot is taken',
      );
    } finally {
      warn.mockRestore();
    }

    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: mover.id },
      include: { scheduleRule: true },
    });
    expect(timeToHHmm(after.scheduleRule.startTime)).toBe(timeToHHmm(mover.scheduleRule.startTime));

    // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue 298),
    // so deleting the rules removes both templates with them — matching the
    // cross-family probe cases above, which clean up the same way and leave
    // `solo`'s teacher/room/account behind the same way.
    await prisma.scheduleRule.deleteMany({ where: { teacherId: solo.teacherId } });
  });

  it('returns slot_conflict with heldBy: studio when the studio family holds the slot, and logs it', async () => {
    const solo = await seedTeacher('slot-conflict-studio');
    const mover = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: solo.teacherId,
            kind: 'regular',
            classType: 'Cross Family Mover',
            dayOfWeek: 5,
            startTime: hhmmToTime('09:00'),
            durationMinutes: 60,
          },
        },
        teacherRoom: { connect: { id: solo.teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
      include: { scheduleRule: true },
    });
    // The OTHER family at the slot the edit moves onto — a live
    // `StudioClassTemplate`, so it is this rule's `kind`, not which detector
    // matched, that decides `heldBy` now. Mirrors the studio twin's own
    // cross-family case, `heldBy: 'regular'`, in the other direction.
    await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: solo.teacherId,
            kind: 'studio',
            classType: 'Cross Family Holder',
            dayOfWeek: 5,
            startTime: hhmmToTime('11:00'),
            durationMinutes: 60,
          },
        },
        location: 'Cross Family Studio',
        hourlyRate: 40,
      },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const result = await updateClassTemplate(prisma, mover.id, solo.teacherId, {
        startTime: '11:00',
      });

      expect(result).toEqual({ ok: false, reason: 'slot_conflict', heldBy: 'studio' });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: mover.id, teacherId: solo.teacherId, heldBy: 'studio' }),
        'recurring class edit refused: that slot is taken',
      );
    } finally {
      warn.mockRestore();
    }

    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: mover.id },
      include: { scheduleRule: true },
    });
    expect(timeToHHmm(after.scheduleRule.startTime)).toBe(timeToHHmm(mover.scheduleRule.startTime));

    // `ClassTemplate`/`StudioClassTemplate` are `onDelete: Cascade` from
    // `ScheduleRule` (issue 298), so deleting the rules removes both
    // templates with them.
    await prisma.scheduleRule.deleteMany({ where: { teacherId: solo.teacherId } });
  });

  /**
   * #194's eligibility gate, paused half.
   *
   * The probe reproduces the grounds on which `generateInstancesForTemplate`
   * declines a candidate DATE. `ACTIVE_TEMPLATE_WHERE` declines whole
   * TEMPLATES, one layer up, before any candidate exists — so for a paused
   * template the generator is never called, no date is ever declined, and
   * every week the probe could name is a week nothing will fill. That gate is
   * not a `SkipReason` and could not have been found by completing the probe's
   * enumeration; it needs its own case.
   *
   * The edit itself still succeeds, and must: this PUT is deliberately open to
   * a paused template (door 5's comment in the service argues why). What is
   * refused is the dated sentence, not the write.
   *
   * Paused through `pauseOrResumeTemplate` rather than by setting the column,
   * so this pins the state a teacher can actually reach from the toggle.
   */
  it('names no week for a paused template, and reports the state instead', async () => {
    const template = await makeTemplate('Paused Edit');
    const paused = await pauseOrResumeTemplate(prisma, template.id, teacherId, 'paused');
    expect(paused.ok).toBe(true);

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      classType: 'Paused Edit, Renamed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // The write landed — the gate is on the prediction, not on the edit.
    expect(result.template.classType).toBe('Paused Edit, Renamed');
    expect(result.template.isActive).toBe(false);
    // No week, and the reason for the absence is on the result rather than
    // left for the copy layer to guess from a bare `null`.
    expect(result.firstEffective).toBeNull();
    expect(result.generationState).toBe('paused');
  });

  /**
   * #194's eligibility gate, archived half — and the sharper of the two.
   *
   * Archiving deletes the future window, so an archived template has no held
   * week at all. An ungated probe therefore returns the EARLIEST answer it can
   * give, this week's Monday, for the template least likely to produce a class
   * — the "dishonest direction" the past-start filter's own comment names,
   * reached by a different route.
   *
   * `archived`, not `paused`, and the distinction is load-bearing rather than
   * cosmetic: `archiveOrUnarchiveTemplate` forces `isActive: false` on both
   * directions, so un-archiving alone puts nothing back. A teacher told to
   * resume an archived recurring class has been given a remedy that does not
   * work — which is what `UNARCHIVE_MESSAGE` exists to prevent one arm over.
   */
  it('distinguishes an archived template from a merely paused one', async () => {
    const template = await makeTemplate('Archived Edit');
    const archived = await archiveOrUnarchiveTemplate(prisma, template.id, teacherId, 'archived');
    expect(archived.ok).toBe(true);

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      classType: 'Archived Edit, Renamed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.classType).toBe('Archived Edit, Renamed');
    // Both flags, because both halves of the state are what the answer below
    // depends on: the archive forced `isActive: false` as well.
    expect(result.template.isArchived).toBe(true);
    expect(result.template.isActive).toBe(false);
    expect(result.firstEffective).toBeNull();
    expect(result.generationState).toBe('archived');
  });

  /**
   * The probe's past-start filter, which nothing could break until now (#194).
   *
   * `updateClassTemplate` filters its horizon with the same predicate
   * `generateInstancesForTemplate` applies to its own candidates: an
   * occurrence whose start instant has already passed is dropped. The comment
   * on that filter says removing it means the sentence "would name a week the
   * sweep never fills … and it is the dishonest one" — and deleting the
   * `.filter(...)` failed no test. `class-templates-api.test.ts` drives both of
   * its probe cases through `sameWeekDayPair()`, whose docblock states outright
   * that neither day is ever today, and this file's own fixtures pin
   * `dayOfWeek: 3`, so the template's weekday is today on one day in seven and
   * the class hour was never arranged to have passed.
   *
   * The arrangement is deliberate on all three inputs and none of them can
   * drift with the calendar:
   *
   *   - `dayOfWeek` is TODAY's, computed from `new Date()`, so
   *     `getNextOccurrences` yields today as its first occurrence
   *     (`daysUntilTarget === 0` — its own comment says it includes today).
   *   - `startTime` is `'00:00'` and the teacher's zone is UTC, so
   *     `classStartInstant` for today is today's midnight UTC, which is never
   *     strictly after `now`. Today is dropped on every run, at every hour,
   *     rather than only after some cutoff.
   *   - No `Class` row exists for this template, so `heldWeeks` is empty and
   *     the answer is simply the first surviving candidate's week. Nothing
   *     else can be responsible for the difference.
   *
   * Both halves are asserted — the week it IS and the week it is NOT — because
   * the failure is off by exactly one week and `not.toBe` alone would pass for
   * any other wrong answer.
   *
   * Built inline rather than through `makeTemplate`, which hardcodes
   * `dayOfWeek: 3` and a counter-derived `09:3x`; this case needs both fields
   * to be something specific. Its own teacher, so the `(teacherId, dayOfWeek,
   * startTime)` slot cannot collide with this block's other templates on the
   * one day in seven when today is a Thursday.
   */
  /**
   * #296. The probe must decline a date the OTHER family holds, for the same
   * reason it declines one this family holds: the generator will skip it
   * (`blocked_by_other_family`), so naming its week promises a class the sweep
   * does not deliver.
   *
   * This is the `slot_taken` omission one table over. That one made the
   * prediction land EARLIER than the sweep delivers — the dishonest direction —
   * and adding the generator's reason without adding the probe's third read
   * would have reproduced it exactly.
   *
   * `23:59` so today's occurrence is never dropped by the probe's own
   * already-started filter, which would move the answer a week for a reason
   * that has nothing to do with what this pins. Both halves asserted: the week
   * it IS and the week it is NOT.
   */
  it('declines a date a live studio class holds, and names the week after', async () => {
    const solo = await seedTeacher('cross-family-probe');
    const todaySchemaDay = (new Date().getUTCDay() + 6) % 7;
    const template = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: solo.teacherId,
            kind: 'regular',
            classType: 'Cross Family Probe',
            dayOfWeek: todaySchemaDay,
            startTime: hhmmToTime('23:59'),
            durationMinutes: 60,
          },
        },
        teacherRoom: { connect: { id: solo.teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });

    const occurrences = getNextOccurrences(todaySchemaDay, new Date(), 2);
    const blocked = occurrences[0]!;
    const nextWeek = occurrences[1]!;

    await createStudioClassFixture(prisma, {
        teacherId: solo.teacherId,
        scheduleRuleId: null,
        classType: 'Cross Family Holder',
        date: blocked,
        startTime: hhmmToTime('23:59'),
        durationMinutes: 60,
        location: 'Elsewhere',
        hourlyRate: 50,
      });

    const result = await updateClassTemplate(prisma, template.id, solo.teacherId, {
      classType: 'Cross Family Probe, Renamed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.firstEffective).not.toBeNull();
    expect(result.firstEffective!.getTime()).toBe(mondayOf(nextWeek));
    expect(result.firstEffective!.getTime()).not.toBe(mondayOf(blocked));

    await prisma.calendarEntry.deleteMany({ where: { teacherId: solo.teacherId } });
    // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue 298), so deleting the rule removes the template with it.
    await prisma.scheduleRule.deleteMany({ where: { teacherId: solo.teacherId } });
  });

  it('does not decline a date a CANCELLED studio class holds', async () => {
    // The liveness half: `cancelledAt IS NULL` is `StudioClass`'s spelling of
    // the `status <> 'cancelled'` the same-family read uses. Widen the probe's
    // third read past liveness and this goes red.
    const solo = await seedTeacher('cross-family-probe-cancelled');
    const todaySchemaDay = (new Date().getUTCDay() + 6) % 7;
    const template = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: solo.teacherId,
            kind: 'regular',
            classType: 'Cross Family Probe Cancelled',
            dayOfWeek: todaySchemaDay,
            startTime: hhmmToTime('23:58'),
            durationMinutes: 60,
          },
        },
        teacherRoom: { connect: { id: solo.teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });

    const occurrences = getNextOccurrences(todaySchemaDay, new Date(), 2);
    const notBlocked = occurrences[0]!;

    await createStudioClassFixture(prisma, {
        teacherId: solo.teacherId,
        scheduleRuleId: null,
        classType: 'Cross Family Cancelled Holder',
        date: notBlocked,
        startTime: hhmmToTime('23:58'),
        durationMinutes: 60,
        location: 'Elsewhere',
        hourlyRate: 50,
        cancelledAt: new Date(),
      });

    const result = await updateClassTemplate(prisma, template.id, solo.teacherId, {
      classType: 'Cross Family Probe Cancelled, Renamed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.firstEffective!.getTime()).toBe(mondayOf(notBlocked));

    await prisma.calendarEntry.deleteMany({ where: { teacherId: solo.teacherId } });
    // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue 298), so deleting the rule removes the template with it.
    await prisma.scheduleRule.deleteMany({ where: { teacherId: solo.teacherId } });
  });

  it('drops an occurrence whose start has already passed, exactly as the sweep does', async () => {
    const solo = await seedTeacher('past-start');
    const todaySchemaDay = (new Date().getUTCDay() + 6) % 7;
    const template = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: solo.teacherId,
            kind: 'regular',
            classType: 'Past Start',
            dayOfWeek: todaySchemaDay,
            startTime: hhmmToTime('00:00'),
            durationMinutes: 60,
          },
        },
        teacherRoom: { connect: { id: solo.teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });

    // The probe's own horizon function, so the arithmetic below cannot drift
    // from the arithmetic under test: [0] is today, [1] is next week.
    const occurrences = getNextOccurrences(todaySchemaDay, new Date(), 2);
    const todayOccurrence = occurrences[0]!;
    const nextWeekOccurrence = occurrences[1]!;
    expect(todayOccurrence.getTime()).toBe(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      ),
    );

    const result = await updateClassTemplate(prisma, template.id, solo.teacherId, {
      classType: 'Past Start, Renamed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.firstEffective).not.toBeNull();
    expect(result.firstEffective!.getTime()).toBe(mondayOf(nextWeekOccurrence));
    expect(result.firstEffective!.getTime()).not.toBe(mondayOf(todayOccurrence));

    // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue 298), so deleting the rule removes the template with it.
    await prisma.scheduleRule.deleteMany({ where: { teacherId: solo.teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: solo.teacherId } });
    await prisma.room.delete({ where: { id: solo.roomId } });
    await prisma.teacher.delete({ where: { id: solo.teacherId } });
    await prisma.account.delete({ where: { id: solo.accountId } });
  });

  // The service-level statement of rule 1, next to the function that owns it:
  // `updateClassTemplate` writes the template row and no `Class` row, ever.
  // `class-templates-api.test.ts` proves the same thing end-to-end over HTTP;
  // this one proves it of the service in isolation, which is where a future
  // "just sync the unbooked ones" special case would actually be written.
  //
  // The edit deliberately spans all three families the deleted sync treated
  // differently — the day (it deleted wrong-day instances), the time (it
  // rewrote same-day ones) and the economics (it rewrote unbooked ones) — so
  // a partial revival cannot pass by touching only the family this case
  // forgot to name.
  it('changes the template row and no Class row, on any field', async () => {
    const template = await makeTemplate('Stamp Only');

    const instance = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        scheduleRuleId: template.scheduleRuleId,
        classType: 'Stamp Only',
        date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        startTime: template.scheduleRule.startTime,
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
        status: 'open',
        settingsLocked: false,
      });

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      dayOfWeek: (template.scheduleRule.dayOfWeek + 2) % 7,
      startTime: '23:31',
      roomCost: 99,
      maxStudents: 20,
    });
    expect(result.ok).toBe(true);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: instance.id }, include: { calendarEntry: true },});
    expect(after.calendarEntry.date.toISOString()).toBe(instance.calendarEntry.date.toISOString());
    expect(after.calendarEntry.startTime.getTime()).toBe(instance.calendarEntry.startTime.getTime());
    expect(after.roomCost.toString()).toBe(instance.roomCost.toString());
    expect(after.maxStudents).toBe(instance.maxStudents);
    expect(after.teacherRoomId).toBe(instance.teacherRoomId);
  });

  /**
   * #100. The read at the top of `updateClassTemplate` and the `update`
   * inside the transaction it opens are not one statement, so a delete
   * landing between them raises P2025 at the write. Before #100 that escaped
   * as a 500 — the bug this issue exists to close.
   *
   * This used to be the first of two windows one `catch` covered. The
   * second — a delete landing between the write committing and the sync's
   * own read — closed when task 6 of the atomic-template-update work put
   * both inside one transaction: that read ran on a row the write above had
   * already locked, so nothing could delete it out from under the read before
   * the transaction ended. #194 then deleted the sync outright, so the second
   * window has no code left behind it at all. A test pinning it used to stand
   * here; it hung rather than failed once the window closed, because the
   * out-of-band delete it relied on blocked on the lock instead of racing it.
   * This is the only window
   * left; its replacement — pinning the blocking behaviour the closed window
   * now produces in place of a race — sits below. (Not "once task 7 gave that
   * wait a bound to test against", as this said: task 7's `setLockTimeout`
   * bounds the EDIT's waits, and the party that waits in the replacement is
   * the concurrent delete, bounded by that test's own `setLockTimeout(tx)`
   * call. The replacement asserts blocking-then-completion and never tests
   * against a bound at all.)
   *
   * Interposed rather than raced, like the pause guard's twin: the extension
   * performs the real read and then deletes the row before returning it, which
   * *is* the interleaving the guard exists for. The payload is `classType`
   * alone, deliberately — no `teacherRoomId`, so the room lookup is skipped
   * and nothing at all runs between the hooked read and the write.
   */
  it('maps a delete landing between the read and the write to not_found', async () => {
    const t = await makeTemplate('P2025 Write');

    let deleted = false;
    // Cast for the same reason `template-lock-order.test.ts`'s hooked clients
    // need one: the extended client is missing `$on`, so it is not assignable
    // to `updateClassTemplate`'s `PrismaClient`-typed `db` parameter, and
    // reusing the existing stub-client cast is the only accepted way past that
    // without loosening the parameter's type. (Not `template-sync.test.ts`,
    // which this once pointed at: its casts existed for a DIFFERENT reason —
    // the extended `$transaction` callback's `tx` was not assignable to
    // `TransactionClientOnly` — and nothing to do with `$on`. That file went
    // with its function in #194; the distinction is kept because the same
    // wrong cross-reference is easy to write again.)
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!deleted) {
              deleted = true;
              await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: t.id } } } },
    });
              await prisma.classTemplate.delete({ where: { id: t.id } });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await updateClassTemplate(interposing, t.id, teacherId, {
      classType: 'Renamed',
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  /**
   * The replacement for the test task 6 deleted (see the docblock above).
   * Before task 6, `classTemplate.update` and the sync's own read ran as two
   * separately-committed statements with no lock held in between, so an
   * out-of-band delete could land in the gap and race the write. Task 6 put
   * them inside ONE transaction, and #194 then deleted the sync entirely.
   * Either way the write's row lock is held for the whole transaction's
   * lifetime — there is no gap for a concurrent delete to land in, only a
   * lock to queue behind. That property is what this case still pins, and it
   * is a property of the transaction, not of the sync.
   *
   * That is why the deleted test could not simply be un-deleted: once this
   * window closed, its own out-of-band delete stopped racing and started
   * blocking — and it hung rather than failed, because it ran SYNCHRONOUSLY
   * *inside* the very `$extends` hook intercepting the write, awaited from
   * within the still-open transaction whose row lock that delete needed. The
   * transaction could never reach `COMMIT` to release the lock (it was
   * paused awaiting the delete), and the delete — issued on a separate
   * connection with no `lock_timeout` of its own — had nothing to time out
   * against either. A genuine deadlock, not a slow test, which is why it
   * outlasted the file's 10s `afterAll` hook rather than merely failing one
   * assertion. Observed while writing task 7 and recorded here rather than
   * cited: the task reports live under `.superpowers/sdd/`, which is
   * gitignored, so a pointer to one is a pointer to nothing after merge —
   * the same reason the archive pre-lock's evidence was inlined into the
   * spec instead.
   *
   * This version does not reproduce that: the hook only signals that the
   * write landed and then waits on a promise the test controls, so the
   * concurrent delete can run from the test's own top level — on its own
   * connection, in its own transaction, bounded by `setLockTimeout` the same
   * way any bounded wait in this project is. `hookedPrisma.$transaction`'s
   * query extension still applies inside the interactive transaction it
   * opens, so this fires on `tx.classTemplate.update` while that transaction
   * is genuinely still open — not merely believed to be.
   */
  it(
    'a concurrent delete blocks on the write lock and completes cleanly once the edit commits',
    async () => {
      const t = await makeTemplate('P2025 Sync Replacement');

      let writeLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        writeLocked = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Cast for the same reason the sibling hook above needs one: `$extends`
      // is missing `$on`, so it is not assignable to `updateClassTemplate`'s
      // `PrismaClient`-typed `db` parameter.
      const interposing = prisma.$extends({
        query: {
          classTemplate: {
            async update({ args, query }) {
              const row = await query(args);
              // The write has landed; its row lock is held by this
              // still-open transaction. Signal, then hold — deliberately
              // NOT performing the delete from inside this hook. See the
              // docblock above for why that deadlocked the test this
              // replaces.
              writeLocked();
              await held;
              return row;
            },
          },
        },
      }) as unknown as PrismaClient;

      const editing = updateClassTemplate(interposing, t.id, teacherId, {
        classType: 'Renamed',
      });

      await locked;

      let deleteSettled = false;
      const deleting = prisma
        .$transaction(async (tx) => {
          await setLockTimeout(tx);
          await tx.classTemplate.delete({ where: { id: t.id } });
        })
        .then(() => {
          deleteSettled = true;
        });

      try {
        // The edit's transaction is still open and holds the row; the
        // delete must still be queued behind it rather than having raced it.
        await new Promise((r) => setTimeout(r, 300));
        expect(deleteSettled).toBe(false);
      } finally {
        // In a `finally`, so a failed assertion above still releases the
        // edit's transaction rather than leaving it — and the connection it
        // holds — parked on `held` for the rest of the file's run.
        release();
      }

      const result = await editing;
      expect(result.ok).toBe(true);

      // Completes rather than hanging, now that the edit committed and
      // released the lock — the assertion this test exists to make.
      await deleting;
      expect(deleteSettled).toBe(true);
      expect(await prisma.classTemplate.findUnique({ where: { id: t.id } })).toBeNull();
    },
    10_000,
  );
});

describe('archiveOrUnarchiveTemplate (DB)', () => {
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
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;
  let waiterId: string;
  let secondWaiterId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let otherRoomId: string;
  type Seeded = Awaited<ReturnType<typeof seedTeacher>>;
  let east: Seeded;
  let west: Seeded;

  // Counter-derived startTime: this block calls makeTemplate 29 times at
  // runtime (28 call sites, one of them an `it.each` over 2 statuses) for one
  // teacher/dayOfWeek — the tightest counter in this repair. Most tests here
  // do archive their own template by the end (which flips isArchived and
  // would free the slot on its own), but several deliberately don't (the two
  // 'forbidden' cases, and the "does not tell a waiting student when the
  // class was spared" case, whose whole point is that the archive matches
  // nothing) — and once any one template is left behind unarchived, every
  // later makeTemplate call in the block collides with it before it even
  // gets a row created, which is what turned into a near-total cascade here.
  //
  // `ScheduleRule_teacher_slot_excl` (issue 298) excludes on RANGE overlap,
  // not exact `startTime` match, so a distinct minute per call is no longer
  // enough — each slot must be spaced a full `durationMinutes` from the
  // last. `durationMinutes: 10` here (not this file's usual 60) is what
  // keeps 29 back-to-back slots inside one day; no test reads or asserts a
  // created template's literal `durationMinutes` or `startTime`.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string) => {
    makeTemplateCounter += 1;
    return prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'regular',
            classType,
            dayOfWeek: 3,
            startTime: hhmmToTime(slotTime(30 + makeTemplateCounter * 10)),
            durationMinutes: 10,
          },
        },
        teacherRoom: { connect: { id: teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
      include: { scheduleRule: true },
    });
  };

  // Closes over the block's own teacherId/teacherRoomId, like the sibling
  // block's makeTemplate does.
  //
  // Counter-derived startTime: this block calls makeClass 38 times at runtime
  // (37 call sites, one of them an `it.each` over 2 statuses) across many
  // tests, and several recurring `date` values (`future()` especially) are
  // reused across tests whose class deliberately survives the archive (a
  // kept/registered/late_cancel class, or a forbidden request that touches
  // nothing) — so under Class_teacher_slot_unique a later test's create at
  // the same date collided with an earlier test's still-open leftover. This
  // was masked in the original baseline: those tests never even reached this
  // call, because the template-level collision fixed above threw first.
  // Routed through `slotTime` (see its docblock), like `makeTemplate`'s own
  // counter above: the raw `09:${counter}` this replaced had only 21 minutes
  // of headroom at this call count — the tightest margin of any counter on
  // this branch, in the file that defines the helper. `startTime` can be
  // overridden per call for the one test whose notification-body assertion
  // pins the literal value.
  let makeClassCounter = 0;
  // `scheduleRuleId`, not a template id: since #327 the generated class hangs
  // off its rule through the entry. `status` still accepts `'cancelled'` and
  // the fixture splits it across the two rows, because a cancelled class is
  // what several of these cases are about.
  const makeClass = async (
    scheduleRuleId: string,
    opts: {
      date: Date;
      status?: 'draft' | 'open' | 'cancelled';
      classType?: string;
      startTime?: string;
    },
  ) => {
    makeClassCounter += 1;
    const state = opts.status ?? 'open';
    return createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        scheduleRuleId,
        classType: opts.classType ?? 'Archive Rule',
        date: opts.date,
        startTime: hhmmToTime(opts.startTime ?? slotTime(makeClassCounter)),
        // ONE MINUTE, and it is the counter-spacing that decides it (#327).
        // `CalendarEntry_teacher_slot_excl` is a range overlap now, so
        // fixtures a minute apart must be a minute long or they collide —
        // and this block plants more fixtures on one date than any wider
        // spacing fits in a day. Nothing here reads the duration; what these
        // tests are about is which classes an archive withdraws.
        durationMinutes: 1,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: state === 'cancelled' ? 'open' : state,
        cancelledAt: state === 'cancelled' ? new Date() : null,
      });
  };

  const register = (classId: string, studentId: string, status: RegistrationStatus) =>
    prisma.registration.create({ data: { classId, studentId, tierAtBooking: 3, status } });

  /**
   * Narrows to the archiving arm. `deleted`/`remaining` exist only there —
   * un-archiving reports no counts rather than two zeros that would read like
   * "archived, and nothing matched" — so every count assertion has to say
   * which direction it expected. That is the discriminant earning its keep.
   */
  const expectArchived = (result: Awaited<ReturnType<typeof archiveOrUnarchiveTemplate>>) => {
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.action !== 'archived') throw new Error('expected the archiving direction');
    return result;
  };

  beforeAll(async () => {
    await prisma.$connect();
    const seeded = await seedTeacher('archive');
    teacherId = seeded.teacherId;
    accountId = seeded.accountId;
    roomId = seeded.roomId;
    teacherRoomId = seeded.teacherRoomId;

    const other = await seedTeacher('archive-other');
    otherTeacherId = other.teacherId;
    otherAccountId = other.accountId;
    otherRoomId = other.roomId;

    // Two zones 25 hours apart, so their local calendar dates always differ by
    // exactly one day — whatever the clock says when this runs. See the
    // timezone test below for why that fixed gap is what makes it deterministic.
    east = await seedTeacher('archive-east', 'Pacific/Kiritimati');
    west = await seedTeacher('archive-west', 'Pacific/Niue');

    const student = await prisma.student.create({
      data: {
        firstName: 'Archive',
        lastName: 'Student',
        email: `archive-student-${uniqueSuffix}@test.local`,
      },
    });
    studentId = student.id;

    // #112. A second student who only ever waits — the spared-class test needs
    // a registrant and a waiter who are different people, or "the waiter was
    // not notified" is indistinguishable from "the registrant was not".
    const waiter = await prisma.student.create({
      data: {
        firstName: 'Archive',
        lastName: 'Waiter',
        email: `archive-waiter-${uniqueSuffix}@test.local`,
      },
    });
    waiterId = waiter.id;

    // A third, for the mixed-batch test: one archive, two classes, and the
    // assertion is that the spared class's waiter hears nothing WHILE the
    // withdrawn class's waiter hears. One student on both queues could not
    // tell those two apart.
    const secondWaiter = await prisma.student.create({
      data: {
        firstName: 'Archive',
        lastName: 'Waiter Two',
        email: `archive-waiter2-${uniqueSuffix}@test.local`,
      },
    });
    secondWaiterId = secondWaiter.id;
  });

  afterAll(async () => {
    // Archive notifications outlive their class: `Notification.relatedClass`
    // is `onDelete: SetNull` (`prisma/schema.prisma`), so the class deletes
    // below do NOT reap them. Delete by recipient, before the students go.
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [studentId, waiterId, secondWaiterId] } },
    });
    await prisma.waitlistEntry.deleteMany({
      where: { studentId: { in: [studentId, waiterId, secondWaiterId] } },
    });
    await prisma.registration.deleteMany({
      where: { studentId: { in: [studentId, waiterId, secondWaiterId] } },
    });
    await prisma.student.deleteMany({ where: { id: { in: [studentId, waiterId, secondWaiterId] } } });
    for (const [t, r, a] of [
      [teacherId, roomId, accountId],
      [otherTeacherId, otherRoomId, otherAccountId],
      [east.teacherId, east.roomId, east.accountId],
      [west.teacherId, west.roomId, west.accountId],
    ] as const) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: t } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: t } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: t } });
      await prisma.room.delete({ where: { id: r } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('returns not_found for a template that does not exist', async () => {
    const result = await archiveOrUnarchiveTemplate(
      prisma,
      '00000000-0000-0000-0000-000000000000',
      teacherId,
      'archived',
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("returns forbidden for another teacher's template, and leaves it and its classes untouched", async () => {
    const t = await makeTemplate('Not Yours');
    const c = await makeClass(t.scheduleRuleId, { date: future() });

    // The ownership check is the only thing stopping teacher B from
    // destroying teacher A's schedule — this is the function that deletes
    // rows, so it must refuse before touching anything.
    const result = await archiveOrUnarchiveTemplate(prisma, t.id, otherTeacherId, 'archived');

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(false);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  /**
   * The guard order matters here specifically: `isArchived === archiving` is
   * true on this fresh (unarchived) row and the request names 'unarchived',
   * so this is the one case that distinguishes "ownership checked first" from
   * "unchanged checked first" — every other forbidden case in this file asks
   * for a state the row is NOT already in, so it would pass just as well with
   * the guards swapped. Reordering `unchanged` above `forbidden` would answer
   * this with a 200 `unchanged` instead — handing a non-owner the row.
   */
  it("returns forbidden for another teacher's template already in the requested state, and writes nothing", async () => {
    const t = await makeTemplate('Owner Unarchived, Foreign Request');

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, otherTeacherId, 'unarchived');

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(false);
  });

  it('deletes a future class nobody booked', async () => {
    const t = await makeTemplate('Del Unbooked');
    const c = await makeClass(t.scheduleRuleId, { date: future() });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  it('deletes a future class whose only registration is cancelled', async () => {
    const t = await makeTemplate('Del Cancelled');
    const c = await makeClass(t.scheduleRuleId, { date: future() });
    await register(c.id, studentId, 'cancelled');

    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    // Nobody is affected and nothing is owed, so this is not "booked".
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  it('keeps a future class with a late_cancel registration — it is still charged', async () => {
    const t = await makeTemplate('Keep LateCancel');
    const c = await makeClass(t.scheduleRuleId, { date: future() });
    await register(c.id, studentId, 'late_cancel');

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    // Assert the archive itself actually happened — a class surviving proves
    // nothing on its own if the function silently no-op'd or errored.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    // ACTIVE_REGISTRATION_STATUSES excludes late_cancel; CHARGED_STATUSES does
    // not. Deleting this would cascade away a registration the student owes
    // for. If this test ever fails, check which constant the rule is using.
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  /**
   * #86 (`2026-07-25-template-archive-withdraws-window-design.md:231`) asked
   * for this and it was never written. The archive path's whole notification
   * design (#112) rests on the cascade being real: it READS its recipients
   * before the delete precisely because these rows do not survive it, and
   * decides who to notify after. (It does not notify before — notifying from
   * the candidate read is the bug the race test below exists to catch.) A
   * migration that changed `onDelete` would silently turn that read's ordering
   * from necessary into merely early, and nothing else in the suite would
   * notice.
   */
  it('cascade-deletes waitlist entries when the class row goes', async () => {
    const t = await makeTemplate('Cascade Pin');
    const c = await makeClass(t.scheduleRuleId, { date: future() });
    const entry = await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId, position: 1, status: 'waiting' },
    });

    // Delete the class directly rather than through archiving: this pins the
    // schema property itself, not the one caller that happens to rely on it.
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: c.id } } } });

    expect(await prisma.waitlistEntry.count({ where: { id: entry.id } })).toBe(0);
  });

  /**
   * #112. The archive's recipients are destroyed by the same statement that
   * withdraws their class, so they have to be READ before the delete — and
   * `Notification.relatedClass` being `SetNull` means the notice survives with
   * a null link. The body therefore has to name the class itself; a student
   * opening their inbox has nothing else left to identify it by.
   */
  it('tells a waiting student when archiving withdraws their class', async () => {
    const t = await makeTemplate('Withdraw Notice');
    // startTime pinned explicitly: the notification-body assertion below
    // checks for this literal, so it can't take the counter-derived default.
    const c = await makeClass(t.scheduleRuleId, {
      date: future(),
      classType: 'Withdraw Notice',
      startTime: '09:00',
    });
    await register(c.id, studentId, 'cancelled'); // not charged — class is deletable
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    // `finally`, not a trailing statement — the convention `gdpr.test.ts:108`
    // records after round 1's M5. Every test below asserting a zero count for
    // `waiterId` depends on this running, and cleaning up only on the happy
    // path would turn one real failure here into several, most of them in the
    // very tests a reader would open to understand the first.
    try {
      const result = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
      expect(result.deleted).toBe(1);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);

      const note = await prisma.notification.findFirstOrThrow({
        where: { recipientType: 'student', recipientId: waiterId, type: 'class_cancelled' },
      });
      // The link is gone with the class; the body is the only durable record,
      // so it has to carry all three identifying fields. Derived from the
      // fixture rather than hard-coded — a literal '16 Aug' would rot in five
      // days, since `future()` is relative to the run. `formatDayHeader`, the
      // whole rendering including the weekday: asserting only `12 Jun` would
      // pass against any formatter that contains it, which is how the earlier
      // version of this test could not have caught a swap.
      expect(note.relatedClassId).toBeNull();
      expect(note.body).toContain('Withdraw Notice');
      expect(note.body).toContain(formatDayHeader(c.calendarEntry.date));
      expect(note.body).toContain('09:00'); // makeClass's startTime

      // Waiters, and ONLY waiters. `studentId` holds a `cancelled`
      // registration on this class and is deliberately not told: they left the
      // class themselves, or their teacher removed them, and either way the
      // withdrawal is not news they are owed. Widening the archive recipient
      // list to registrations would otherwise pass this whole file.
      expect(
        await prisma.notification.count({ where: { recipientId: studentId, type: 'class_cancelled' } }),
      ).toBe(0);
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: { in: [waiterId, studentId] } } });
    }
  });

  /**
   * The complement: a class the delete SPARED must not generate a notice.
   *
   * This kills `withdrawn = candidates` — but only because the candidate read
   * is deliberately WIDER than the delete (no registration predicate), so this
   * spared class IS a candidate and the survivor filter is what removes it.
   * Narrow the candidate read to mirror the delete and this test stops being
   * able to fail, because `candidates` comes back empty and notifying from it
   * produces the same zero. That is not hypothetical: it is what the first
   * implementation did, and PR review measured this test passing against the
   * mutation it was written to catch.
   */
  it('does not tell a waiting student when the class was spared', async () => {
    const t = await makeTemplate('Spared Notice');
    const c = await makeClass(t.scheduleRuleId, { date: future() });
    await register(c.id, studentId, 'registered'); // charged — class survives
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    try {
      const result = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
      expect(result.deleted).toBe(0);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);

      expect(
        await prisma.notification.count({ where: { recipientId: waiterId, type: 'class_cancelled' } }),
      ).toBe(0);
      // And the entry is untouched — the class is still on, the queue with it.
      const entry = await prisma.waitlistEntry.findFirstOrThrow({ where: { classId: c.id } });
      expect(entry.status).toBe('waiting');
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: waiterId } });
    }
  });

  /**
   * One archive, several classes, mixed outcomes — the ordinary case, since a
   * template generates instances on a rolling 4-week basis.
   *
   * The two tests above each archive a template carrying exactly one class, so
   * "filter by class id" and "all-or-nothing across the batch" produce
   * identical output and nothing distinguishes them. PR review measured
   * `withdrawn = survived.size === 0 ? candidates : []` passing the entire
   * file. Under that mutation this test notifies nobody: one spared class
   * silences every withdrawn one, which is #112 reintroduced through its own
   * fix.
   */
  it('notifies only the waiters of the classes it actually withdrew', async () => {
    const t = await makeTemplate('Mixed Batch');
    const kept = await makeClass(t.scheduleRuleId, { date: futureOn(6), classType: 'Mixed Kept' });
    const gone = await makeClass(t.scheduleRuleId, { date: futureOn(13), classType: 'Mixed Gone' });
    await register(kept.id, studentId, 'registered'); // charged — spares `kept`
    await prisma.waitlistEntry.create({
      data: { classId: kept.id, studentId: waiterId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: gone.id, studentId: secondWaiterId, position: 1, status: 'waiting' },
    });

    try {
      const result = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
      expect(result.deleted).toBe(1);
      expect(await prisma.class.count({ where: { id: kept.id } })).toBe(1);
      expect(await prisma.class.count({ where: { id: gone.id } })).toBe(0);

      // The withdrawn class's waiter hears, and the body names THAT class.
      const note = await prisma.notification.findFirstOrThrow({
        where: { recipientId: secondWaiterId, type: 'class_cancelled' },
      });
      expect(note.body).toContain('Mixed Gone');
      // The spared class's waiter hears nothing, in the same transaction.
      expect(
        await prisma.notification.count({ where: { recipientId: waiterId, type: 'class_cancelled' } }),
      ).toBe(0);
    } finally {
      await prisma.notification.deleteMany({
        where: { recipientId: { in: [waiterId, secondWaiterId] } },
      });
    }
  });

  /**
   * The `status: 'waiting'` filter on the candidate read, which nothing else
   * pins: every waitlist fixture in this file writes `waiting`, so dropping
   * the filter changes no other test's outcome.
   *
   * It matters because `class_cancelled` is in `ESSENTIAL_NOTIFICATION_TYPES`
   * and bypasses the student's email preference. Without the filter, someone
   * who left the queue months ago is emailed about a class they are not
   * waiting for and cannot act on.
   */
  it('does not notify a student who had already left the queue', async () => {
    const t = await makeTemplate('Removed Entry');
    const c = await makeClass(t.scheduleRuleId, { date: future() });
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'removed' },
    });

    try {
      const result = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
      expect(result.deleted).toBe(1); // the class still goes — nothing charged
      expect(
        await prisma.notification.count({ where: { recipientId: waiterId, type: 'class_cancelled' } }),
      ).toBe(0);
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: waiterId } });
    }
  });

  /**
   * #112, restored after #180 task 4's pre-lock closed the INSERT-shaped
   * race this test used to run. This is guard 8 of the #112 mutation ledger
   * (`docs/superpowers/plans/2026-08-11-waitlist-withdrawal-notice-mutations.md`)
   * — the one guard in this change that needs real concurrency to bite:
   * without it, notifying from the candidate read and notifying from the
   * survivor filter are indistinguishable, since every non-concurrent case
   * produces identical output — see "does not tell a waiting student when
   * the class was spared" and "notifies only the waiters of the classes it
   * actually withdrew" above for that non-racy protection, which this test
   * does not duplicate.
   *
   * A first attempt at restoring this raced a brand-new `prisma.registration.
   * create()` into the gap, the same shape the pre-#180-task-4 version of
   * this test used. That construction really is gone: a new `Registration`
   * needs `FOR KEY SHARE` on the parent `Class` row to satisfy the foreign
   * key, which now conflicts with the pre-lock's `FOR UPDATE`, so the insert
   * cannot even start until the archive transaction ends — measured, not
   * assumed: awaited directly inside the hook, it hung the test (an
   * application-level deadlock invisible to Postgres's own detector, since
   * one side is blocked in JS, not in Postgres); fire-and-forget instead let
   * the archive proceed, but then the class was already gone once the insert
   * was released, so the archive completed exactly as if the race had never
   * happened. Nothing about that construction can any longer produce "spared
   * because of a race" — it produces "gone before the race resolves" or a
   * hang, never a spare. A test built on it could not fail no matter what
   * the survivor filter did: measured, three runs, passing with the pre-lock
   * commented out every time.
   *
   * The race that DOES still reach this gap: `PUT /api/registrations/[id]`
   * (`src/app/api/registrations/[id]/route.ts:98`) writes `registration.
   * update({ data: { status } })` for `status ∈ {attended, no_show,
   * late_cancel}` — all three in `CHARGED_STATUSES` — touching only the
   * `status` column, never the `classId` foreign key. No FK write means no
   * `FOR KEY SHARE` on the parent `Class` row, so this one still races the
   * pre-lock freely, awaited directly inside the hook below with no
   * fire-and-forget needed — the same shape "notifies a waiter whose class
   * became deletable after the candidate read" below already uses for its
   * own, opposite-direction status flip. The registration below starts
   * `cancelled` — not charged, so the class is a genuine delete candidate
   * when the pre-lock and the candidate read run — and is flipped to
   * `attended` in the gap, so the delete's live re-evaluation excludes it
   * and the class survives.
   *
   * Exactly one — no more, no fewer, the same pin `gdpr.test.ts`'s own
   * candidate-read interposition and the
   * sibling interposition at `class-transitions.test.ts` carry, and the same
   * reasoning the #112 mutation ledger's own note on this guard gives: a bare
   * "it fired at all" flag lets the race land on the wrong read and every
   * assertion below pass regardless, so `calls`/`candidateRows` pin that it
   * was the candidate read specifically.
   */
  it('does not notify a waiter whose class was spared after the candidate read', async () => {
    const t = await makeTemplate('Race Spare');
    const c = await makeClass(t.scheduleRuleId, { date: future() });
    const reg = await register(c.id, studentId, 'cancelled'); // not charged — a delete candidate, for now
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    let calls = 0;
    let candidateRows = -1;
    const interposing = prisma.$extends({
      query: {
        waitlistEntry: {
          async findMany({ args, query }) {
            calls++;
            const rows = await query(args);
            // Once, and only after the candidate read has returned: commit
            // the charge from outside the archive transaction. See the
            // docblock above for why this specific write — a status-only
            // `update`, not an `insert` — is the one that still reaches this
            // gap under the pre-lock.
            if (calls === 1) {
              candidateRows = rows.length;
              await prisma.registration.update({
                where: { id: reg.id },
                data: { status: 'attended' },
              });
            }
            return rows;
          },
        },
      },
    }) as unknown as typeof prisma;

    try {
      const result = expectArchived(
        await archiveOrUnarchiveTemplate(interposing, t.id, teacherId, 'archived'),
      );

      expect(calls).toBe(1);
      expect(candidateRows).toBe(1);
      // The delete re-evaluated and spared the class.
      expect(result.deleted).toBe(0);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
      // So the waiter must NOT have been told it was withdrawn.
      expect(
        await prisma.notification.count({ where: { recipientId: waiterId, type: 'class_cancelled' } }),
      ).toBe(0);
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: waiterId } });
    }
  });

  /**
   * The mirror of the test above, and the regression guard for the candidate
   * read being WIDER than the delete.
   *
   * There the class became un-deletable in the gap and its waiter must not be
   * told. Here it becomes deletable in the gap — the last charged registration
   * is cancelled between the candidate read and the `deleteMany` — and the
   * waiter MUST be told.
   *
   * Narrow the candidate read to mirror the delete's predicate and this class
   * is not a candidate when it is read, is deleted anyway when the predicate is
   * re-evaluated, and its waiter is cascade-deleted in silence. PR review
   * reproduced exactly that against the first implementation. Every other test
   * in this file passes under that mutation; only this one fails.
   *
   * The trigger is ordinary: a queue only forms at `maxStudents`, so a class
   * with waiters normally DOES hold a charged registration, and a student's own
   * before-deadline cancel writes plain `cancelled` (`registrations/[id]`).
   */
  it('notifies a waiter whose class became deletable after the candidate read', async () => {
    const t = await makeTemplate('Race Delete');
    const c = await makeClass(t.scheduleRuleId, { date: future(), classType: 'Race Delete' });
    const reg = await register(c.id, studentId, 'registered'); // charged — spared, for now
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    let calls = 0;
    const interposing = prisma.$extends({
      query: {
        waitlistEntry: {
          async findMany({ args, query }) {
            calls++;
            const rows = await query(args);
            if (calls === 1) {
              // Commit the cancellation from OUTSIDE the archive transaction,
              // after the candidate read has returned. `cancelled` is not in
              // `CHARGED_STATUSES`, so the delete's predicate now matches.
              await prisma.registration.update({
                where: { id: reg.id },
                data: { status: 'cancelled', cancelledAt: new Date() },
              });
            }
            return rows;
          },
        },
      },
    }) as unknown as typeof prisma;

    try {
      const result = expectArchived(
        await archiveOrUnarchiveTemplate(interposing, t.id, teacherId, 'archived'),
      );

      expect(calls).toBe(1);
      // The delete re-evaluated and took the class.
      expect(result.deleted).toBe(1);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
      // So the waiter must have been told, even though the class did not match
      // the delete's predicate at the moment they were read.
      const note = await prisma.notification.findFirstOrThrow({
        where: { recipientId: waiterId, type: 'class_cancelled' },
      });
      expect(note.body).toContain('Race Delete');
      expect(note.relatedClassId).toBeNull();
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: waiterId } });
    }
  });

  it('keeps a future class with a registered student', async () => {
    const t = await makeTemplate('Keep Registered');
    const c = await makeClass(t.scheduleRuleId, { date: future() });
    await register(c.id, studentId, 'registered');

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  it("keeps today's class — the date > now boundary", async () => {
    const t = await makeTemplate('Keep Today');
    const c = await makeClass(t.scheduleRuleId, { date: today() });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    const archived = expectArchived(result);
    expect(archived.template.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
    // A `remaining` still keyed on the delete's own boundary would read 0 here
    // and tell the teacher nothing is scheduled while this exact class stays
    // open on their public page.
    expect(archived.remaining).toBe(1);
  });

  it("reports deleted: 0, remaining: 1 when today's class is the only one scheduled", async () => {
    const t = await makeTemplate('Today Only');
    await makeClass(t.scheduleRuleId, { date: today() });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    // Nothing was eligible for deletion (today is spared) and the one class
    // on the schedule is today's — the confirmation must say so, not "nothing
    // scheduled any more".
    const archived = expectArchived(result);
    expect(archived.deleted).toBe(0);
    expect(archived.remaining).toBe(1);
  });

  /**
   * The rule is "no CHARGED registration", deliberately *not* `settingsLocked`
   * — which answers whether the price may still change and, once set, never
   * resets. Every other fixture here leaves `settingsLocked` false (the test
   * helper writes `Registration` rows directly, bypassing the flip in
   * `api/registrations/route.ts`), so without this case a refactor to the
   * wrong-but-plausible `settingsLocked` check would pass the whole suite.
   */
  it('deletes a future class that is settingsLocked but carries no charged registration', async () => {
    const t = await makeTemplate('Locked But Unbooked');
    const c = await makeClass(t.scheduleRuleId, { date: future() });
    await prisma.class.update({ where: { id: c.id }, data: { settingsLocked: true } });
    await register(c.id, studentId, 'cancelled');

    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.deleted).toBe(1);
    expect(archived.remaining).toBe(0);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  /**
   * `SCHEDULED_STATUSES` is `['draft', 'open']`. A future class in any other
   * status is out of the archive rule's scope and must survive — pinning the
   * list against silent widening, which nothing else here does.
   */
  it.each(['in_progress', 'completed'] as const)(
    'keeps a future %s class — outside the draft/open scope',
    async (status) => {
      const t = await makeTemplate(`Scope ${status}`);
      const c = await makeClass(t.scheduleRuleId, { date: future() });
      await prisma.class.update({ where: { id: c.id }, data: { status } });

      const archived = expectArchived(
        await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
      );

      expect(archived.deleted).toBe(0);
      expect(archived.remaining).toBe(0);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
    },
  );

  it('deletes a future draft class, like an open one', async () => {
    const t = await makeTemplate('Draft Scope');
    const c = await makeClass(t.scheduleRuleId, { date: future(), status: 'draft' });

    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.deleted).toBe(1);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  /**
   * The boundary is the *teacher's* calendar day, not UTC's.
   *
   * Deterministic despite depending on the wall clock, because the two zones
   * are 25 hours apart: their local dates always differ by exactly one day.
   * Let U be UTC's date. Either Kiritimati is on U+1 and Niue on U, or
   * Kiritimati is on U and Niue on U-1 — and each case breaks a different
   * half of the old UTC-based logic:
   *
   *   - Kiritimati on U+1: `date > now` reads true for its today, so the
   *     class running that same evening is deleted.
   *   - Niue on U-1: `date >= startOfUtcToday` reads false for its today, so
   *     the surviving class is not counted and the teacher is told nothing is
   *     left while it is still open on their page.
   *
   * One of the two always fires, whichever hour CI runs at.
   */
  it("keys the boundary on the teacher's calendar day, not UTC's", async () => {
    for (const seeded of [east, west]) {
      const teacher = await prisma.teacher.findUniqueOrThrow({
        where: { id: seeded.teacherId },
        select: { defaultTimezone: true },
      });
      const localToday = startOfLocalDay(new Date(), teacher.defaultTimezone);

      const t = await prisma.classTemplate.create({
        data: {
          scheduleRule: {
            create: {
              teacherId: seeded.teacherId,
              kind: 'regular',
              classType: `Zone ${teacher.defaultTimezone}`,
              dayOfWeek: 3,
              startTime: hhmmToTime('09:30'),
              durationMinutes: 60,
            },
          },
          teacherRoom: { connect: { id: seeded.teacherRoomId } },
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 8,
        },
      });
      const c = await createClassFixture(prisma, {
          teacherId: seeded.teacherId,
          teacherRoomId: seeded.teacherRoomId,
          scheduleRuleId: t.scheduleRuleId,
          classType: 'Zone Boundary',
          date: localToday,
          startTime: hhmmToTime('19:00'),
          durationMinutes: 60,
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 1,
          maxStudents: 8,
          status: 'open',
        });

      const archived = expectArchived(
        await archiveOrUnarchiveTemplate(prisma, t.id, seeded.teacherId, 'archived'),
      );

      expect(archived.deleted).toBe(0);
      expect(archived.remaining).toBe(1);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
    }
  });

  it('keeps past classes', async () => {
    const t = await makeTemplate('Keep Past');
    const c = await makeClass(t.scheduleRuleId, { date: past() });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  it('reports deleted and remaining counts', async () => {
    const t = await makeTemplate('Counts');
    const unbooked1 = await makeClass(t.scheduleRuleId, { date: futureOn(5) });
    const unbooked2 = await makeClass(t.scheduleRuleId, { date: futureOn(6) });
    const booked = await makeClass(t.scheduleRuleId, { date: futureOn(7) });
    await register(booked.id, studentId, 'registered');
    await makeClass(t.scheduleRuleId, { date: past() });
    // Future, unbooked, but already `cancelled` — out of the archive rule's
    // scope entirely (scope is `draft`/`open`), so it must be swept into
    // neither the deleted count nor the remaining one.
    const alreadyCancelled = await makeClass(t.scheduleRuleId, { date: futureOn(8), status: 'cancelled' });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    const archived = expectArchived(result);
    expect(archived.deleted).toBe(2);
    expect(archived.remaining).toBe(1);
    expect(await prisma.class.count({ where: { id: unbooked1.id } })).toBe(0);
    expect(await prisma.class.count({ where: { id: unbooked2.id } })).toBe(0);
    expect(await prisma.class.count({ where: { id: booked.id } })).toBe(1);
    expect(await prisma.class.count({ where: { id: alreadyCancelled.id } })).toBe(1);
  });

  it('leaves the window untouched when un-archiving', async () => {
    const t = await makeTemplate('Archive Then Resume');
    const unbooked = await makeClass(t.scheduleRuleId, { date: futureOn(5) });
    const booked = await makeClass(t.scheduleRuleId, { date: futureOn(6) });
    await register(booked.id, studentId, 'registered');

    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );
    expect(archived.deleted).toBe(1);
    expect(archived.remaining).toBe(1);

    const survivingIds = (
      await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: t.id } } } } }, select: { id: true } })
    ).map((c) => c.id);

    const resumed = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'unarchived');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    // Reports the direction and nothing else. Previously this arm returned
    // `deleted: 0, remaining: 0` — indistinguishable from a real archive that
    // matched nothing, even though a booked class is still standing (asserted
    // by `stillSurviving` below).
    expect(resumed.action).toBe('unarchived');
    expect(resumed.template.isArchived).toBe(false);

    const stillSurviving = (
      await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: t.id } } } } }, select: { id: true } })
    ).map((c) => c.id);
    expect(new Set(stillSurviving)).toEqual(new Set(survivingIds));
    expect(await prisma.class.count({ where: { id: unbooked.id } })).toBe(0);
    expect(await prisma.class.count({ where: { id: booked.id } })).toBe(1);
  });

  /**
   * #97. The counts used to live only in the confirmation message, so closing
   * the tab lost them. `withdrawnCount` comes from the `deleteMany`'s own
   * returned count — not a separate query — so the record cannot claim a
   * different number from the one the delete actually removed.
   */
  it('records when it archived and how many classes it withdrew', async () => {
    const t = await makeTemplate('Records Withdrawal');
    await makeClass(t.scheduleRuleId, { date: futureOn(5) });
    await makeClass(t.scheduleRuleId, { date: futureOn(6) });

    const before = Date.now();
    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.deleted).toBe(2);
    expect(archived.template.withdrawnCount).toBe(2);
    expect(archived.template.archivedAt).not.toBeNull();
    expect(archived.template.archivedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(archived.template.archivedAt!.getTime()).toBeLessThanOrEqual(Date.now());

    // The assertions above are all on the value the function *returned*.
    // Re-read the row so this test also proves the write reached the
    // database, not just the response — the two can diverge if the service
    // ever fabricates a return value instead of persisting it. Both columns
    // are checked against the returned value exactly, the timestamp included:
    // a fabricated timestamp is the hardest kind to spot, so `not.toBeNull()`
    // is the one assertion that would wave through the divergence this re-read
    // exists to catch.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.withdrawnCount).toBe(2);
    expect(after.scheduleRule.archivedAt).not.toBeNull();
    expect(after.scheduleRule.archivedAt!.getTime()).toBe(archived.template.archivedAt!.getTime());
  });

  /**
   * The count must equal what was deleted, not what was scheduled. Today's
   * class is spared by the delete's boundary, so the two numbers differ here —
   * which is exactly the case a `count()` written from the wrong query would
   * get wrong while looking right.
   */
  it('records the deleted count, not the scheduled count', async () => {
    const t = await makeTemplate('Withdrawal Excludes Today');
    await makeClass(t.scheduleRuleId, { date: futureOn(5) });
    await makeClass(t.scheduleRuleId, { date: futureOn(6) });
    await makeClass(t.scheduleRuleId, { date: today() });

    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.deleted).toBe(2);
    expect(archived.remaining).toBe(1);
    expect(archived.template.withdrawnCount).toBe(2);
  });

  /**
   * Zero is a real answer and must be distinguishable from "never archived".
   * That distinction is the entire reason both columns are nullable.
   *
   * Which makes it a claim about `0` versus `NULL` in the column, not about
   * the returned object — so the re-read is not decoration here, it is the
   * assertion. A service that returned `0` while leaving the column `NULL`
   * would satisfy every in-memory check and still lose the distinction this
   * test is named for.
   */
  it('records zero when there was nothing to withdraw', async () => {
    const t = await makeTemplate('Nothing To Withdraw');

    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.template.withdrawnCount).toBe(0);
    expect(archived.template.archivedAt).not.toBeNull();

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.withdrawnCount).toBe(0);
    expect(after.scheduleRule.archivedAt).not.toBeNull();
  });

  /**
   * "Cleared", not "never written". Asserting only the trailing nulls cannot
   * tell those two apart — replace the archive arm's record write with `data:
   * {}` and a test that jumps straight from archive to un-archive still
   * passes, having proved nothing.
   *
   * So the midpoint re-read is the load-bearing part: it establishes there was
   * a record in the column to clear. It is also what makes the fixture's future
   * class earn its place, since nothing else here reads what the delete
   * produced.
   */
  it('clears the record when un-archiving', async () => {
    const t = await makeTemplate('Cleared On Resume');
    await makeClass(t.scheduleRuleId, { date: futureOn(5) });
    expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));

    const recorded = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(recorded.scheduleRule.withdrawnCount).toBe(1);
    expect(recorded.scheduleRule.archivedAt).not.toBeNull();

    const resumed = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'unarchived');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');

    expect(resumed.template.archivedAt).toBeNull();
    expect(resumed.template.withdrawnCount).toBeNull();

    // As above: the assertions so far only prove what came back in the
    // response. Re-read the row to prove the clear reached the database.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.archivedAt).toBeNull();
    expect(after.scheduleRule.withdrawnCount).toBeNull();
  });

  /**
   * The `unchanged` guard (`isArchived === archiving`, above) makes archiving
   * twice in a row unreachable — the only way back to the archiving arm is
   * through an un-archive first, and that un-archive already nulled both
   * columns. So what this test actually walks is archive → un-archive →
   * archive again, and what it defends is that the second archive's record
   * reflects what it just withdrew rather than carrying the un-archive's
   * `null` forward. It also rules out an accumulate-style write: `{
   * increment: deleted }` against a NULL column yields NULL in SQL, not a
   * wrong total, so that bug would fail here as `null !== 1` — never as "2".
   */
  it('overwrites the record when archiving a second time', async () => {
    const t = await makeTemplate('Archived Twice');
    await makeClass(t.scheduleRuleId, { date: futureOn(5) });
    await makeClass(t.scheduleRuleId, { date: futureOn(6) });
    expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'unarchived');

    await makeClass(t.scheduleRuleId, { date: futureOn(7) });
    const before = Date.now();
    const second = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(second.deleted).toBe(1);
    expect(second.template.withdrawnCount).toBe(1);
    expect(second.template.archivedAt).not.toBeNull();
    expect(second.template.archivedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(second.template.archivedAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  /**
   * The case the sequential idempotency tests structurally cannot reach. The
   * `isArchived === archiving` fast path reads a row fetched *before* the
   * transaction opens, so it is outside the row lock: two archives issued
   * close enough together both see `false` and both clear it. Before the
   * compare-and-swap, the loser then re-applied the whole archive — its
   * `deleteMany` matched nothing (the winner had already deleted those
   * classes) and it wrote `withdrawnCount: 0` over the winner's correct 2.
   * Display-only, but #97 makes that display the durable record.
   *
   * Deterministic by the same lever `class-generator.test.ts` uses for the
   * #95 races: a third transaction holds the template's row lock without
   * changing anything, and uncommitted work is invisible under READ
   * COMMITTED. That fixes both halves of the ordering the race needs — the
   * second call's pre-transaction read genuinely sees `isArchived: false`
   * (nothing has committed), and both calls' first write genuinely queue on
   * the same lock instead of running back to back.
   *
   * It is also the one test that exercises the Postgres behaviour the fix
   * rests on: the loser blocks inside its `UPDATE`, and when the winner
   * commits, READ COMMITTED re-evaluates the CAS predicate against the row
   * version the winner left (EvalPlanQual) and matches nothing.
   */
  it('two concurrent archives: the loser records nothing over the winner', async () => {
    const t = await makeTemplate('Concurrent Archive');
    await makeClass(t.scheduleRuleId, { date: futureOn(5) });
    await makeClass(t.scheduleRuleId, { date: futureOn(6) });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Holds the row lock and nothing else — no write, so neither archive can
    // observe it, only wait for it.
    const blocking = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ClassTemplate" WHERE "id" = ${t.id} FOR UPDATE`;
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let firstSettled = false;
    const first = archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived').then((r) => {
      firstSettled = true;
      return r;
    });

    // Staggered so the two contend in a known order. The assertions below do
    // not depend on which one wins — Postgres grants tuple-lock waiters FIFO,
    // so it is the first — but the *invariant* is "exactly one of them
    // archives", and asserting it that way is what makes this test about the
    // CAS rather than about lock scheduling.
    await new Promise((r) => setTimeout(r, 100));

    let secondSettled = false;
    const second = archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived').then((r) => {
      secondSettled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 300));
    // Both are blocked in their first write. If either had settled here, the
    // two never contended and the rest of this test would prove nothing.
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    release();
    await blocking;

    const settled = await Promise.all([first, second]);
    const won = settled.find((r) => r.ok && r.action === 'archived');
    const lost = settled.find((r) => r.ok && r.action === 'unchanged');
    if (!won || !lost) {
      throw new Error(
        `expected one archived and one unchanged, got ${settled
          .map((r) => (r.ok ? r.action : r.reason))
          .join(' + ')}`,
      );
    }

    const winner = expectArchived(won);
    expect(winner.deleted).toBe(2);
    expect(winner.template.withdrawnCount).toBe(2);

    if (!lost.ok) throw new Error('expected ok');
    // The loser reports the state the winner left, not the pre-race snapshot
    // it read at the top of its own call — that one still said `isArchived:
    // false`, which by then is exactly the value the winner had falsified.
    expect(lost.template.isArchived).toBe(true);
    expect(lost.template.withdrawnCount).toBe(2);

    // The durable record, which is what #97 is for: the winner's count and
    // the winner's timestamp, not the loser's `0` and `now`.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.withdrawnCount).toBe(2);
    expect(after.scheduleRule.archivedAt).not.toBeNull();
    expect(after.scheduleRule.archivedAt!.getTime()).toBe(winner.template.archivedAt!.getTime());
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: t.id } } } } } })).toBe(0);
  });

  /**
   * #100. `archiveOrUnarchiveTemplate` carries no P2025 guard, and the comment
   * on its compare-and-swap justifies that with "the zero-count branch below
   * already answers `not_found` by re-reading". Until now nothing exercised
   * that re-read: the only other archive `not_found` assertion in this file
   * passes a ghost id, which the guard at the *top* of the function answers
   * without ever opening the transaction.
   *
   * This is the path where the row is real when the function starts and gone
   * when the CAS runs, so `updateMany` matches nothing, `count` is 0, and the
   * inner `findUnique` legitimately returns `null` — the only way that null
   * branch is reachable at all. Two mutants live here without it: turning the
   * inner read into a `findUniqueOrThrow` (its P2025 would escape the
   * transaction as a 500), and dropping the null check to report the
   * pre-transaction snapshot as `unchanged` (a 200 describing a template that
   * no longer exists).
   *
   * Interposed on `classTemplate.findUnique`, which both reads go through: the
   * latch fires on the outer one, deleting the row after it has been read, and
   * no-ops on the inner one, which then sees the delete for real.
   */
  it('answers not_found when the row disappears between the read and the compare-and-swap', async () => {
    const t = await makeTemplate('P2025 Archive CAS');

    let deleted = false;
    // Same cast, same reason as the `interposing` clients in the
    // `updateClassTemplate` block above.
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!deleted) {
              deleted = true;
              await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: t.id } } } },
    });
              await prisma.classTemplate.delete({ where: { id: t.id } });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await archiveOrUnarchiveTemplate(interposing, t.id, teacherId, 'archived');

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('pauseOrResumeTemplate (DB)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let otherRoomId: string;

  // Counter-derived startTime: this block calls makeTemplate 9 times for one
  // teacher/dayOfWeek, and pausing (unlike archiving) never sets
  // isArchived, so a merely-paused template keeps occupying its slot for
  // the rest of the run — only the two tests that go on to archive their
  // template free theirs. No test reads or asserts a created template's
  // literal startTime *except* "reports what the window holds when a slot
  // is already taken" below, which hardcodes '09:30' three times to match
  // a manually-inserted "occupied" class against the template's own
  // generated occurrences — that one call takes an explicit override
  // instead of the counter-derived default.
  //
  // `ScheduleRule_teacher_slot_excl` (issue 298) excludes on RANGE overlap,
  // so each counter-derived slot is spaced a full `durationMinutes` (60)
  // from the last, not just a minute — nine slots that way still lands
  // inside one day (`'10:30'` .. `'18:30'`), each starting no earlier than
  // the override's own slot ends (`'10:30'`), so the two schemes can never
  // overlap.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string, startTime?: string) => {
    makeTemplateCounter += 1;
    return prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'regular',
            classType,
            dayOfWeek: 3,
            startTime: hhmmToTime(startTime ?? slotTime(30 + makeTemplateCounter * 60)),
            durationMinutes: 60,
          },
        },
        teacherRoom: { connect: { id: teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
      include: { scheduleRule: true },
    });
  };

  const makeClass = (scheduleRuleId: string, date: Date, startTime: string) =>
    createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        scheduleRuleId,
        classType: 'Pause Rule',
        date,
        startTime: hhmmToTime(startTime),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'open',
      });

  beforeAll(async () => {
    await prisma.$connect();
    const seeded = await seedTeacher('pause');
    teacherId = seeded.teacherId;
    accountId = seeded.accountId;
    roomId = seeded.roomId;
    teacherRoomId = seeded.teacherRoomId;

    const other = await seedTeacher('pause-other');
    otherTeacherId = other.teacherId;
    otherAccountId = other.accountId;
    otherRoomId = other.roomId;
  });

  afterAll(async () => {
    for (const [t, r, a] of [
      [teacherId, roomId, accountId],
      [otherTeacherId, otherRoomId, otherAccountId],
    ] as const) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: t } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId: t } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: t } });
      await prisma.room.delete({ where: { id: r } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('pausing an active template deletes nothing and reports the furthest-out scheduled class', async () => {
    const t = await makeTemplate('Pause Active');
    const soon = await makeClass(t.scheduleRuleId, futureOn(3), '08:00');
    const later = await makeClass(t.scheduleRuleId, futureOn(10), '19:00');

    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    if (result.action !== 'paused') throw new Error('expected the paused action');
    expect(result.template.isActive).toBe(false);
    expect(result.lastScheduled).not.toBeNull();
    if (!result.lastScheduled) throw new Error('expected lastScheduled');
    expect(result.lastScheduled.date.toISOString().slice(0, 10)).toBe(
      later.calendarEntry.date.toISOString().slice(0, 10),
    );
    expect(result.lastScheduled.startTime).toBe('19:00');
    // Deletes nothing: pausing withdraws no already-generated class — that is
    // archiving's job, not pausing's.
    expect(await prisma.class.count({ where: { id: soon.id } })).toBe(1);
    expect(await prisma.class.count({ where: { id: later.id } })).toBe(1);
  });

  it('resuming a paused template regenerates its instance window', async () => {
    const t = await makeTemplate('Resume Regenerates');

    const paused = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');
    expect(paused.ok).toBe(true);
    if (!paused.ok) throw new Error('expected ok');
    expect(paused.template.isActive).toBe(false);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: t.id } } } } } })).toBe(0);

    const resumed = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    expect(resumed.template.isActive).toBe(true);
    // The rolling window materializes classes where a moment ago there were
    // none — the regeneration this test exists to prove wasn't silently
    // dropped when the PATCH route's logic was moved into this function.
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: t.id } } } } } })).toBeGreaterThan(0);
  });

  /**
   * A manually created class (templateId null) occupies one of the resume's
   * candidate slots, so the resume creates three and reports the occupied date
   * as `slotTaken`. `scheduled` counts the three it created for this template —
   * the manual class belongs to no template, so it is not counted here.
   */
  it('reports what the window holds when a slot is already taken', async () => {
    // Explicit '09:30' override: the candidate/manual-class computation
    // below hardcodes '09:30' to match what this template will generate, so
    // it can't take the counter-derived default the other calls in this
    // block use.
    const t = await makeTemplate('Slot Taken Report', '09:30');
    await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');

    const candidates = getNextOccurrences(3, new Date(), 5)
      .filter((d) => classStartInstant(d, hhmmToTime('09:30'), 'UTC') > new Date())
      .slice(0, 4);
    await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        scheduleRuleId: null,
        classType: 'Manual',
        date: candidates[0]!,
        startTime: hhmmToTime('09:30'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        cancelDeadline: 'HOURS_24',
        autoCancelCheck: 'HOURS_2',
        status: 'open',
      });

    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');

    expect(result).toMatchObject({
      ok: true,
      action: 'active',
      added: 3,
      counts: { slotTaken: 1 },
    });
    if (result.ok && result.action === 'active') {
      expect(result.scheduled).toBe(3);
      expect(result.counts.blockedByCancelled).toBe(0);
    }
  });

  /**
   * The mirror of the case above, and the reason it has to exist: until this
   * test, `blockedByCancelled` was only ever asserted at **zero**, in a window
   * whose skips were all `slot_taken`. Re-pointing its filter to
   * `already_generated` therefore passed every test in the repo — while telling
   * a teacher resuming a perfectly healthy template "4 classes on your
   * schedule. 4 cancelled classes still hold those dates.", because a resumed
   * window whose four dates are already generated is the *common* case (pausing
   * deletes nothing).
   *
   * Three of four cancelled, not two: with two, `blocked_by_cancelled` and
   * `already_generated` are both 2, so the mis-wired filter returns the right
   * number by coincidence and the test passes against the bug. Measured — the
   * first version of this test did exactly that. Three and one cannot collide.
   */
  it('counts cancelled dates separately from taken slots', async () => {
    const t = await makeTemplate('Blocked By Cancelled Report');
    // Generate the window, then cancel two of the four dates it created.
    await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');
    await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');
    const made = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: t.id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, select: { id: true } });
    expect(made).toHaveLength(4);
    await prisma.calendarEntry.updateMany({
      where: { classes: { some: { id: { in: [made[0]!.id, made[1]!.id, made[2]!.id] } } } },
      data: { cancelledAt: new Date() },
    });

    await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');
    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');

    expect(result).toMatchObject({
      ok: true,
      action: 'active',
      added: 0,
      counts: { blockedByCancelled: 3 },
    });
    if (result.ok && result.action === 'active') {
      // One survivor, still draft/open — cancelled rows are excluded from
      // `scheduled` by SCHEDULED_STATUSES. Also the `already_generated` count,
      // which is what a mis-wired filter would report instead of 3.
      expect(result.scheduled).toBe(1);
      expect(result.counts.slotTaken).toBe(0);
    }
  });

  it('pausing a template with no scheduled classes reports lastScheduled: null', async () => {
    const t = await makeTemplate('Pause Empty');

    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    if (result.action !== 'paused') throw new Error('expected the paused action');
    expect(result.lastScheduled).toBeNull();
  });

  /**
   * A fresh template's `isActive` defaults `true`, so requesting 'active' as
   * a non-owner asks for the state the row is already in — the one case that
   * would let a swapped guard order answer `unchanged` (and hand a non-owner
   * the row) instead of `forbidden`. Every other case in this file requests a
   * state the row is NOT already in, so it cannot tell the two orderings
   * apart.
   */
  it("returns forbidden for another teacher's template already in the requested state, and writes nothing", async () => {
    const t = await makeTemplate('Owner Active, Foreign Request');

    const result = await pauseOrResumeTemplate(prisma, t.id, otherTeacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(true);
  });

  it("returns 'archived' for an archived template rather than toggling", async () => {
    const t = await makeTemplate('Pause Archived');
    const archived = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');
    expect(archived.ok).toBe(true);

    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'archived' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(false);
  });

  /**
   * The guard order in `pauseOrResumeTemplate` is deliberate: `unchanged`
   * must be checked before the `archived` guard, because archiving forces
   * `isActive: false` — so `?state=paused` on an archived template is
   * already true and there is nothing to refuse. Swap the two guards and
   * every other test in this file still passes; only this one would start
   * seeing a 409 (`reason: 'archived'`) where it should see a 200
   * `unchanged` — reachable from exactly the stale-tab case #98 is about:
   * tab A archives, tab B still shows an active template and offers "Pause
   * recurring class".
   */
  it('an archived template is already paused — pausing it again is unchanged, not a 409', async () => {
    const t = await makeTemplate('Archived Then Paused');
    const archived = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');
    expect(archived.ok).toBe(true);

    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.action).toBe('unchanged');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(false);
    expect(after.scheduleRule.isArchived).toBe(true);
  });

  /**
   * #100, and since #116 by a different mechanism — worth stating, because the
   * test passes either way and a reader debugging a 404 here would otherwise
   * hunt for a guard that no longer exists.
   *
   * The read and the write are still not one transaction, so a delete can
   * still land between them. What changed is the write: it used to be a
   * single-record `update` raising P2025, caught and mapped to `not_found`
   * (before #100 that escaped as a 500, which is what this originally pinned).
   * It is now a CAS whose `updateMany` matches zero rows, and `not_found`
   * comes from the miss branch's `findUnique` returning null. No P2025, no
   * guard — the same answer down a different path, and this test is what
   * proves that path exists.
   *
   * Interposed rather than raced: the extension below performs the real read
   * and then deletes the row before returning it, which *is* the interleaving
   * the guard exists for. A two-connection race would only reach the same
   * state less reliably.
   */
  it('maps a delete landing between the read and the write to not_found', async () => {
    const t = await makeTemplate('Deleted Pause');
    await prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { isActive: false } });

    let deleted = false;
    // Cast for the same reason as `interposing` above: the
    // extended client is missing `$on`, so it is not assignable to
    // `pauseOrResumeTemplate`'s `PrismaClient`-typed `db` parameter, and
    // reusing the existing stub-client cast is the only accepted way past
    // that without loosening the parameter's type.
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!deleted) {
              deleted = true;
              await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: t.id } } } },
    });
              await prisma.classTemplate.delete({ where: { id: t.id } });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  /**
   * The window this test drives is the one the pre-transaction guards cannot
   * cover: the `findUnique` at the top of the function and the transaction's
   * first write are not one statement, so an archive committing in between is
   * invisible to the guard that already passed. Before the CAS, the write's
   * `where` was `{ id }` alone and simply did not notice — it set
   * `isActive: true` on a row that had just been archived and then generated a
   * four-week window onto it. `pauseOrResumeStudioTemplate`'s docblock
   * describes exactly this failure for its own family, which is why the fix is
   * a port rather than an invention.
   */
  it('answers archived when an archive lands between the read and the write', async () => {
    const t = await makeTemplate('Archive Race');
    await prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { isActive: false } });

    let archived = false;
    // Cast for the same reason the sibling tests' `interposing` clients need
    // one: the extended client is missing `$on`, so it is not assignable to
    // `pauseOrResumeTemplate`'s `PrismaClient`-typed `db` parameter.
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!archived) {
              archived = true;
              await prisma.scheduleRule.update({
                where: { id: t.scheduleRuleId },
                data: { isArchived: true, isActive: false, archivedAt: new Date() },
              });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'archived' });

    // The refusal is not the whole guarantee: assert the two states the old
    // code actually corrupted. Without these, dropping `isArchived: false`
    // from the CAS and answering `archived` from a stale read would pass.
    const after = await prisma.classTemplate.findUnique({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after?.scheduleRule.isActive).toBe(false);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: t.id } } } } } })).toBe(0);
  });

  it('answers unchanged when a pause lands between the read and the write', async () => {
    const t = await makeTemplate('Pause Race');

    let paused = false;
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!paused) {
              paused = true;
              await prisma.scheduleRule.update({
                where: { id: t.scheduleRuleId },
                data: { isActive: false },
              });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe('unchanged');
    // The PAYLOAD, not just the arm. `ResumeTransactionOutcome`'s docblock
    // claims none of its arms carries the stale pre-transaction snapshot, and
    // `unchanged` is the one that has to earn it from a plain re-read rather
    // than from under the CAS's lock. Without this, returning the stale `bare`
    // instead of the re-read passes every other assertion in this file —
    // measured — and `api/class-templates/[id]/route.ts` spreads this template
    // onto the wire, so the settings toggle would render `isActive: true` for
    // a template that is in fact paused.
    if (result.ok && result.action === 'unchanged') {
      expect(result.template.isActive).toBe(false);
    }
  });

  /**
   * An archived row racing a *pause* is simultaneously "already the desired
   * state" (archiving forces `isActive: false`) and "archived". The miss
   * branch must answer `unchanged`, matching the fast path above it — checking
   * `isArchived` first would answer a plain pause with a 409 meant for
   * resuming an archived template. A racing *resume* is not already-desired,
   * so it falls through to `isArchived` regardless of order; only this
   * direction can tell the two orderings apart.
   */
  it('answers unchanged, not archived, when an archive races a pause', async () => {
    const t = await makeTemplate('Order Race');

    let archived = false;
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!archived) {
              archived = true;
              await prisma.scheduleRule.update({
                where: { id: t.scheduleRuleId },
                data: { isArchived: true, isActive: false, archivedAt: new Date() },
              });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe('unchanged');
  });

  /**
   * The claim's observable effect, stated as a race rather than as a lock:
   * while `pauseOrResumeTemplate` generates, a concurrent `Class` insert for
   * this template cannot proceed — and with the claim removed, it can.
   *
   * The mechanism is the mode. `claimTemplateForGeneration` takes `FOR UPDATE`
   * on the `ClassTemplate` row, which conflicts with a concurrent
   * `FOR KEY SHARE` on it; the CAS above it takes `FOR NO KEY UPDATE`, which
   * does not. So the claim is the only thing in this transaction that can
   * block such a writer, and this test drives the collision from the other
   * side: the holder takes `FOR KEY SHARE` first, and the resume must then
   * fail to get its `FOR UPDATE` inside the 2s `setLockTimeout` bound and
   * answer `busy`.
   *
   * THE HOLDER TAKES THAT LOCK DIRECTLY SINCE #327, and the reason is a
   * property this test used to rely on and no longer has. It used to insert a
   * `Class` for the template and let the FK check take `FOR KEY SHARE` on
   * `ClassTemplate` for free. `Class.templateId` is gone: a class hangs off a
   * `CalendarEntry`, and the entry's own FK reaches `ScheduleRule`, not
   * `ClassTemplate` — so inserting a class no longer touches the row this
   * claim holds at all. The claim still serialises generation against
   * pause/resume and archive, which take that row explicitly and are what #95
   * is about; what it stopped doing is blocking an unrelated insert. Named
   * here rather than smoothed over, because the incidental protection is the
   * kind of thing that is missed when it goes.
   *
   * The statement is still what discriminates: with the claim removed the
   * resume takes only `FOR NO KEY UPDATE`, never conflicts with the holder,
   * and succeeds.
   *
   * Why not a `FOR KEY SHARE NOWAIT` probe interposed on the generator's own
   * queries, which is what an earlier version of this test did: a second
   * `PrismaClient`'s query does not run while a Prisma interactive
   * transaction is in flight in the same process. Measured — the probe
   * returned after 9982ms, i.e. only once the resume's 10s transaction
   * budget expired and released everything, so it reported "granted" whether
   * or not the claim was ever held. `NOWAIT` was never the problem: the same
   * statement against a psql-held `FOR UPDATE` is refused in 5ms through this
   * same Prisma client. The probe simply never ran while the lock existed.
   */
  it(
    'blocks a concurrent Class insert while generating, and answers busy',
    async () => {
      const t = await makeTemplate('Claim Blocks Insert');
      await prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { isActive: false } });

      const holder = new PrismaClient();
      let release!: () => void;
      let holdEstablished!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      const holding_ = new Promise<void>((r) => {
        holdEstablished = r;
      });

      const holding = holder.$transaction(
        async (tx) => {
          // `FOR KEY SHARE` on the template row, taken directly — see the
          // docblock for why this is no longer a side effect of inserting a
          // class. Nothing else here touches a row the resume wants, so the
          // only reason it can wait is this lock.
          await tx.$queryRaw`
            SELECT "id" FROM "ClassTemplate" WHERE "id" = ${t.id} FOR KEY SHARE`;
          holdEstablished();
          await released;
        },
        { timeout: 30_000 },
      );

      try {
        await holding_;
        const startedAt = Date.now();
        const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');
        const waited = Date.now() - startedAt;

        expect(result).toEqual({ ok: false, reason: 'busy' });
        // The 2s bound, not the 10s transaction budget: proves the wait was a
        // lock wait cut short by `setLockTimeout`, not a transaction expiry.
        expect(waited).toBeGreaterThanOrEqual(1_800);
        expect(waited).toBeLessThan(5_000);

        // The rollback took the flag with it.
        const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
        expect(after.scheduleRule.isActive).toBe(false);
      } finally {
        release();
        await holding;
        await holder.$disconnect();
      }
    },
    30_000,
  );

  /**
   * The CAS's miss branch has a fourth state, and it is reachable: the re-read
   * finds the row neither already in the desired state nor archived. Driven
   * here with the `$extends` lever the tests above use, interposed on the CAS
   * itself — a resume commits before it (so the CAS misses on `isActive`) and
   * a pause commits after it, before the re-read.
   *
   * Two tabs get there: A resumes and then pauses while B's resume is in
   * flight. `busy` is the answer because the CAS matched zero rows, so B wrote
   * nothing and rolled back clean — a retry wins. An earlier version of this
   * branch threw instead, which the route rendered as a 500 logged at `error`.
   */
  it('answers busy when the CAS miss lands in the residual fourth state', async () => {
    const t = await makeTemplate('Residual Race');
    await prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { isActive: false } });

    let straddled = false;
    const interposing = prisma.$extends({
      query: {
        scheduleRule: {
          async updateMany({ args, query }) {
            if (straddled) return query(args);
            straddled = true;
            await prisma.scheduleRule.update({
              where: { id: t.scheduleRuleId },
              data: { isActive: true },
            });
            const swapped = await query(args);
            await prisma.scheduleRule.update({
              where: { id: t.scheduleRuleId },
              data: { isActive: false },
            });
            return swapped;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'active');

    expect(straddled).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'busy' });

    // Nothing was written: the CAS matched no row, so the rollback leaves the
    // template exactly as the interposed pause left it.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(false);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: t.id } } } } } })).toBe(0);
  });
});
