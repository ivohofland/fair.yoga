import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { studioClassDeletability } from './studio-class-deletion';
import { generateStudioInstancesForTemplate } from './studio-class-generator';
import { hhmmToTime } from '@/lib/time-of-day';

const AMS = 'Europe/Amsterdam';
const NYC = 'America/New_York';

/** A `@db.Date` value — midnight UTC of the calendar date, as Prisma returns one. */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('studioClassDeletability', () => {
  // 2026-06-15T12:00Z is 14:00 in Amsterdam and 08:00 in New York — the same
  // calendar date in both, so it isolates the template/past axis from the zone
  // axis, which gets its own describe below.
  const now = new Date('2026-06-15T12:00:00.000Z');

  describe('the matrix', () => {
    it('allows a manual class that has not started', () => {
      expect(
        studioClassDeletability({ scheduleRuleId: null, date: d('2026-06-20') }, now, AMS),
      ).toEqual({ deletable: true });
    });

    it('allows a manual class dated today, which no date rule may refuse', () => {
      // The first disjunct short-circuits, so the calendar-date rule below never
      // runs. This is the case that separates "manual" from "past": a teacher
      // who mislogged this morning's studio class clears it this morning.
      expect(
        studioClassDeletability({ scheduleRuleId: null, date: d('2026-06-15') }, now, AMS),
      ).toEqual({ deletable: true });
    });

    it('refuses a generated class dated in the future, because the sweep would create it again', () => {
      expect(
        studioClassDeletability({ scheduleRuleId: 'tpl-1', date: d('2026-06-20') }, now, AMS),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });

    it('allows a generated class dated before today, which the sweep cannot reach', () => {
      expect(
        studioClassDeletability({ scheduleRuleId: 'tpl-1', date: d('2026-06-10') }, now, AMS),
      ).toEqual({ deletable: true });
    });
  });

  /**
   * THE CASE THIS RULE EXISTS FOR, and the one a start-instant rule got wrong.
   *
   * The predicate cannot ask "has this class started", because the class's
   * `startTime` is a STAMP and the generator filters on the TEMPLATE's current
   * one (`studio-class-generator.ts:141`, `:177`). Editing a template moves the
   * template's and leaves the class's untouched — "a template is a stamp, not a
   * live link" — so the two disagree by design, and the start-instant reading
   * answered from the wrong one.
   *
   * Worked: template moved Wed 09:00 → 19:00. The standing class keeps 09:00.
   * At 10:30 its own start has passed, so the old rule allowed removal — and
   * the sweep, filtering on 19:00, found that instant still ahead, found
   * `(scheduleRuleId, date)` freed by the removal, and re-inserted on the same date
   * within the hour. A delete that undid itself.
   *
   * The calendar-date rule is immune rather than merely careful: the latest
   * instant any start time can name on a date is 23:59 local, which precedes
   * the next local midnight. So if the date is strictly before the teacher's
   * today, EVERY start time on it has passed and the generator's `> now` filter
   * excludes the date whatever the template says. No `startTime` is consulted,
   * which is why the parameter no longer carries one.
   */
  describe('a generated class dated today is refused, whatever its start time', () => {
    it('refuses one whose own start passed hours ago', () => {
      // 09:00 Amsterdam on 2026-06-15 is 07:00Z; `now` is 12:00Z. Started, and
      // still refused, because the template may name a later hour today.
      expect(
        studioClassDeletability({ scheduleRuleId: 'tpl-1', date: d('2026-06-15') }, now, AMS),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });

    it('refuses one at the last minute of the teacher’s day', () => {
      // 23:58 local Amsterdam — the date is still today, so still refused.
      expect(
        studioClassDeletability(
          { scheduleRuleId: 'tpl-1', date: d('2026-06-15') },
          new Date('2026-06-15T21:58:00.000Z'),
          AMS,
        ),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });

    it('allows it once the teacher’s day has rolled over', () => {
      // 00:30 Amsterdam on the 16th. The 15th is now strictly past, locally.
      expect(
        studioClassDeletability(
          { scheduleRuleId: 'tpl-1', date: d('2026-06-15') },
          new Date('2026-06-15T22:30:00.000Z'),
          AMS,
        ),
      ).toEqual({ deletable: true });
    });
  });

  /**
   * BOTH DIRECTIONS, DELIBERATELY. A single zone proves nothing: run only the
   * east-of-UTC case and a UTC-naive implementation still fails it, but run
   * only a case where local and UTC agree and every implementation passes.
   * `prisma/seed.ts:622-625` records that exact failure for the class family.
   *
   * Both instants below are chosen so the teacher's calendar date DISAGREES
   * with UTC's — comparing `sc.date` against `new Date()` gets each one wrong,
   * in opposite directions.
   */
  describe('the zone decides which day is today, not UTC', () => {
    it('east of UTC: past midnight in Amsterdam, yesterday is removable though UTC still calls it today', () => {
      // 2026-06-15T22:30Z is 00:30 on the 16th in Amsterdam. A UTC reading puts
      // "today" at the 15th and refuses a class dated the 15th.
      expect(
        studioClassDeletability(
          { scheduleRuleId: 'tpl-1', date: d('2026-06-15') },
          new Date('2026-06-15T22:30:00.000Z'),
          AMS,
        ),
      ).toEqual({ deletable: true });
    });

    it('west of UTC: still the 14th in New York, so the 14th is refused though UTC calls it yesterday', () => {
      // 2026-06-15T02:30Z is 22:30 on the 14th in New York. A UTC reading puts
      // "today" at the 15th and would allow removing a class dated the 14th —
      // which is still today for this teacher, and still a generator candidate.
      expect(
        studioClassDeletability(
          { scheduleRuleId: 'tpl-1', date: d('2026-06-14') },
          new Date('2026-06-15T02:30:00.000Z'),
          NYC,
        ),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });
  });

  /**
   * FAIL CLOSED, PINNED RATHER THAN INHERITED. Without the explicit guard this
   * happens to be correct by the polarity of the comparison — `NaN > date` is
   * false, so it falls through to the refusal. That is a property a refactor
   * can invert while looking equivalent: rewriting the last two lines as
   * `if (startOfLocalDay(...) <= sc.date) return refuse; return allow;` reads
   * the same and silently removes classes with an unreadable date.
   */
  it('refuses a generated class whose date cannot be read', () => {
    expect(
      studioClassDeletability({ scheduleRuleId: 'tpl-1', date: new Date('nonsense') }, now, AMS),
    ).toEqual({ deletable: false, reason: 'regenerates' });
  });

  /**
   * THE PARAMETER TYPE IS THE GUARD, and this is the ONLY place that can prove
   * it — see the docblock in `studio-class-deletion.ts`.
   *
   * Not because of excess-property checking: an OPTIONAL widening
   * (`template?: …`) is legal to supply and legal to omit, so every production
   * call site compiles either way, literal or variable. What catches it is this
   * directive. Under a widening the line below stops being an error, and an
   * unused `@ts-expect-error` is itself `TS2578` — so `tsc` fails here, and
   * measurably nowhere else.
   *
   * DO NOT DELETE THIS CASE. It is the entire alarm.
   */
  it('refuses template state at the type level', () => {
    studioClassDeletability(
      // @ts-expect-error template state is reversible and must not reach the predicate
      { scheduleRuleId: 'tpl-1', date: d('2026-06-10'), template: { isArchived: true } },
      now,
      AMS,
    );
  });
});

/**
 * WHAT REMOVING A PAST GENERATED CLASS DOES TO ITS WEEK (issue 284), and the
 * first moment it is observable — `studio-class-deletion.ts`'s own docblock
 * names this test.
 *
 * Week-keyed generation (`entry-generation.ts`) gives a template at most one
 * class per week, holding the week whether the class is future, past, or
 * cancelled — there is no liveness filter on that read, deliberately.
 * Removing a class does not touch that rule; it removes the row that was
 * holding the week. So a candidate the sweep skipped as `already_this_week`
 * before the removal can be `already_this_week`'s opposite — created —
 * after, with nothing about the week rule itself having changed.
 *
 * BOTH HALVES ARE ASSERTED, deliberately, because the first is what makes the
 * second mean anything. A generator that never had a week key at all — one
 * degraded back to a per-DATE key — fills the Thursday candidate below
 * regardless of whether anything was removed, because nothing on that exact
 * date ever blocked it. Asserting only the CREATE after removal cannot tell
 * that generator apart from this one; the `already_this_week` skip BEFORE
 * removal is what a per-date key cannot produce, and pinning it is what makes
 * the CREATE after removal mean "the week was freed" rather than "this
 * generator always fills that date".
 */
describe('a removed past generated class frees its week (issue 284)', () => {
  const prisma = new PrismaClient();
  const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // Schema convention: 0=Mon, 1=Tue, ..., 6=Sun.
  const TUESDAY = 1;
  const THURSDAY = 3;

  // Verified (not merely asserted) by `date -j -f '%Y-%m-%d' <date> '+%A'`:
  // 2026-04-06 Monday, -07 Tuesday, -09 Thursday, -14 Tuesday, -16 Thursday.
  // Only week 1 needs naming as individual dates — the other three weeks are
  // exercised only through their skip *count*, never their own dates.
  const WEEK1_MONDAY = d('2026-04-06');
  const WEEK1_TUESDAY = d('2026-04-07');
  const WEEK1_THURSDAY = d('2026-04-09');
  // The generator's own `from`: a fixed instant, not `new Date()`, so this
  // test's candidate dates do not depend on when the suite runs.
  const FROM = WEEK1_MONDAY;
  // Comfortably after `WEEK1_MONDAY` in `AMS`, and comfortably before every
  // other week's Tuesday — the gap is what makes the calendar-date comparison
  // in `studioClassDeletability` unambiguous without pinning an exact offset.
  const DELETION_NOW = new Date('2026-04-08T12:00:00.000Z');

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('is already_this_week before removal, and fills after', async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'StudioDelWeek',
        lastName: 'Teacher',
        email: `studiodel-week-${uniqueSuffix}@test.local`,
        account: { create: { email: `studiodel-week-${uniqueSuffix}@test.local` } },
        bio: 'studio-class-deletion week-freeing test (issue 284)',
        pageSlug: `studiodel-week-${uniqueSuffix}`,
        defaultTimezone: AMS,
      },
    });

    const template = await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: teacher.id,
            kind: 'studio',
            classType: 'Week Freeing',
            dayOfWeek: TUESDAY,
            startTime: hhmmToTime('09:00'),
            durationMinutes: 45,
            isActive: true,
          },
        },
        location: 'Week Freeing Studio',
        hourlyRate: 40,
      },
    });
    const scheduleRuleId = template.scheduleRuleId;

    /** Loads the template in the shape the generator takes, freshly each call. */
    const withZone = () =>
      prisma.studioClassTemplate.findUniqueOrThrow({
        where: { id: template.id },
        include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
      });

    try {
      // 1. Generate the four-week window on Tuesdays.
      const seeded = await generateStudioInstancesForTemplate(prisma, await withZone(), FROM);
      expect(seeded.created).toBe(4);

      // 2. Age week 1's class into the past by writing its date directly —
      //    the file's own convention (`tests/integration/studio-api.test.ts`'s
      //    `PAST` fixtures) rather than mocking the system clock, and the only
      //    option here regardless: the generator only ever creates dates ahead
      //    of its own `from`, so nothing it produces is already past on
      //    arrival. Moved to this week's Monday — still inside the same
      //    Monday-bounded week `isWeekHeld` reads, so the week stays held by
      //    this same row; only which day of that week it sits on changes.
      const week1 = await prisma.studioClass.findFirstOrThrow({
        where: { calendarEntry: { scheduleRuleId, date: WEEK1_TUESDAY } },
        select: { calendarEntryId: true },
      });
      await prisma.calendarEntry.update({
        where: { id: week1.calendarEntryId },
        data: { date: WEEK1_MONDAY },
      });

      // 3. Move the template to Thursday and generate again, before removing
      //    anything. THE BEFORE HALF: every week is still held, week 1 by the
      //    aged row rather than by a Thursday of its own.
      await prisma.scheduleRule.update({
        where: { id: scheduleRuleId },
        data: { dayOfWeek: THURSDAY },
      });
      const beforeRemoval = await generateStudioInstancesForTemplate(
        prisma,
        await withZone(),
        FROM,
      );
      expect(beforeRemoval.created).toBe(0);
      expect(beforeRemoval.skipped.map((s) => s.reason)).toEqual([
        'already_this_week',
        'already_this_week',
        'already_this_week',
        'already_this_week',
      ]);

      // 4. Remove week 1's now-past class through the deletion path: the
      //    predicate first, then the same statement the route takes on a
      //    `deletable: true` verdict (`api/studio-classes/[id]/route.ts`) —
      //    the entry, not the child, since the entry is what holds the week.
      const verdict = studioClassDeletability(
        { scheduleRuleId, date: WEEK1_MONDAY },
        DELETION_NOW,
        AMS,
      );
      expect(verdict).toEqual({ deletable: true });
      await prisma.calendarEntry.delete({ where: { id: week1.calendarEntryId } });

      // 5. Generate again. THE AFTER HALF: week 1 is free and the Thursday
      //    candidate fills it; weeks 2-4 are untouched and still held.
      const afterRemoval = await generateStudioInstancesForTemplate(
        prisma,
        await withZone(),
        FROM,
      );
      expect(afterRemoval.created).toBe(1);
      expect(afterRemoval.skipped.map((s) => s.reason)).toEqual([
        'already_this_week',
        'already_this_week',
        'already_this_week',
      ]);
      expect(
        await prisma.studioClass.findFirst({
          where: { calendarEntry: { scheduleRuleId, date: WEEK1_THURSDAY } },
          select: { id: true },
        }),
      ).not.toBeNull();
    } finally {
      await prisma.calendarEntry.deleteMany({ where: { scheduleRuleId } });
      // `StudioClassTemplate` is `onDelete: Cascade` from `ScheduleRule`
      // (issue 298), so deleting the rule removes the template with it.
      await prisma.scheduleRule.delete({ where: { id: scheduleRuleId } });
      await prisma.teacher.delete({ where: { id: teacher.id } });
      // `account: { create }` above is the only thing that makes this row.
      await prisma.account.delete({ where: { id: teacher.accountId } });
    }
  });
});
