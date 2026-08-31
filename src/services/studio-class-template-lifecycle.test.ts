import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  archiveOrUnarchiveStudioTemplate,
  pauseOrResumeStudioTemplate,
  updateStudioClassTemplate,
  type StudioClassTemplateUpdateData,
} from './studio-class-template-lifecycle';

/**
 * Compile-time pin asserting updateStudioClassTemplate rejects forbidden fields.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _studioTemplateForbiddenFieldsAreRejected(
  db: PrismaClient,
  reparent: StudioClassTemplateUpdateData & { scheduleRuleId: string },
  activeRule: StudioClassTemplateUpdateData & { isActive: boolean },
  archivedRule: StudioClassTemplateUpdateData & { isArchived: boolean },
): Promise<void> {
  // @ts-expect-error `scheduleRuleId` is identity — a plain edit may never re-parent.
  await updateStudioClassTemplate(db, 'never-called', 'never-called', reparent);
  // @ts-expect-error `isActive` belongs to PATCH, never to a plain edit.
  await updateStudioClassTemplate(db, 'never-called', 'never-called', activeRule);
  // @ts-expect-error `isArchived` belongs to PATCH, never to a plain edit.
  await updateStudioClassTemplate(db, 'never-called', 'never-called', archivedRule);
}
import { generateStudioInstancesForTemplate } from './studio-class-generator';
import { getNextOccurrences } from './entry-generation';
import { log } from '@/lib/log';
import { mondayOf } from '@/lib/timezone';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { createClassFixture, createStudioClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`
 * once a block's fixture counter crosses 30. `totalMinutes % 60` is always
 * 0-59 by construction, so the assertion below is a cheap, self-checking
 * proof of that invariant rather than a defence this formula can actually
 * fail — mirrors `class-template-lifecycle.test.ts`'s `slotTime`, added by
 * the same Task 6d review finding: a fixed-width literal
 * (`` `09:${30 + counter}` ``) has no such guarantee, and both describes
 * below were closer to that ceiling than a quick read suggests (14 and 17
 * minutes of headroom, not the 20+ the review's spot check assumed for
 * every counter it didn't individually verify).
 */
function slotTime(totalMinutesFrom9am: number): string {
  const hour = 9 + Math.floor(totalMinutesFrom9am / 60);
  const minute = totalMinutesFrom9am % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  // Postgres's `time` accepts up to '24:00:00' and nothing later, but the
  // shape check below can't see that: `\d{2}` matches '25' and '99' exactly
  // as readily as '09'. Checked here instead, naming the `totalMinutesFrom9am`
  // this was called with — the caller derives that value from its own
  // counter (`base + counter * 60`), so the number here is what lets the
  // next person find which call ran the block out of slots.
  if (hour > 24 || (hour === 24 && minute !== 0)) {
    throw new Error(
      `slotTime(${totalMinutesFrom9am}) would produce '${startTime}', past ` +
        `'24:00:00' — the last time-of-day value Postgres's \`time\` accepts. ` +
        'The caller has run its counter out of slots in this block.',
    );
  }
  if (!/^\d{2}:[0-5]\d$/.test(startTime)) {
    throw new Error(`slotTime produced an invalid startTime: ${startTime}`);
  }
  return startTime;
}

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
      // Pinned, not left to the schema default of `Europe/Amsterdam` (#123).
      // `today()` below is an instant whose `@db.Date` column keeps the UTC
      // calendar date, while the services derive their boundary from
      // `startOfLocalDay(new Date(), defaultTimezone)`. From 22:00 UTC in
      // summer those disagree by a day, so `remaining`'s `gte` missed the
      // survivor the fixture had just created and three tests failed every
      // evening — deterministically, and independently of the runner's own
      // zone, since `vitest.config.ts` pins `TZ`.
      //
      // UTC makes the two sides agree by construction. It does not cost
      // coverage: nothing in this file tests the archive boundary across
      // zones, and the tests that do pin zone-dependent behaviour seed their
      // own explicit zones (see `generateStudioInstancesForTemplate (DB)` in
      // studio-class-generator.test.ts, which uses Kiritimati and Niue).
      defaultTimezone: 'UTC',
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
  // `date` truncates to a calendar day and its entry carries
  // `@@unique([scheduleRuleId, date])`, so tests that put more than one class
  // on the same template need distinct days — plain `future()` called twice
  // would collide.
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let otherTeacherId: string;
  let otherAccountId: string;

  // Counter-derived startTime: every makeTemplate call in this block needs a
  // slot of its own on one teacher/dayOfWeek, because most tests never archive
  // their template (the 'forbidden' cases, and several 'keeps'/'records' cases
  // where archiving matches nothing to withdraw but still runs against a
  // template that stays unarchived until its own later un-archive, if any) —
  // so, mirroring the class family's equivalent block, one unarchived leftover
  // blocks every later makeTemplate call before it even creates a row.
  //
  // `ScheduleRule_teacher_slot_excl` (issue 298) excludes on RANGE overlap,
  // not exact `startTime` match, so each slot is spaced a full
  // `durationMinutes` (60) from the last rather than a minute; the plain
  // `30 + counter` this block used before would have overlapped every
  // neighbour. No test reads or asserts a created template's literal
  // startTime, and `slotTime` throws naming the counter value if the block
  // ever runs out — which is why no call count is written here.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string) => {
    makeTemplateCounter += 1;
    // Two disjoint ranges, the same treatment the pause block below already
    // needed. `counter * 60 - 30` walks `'09:30'` up to `'23:30'` and then
    // runs out: counter 16 computes `'24:30'`, past the last time-of-day
    // Postgres's `time` accepts, and `slotTime` refuses it. Counters past 15
    // use a second, negative-offset expression that fills the morning the
    // first range never reaches — `'00:00'`, `'01:00'`, and so on. Exact
    // multiples of 60, deliberately: a negative argument that is not one puts
    // JavaScript's negative remainder into the minutes, which `slotTime`
    // refuses too. That second range in turn stops before counter 25, which
    // would compute `'09:00'` and overlap the first range's opening slot.
    const startTime =
      makeTemplateCounter <= 15
        ? slotTime(makeTemplateCounter * 60 - 30)
        : slotTime((makeTemplateCounter - 25) * 60);
    return prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'studio',
            classType,
            dayOfWeek: 3,
            startTime: hhmmToTime(startTime),
            durationMinutes: 60,
          },
        },
        location: 'Studio Loft',
        hourlyRate: 45,
      },
    });
  };

  // Closes over the block's own teacherId, like the sibling block's
  // makeTemplate does. `cancelledAt` stands in for the class family's
  // `status`: `StudioClass` has no status column at all.
  //
  // Counter-derived startTime, for the same reason as the class family's
  // equivalent makeClass: several tests here leave their StudioClass
  // uncancelled at a recurring `future()`/`futureOn(n)` date (an
  // already-cancelled one, a kept survivor, or a forbidden request that
  // touches nothing), so a later test's create at the same date can collide
  // under `CalendarEntry_teacher_slot_excl` once the template-level collision
  // above stops masking it. No test here reads or asserts the created
  // class's literal startTime. Routed through `slotTime` (see its docblock)
  // rather than a raw `09:${counter}` literal, matching `makeTemplate`'s own
  // counter above.
  let makeClassCounter = 0;
  const makeClass = (scheduleRuleId: string, opts: { date: Date; cancelledAt?: Date | null }) => {
    makeClassCounter += 1;
    return createStudioClassFixture(prisma, {
        teacherId,
        scheduleRuleId,
        classType: 'Archive Rule',
        date: opts.date,
        startTime: hhmmToTime(slotTime(makeClassCounter)),
        // ONE MINUTE, and it is the counter-spacing that decides it (#327).
        // `CalendarEntry_teacher_slot_excl` is a range overlap now, so
        // fixtures a minute apart must be a minute long or they collide — and
        // this block plants more fixtures on one date than any wider spacing
        // fits in a day. Nothing here reads the duration; what these tests are
        // about is which classes an archive withdraws.
        durationMinutes: 1,
        location: 'Studio Loft',
        hourlyRate: 45,
        cancelledAt: opts.cancelledAt ?? null,
      });
  };

  /** Narrows to the archiving arm — see the class family's test for why. */
  const expectArchived = (result: Awaited<ReturnType<typeof archiveOrUnarchiveStudioTemplate>>) => {
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.action !== 'archived') throw new Error('expected the archiving direction');
    return result;
  };

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
      await prisma.calendarEntry.deleteMany({ where: { teacherId: t } });
      // `StudioClassTemplate` is `onDelete: Cascade` from `ScheduleRule`
      // (issue 298), so deleting the rule removes the template with it.
      await prisma.scheduleRule.deleteMany({ where: { teacherId: t } });
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
    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, otherTeacherId, 'archived');

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(false);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
  });

  /**
   * See the class family's equivalent test for why this specific combination
   * — requesting the state the row is already in, as a non-owner — is the
   * one case that distinguishes "ownership checked first" from "unchanged
   * checked first".
   */
  it("returns forbidden for another teacher's template already in the requested state, and writes nothing", async () => {
    const t = await makeTemplate('Owner Unarchived, Foreign Request');

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, otherTeacherId, 'unarchived');

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isArchived).toBe(false);
  });

  it('deletes a future uncancelled studio class', async () => {
    const t = await makeTemplate('Del Unbooked');
    const c = await makeClass(t.scheduleRuleId, { date: future() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(0);
  });

  it('keeps an already-cancelled future class — it holds its template date, and is not income', async () => {
    const t = await makeTemplate('Keep Cancelled');
    const c = await makeClass(t.scheduleRuleId, { date: future(), cancelledAt: new Date() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
  });

  it("keeps today's class — the date > now boundary", async () => {
    const t = await makeTemplate('Keep Today');
    const c = await makeClass(t.scheduleRuleId, { date: today() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');

    const archived = expectArchived(result);
    expect(archived.template.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
    // The literal `remaining: 0` this replaced would have been wrong here.
    expect(archived.remaining).toBe(1);
  });

  it("reports deleted: 0, remaining: 1 when today's class is the only one scheduled", async () => {
    const t = await makeTemplate('Today Only');
    await makeClass(t.scheduleRuleId, { date: today() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');

    // Nothing was eligible for deletion (today is spared) and the one class
    // on the schedule is today's — the confirmation must say so, not "nothing
    // scheduled any more".
    const archived = expectArchived(result);
    expect(archived.deleted).toBe(0);
    expect(archived.remaining).toBe(1);
  });

  it('keeps past classes', async () => {
    const t = await makeTemplate('Keep Past');
    const c = await makeClass(t.scheduleRuleId, { date: past() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
  });

  it('reports deleted and remaining counts — remaining is 0 with nothing scheduled today', async () => {
    const t = await makeTemplate('Counts');
    const unbooked1 = await makeClass(t.scheduleRuleId, { date: futureOn(5) });
    const unbooked2 = await makeClass(t.scheduleRuleId, { date: futureOn(6) });
    const pastClass = await makeClass(t.scheduleRuleId, { date: past() });
    // Future, uncancelled classes have no registrations to consult at all —
    // there is no charged-status filter, so every one of them beyond today is
    // deletable. None of these is dated today, so `remaining` — which now
    // only ever counts a today survivor — is 0 here (see the "keeps today's
    // class" case above for when it is not).
    const alreadyCancelled = await makeClass(t.scheduleRuleId, {
      date: futureOn(7),
      cancelledAt: new Date(),
    });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');

    const archived = expectArchived(result);
    expect(archived.deleted).toBe(2);
    expect(archived.remaining).toBe(0);
    expect(await prisma.studioClass.count({ where: { id: unbooked1.id } })).toBe(0);
    expect(await prisma.studioClass.count({ where: { id: unbooked2.id } })).toBe(0);
    expect(await prisma.studioClass.count({ where: { id: pastClass.id } })).toBe(1);
    expect(await prisma.studioClass.count({ where: { id: alreadyCancelled.id } })).toBe(1);
  });

  it('leaves the window untouched when un-archiving', async () => {
    const t = await makeTemplate('Archive Then Resume');
    const unbooked = await makeClass(t.scheduleRuleId, { date: futureOn(5) });
    const cancelled = await makeClass(t.scheduleRuleId, { date: futureOn(6), cancelledAt: new Date() });

    const archived = expectArchived(
      await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'),
    );
    expect(archived.deleted).toBe(1);
    expect(archived.remaining).toBe(0);

    const resumed = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'unarchived');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    // Reports the direction and nothing else — no zeros that would read like
    // a real archive that happened to match nothing.
    expect(resumed.action).toBe('unarchived');
    expect(resumed.template.isArchived).toBe(false);

    expect(await prisma.studioClass.count({ where: { id: unbooked.id } })).toBe(0);
    expect(await prisma.studioClass.count({ where: { id: cancelled.id } })).toBe(1);
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
      await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'),
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
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
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
      await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'),
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
      await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.template.withdrawnCount).toBe(0);
    expect(archived.template.archivedAt).not.toBeNull();

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
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
    expectArchived(await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'));

    const recorded = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(recorded.scheduleRule.withdrawnCount).toBe(1);
    expect(recorded.scheduleRule.archivedAt).not.toBeNull();

    const resumed = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'unarchived');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');

    expect(resumed.template.archivedAt).toBeNull();
    expect(resumed.template.withdrawnCount).toBeNull();

    // As above: the assertions so far only prove what came back in the
    // response. Re-read the row to prove the clear reached the database.
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
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
    expectArchived(await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'));
    await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'unarchived');

    await makeClass(t.scheduleRuleId, { date: futureOn(7) });
    const before = Date.now();
    const second = expectArchived(
      await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(second.deleted).toBe(1);
    expect(second.template.withdrawnCount).toBe(1);
    expect(second.template.archivedAt).not.toBeNull();
    expect(second.template.archivedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(second.template.archivedAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  /**
   * The studio half of the same race — see the class family's version of this
   * test for the full account of what the compare-and-swap fixes and why a
   * third lock-holding transaction is what makes it deterministic rather than
   * timing-dependent. The two functions are deliberately parallel, and a race
   * fixed in one and not the other is exactly the drift #92 found.
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
        await tx.$queryRaw`SELECT "id" FROM "StudioClassTemplate" WHERE "id" = ${t.id} FOR UPDATE`;
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let firstSettled = false;
    const first = archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived').then(
      (r) => {
        firstSettled = true;
        return r;
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    let secondSettled = false;
    const second = archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived').then(
      (r) => {
        secondSettled = true;
        return r;
      },
    );

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
    // it read at the top of its own call.
    expect(lost.template.isArchived).toBe(true);
    expect(lost.template.withdrawnCount).toBe(2);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.withdrawnCount).toBe(2);
    expect(after.scheduleRule.archivedAt).not.toBeNull();
    expect(after.scheduleRule.archivedAt!.getTime()).toBe(winner.template.archivedAt!.getTime());
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: t.id } } } } } })).toBe(0);
  });

  /**
   * `TemplateFamily.withSlot` (`rule-lifecycle.ts`) advertises as STRUCTURAL
   * that the shared archive cannot spread a joined `scheduleRule` into a
   * response: it is handed the joined row and each family destructures in its
   * own adapter, so nothing in that module ever holds one. The structure is
   * real, but it lives in each family's adapter — rewrite `STUDIO_FAMILY.
   * withSlot` to spread the joined row and the claim is false here with
   * nothing to say so. The class family's twin of this test
   * (`class-template-lifecycle.test.ts`) makes the same argument about
   * `CLASS_FAMILY`'s adapter; neither pins the other's.
   *
   * The un-archiving arm, matching that twin. What would go wrong is silent
   * from end to end: `withSlot` spreads its first argument, `route.ts` spreads
   * the template onto the response body, and
   * `StudioClassTemplateWithSlot` never declares `scheduleRule` — so no caller
   * could type the extra field and no compiler error would find it.
   *
   * `not.toContain`, not a whole-shape assertion: the template row's own
   * fields change with the schema, and this is about one field that must not
   * be there.
   */
  it('un-archiving answers with a flattened template, never the joined rule row', async () => {
    const t = await makeTemplate('No Joined Rule On The Wire');
    const rule = await prisma.scheduleRule.findUniqueOrThrow({ where: { id: t.scheduleRuleId } });
    expectArchived(await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'));

    const resumed = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'unarchived');
    if (!resumed.ok) throw new Error(`expected ok, got ${resumed.reason}`);
    expect(resumed.action).toBe('unarchived');

    expect(Object.keys(resumed.template)).not.toContain('scheduleRule');
    // This assertion IS the guarantee, not a backstop behind a compile-time
    // one. What keeps `teacher` off the wire is that `withSlot` picks the
    // rule's columns by name rather than spreading the rule; `withSlot`'s
    // `rule` parameter being the joined type makes the shipped adapters
    // provably teacher-free but makes no leak a compile error, because an
    // adapter sits where TypeScript applies no excess-property check at all.
    expect(Object.keys(resumed.template)).not.toContain('teacher');
    // The flattening itself still happened — otherwise "no `scheduleRule`"
    // would pass on a response that lost the rule's columns altogether.
    expect(resumed.template.dayOfWeek).toBe(rule.dayOfWeek);
    expect(resumed.template.startTime).toBe(timeToHHmm(rule.startTime));
  });
});

describe('pauseOrResumeStudioTemplate (DB)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let otherTeacherId: string;
  let otherAccountId: string;

  // Counter-derived startTime, not a literal: pausing (unlike archiving)
  // never sets isArchived, so a merely-paused template keeps occupying its
  // slot for the rest of the run — mirroring the class family's equivalent
  // block. No test reads or asserts a created template's literal startTime.
  //
  // `ScheduleRule_teacher_slot_excl` (issue 298) excludes on RANGE overlap,
  // so each slot is spaced a full `durationMinutes` (60) from the last.
  // Calls up to 13 land on `'12:00'`..`'23:00'` plus one more: counter 13's
  // `120 + 13 * 60` computes `'24:00'`, the string `slotTime` allows as
  // Postgres's own last `time`, but `hhmmToTime` parses it as
  // `Date('1970-01-01T24:00:00Z')`, which JavaScript normalizes to
  // `1970-01-02T00:00:00.000Z` — the DATE rolls forward and only the TIME
  // survives into the `@db.Time` column. Counter 13's row is therefore
  // stored as `'00:00'`, confirmed by querying it directly, not as the
  // `'24:00'` its own source expression suggests. Not `'09:xx'` for any of
  // these: the sibling `makeTemplateOn` below reserves `'09:00'`-`'12:00'`
  // on the same teacher/day for its own 3 slots, and the two ranges must not
  // touch. Calls past 13 switch to a second, disjoint range that starts at
  // `'01:00'`, not `'00:00'` — see `makeTemplate` below for why.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string) => {
    makeTemplateCounter += 1;
    // Two disjoint ranges, not one continued sequence. Extending
    // `120 + counter * 60` past counter 13 reaches `'25:00'`, which
    // `slotTime` now refuses (Postgres's `time` stops at `'24:00:00'`), so
    // counters past 13 use a second, negative-offset expression instead:
    // `(counter - 22) * 60` lands counter 14 on `'01:00'`, counter 15 on
    // `'02:00'`, and so on through counter 21's `'08:00'`. Deliberately not
    // `'00:00'`: counter 13 already silently holds that slot (see the block
    // comment above for `hhmmToTime`'s day-rollover), so a row aimed at
    // `'00:00'` collides with it under `ScheduleRule_teacher_slot_excl`. The
    // exclusion constraint is the authority on whether a slot is free — the
    // arithmetic alone cannot show `hhmmToTime`'s day-rollover.
    const startTime =
      makeTemplateCounter <= 13
        ? slotTime(120 + makeTemplateCounter * 60)
        : slotTime((makeTemplateCounter - 22) * 60);
    return prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'studio',
            classType,
            dayOfWeek: 3,
            startTime: hhmmToTime(startTime),
            durationMinutes: 60,
          },
        },
        location: 'Studio Loft',
        hourlyRate: 45,
      },
    });
  };

  const makeClass = (scheduleRuleId: string, date: Date, startTime: string) =>
    createStudioClassFixture(prisma, {
        teacherId,
        scheduleRuleId,
        classType: 'Pause Rule',
        date,
        startTime: hhmmToTime(startTime),
        // ONE MINUTE (#327): callers here space their fixtures a minute apart
        // ('08:00' beside '08:01'), and the slot constraint is a range overlap
        // now — so the duration has to be no wider than that spacing. Nothing
        // in this block reads it.
        durationMinutes: 1,
        location: 'Studio Loft',
        hourlyRate: 45,
      });

  /**
   * A `dayOfWeek` two days out, so a generated window never contains a class
   * dated today. The archive's delete boundary is `gt: today` while the counts
   * are `gte: today`, so a today-dated class changes the expected numbers in
   * the two tests below — and whether one exists depends on what weekday the
   * suite happens to run on. Pinned rather than left to chance: a test whose
   * expectations shift with the calendar is the #138 shape, where a check
   * passed because both code paths agreed at the hour it ran.
   *
   * Two days rather than one so a run that crosses local midnight cannot turn
   * "tomorrow" into "today" mid-test.
   *
   * This helper is only date-independent because `seedTeacher` pins
   * `defaultTimezone: 'UTC'` (see its comment, which #123 put there). That pin
   * is what makes this `getUTCDay()` and the service's `startOfLocalDay(now,
   * tz)` name the same day, and what makes the boundary test's
   * `makeClass(t.scheduleRuleId, new Date(), …)` land exactly on `gte` rather than a day
   * off. Under the schema default of `Europe/Amsterdam` the boundary test would
   * fail deterministically between 00:00 and 02:00 local — the same failure
   * #123 already fixed once in this file. Do not seed a zone here without
   * reworking both tests' arithmetic.
   */
  const dayOfWeekNeverToday = () => {
    const jsDay = new Date().getUTCDay(); // 0=Sun … 6=Sat
    const schemaToday = (jsDay + 6) % 7; // schema: 0=Mon … 6=Sun
    return (schemaToday + 2) % 7;
  };

  // Counter-derived startTime, separate from makeTemplate's own counter
  // above, so the two counters can never land on the same value even on a
  // day where dayOfWeekNeverToday() happens to equal makeTemplate's fixed
  // dayOfWeek 3: all 3 calls to this helper compute the same
  // dayOfWeekNeverToday()
  // for a given run, and none of their templates ends up archived at the
  // end of its test ('Resume After Archive' un-archives at the finish), so
  // all 3 would collide with each other at a shared time — a fixed
  // startTime here would only ever surface as flaky, on the days
  // dayOfWeekNeverToday() coincides with 3. dayOfWeek itself is left
  // untouched: it is deliberately chosen to never fall on today.
  //
  // `ScheduleRule_teacher_slot_excl` (issue 298) excludes on RANGE overlap,
  // so each slot is spaced a full `durationMinutes` (60) from the last:
  // `(counter - 1) * 60` packs the 3 calls into `'09:00'`, `'10:00'`,
  // `'11:00'`, ending exactly at `'12:00'` — where makeTemplate's own range
  // begins, on the day the two dayOfWeeks coincide.
  let makeTemplateOnCounter = 0;
  const makeTemplateOn = (classType: string, dayOfWeek: number) => {
    makeTemplateOnCounter += 1;
    return prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'studio',
            classType,
            dayOfWeek,
            startTime: hhmmToTime(slotTime((makeTemplateOnCounter - 1) * 60)),
            durationMinutes: 60,
          },
        },
        location: 'Studio Loft',
        hourlyRate: 45,
      },
    });
  };

  beforeAll(async () => {
    await prisma.$connect();
    const seeded = await seedTeacher('pause');
    teacherId = seeded.teacherId;
    accountId = seeded.accountId;

    const other = await seedTeacher('pause-other');
    otherTeacherId = other.teacherId;
    otherAccountId = other.accountId;
  });

  afterAll(async () => {
    for (const [t, a] of [
      [teacherId, accountId],
      [otherTeacherId, otherAccountId],
    ] as const) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: t } });
      // `StudioClassTemplate` is `onDelete: Cascade` from `ScheduleRule`
      // (issue 298), so deleting the rule removes the template with it.
      await prisma.scheduleRule.deleteMany({ where: { teacherId: t } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('pausing deletes nothing and reports the furthest-out scheduled class', async () => {
    const t = await makeTemplate('Pause Active');
    const soon = await makeClass(t.scheduleRuleId, futureOn(3), '08:02');
    const later = await makeClass(t.scheduleRuleId, futureOn(10), '19:02');

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    if (result.action !== 'paused') throw new Error('expected the paused action');
    expect(result.template.isActive).toBe(false);
    expect(result.lastScheduled).not.toBeNull();
    if (!result.lastScheduled) throw new Error('expected lastScheduled');
    expect(result.lastScheduled.date.toISOString().slice(0, 10)).toBe(
      later.calendarEntry.date.toISOString().slice(0, 10),
    );
    expect(result.lastScheduled.startTime).toBe('19:02');
    // Deletes nothing: pausing withdraws no already-generated class — that is
    // archiving's job, not pausing's.
    expect(await prisma.studioClass.count({ where: { id: soon.id } })).toBe(1);
    expect(await prisma.studioClass.count({ where: { id: later.id } })).toBe(1);
  });

  /**
   * Pre-#94 this title read "…without deleting or generating anything" —
   * true then, false now that resuming generates (see the "fills the window"
   * case below for that behaviour on its own). What survives from the
   * original test: a class already on the schedule is not deleted by the
   * resume that follows. `c`'s date is arbitrary relative to the template's
   * own pattern — `futureOn(3)` against `dayOfWeek: 3` coincides with it one
   * day in seven, so this fixture is not reliably "off pattern" and the test
   * does not depend on which it is. Duplication is not asserted separately:
   * `@@unique([scheduleRuleId, date])` makes two rows at the same date
   * unrepresentable, so a count at `c`'s own date could only ever show 0 or
   * 1 and would add nothing beyond the not-deleted check below.
   */
  it('resuming toggles isActive back on and does not delete an already-scheduled class', async () => {
    const t = await makeTemplate('Resume Simple');
    // '08:03', not '08:00': the earlier "pausing deletes nothing..." test
    // above leaves its own `soon` class at futureOn(3)/'08:02' standing
    // (pausing never deletes), which would otherwise collide under
    // `CalendarEntry_teacher_slot_excl`. The exact minute is arbitrary here —
    // see the comment above, and the one-minute durations that make a minute
    // of separation disjoint under a range overlap — and neither lands on ':00',
    // preventing any exclusion conflict with makeTemplate's hourly slots.
    const c = await makeClass(t.scheduleRuleId, futureOn(3), '08:03');

    const paused = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');
    expect(paused.ok).toBe(true);
    if (!paused.ok) throw new Error('expected ok');
    expect(paused.template.isActive).toBe(false);

    const resumed = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    expect(resumed.template.isActive).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);

    // "Toggles isActive back on" is a claim about the row, and the assertion
    // above only reads the response. Re-read so the two cannot diverge — the
    // same reason the archive block's record tests re-read.
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(true);
  });

  it('pausing a template with no scheduled classes reports lastScheduled: null', async () => {
    const t = await makeTemplate('Pause Empty');

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    if (result.action !== 'paused') throw new Error('expected the paused action');
    expect(result.lastScheduled).toBeNull();
  });

  /**
   * See the class family's equivalent test for why this specific combination
   * — requesting the state the row is already in ('active', a fresh
   * template's default), as a non-owner — is the one case that distinguishes
   * "ownership checked first" from "unchanged checked first".
   */
  it("returns forbidden for another teacher's template already in the requested state, and writes nothing", async () => {
    const t = await makeTemplate('Owner Active, Foreign Request');

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, otherTeacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(true);
  });

  it("returns 'archived' for an archived template rather than toggling", async () => {
    const t = await makeTemplate('Pause Archived');
    const archived = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');
    expect(archived.ok).toBe(true);

    // 'active' specifically: that is the only transition the archived guard
    // blocks. 'paused' would hit the unchanged guard first — see the
    // guard-order test below.
    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'archived' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(false);
  });

  /**
   * The guard order in `pauseOrResumeStudioTemplate` is deliberate: `unchanged`
   * must be checked before the `archived` guard, because archiving forces
   * `isActive: false` — so `?state=paused` on an archived template is already
   * true and there is nothing to refuse. Swap the two guards and every other
   * test in this file still passes; only this one would start seeing a 409
   * (`reason: 'archived'`) where it should see a 200 `unchanged` — reachable
   * from exactly the stale-tab case #98 is about: tab A archives, tab B still
   * shows an active template and offers "Pause studio class".
   */
  it('an archived template is already paused — pausing it again is unchanged, not a 409', async () => {
    const t = await makeTemplate('Archived Then Paused');
    const archived = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');
    expect(archived.ok).toBe(true);

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.action).toBe('unchanged');

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(false);
    expect(after.scheduleRule.isArchived).toBe(true);
  });

  /**
   * #94. Resuming used to flip `isActive` and stop, leaving the teacher on an
   * empty schedule until the hourly sweep. It could not call
   * `generateStudioClassInstances` — that sweeps every teacher on the
   * instance — so the fix was a per-template generator to call instead.
   */
  it('fills the window when resuming', async () => {
    const t = await makeTemplate('Resume Generates');
    await prisma.scheduleRule.update({
      where: { id: t.scheduleRuleId },
      data: { isActive: false },
    });

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.action).toBe('active');
    if (result.action !== 'active') throw new Error('expected the active action');
    expect(result.added).toBe(4);
    expect(result.scheduled).toBe(4);
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: t.id } } } } } })).toBe(4);

    // The window count above reads the database, but the resume itself is
    // only asserted through the returned `action`. Re-read the flag too: the
    // window and the flip commit in one transaction, and a test that watches
    // only one of them cannot say the pair stayed together.
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(true);
  });

  /**
   * The ordinary path, and the only input that selects `resumeStudioMessage`'s
   * "Nothing needed adding." branch: a fast pause → resume, where pausing
   * deleted nothing so all four dates are still occupied and generation creates
   * nothing.
   *
   * Spec test item 2, missing from the first implementation pass and undeclared
   * as a deviation — every other test in this file asserts a non-zero `added`,
   * so that the service can produce `0` at all was unpinned while the copy
   * branch consuming it was covered. Found by PR review.
   */
  it('reports an intact window as nothing needed adding', async () => {
    const t = await makeTemplateOn('Resume Intact', dayOfWeekNeverToday());
    await prisma.scheduleRule.update({
      where: { id: t.scheduleRuleId },
      data: { isActive: false },
    });

    const filled = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');
    expect(filled.ok).toBe(true);
    if (!filled.ok) throw new Error('expected ok');
    if (filled.action !== 'active') throw new Error('expected the active action');
    expect(filled.added).toBe(4);

    await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');
    const resumed = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    if (resumed.action !== 'active') throw new Error('expected the active action');
    expect(resumed.added).toBe(0);
    expect(resumed.scheduled).toBe(4);
  });

  /**
   * The case #119 exists for. `pause → archive → un-archive → resume` is the
   * sequence #94's PR body named: the archive deliberately spares cancelled
   * classes (not because they are income records — reporting excludes them —
   * but because they hold their dates), and the generator's existence probe has
   * no `cancelledAt` filter, so those dates cannot be regenerated either —
   * `@@unique([scheduleRuleId, date])` makes it unrepresentable. The teacher
   * therefore gets back fewer classes than the archive withdrew, and before
   * this test nothing said so.
   */
  it('reports a window shortened by cancelled classes, not the four it withdrew', async () => {
    const t = await makeTemplateOn('Resume After Archive', dayOfWeekNeverToday());
    await prisma.scheduleRule.update({
      where: { id: t.scheduleRuleId },
      data: { isActive: false },
    });

    const filled = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');
    expect(filled.ok).toBe(true);
    if (!filled.ok) throw new Error('expected ok');
    if (filled.action !== 'active') throw new Error('expected the active action');
    expect(filled.added).toBe(4);
    expect(filled.scheduled).toBe(4);

    // Cancel the two furthest-out. `.slice(2)` rather than indexing, so this
    // needs no non-null assertions under `noUncheckedIndexedAccess`.
    const generated = await prisma.studioClass.findMany({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: t.id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, select: { id: true } });
    expect(generated).toHaveLength(4);
    const toCancel = generated.slice(2).map((c) => c.id);
    expect(toCancel).toHaveLength(2);
    await prisma.calendarEntry.updateMany({
      where: { studioClasses: { some: { id: { in: toCancel } } } },
      data: { cancelledAt: new Date() },
    });

    await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');
    const archived = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error('expected ok');
    if (archived.action !== 'archived') throw new Error('expected the archived action');
    // Two of the four: the cancelled pair is spared.
    //
    // This line, not the `scheduled` assertion below, is where this test dies
    // if `scheduledWhere` loses its `cancelledAt: null`. That helper feeds the
    // archive's `deleteMany` as well as the resume's count, so the archive
    // starts deleting the cancelled pair and fails here — `expected 4 to be 2`,
    // measured, not assumed — before the resume is ever reached.
    //
    // So read this test as a pin on the whole `pause → archive → un-archive →
    // resume` *sequence*, which is what #119 was filed about. What isolates the
    // resume count's own `cancelledAt` filter is the boundary test below
    // ("counts a class dated today, and excludes a cancelled one"): it calls no
    // archive, so the same mutation surfaces there as `expected 6 to be 5`.
    expect(archived.deleted).toBe(2);
    await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'unarchived');

    const resumed = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    if (resumed.action !== 'active') throw new Error('expected the active action');
    // Two, not four. Only the dates the archive emptied come back.
    expect(resumed.added).toBe(2);
    expect(resumed.scheduled).toBe(2);
    // No `expect(scheduled).toBeGreaterThanOrEqual(added)` here or in the
    // boundary test below, though both used to carry one. With both operands
    // pinned to literals on the two lines above, such an assertion cannot fail
    // whatever the code does — documentation wearing an assertion's clothes,
    // and this branch's own standard rejects a pin that cannot fail. The
    // relation is guaranteed by construction, not by test; the argument lives
    // on `PauseStudioTemplateResult.added`.

    // The spared pair still stands: the archive left them and the resume did
    // not resurrect them.
    expect(
      await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: t.id } } }, cancelledAt: { not: null } } } }),
    ).toBe(2);
  });

  /**
   * The all-cancelled extreme of #192: every candidate date holds a cancelled
   * own row, so the resume creates nothing and `scheduled` is 0 because the
   * rows that block it are exactly the rows the count excludes. The teacher
   * already learns this (`resumeStudioMessage`'s `scheduled === 0` branch);
   * what this pins is that the result names *which* mechanism filled the
   * window's dates — the count that makes the operator-facing `log.warn` (and
   * the Task 6 copy) a measured number rather than an inference. The warn
   * itself is asserted here too, on the exact string it composes.
   */
  it('reports the cancelled classes holding the window', async () => {
    const t = await makeTemplate('Blocked By Cancelled');
    await prisma.scheduleRule.update({
      where: { id: t.scheduleRuleId },
      data: { isActive: false },
    });

    const filled = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');
    expect(filled.ok).toBe(true);
    if (!filled.ok) throw new Error('expected ok');
    if (filled.action !== 'active') throw new Error('expected the active action');
    // Precondition: a full window stood before anything was cancelled, so the
    // 0s below are caused by the cancels, not by a starved fixture.
    expect(filled.added).toBe(4);

    await prisma.calendarEntry.updateMany({ where: { scheduleRule: { studioClassTemplates: { some: { id: t.id } } } }, data: { cancelledAt: new Date() } });

    await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');

    // Spied with `mockImplementation` so the real line does not print on a
    // passing run, the way the residual-branch test further down does it.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const resumed = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

      expect(resumed).toMatchObject({
        ok: true,
        action: 'active',
        added: 0,
        scheduled: 0,
        counts: { blockedByCancelled: 4 },
      });

      // The operator-facing half, keyed on the exact string. This is the only
      // resume in this block that reaches the empty-window branch, and
      // `TemplateFamily.logNoun`'s docblock (`rule-lifecycle.ts`) claims every
      // message composed from it is held by an assertion on that string; this
      // is that assertion for this one.
      const emptyWindow = warn.mock.calls.find(
        (call) => call[1] === 'studio class template resumed live with an empty window',
      );
      expect(emptyWindow).toBeDefined();
      expect(emptyWindow?.[0]).toMatchObject({
        templateId: t.id,
        teacherId,
        added: 0,
        blockedByCancelled: 4,
      });
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The two filters inside `scheduled`'s count, each pinned by a row the other
   * filter would not move: one dated exactly on the `gte` boundary, one
   * cancelled and comfortably inside it. Both sit off the template's own
   * weekday, so generation neither creates nor touches them.
   */
  it('counts a class dated today, and excludes a cancelled one', async () => {
    const t = await makeTemplateOn('Resume Counts Boundary', dayOfWeekNeverToday());
    await prisma.scheduleRule.update({
      where: { id: t.scheduleRuleId },
      data: { isActive: false },
    });

    // Exactly on the `gte: today` boundary.
    await makeClass(t.scheduleRuleId, new Date(), '07:00');
    // Inside the boundary but cancelled. Placed beyond the 4-week generated
    // window so week-keyed generation is not blocked by this fixture.
    await createStudioClassFixture(prisma, {
        teacherId,
        scheduleRuleId: t.scheduleRuleId,
        classType: 'Pause Rule',
        date: futureOn(35),
        startTime: hhmmToTime('07:30'),
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
        cancelledAt: new Date(),
      });

    const resumed = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    if (resumed.action !== 'active') throw new Error('expected the active action');
    expect(resumed.added).toBe(4);
    // Four generated plus today's = 5. The cancelled one does not count. This
    // is the only place in the branch where the two numbers genuinely differ,
    // which is what makes it the isolator for the `cancelledAt` filter.
    expect(resumed.scheduled).toBe(5);
  });

  it('generates nothing when pausing', async () => {
    const t = await makeTemplate('Pause Generates Nothing');

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.action).toBe('paused');
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: t.id } } } } } })).toBe(0);
  });

  /**
   * The archived guard runs before the write, so an archived template must
   * come back refused with nothing generated — not merely un-flipped. This is
   * the case where generating would be worst: archiving just deleted the
   * window on purpose.
   */
  it('refuses to resume an archived template, and generates nothing', async () => {
    const t = await makeTemplate('Archived Resume');
    await prisma.scheduleRule.update({
      where: { id: t.scheduleRuleId },
      data: { isActive: false, isArchived: true },
    });

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'archived' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.isActive).toBe(false);
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: t.id } } } } } })).toBe(0);
  });

  /**
   * The race a reviewer of this fix reproduced against a "provably
   * unreachable" claim. `pauseOrResumeStudioTemplate`'s body is a single
   * `return` that parameterises `pauseOrResumeRule` (`rule-lifecycle.ts`) with
   * `STUDIO_FAMILY`; the guards are in that shared body, where both fast paths
   * are read outside any lock and before the transaction opens, so a
   * concurrent archive can commit in the gap between those reads and the CAS.
   * Constructed the same way as this file's
   * `archiveOrUnarchiveStudioTemplate` concurrent-archive test — a third
   * transaction holds the row lock so both requests queue behind it — except
   * archive is started and confirmed queued first, so Postgres's FIFO lock
   * grant hands it the row before resume's CAS gets a turn. Resume must then
   * see the row already archived and answer `{ reason: 'archived' }`, which is
   * what the CAS-miss branch's `isArchived` check is there to produce.
   */
  it('a concurrent archive mid-resume is reported as archived, not thrown', async () => {
    const t = await makeTemplate('Resume Vs Archive Race');
    await prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { isActive: false } });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Holds the row lock and nothing else — neither racer can observe it,
    // only queue behind it.
    const blocking = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "StudioClassTemplate" WHERE "id" = ${t.id} FOR UPDATE`;
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let archiveSettled = false;
    const archive = archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived').then(
      (r) => {
        archiveSettled = true;
        return r;
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    let resumeSettled = false;
    const resume = pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active').then((r) => {
      resumeSettled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 300));
    // Both blocked in their own transaction's first statement. If either had
    // settled here, it never queued behind the held lock and the rest of
    // this test proves nothing about the race it targets.
    expect(archiveSettled).toBe(false);
    expect(resumeSettled).toBe(false);

    release();
    await blocking;

    const [archiveResult, resumeResult] = await Promise.all([archive, resume]);

    // Archive's own CAS only ever checks `isArchived`, which resume never
    // touches, so archive succeeds regardless of arrival order — asserting
    // its success alone would pin nothing about which one actually won the
    // queued lock. What pins that is the resume assertion below: it would
    // read `active` instead of `archived` had resume's CAS run first.
    expect(archiveResult.ok).toBe(true);
    if (!archiveResult.ok) throw new Error('expected ok');
    expect(archiveResult.action).toBe('archived');

    expect(resumeResult).toEqual({ ok: false, reason: 'archived' });

    // And generated nothing — the half the result value alone cannot show.
    // The winning archive's own `deleteMany` has already run by the time
    // resume's CAS misses, so a window generated on the way out of the
    // `archived` branch is one nothing would ever withdraw: four classes
    // standing on a template the teacher just archived. Its non-racing twin
    // ("refuses to resume an archived template, and generates nothing")
    // asserts this too; the racing case is where getting it wrong is easier.
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: t.id } } } } } })).toBe(0);
  });

  /**
   * The other half of the same race, and the one the guard-order fix above
   * exists for: a *pause* racing an archive must answer `unchanged`, not the
   * `archived` a racing *resume* gets — archiving forces `isActive: false`,
   * so a paused-or-pausing template is already in the state a pause wants.
   * Built the same way as the resume-vs-archive race above (third
   * transaction holds the row lock, both requests queue behind it, archive
   * queued first so it wins the FIFO grant); the fixture also differs, since
   * a pause acts on an active template rather than a paused one, so there is
   * no `isActive: false` seed here.
   */
  it('a concurrent archive mid-pause is reported as unchanged, not archived', async () => {
    const t = await makeTemplate('Pause Vs Archive Race');
    // Left active (a fresh template's default) — the state a pause acts on.

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const blocking = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "StudioClassTemplate" WHERE "id" = ${t.id} FOR UPDATE`;
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let archiveSettled = false;
    const archive = archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived').then(
      (r) => {
        archiveSettled = true;
        return r;
      },
    );

    await new Promise((r) => setTimeout(r, 100));

    let pauseSettled = false;
    const pause = pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused').then((r) => {
      pauseSettled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(archiveSettled).toBe(false);
    expect(pauseSettled).toBe(false);

    release();
    await blocking;

    const [archiveResult, pauseResult] = await Promise.all([archive, pause]);

    expect(archiveResult.ok).toBe(true);
    if (!archiveResult.ok) throw new Error('expected ok');
    expect(archiveResult.action).toBe('archived');

    // Not `{ ok: false, reason: 'archived' }` — the guard order the fix
    // above restores.
    expect(pauseResult.ok).toBe(true);
    if (!pauseResult.ok) throw new Error('expected ok');
    expect(pauseResult.action).toBe('unchanged');

    // The template it carries must be the row the winning archive left, not
    // the snapshot this call read before its own transaction opened. The
    // route spreads `...result.template` straight into its 200 body, so
    // returning that snapshot would describe the template to the teacher as
    // live and unarchived when it is neither. This is the arm
    // `PauseRuleOutcome`'s docblock (`rule-lifecycle.ts`) singles out when it
    // claims none of its arms ever carries the stale pre-transaction snapshot;
    // without these two lines that claim has nothing holding it.
    expect(pauseResult.template.isArchived).toBe(true);
    expect(pauseResult.template.isActive).toBe(false);
  });

  /**
   * The CAS's `where` is `isArchived: false AND isActive: !desiredActive`. A
   * miss means one of those held when the CAS ran, and the branch checks both
   * against a SECOND, later read — so a row that changes back in between
   * matches neither classification and falls through to the residual.
   *
   * Driven by two `$extends` hooks rather than by sleeps: each fires at a
   * known statement boundary, so the interleaving is deterministic — and
   * the branch is identified by the message it logs rather than by how
   * long the call took, so nothing here depends on wall-clock timing.
   */
  it('the residual CAS miss answers busy rather than throwing', async () => {
    const t = await makeTemplate('Residual Miss');
    await prisma.scheduleRule.update({
      where: { id: t.scheduleRuleId },
      data: { isActive: false },
    });

    // Guards: each hook must fire ONCE. The miss branch re-reads through the
    // same `findUnique` the first hook is attached to, so an unguarded hook
    // would fire again there and undo the setup this test depends on.
    let armedRead = true;
    let armedCas = true;

    const interposing = prisma.$extends({
      query: {
        studioClassTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (armedRead) {
              armedRead = false;
              // Commits AFTER the service's pre-transaction read, so the row
              // it holds says `isActive: false` while the database says true —
              // which is what makes the CAS's `isActive: false` predicate miss.
              await prisma.scheduleRule.update({
                where: { id: t.scheduleRuleId },
                data: { isActive: true },
              });
            }
            return row;
          },
        },
        scheduleRule: {
          async updateMany({ args, query }) {
            const res = await query(args);
            if (armedCas) {
              armedCas = false;
              // Commits AFTER the CAS has missed, putting the row back so the
              // re-read below sees neither already-desired nor archived.
              // Targets `ScheduleRule` while the transaction holds `FOR UPDATE`
              // on `StudioClassTemplate` — a different table, so no wait.
              await prisma.scheduleRule.update({
                where: { id: t.scheduleRuleId },
                data: { isActive: false },
              });
            }
            return res;
          },
        },
      },
    }) as unknown as PrismaClient;

    // `busy` has a second producer in this function — the `catch`'s
    // `isTransientDbError` branch — and the two are told apart by the message
    // each logs, not by how long the call took. Spied with
    // `mockImplementation` so the real line does not print on a passing run.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const result = await pauseOrResumeStudioTemplate(interposing, t.id, teacherId, 'active');

      // Both hooks fired, so the interleaving this test constructs is the one
      // that ran — an unfired hook would leave the row in a state the CAS
      // matches, and this call would never reach the residual at all.
      expect(armedRead).toBe(false);
      expect(armedCas).toBe(false);
      expect(result).toEqual({ ok: false, reason: 'busy' });

      const residualLog = warn.mock.calls.find(
        (call) =>
          call[1] === 'studio class pause/resume CAS missed and the re-read matched no classification',
      );
      expect(residualLog).toBeDefined();
      expect(residualLog?.[0]).toMatchObject({
        templateId: t.id,
        teacherId,
        target: 'active',
        observed: { isActive: false, isArchived: false },
        desiredActive: true,
      });
      // And NOT the other producer's, which would mean this `busy` came from a
      // lock-timeout expiry rather than from the residual branch.
      expect(
        warn.mock.calls.find(
          (call) => call[1] === 'studio class pause/resume lost the template lock race',
        ),
      ).toBeUndefined();
    } finally {
      warn.mockRestore();
    }

    // Nothing was written: the CAS matched no row, so the rollback leaves the
    // row exactly as the second interposed write left it.
    const after = await prisma.scheduleRule.findUniqueOrThrow({ where: { id: t.scheduleRuleId } });
    expect(after.isActive).toBe(false);
  });

  /**
   * `TemplateFamily.withSlot` (`rule-lifecycle.ts`) advertises as STRUCTURAL
   * that the shared pause cannot spread a joined `scheduleRule` onto a
   * response: it takes the joined row and each family destructures in its own
   * adapter, so nothing in that module ever holds a loose one. The structure
   * is real, but it lives in `STUDIO_FAMILY`'s adapter — rewrite that adapter
   * to pass its first argument straight through and the claim is false with
   * nothing to say so.
   *
   * Every arm of `pauseOrResumeRule` reaches that adapter with a joined row,
   * so one arm exercises it for all of them. The CAS-miss `unchanged` arm is
   * the one driven here because its template is built inside the transaction
   * from a re-read, rather than from the row the caller already held.
   *
   * `api/studio-class-templates/[id]/route.ts` spreads this template onto the
   * response body and `StudioClassTemplateWithSlot` never declares
   * `scheduleRule`, so no caller can type the field and no compiler error can
   * find it. The archive arm's twin of this test is "un-archiving answers with
   * a flattened template, never the joined rule row", and the class family's
   * is the same-named test in `class-template-lifecycle.test.ts`; one
   * property, one spelling, and they are meant to be read as a set.
   *
   * `not.toContain`, not a whole-shape assertion: the template row's own
   * fields change with the schema, and this is about fields that must not be
   * there.
   */
  it('answers unchanged with a flattened template, never the joined rule row', async () => {
    const t = await makeTemplate('No Joined Rule On A Pause Miss');
    const rule = await prisma.scheduleRule.findUniqueOrThrow({ where: { id: t.scheduleRuleId } });

    // Guard: the miss branch re-reads through the same `findUnique` this hook
    // is attached to, so an unguarded hook would fire again there and pause
    // the row a second time — after the re-read the assertions below depend on.
    let paused = false;
    // Cast because the extended client is missing `$on`, so it is not
    // assignable to `pauseOrResumeStudioTemplate`'s `PrismaClient`-typed `db`
    // parameter.
    const interposing = prisma.$extends({
      query: {
        studioClassTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!paused) {
              paused = true;
              // Commits AFTER the service's pre-transaction read, so that read
              // still says `isActive: true` and takes neither fast path, while
              // the CAS's `isActive: true` predicate matches nothing. The
              // re-read below the miss then sees the state this pause asked
              // for, which is the `unchanged` arm.
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

    const result = await pauseOrResumeStudioTemplate(interposing, t.id, teacherId, 'paused');

    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    // The hook fired, so the interleaving this test constructs is the one that
    // ran — without it the CAS matches and the arm under test is never reached.
    expect(paused).toBe(true);
    expect(result.action).toBe('unchanged');

    expect(Object.keys(result.template)).not.toContain('scheduleRule');
    // As at the archive twin above, this assertion IS the guarantee: the
    // adapter's `rule` parameter is the joined row, and one that spread it
    // whole — or wrote `teacher:` by hand — would still compile. What keeps
    // `teacher` off the wire is `withSlot` picking the rule's columns by name.
    expect(Object.keys(result.template)).not.toContain('teacher');
    // The flattening itself still happened — otherwise "no `scheduleRule`"
    // would pass on a response that lost the rule's columns altogether.
    expect(result.template.dayOfWeek).toBe(rule.dayOfWeek);
    expect(result.template.startTime).toBe(timeToHHmm(rule.startTime));
  });
});

describe('updateStudioClassTemplate (DB)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  // `ScheduleRule_teacher_slot_excl` (issue 298) excludes on RANGE overlap,
  // so each slot below is spaced a full `durationMinutes` (60) from the
  // last (`counter * 60 - 30`) rather than a minute: counter 1 is `'09:30'`
  // and every call after it climbs an hour. Two calls of headroom are left —
  // counter 16 computes `'24:30'`, which `slotTime` refuses.
  //
  // This describe's deliberate collisions are written as explicit literals
  // rather than derived from the counter, and `'21:45'` in the cross-family
  // case is INSIDE the range the counter now reaches. What keeps it from
  // colliding is ORDERING, not distance: that holder is a `ClassTemplate`
  // created and dropped inside its own test's `finally`, so no later slot is
  // ever minted while it exists. A new literal collision needs the same
  // teardown — it cannot rely on sitting past the counter's ceiling.
  let counter = 0;

  const makeTemplate = async (owner: string, classType: string) => {
    counter += 1;
    return prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: owner,
            kind: 'studio',
            classType,
            dayOfWeek: 4,
            startTime: hhmmToTime(slotTime(counter * 60 - 30)),
            durationMinutes: 60,
          },
        },
        location: 'Update Studio',
        hourlyRate: 45,
      },
      include: { scheduleRule: true },
    });
  };

  beforeAll(async () => {
    ({ teacherId, accountId } = await seedTeacher('update-owner'));
    ({ teacherId: otherTeacherId, accountId: otherAccountId } = await seedTeacher('update-other'));
  });

  // Both sibling describes carry this and it was missed here. `unit-db.ts`
  // provisions and migrates `ethical_yoga_test` but never truncates it, so an
  // uncleaned describe accumulates across every run forever. Measured before
  // this was added: 151 studio templates in the test database, 150 of them
  // active-and-unarchived, ~149 of those this describe's garbage.
  //
  // The cost is not a wrong assertion — the generator tests scope to their own
  // `templateId`. It is that `generateStudioClassInstances`
  // (`studio-class-generator.ts`) sweeps `{ isActive: true, isArchived: false }`
  // with NO teacher scope, and `studio-class-generator.test.ts` calls it
  // unscoped seven times. Every one of those was opening ~150 transactions —
  // a claim, a `FOR UPDATE` and a generate apiece — growing by seven per run.
  afterAll(async () => {
    for (const [t, a] of [
      [teacherId, accountId],
      [otherTeacherId, otherAccountId],
    ] as const) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: t } });
      // `StudioClassTemplate` is `onDelete: Cascade` from `ScheduleRule`
      // (issue 298), so deleting the rule removes the template with it.
      await prisma.scheduleRule.deleteMany({ where: { teacherId: t } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('returns not_found for a template that does not exist', async () => {
    const result = await updateStudioClassTemplate(
      prisma,
      '00000000-0000-0000-0000-000000000000',
      teacherId,
      { classType: 'Ghost' },
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("returns forbidden for another teacher's template, and leaves it untouched", async () => {
    const t = await makeTemplate(otherTeacherId, 'Not Yours');

    const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
      classType: 'Hijacked',
    });

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.classType).toBe('Not Yours');
  });

  it('returns no_fields for an empty payload', async () => {
    const t = await makeTemplate(teacherId, 'Empty Payload');
    expect(await updateStudioClassTemplate(prisma, t.id, teacherId, {})).toEqual({
      ok: false,
      reason: 'no_fields',
    });
  });

  // The case a key-count check lets through. Unreachable over the wire — JSON
  // cannot carry `undefined`, so a key never arrives with that value — and
  // reachable here, which is the whole point of there being a function
  // boundary. `Object.keys({ classType: undefined }).length` is 1.
  it('returns no_fields for a payload whose only key is undefined', async () => {
    const t = await makeTemplate(teacherId, 'Undefined Only');
    expect(
      await updateStudioClassTemplate(prisma, t.id, teacherId, { classType: undefined }),
    ).toEqual({ ok: false, reason: 'no_fields' });

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
    expect(after.scheduleRule.classType).toBe('Undefined Only');
  });

  it('writes the edited fields and returns the updated row', async () => {
    const t = await makeTemplate(teacherId, 'Editable');

    const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
      classType: 'Edited',
      hourlyRate: 62.5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.classType).toBe('Edited');
    expect(Number(result.template.hourlyRate)).toBe(62.5);
    // Untouched fields survive a partial update.
    expect(result.template.location).toBe('Update Studio');
    // Exhaustive on the success arm's own keys, and the class family pins the
    // same shape for the same reason (`class-template-lifecycle.test.ts`): a
    // field added to the arm and not to the route reaches nobody, and this is
    // where that shows up. `Object.keys`, not a whole-result `toEqual`, because
    // the template row's own fields are asserted above and re-listing them here
    // would make this case fail on every unrelated schema change.
    //
    // Both new keys are PREDICTIONS about the sweep, not reports of work this
    // call did. A key counting rows this call touched would be the propagation
    // #194 deleted coming back, and it fails here first.
    expect(Object.keys(result).sort()).toEqual([
      'firstEffective',
      'generationState',
      'ok',
      'template',
    ]);
    // A live template, so the state is `active` and the week is a real
    // prediction rather than the absence of one.
    expect(result.generationState).toBe('active');
    // And it is a week, not a class date: a Monday, never the Friday this
    // block's `makeTemplate` puts the template on. The copy renders it as "the
    // week starting …", so a candidate occurrence left unconverted would put
    // the wrong weekday in front of a teacher.
    expect(result.firstEffective).not.toBeNull();
    expect(result.firstEffective!.getUTCDay()).toBe(1);
  });

  it('returns slot_conflict with heldBy: studio when the edit lands on a live sibling slot, and logs it', async () => {
    const occupant = await makeTemplate(teacherId, 'Slot Occupant');
    const mover = await makeTemplate(teacherId, 'Slot Mover');

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const result = await updateStudioClassTemplate(prisma, mover.id, teacherId, {
        startTime: timeToHHmm(occupant.scheduleRule.startTime),
      });

      expect(result).toEqual({ ok: false, reason: 'slot_conflict', heldBy: 'studio' });

      // #231: a RETURNED failure never reaches `withErrorHandler`, and
      // `respondError` does not log. Catching this `23P01` is what would
      // delete the line `classifyApiError` emits when it escapes, so the
      // catch has to put one back.
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: mover.id, teacherId, heldBy: 'studio' }),
        'studio template edit refused: that slot is taken',
      );
    } finally {
      warn.mockRestore();
    }

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: mover.id }, include: { scheduleRule: true } });
    expect(timeToHHmm(after.scheduleRule.startTime)).toBe(timeToHHmm(mover.scheduleRule.startTime));
  });

  /**
   * PR #300 third pass, updated for issue 298: the two arms this pinned
   * separately (a same-family P2002, a cross-family `YG001`) are now one —
   * `ScheduleRule_teacher_slot_excl` raises the identical `23P01` either way,
   * and `heldBy` (probed by `ruleSlotHolder`, `src/lib/rule-slot-holder.ts`)
   * is what tells them apart. This case pins the `heldBy: 'regular'` side;
   * the case above pins `heldBy: 'studio'`. The ARM is pinned end-to-end by
   * the integration suite (delete it and a 409 becomes a 500), but the log
   * line inside it was free to be deleted silently before this test existed
   * — the same shape as the defect this whole issue's review found: catching
   * is what removes the record, and nothing checked that the record gets
   * written.
   */
  it('returns slot_conflict with heldBy: regular when the class family holds the slot, and logs it', async () => {
    const mover = await makeTemplate(teacherId, 'Cross Family Mover');
    // The OTHER family at the slot the edit moves onto. A live `ClassTemplate`,
    // so it is this rule's `kind` — not which detector matched — that decides
    // `heldBy` now.
    const room = await prisma.room.create({
      data: {
        venueName: 'Cross Venue', address: `${mover.id} Cross Street`, city: 'Amsterdam',
        postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
        isPublic: false, createdById: teacherId,
      },
    });
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12 },
    });
    await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId, kind: 'regular', classType: 'Cross Family Holder',
            dayOfWeek: mover.scheduleRule.dayOfWeek, startTime: hhmmToTime('21:45'), durationMinutes: 60,
          },
        },
        teacherRoom: { connect: { id: teacherRoom.id } },
        roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
      },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const result = await updateStudioClassTemplate(prisma, mover.id, teacherId, {
        startTime: '21:45',
      });

      expect(result).toEqual({ ok: false, reason: 'slot_conflict', heldBy: 'regular' });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: mover.id, teacherId, heldBy: 'regular' }),
        'studio template edit refused: that slot is taken',
      );
    } finally {
      warn.mockRestore();
      // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue
      // 298), so deleting the rule removes the holder template with it.
      await prisma.scheduleRule.deleteMany({ where: { teacherId, kind: 'regular' } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId } });
      await prisma.room.deleteMany({ where: { createdById: teacherId } });
    }

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: mover.id }, include: { scheduleRule: true } });
    expect(timeToHHmm(after.scheduleRule.startTime)).toBe(timeToHHmm(mover.scheduleRule.startTime));
  });

  /**
   * The bound, proved the way `studio-class-generator.test.ts`'s twin proves
   * the archive's: a second transaction holds the row — that twin holds it
   * through the generation claim, this one with a raw `SELECT … FOR UPDATE`,
   * so the shared part is the shape, not the locking call. The edit queues
   * behind it and the timing assertions carry the claim.
   *
   * The lower bound proves it actually waited. The upper bound guards a
   * *raised* `LOCK_TIMEOUT_SQL` — measured: `'2s'` → `'6s'` fails it at 6032 ms
   * and `'2s'` → `'1s'` fails the lower bound at 1024 ms, against an unmutated
   * 2025-2030 ms. It does **not** guard "answered at the 2s bound rather than
   * the 10s budget", as this used to say: mutation 10 established the budget
   * can never be what answers, because Prisma cannot roll back a statement
   * already blocked inside Postgres. Deleting `setLockTimeout` produces a
   * hang, not a late answer, so that outcome was never reachable.
   *
   * Removing `setLockTimeout` does not slide the answer later — it stops the
   * edit settling at all, so the test dies on its own 20s timeout. That is the
   * mutation record, not a prediction.
   */
  it(
    'returns busy when another transaction holds the row past the lock timeout, and logs it',
    async () => {
      const t = await makeTemplate(teacherId, 'Busy Edit');

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocking = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "StudioClassTemplate" WHERE "id" = ${t.id} FOR UPDATE`;
          await held;
        },
        { timeout: 15_000 },
      );

      await new Promise((r) => setTimeout(r, 100));

      const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
      try {
        const startedAt = Date.now();
        const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
          classType: 'Blocked',
        });
        const waited = Date.now() - startedAt;

        expect(result).toEqual({ ok: false, reason: 'busy' });
        // Lower bound proves it waited on the lock. Pinned by db-locks.test.ts (#323, waitlist.test.ts:525-555).
        expect(waited).toBeGreaterThanOrEqual(1_800);

        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ templateId: t.id, teacherId }),
          'studio template edit lost a lock race — nothing committed',
        );
      } finally {
        warn.mockRestore();
        release();
        await blocking.catch(() => {});
      }

      const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { scheduleRule: true } });
      expect(after.scheduleRule.classType).toBe('Busy Edit');
    },
    20_000,
  );

  /**
   * The read at the top of `updateStudioClassTemplate` and the `update` inside
   * the transaction it opens are not one statement, so a delete landing
   * between them raises P2025 at the write. Without the `isRecordNotFound`
   * guard it reaches `classifyApiError`, which has no P2025 branch, and falls
   * through to a bare 500.
   *
   * The twin of `class-template-lifecycle.test.ts`'s "maps a delete landing
   * between the read and the write to not_found". The class version
   * additionally clears its `Class` rows before deleting the template; that is
   * housekeeping, **not** a constraint. Since #327 neither family's child row
   * references a template at all: `Class.template` and `StudioClass.template`
   * are gone, and the edge that survives is the one both families now share,
   * `CalendarEntry.scheduleRule` (`onDelete: SetNull`,
   * `prisma/schema.prisma`). So the two families are identical here for a
   * stronger reason than they were — one relation rather than two matching
   * ones.
   *
   * Interposed rather than raced: the extension performs the real read and
   * then deletes the row before returning it, which *is* the interleaving the
   * guard exists for, rather than a race that may or may not land. Nothing
   * between the read and the write re-reads the row.
   *
   * `updateAttempted` is what makes this test about the `catch` rather than
   * about `not_found` in general. The service has TWO paths to that reason —
   * the early `if (!template)` return and this P2025 guard — and they are
   * indistinguishable by result value alone. Without the flag, moving the
   * delete to *before* `query(args)` leaves this test green while exercising
   * the early return and never entering the transaction at all.
   *
   * Unreachable in production today — no DELETE route, and `gdpr.ts` archives
   * rather than deletes — which is exactly why it is worth pinning. #231's
   * point about this branch is that a future statement inside the transaction
   * turns a genuine bug into a silent 404, and only a test makes that visible.
   */
  it('maps a delete landing between the read and the write to not_found', async () => {
    const t = await makeTemplate(teacherId, 'P2025 Write');

    let deleted = false;
    let updateAttempted = false;
    // Cast for the same reason the class family's twin needs one: the extended
    // client is missing `$on`, so it is not assignable to
    // `updateStudioClassTemplate`'s `PrismaClient`-typed `db` parameter.
    const interposing = prisma.$extends({
      query: {
        studioClassTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!deleted) {
              deleted = true;
              await prisma.studioClassTemplate.delete({ where: { id: t.id } });
            }
            return row;
          },
          async update({ args, query }) {
            updateAttempted = true;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await updateStudioClassTemplate(interposing, t.id, teacherId, {
      classType: 'Renamed',
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
    // The assertion that makes the one above mean the `catch` arm.
    expect(updateAttempted, 'the write must have been reached and raised P2025').toBe(true);
  });

  /**
   * The eligibility gate, paused half — the studio twin of
   * `class-template-lifecycle.test.ts`'s "names no week for a paused
   * template".
   *
   * The probe reproduces the grounds on which the generator declines a
   * candidate DATE. `ACTIVE_TEMPLATE_WHERE` declines whole TEMPLATES, one
   * layer up, before any candidate exists — so for a paused template the
   * generator is never called, no date is ever declined, and every week the
   * probe could name is a week nothing will fill. That gate is not a
   * `SkipReason` and could not have been found by completing the probe's own
   * enumeration; it needs its own case.
   *
   * The edit itself still succeeds, and must: this PUT is deliberately open to
   * a paused template. What is refused is the dated sentence, not the write.
   *
   * Paused through `pauseOrResumeStudioTemplate` rather than by setting the
   * column, so this pins the state a teacher can actually reach from the
   * toggle.
   */
  it('names no week for a paused template, and reports the state instead', async () => {
    const t = await makeTemplate(teacherId, 'Paused Edit');
    const paused = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');
    expect(paused.ok).toBe(true);

    const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
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
   * The eligibility gate, archived half — and the sharper of the two.
   *
   * Archiving withdraws the future window, so an archived template has no held
   * week at all. An ungated probe therefore returns the EARLIEST answer it can
   * give, this week's Monday, for the template least likely to produce a class.
   *
   * `archived`, not `paused`, and the distinction is load-bearing rather than
   * cosmetic: `archiveOrUnarchiveStudioTemplate` forces `isActive: false` on
   * both directions, so un-archiving alone puts nothing back. A teacher told
   * to resume an archived studio template has been given a remedy that does
   * not work.
   */
  it('distinguishes an archived template from a merely paused one', async () => {
    const t = await makeTemplate(teacherId, 'Archived Edit');
    const archived = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');
    expect(archived.ok).toBe(true);

    const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
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
   * #296/#327 from this side: the probe must decline a date the OTHER family
   * holds, for the same reason it declines one this family holds — the
   * generator will skip it (`blocked_by_overlap`), so naming its week promises
   * a class the sweep does not deliver. The mirror of
   * `class-template-lifecycle.test.ts`'s "declines a date a live studio class
   * holds", families swapped: a live `Class` against a `StudioClassTemplate`'s
   * candidate.
   *
   * Getting this wrong lands the prediction EARLIER than the sweep delivers,
   * which is the dishonest direction.
   *
   * `23:59` so the first candidate is never dropped by the probe's own
   * already-started filter, which would move the answer a week for a reason
   * that has nothing to do with what this pins. The block's own `makeTemplate`
   * walks its slots up from `'09:30'` an hour at a time, and that filter fires
   * on any of them for most of the day. `23:59` is the last start a calendar
   * day has, so only a run inside its final minute could find today's
   * candidate already begun.
   *
   * Both halves asserted: the week it IS and the week it is NOT, because the
   * failure is off by exactly one week and `not.toBe` alone would pass for any
   * other wrong answer.
   *
   * TODAY's weekday, so the blocked candidate is today; the cancelled twin
   * below takes TOMORROW's, because at 23:59 two rules on one weekday would
   * be the same slot and `ScheduleRule_teacher_slot_excl` refuses the second.
   * Everything this case creates is torn down in a `finally`, so a failure
   * here cannot become a create-time failure there.
   */
  it('declines a date a live class from the other family holds, and names the week after', async () => {
    const todaySchemaDay = (new Date().getUTCDay() + 6) % 7;
    const t = await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'studio',
            classType: 'Cross Family Probe',
            dayOfWeek: todaySchemaDay,
            startTime: hhmmToTime('23:59'),
            durationMinutes: 60,
          },
        },
        location: 'Update Studio',
        hourlyRate: 45,
      },
    });

    const occurrences = getNextOccurrences(todaySchemaDay, new Date(), 2);
    const blocked = occurrences[0]!;
    const nextWeek = occurrences[1]!;

    // The other family needs a room; `StudioClassTemplate` has no room
    // relation, so this block seeds none of its own.
    const room = await prisma.room.create({
      data: {
        venueName: 'Cross Probe Venue', address: `${t.id} Cross Probe Street`, city: 'Amsterdam',
        postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
        isPublic: false, createdById: teacherId,
      },
    });
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12 },
    });
    const holder = await createClassFixture(prisma, {
      teacherId,
      scheduleRuleId: null,
      classType: 'Cross Family Holder',
      date: blocked,
      startTime: hhmmToTime('23:59'),
      durationMinutes: 60,
      teacherRoomId: teacherRoom.id,
      roomCost: 20,
      minRate: 30,
      targetRate: 60,
      minStudents: 3,
      maxStudents: 10,
      status: 'open',
    });

    try {
      const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
        classType: 'Cross Family Probe, Renamed',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.firstEffective).not.toBeNull();
      expect(result.firstEffective!.getTime()).toBe(mondayOf(nextWeek));
      expect(result.firstEffective!.getTime()).not.toBe(mondayOf(blocked));
    } finally {
      await prisma.calendarEntry.delete({ where: { id: holder.calendarEntryId } });
      await prisma.teacherRoom.delete({ where: { id: teacherRoom.id } });
      await prisma.room.delete({ where: { id: room.id } });
      // `StudioClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue
      // 298), so deleting the rule removes the template with it.
      await prisma.scheduleRule.delete({ where: { id: t.scheduleRuleId } });
    }
  });

  /**
   * The liveness half. Since #327 `cancelledAt IS NULL` is the ONE spelling
   * both families use, on the entry, and it is the exclusion constraint's own
   * partial predicate — so a cancelled class holds no slot and the date stays
   * reachable. Widen the probe's slot read past liveness and this goes red.
   *
   * TOMORROW's weekday, for the slot reason the case above gives. That moves
   * the first candidate to tomorrow, which is what `notBlocked` names; nothing
   * else about the case changes, since `23:59` tomorrow is ahead of now at
   * every hour this can run.
   */
  it('does not decline a date a CANCELLED class from the other family holds', async () => {
    const tomorrowSchemaDay = ((new Date().getUTCDay() + 6) % 7 + 1) % 7;
    const t = await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'studio',
            classType: 'Cross Family Probe Cancelled',
            dayOfWeek: tomorrowSchemaDay,
            startTime: hhmmToTime('23:59'),
            durationMinutes: 60,
          },
        },
        location: 'Update Studio',
        hourlyRate: 45,
      },
    });

    const notBlocked = getNextOccurrences(tomorrowSchemaDay, new Date(), 1)[0]!;

    const room = await prisma.room.create({
      data: {
        venueName: 'Cross Cancelled Venue', address: `${t.id} Cross Cancelled Street`, city: 'Amsterdam',
        postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
        isPublic: false, createdById: teacherId,
      },
    });
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12 },
    });
    const holder = await createClassFixture(prisma, {
      teacherId,
      scheduleRuleId: null,
      classType: 'Cross Family Cancelled Holder',
      date: notBlocked,
      startTime: hhmmToTime('23:59'),
      durationMinutes: 60,
      cancelledAt: new Date(),
      teacherRoomId: teacherRoom.id,
      roomCost: 20,
      minRate: 30,
      targetRate: 60,
      minStudents: 3,
      maxStudents: 10,
      status: 'open',
    });

    try {
      const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
        classType: 'Cross Family Probe Cancelled, Renamed',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.firstEffective).not.toBeNull();
      expect(result.firstEffective!.getTime()).toBe(mondayOf(notBlocked));
    } finally {
      await prisma.calendarEntry.delete({ where: { id: holder.calendarEntryId } });
      await prisma.teacherRoom.delete({ where: { id: teacherRoom.id } });
      await prisma.room.delete({ where: { id: room.id } });
      await prisma.scheduleRule.delete({ where: { id: t.scheduleRuleId } });
    }
  });

  /**
   * The probe's past-start filter, and it is here because nothing else catches
   * it: with the five cases this task shipped in place, deleting the
   * `.filter(...)` from `updateStudioClassTemplate`'s horizon left all of them
   * green. The class family's twin was added for exactly that measurement one
   * file over, so this side starts with the guard covered rather than
   * discovering it later.
   *
   * The horizon drops an occurrence whose start instant has already passed,
   * the same predicate the generator applies to its own candidates. Without
   * it this names the CURRENT week on the template's own weekday once the
   * class hour has gone — the sweep never fills it, and the prediction lands
   * earlier than delivery, which is the dishonest direction.
   *
   * All three inputs are deliberate and none can drift with the calendar:
   *
   *   - `dayOfWeek` is TODAY's, computed from `new Date()`, so
   *     `getNextOccurrences` yields today as its first occurrence — its own
   *     comment says it includes today.
   *   - `startTime` is `'00:00'` and this block's teacher is pinned to UTC, so
   *     the start instant for today is today's midnight UTC, never strictly
   *     after `now`. Today is dropped on every run, at every hour, rather than
   *     only after some cutoff. It is also the opposite arrangement from the
   *     two cross-family cases above, which pick `23:59` to keep today's
   *     occurrence alive.
   *   - No entry exists for this rule, so no week is held and the answer is
   *     simply the first surviving candidate's week. Nothing else can be
   *     responsible for the difference.
   *
   * Both halves asserted — the week it IS and the week it is NOT — because the
   * failure is off by exactly one week and `not.toBe` alone would pass for any
   * other wrong answer.
   */
  it('drops an occurrence whose start has already passed, and names the week after', async () => {
    const todaySchemaDay = (new Date().getUTCDay() + 6) % 7;
    const t = await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'studio',
            classType: 'Past Start Probe',
            dayOfWeek: todaySchemaDay,
            startTime: hhmmToTime('00:00'),
            durationMinutes: 60,
          },
        },
        location: 'Update Studio',
        hourlyRate: 45,
      },
    });

    const occurrences = getNextOccurrences(todaySchemaDay, new Date(), 2);
    const todayOccurrence = occurrences[0]!;
    const nextWeekOccurrence = occurrences[1]!;

    try {
      const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
        classType: 'Past Start Probe, Renamed',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.firstEffective).not.toBeNull();
      expect(result.firstEffective!.getTime()).toBe(mondayOf(nextWeekOccurrence));
      expect(result.firstEffective!.getTime()).not.toBe(mondayOf(todayOccurrence));
    } finally {
      await prisma.scheduleRule.delete({ where: { id: t.scheduleRuleId } });
    }
  });

  /**
   * #194, pinned rather than merely asserted in prose.
   *
   * `updateStudioClassTemplate`'s docblock says editing `dayOfWeek` or
   * `startTime` leaves generated `StudioClass` rows exactly where they are.
   * Until this test, the statement was the only thing enforcing it: nothing in
   * the suite created instances, edited the template and checked what happened
   * to them, so adding a sync would have broken no test.
   *
   * Written as a pin on today's behaviour and NOT as an endorsement of it,
   * while #194 still carried two open product decisions (withdraw or leave
   * standing; mirror the class family's propagation, or not). #194 answered
   * both on 2026-08-20 — leave standing, and DELETE the class family's
   * propagation rather than mirror it — so this case now pins the decided rule
   * for this family rather than a placeholder, and the rewrite it was written
   * expecting is not coming. It still fails loudly when someone changes the
   * behaviour, which is the whole of its job.
   *
   * Also covers the two allowlisted fields nothing else writes: `dayOfWeek`
   * and `location` appear in no other update payload in this file.
   */
  it('leaves generated classes on the superseded schedule when dayOfWeek moves (#194)', async () => {
    const t = await makeTemplate(teacherId, 'No Sync On Edit');

    const instance = await createStudioClassFixture(prisma, {
        teacherId,
        scheduleRuleId: t.scheduleRuleId,
        classType: 'No Sync On Edit',
        date: futureOn(7),
        startTime: t.scheduleRule.startTime,
        durationMinutes: 60,
        location: 'Update Studio',
        hourlyRate: 45,
      });

    const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
      dayOfWeek: t.scheduleRule.dayOfWeek === 4 ? 5 : 4,
      location: 'Moved Studio',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.dayOfWeek).not.toBe(t.scheduleRule.dayOfWeek);
    expect(result.template.location).toBe('Moved Studio');

    // The instance is untouched: same day, same time, same location, not
    // cancelled, still attached. Four assertions rather than one because a
    // future sync could plausibly move it, cancel it, re-point it or delete
    // it, and each would be a different product answer to #194.
    const after = await prisma.studioClass.findUnique({ where: { id: instance.id }, include: { calendarEntry: true } });
    expect(after).not.toBeNull();
    expect(after?.calendarEntry.startTime.getTime()).toBe(instance.calendarEntry.startTime.getTime());
    expect(after?.location).toBe('Update Studio');
    expect(after?.calendarEntry.cancelledAt).toBeNull();
    expect(after?.calendarEntry.scheduleRuleId).toBe(t.scheduleRuleId);
  });

  /**
   * #284's first acceptance bullet, and the strongest form of the case above
   * it: an edit leaves every already-generated studio class BYTE-IDENTICAL.
   *
   * Whole rows, not a chosen field list. The case above names four fields, and
   * a list can only prove the fields whoever wrote it thought of — a
   * propagation that rewrote a fifth would pass it. `findMany` with no
   * `select` compares every column of both rows, so any write to either table
   * fails here whether or not anyone anticipated the column.
   *
   * Both tables, because the split is where a propagation would land: #327 put
   * the schedule on `CalendarEntry` and the economics on `StudioClass`, and a
   * sync that moved the day would touch the first while a sync that mirrored
   * the location would touch the second.
   *
   * A real generated window rather than hand-made fixtures — these are the
   * rows the sweep actually produces, complete with their `scheduleRuleId`
   * back-reference, which is what a propagation would follow.
   *
   * `dayOfWeek` AND `startTime` in ONE call, because both are the fields a
   * sync would have to rewrite and an edit that moved only one would leave the
   * other's path untested. The template's own row is asserted to have moved,
   * so a no-op edit cannot be what makes the comparison hold.
   */
  it('leaves every generated studio class byte-identical when the schedule moves (#284)', async () => {
    const t = await makeTemplate(teacherId, 'Byte Identical');
    const withZone = await prisma.studioClassTemplate.findUniqueOrThrow({
      where: { id: t.id },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    });
    const generated = await generateStudioInstancesForTemplate(prisma, withZone);
    expect(generated.created).toBe(4);

    const readEntries = () =>
      prisma.calendarEntry.findMany({
        where: { scheduleRuleId: t.scheduleRuleId },
        orderBy: { date: 'asc' },
      });
    const readChildren = () =>
      prisma.studioClass.findMany({
        where: { calendarEntry: { scheduleRuleId: t.scheduleRuleId } },
        orderBy: { calendarEntryId: 'asc' },
      });

    const entriesBefore = await readEntries();
    const childrenBefore = await readChildren();
    expect(entriesBefore).toHaveLength(4);
    expect(childrenBefore).toHaveLength(4);

    // Thursday in the schema's convention (0 = Monday), which is where no
    // other rule of this teacher sits: `makeTemplate` puts every one of them
    // on `dayOfWeek: 4`, so the move cannot collide with a sibling slot.
    const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
      dayOfWeek: 3,
      startTime: '06:15',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.dayOfWeek).toBe(3);
    expect(result.template.startTime).toBe('06:15');

    expect(await readEntries()).toEqual(entriesBefore);
    expect(await readChildren()).toEqual(childrenBefore);
  });
});
