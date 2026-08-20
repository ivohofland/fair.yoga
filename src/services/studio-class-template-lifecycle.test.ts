import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  archiveOrUnarchiveStudioTemplate,
  pauseOrResumeStudioTemplate,
  updateStudioClassTemplate,
} from './studio-class-template-lifecycle';
import { log } from '@/lib/log';

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
  // `date` truncates to a calendar day and carries `@@unique([templateId,
  // date])`, so tests that put more than one class on the same template need
  // distinct days — plain `future()` called twice would collide.
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let otherTeacherId: string;
  let otherAccountId: string;

  // Counter-derived startTime: this block calls makeTemplate 15 times for
  // one teacher/dayOfWeek (landing on `slotTime(45)` = `'09:45'`, 14 minutes
  // of headroom before the old raw-literal formula would have silently
  // produced an invalid `'09:60'` — hence `slotTime`, see its docblock), and
  // most tests never archive their template (the 'forbidden' cases, and
  // several 'keeps'/'records' cases where archiving matches nothing to
  // withdraw but still runs against a template that stays unarchived until
  // its own later un-archive, if any) — so, mirroring the class family's
  // equivalent block, one unarchived leftover blocks every later
  // makeTemplate call under StudioClassTemplate_teacher_slot_unique before
  // it even creates a row. No test reads or asserts a created template's
  // literal startTime, so a distinct minute per call removes the collision
  // without touching any assertion.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string) => {
    makeTemplateCounter += 1;
    return prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType,
        dayOfWeek: 3,
        startTime: slotTime(30 + makeTemplateCounter),
        durationMinutes: 60,
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
  // under StudioClass_teacher_slot_unique once the template-level collision
  // above stops masking it. No test here reads or asserts the created
  // class's literal startTime. Routed through `slotTime` (see its docblock)
  // rather than a raw `09:${counter}` literal, matching `makeTemplate`'s own
  // counter above.
  let makeClassCounter = 0;
  const makeClass = (templateId: string, opts: { date: Date; cancelledAt?: Date | null }) => {
    makeClassCounter += 1;
    return prisma.studioClass.create({
      data: {
        teacherId,
        templateId,
        classType: 'Archive Rule',
        date: opts.date,
        startTime: slotTime(makeClassCounter),
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
        cancelledAt: opts.cancelledAt ?? null,
      },
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
      'archived',
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("returns forbidden for another teacher's template, and leaves it and its classes untouched", async () => {
    const t = await makeTemplate('Not Yours');
    const c = await makeClass(t.id, { date: future() });

    // The ownership check is the only thing stopping teacher B from
    // destroying teacher A's schedule — this is the function that deletes
    // rows, so it must refuse before touching anything.
    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, otherTeacherId, 'archived');

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isArchived).toBe(false);
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
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isArchived).toBe(false);
  });

  it('deletes a future uncancelled studio class', async () => {
    const t = await makeTemplate('Del Unbooked');
    const c = await makeClass(t.id, { date: future() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(0);
  });

  it('keeps an already-cancelled future class — it is an income record, not an offer', async () => {
    const t = await makeTemplate('Keep Cancelled');
    const c = await makeClass(t.id, { date: future(), cancelledAt: new Date() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
  });

  it("keeps today's class — the date > now boundary", async () => {
    const t = await makeTemplate('Keep Today');
    const c = await makeClass(t.id, { date: today() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');

    const archived = expectArchived(result);
    expect(archived.template.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
    // The literal `remaining: 0` this replaced would have been wrong here.
    expect(archived.remaining).toBe(1);
  });

  it("reports deleted: 0, remaining: 1 when today's class is the only one scheduled", async () => {
    const t = await makeTemplate('Today Only');
    await makeClass(t.id, { date: today() });

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
    const c = await makeClass(t.id, { date: past() });

    const result = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { id: c.id } })).toBe(1);
  });

  it('reports deleted and remaining counts — remaining is 0 with nothing scheduled today', async () => {
    const t = await makeTemplate('Counts');
    const unbooked1 = await makeClass(t.id, { date: futureOn(5) });
    const unbooked2 = await makeClass(t.id, { date: futureOn(6) });
    const pastClass = await makeClass(t.id, { date: past() });
    // Future, uncancelled classes have no registrations to consult at all —
    // there is no charged-status filter, so every one of them beyond today is
    // deletable. None of these is dated today, so `remaining` — which now
    // only ever counts a today survivor — is 0 here (see the "keeps today's
    // class" case above for when it is not).
    const alreadyCancelled = await makeClass(t.id, {
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
    const unbooked = await makeClass(t.id, { date: futureOn(5) });
    const cancelled = await makeClass(t.id, { date: futureOn(6), cancelledAt: new Date() });

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
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: futureOn(6) });

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
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.withdrawnCount).toBe(2);
    expect(after.archivedAt).not.toBeNull();
    expect(after.archivedAt!.getTime()).toBe(archived.template.archivedAt!.getTime());
  });

  /**
   * The count must equal what was deleted, not what was scheduled. Today's
   * class is spared by the delete's boundary, so the two numbers differ here —
   * which is exactly the case a `count()` written from the wrong query would
   * get wrong while looking right.
   */
  it('records the deleted count, not the scheduled count', async () => {
    const t = await makeTemplate('Withdrawal Excludes Today');
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: futureOn(6) });
    await makeClass(t.id, { date: today() });

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

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.withdrawnCount).toBe(0);
    expect(after.archivedAt).not.toBeNull();
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
    await makeClass(t.id, { date: futureOn(5) });
    expectArchived(await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'));

    const recorded = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(recorded.withdrawnCount).toBe(1);
    expect(recorded.archivedAt).not.toBeNull();

    const resumed = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'unarchived');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');

    expect(resumed.template.archivedAt).toBeNull();
    expect(resumed.template.withdrawnCount).toBeNull();

    // As above: the assertions so far only prove what came back in the
    // response. Re-read the row to prove the clear reached the database.
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.archivedAt).toBeNull();
    expect(after.withdrawnCount).toBeNull();
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
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: futureOn(6) });
    expectArchived(await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'));
    await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'unarchived');

    await makeClass(t.id, { date: futureOn(7) });
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
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: futureOn(6) });

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

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.withdrawnCount).toBe(2);
    expect(after.archivedAt).not.toBeNull();
    expect(after.archivedAt!.getTime()).toBe(winner.template.archivedAt!.getTime());
    expect(await prisma.studioClass.count({ where: { templateId: t.id } })).toBe(0);
  });
});

describe('pauseOrResumeStudioTemplate (DB)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let otherTeacherId: string;
  let otherAccountId: string;

  // Counter-derived startTime: this block calls makeTemplate 12 times for
  // one teacher/dayOfWeek (landing on `slotTime(42)` = `'09:42'`, 17 minutes
  // of headroom before the old raw-literal formula would have silently
  // produced an invalid `'09:60'` — hence `slotTime`, see its docblock), and
  // pausing (unlike archiving) never sets isArchived, so a merely-paused
  // template keeps occupying its slot for the rest of the run — mirroring
  // the class family's equivalent block. No test reads or asserts a created
  // template's literal startTime.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string) => {
    makeTemplateCounter += 1;
    return prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType,
        dayOfWeek: 3,
        startTime: slotTime(30 + makeTemplateCounter),
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
      },
    });
  };

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
   * `makeClass(t.id, new Date(), …)` land exactly on `gte` rather than a day
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
  // above and in a different hour (10:xx, not 09:xx, via `slotTime(60 +
  // counter)`) so the two counters can never land on the same value even on
  // a day where dayOfWeekNeverToday() happens to equal makeTemplate's fixed
  // dayOfWeek 3: all 3 calls to this helper compute the same
  // dayOfWeekNeverToday()
  // for a given run, and none of their templates ends up archived at the
  // end of its test ('Resume After Archive' un-archives at the finish), so
  // all 3 would collide with each other at a shared '09:30' — a fixed
  // startTime here would only ever surface as flaky, on the days
  // dayOfWeekNeverToday() coincides with 3. dayOfWeek itself is left
  // untouched: it is deliberately chosen to never fall on today.
  let makeTemplateOnCounter = 0;
  const makeTemplateOn = (classType: string, dayOfWeek: number) => {
    makeTemplateOnCounter += 1;
    return prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType,
        dayOfWeek,
        startTime: slotTime(60 + makeTemplateOnCounter),
        durationMinutes: 60,
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
      await prisma.studioClass.deleteMany({ where: { teacherId: t } });
      await prisma.studioClassTemplate.deleteMany({ where: { teacherId: t } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('pausing deletes nothing and reports the furthest-out scheduled class', async () => {
    const t = await makeTemplate('Pause Active');
    const soon = await makeClass(t.id, futureOn(3), '08:00');
    const later = await makeClass(t.id, futureOn(10), '19:00');

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    if (result.action !== 'paused') throw new Error('expected the paused action');
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

  /**
   * Pre-#94 this title read "…without deleting or generating anything" —
   * true then, false now that resuming generates (see the "fills the window"
   * case below for that behaviour on its own). What survives from the
   * original test: a class already on the schedule is not deleted by the
   * resume that follows. `c`'s date is arbitrary relative to the template's
   * own pattern — `futureOn(3)` against `dayOfWeek: 3` coincides with it one
   * day in seven, so this fixture is not reliably "off pattern" and the test
   * does not depend on which it is. Duplication is not asserted separately:
   * `@@unique([templateId, date])` makes two rows at the same date
   * unrepresentable, so a count at `c`'s own date could only ever show 0 or
   * 1 and would add nothing beyond the not-deleted check below.
   */
  it('resuming toggles isActive back on and does not delete an already-scheduled class', async () => {
    const t = await makeTemplate('Resume Simple');
    // '08:01', not '08:00': the earlier "pausing deletes nothing..." test
    // above leaves its own `soon` class at futureOn(3)/'08:00' standing
    // (pausing never deletes), which would otherwise collide under
    // StudioClass_teacher_slot_unique. The exact minute is arbitrary here —
    // see the comment above — so this is a same-family repair, not a
    // change to what the test proves.
    const c = await makeClass(t.id, futureOn(3), '08:01');

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
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(true);
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
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(true);
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
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(false);
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

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(false);
    expect(after.isArchived).toBe(true);
  });

  /**
   * #94. Resuming used to flip `isActive` and stop, leaving the teacher on an
   * empty schedule until the hourly sweep. It could not call
   * `generateStudioClassInstances` — that sweeps every teacher on the
   * instance — so the fix was a per-template generator to call instead.
   */
  it('fills the window when resuming', async () => {
    const t = await makeTemplate('Resume Generates');
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
      data: { isActive: false },
    });

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.action).toBe('active');
    if (result.action !== 'active') throw new Error('expected the active action');
    expect(result.added).toBe(4);
    expect(result.scheduled).toBe(4);
    expect(await prisma.studioClass.count({ where: { templateId: t.id } })).toBe(4);

    // The window count above reads the database, but the resume itself is
    // only asserted through the returned `action`. Re-read the flag too: the
    // window and the flip commit in one transaction, and a test that watches
    // only one of them cannot say the pair stayed together.
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(true);
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
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
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
   * classes (they are income records), and the generator's existence probe has
   * no `cancelledAt` filter, so those dates cannot be regenerated either —
   * `@@unique([templateId, date])` makes it unrepresentable. The teacher
   * therefore gets back fewer classes than the archive withdrew, and before
   * this test nothing said so.
   */
  it('reports a window shortened by cancelled classes, not the four it withdrew', async () => {
    const t = await makeTemplateOn('Resume After Archive', dayOfWeekNeverToday());
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
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
    const generated = await prisma.studioClass.findMany({
      where: { templateId: t.id },
      orderBy: { date: 'asc' },
      select: { id: true },
    });
    expect(generated).toHaveLength(4);
    const toCancel = generated.slice(2).map((c) => c.id);
    expect(toCancel).toHaveLength(2);
    await prisma.studioClass.updateMany({
      where: { id: { in: toCancel } },
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
      await prisma.studioClass.count({
        where: { templateId: t.id, cancelledAt: { not: null } },
      }),
    ).toBe(2);
  });

  /**
   * The all-cancelled extreme of #192: every candidate date holds a cancelled
   * own row, so the resume creates nothing and `scheduled` is 0 because the
   * rows that block it are exactly the rows the count excludes. The teacher
   * already learns this (`resumeStudioMessage`'s `scheduled === 0` branch);
   * what this pins is that the result names *which* mechanism filled the
   * window's dates — the count that makes the operator-facing `log.warn` (and
   * the Task 6 copy) a measured number rather than an inference.
   */
  it('reports the cancelled classes holding the window', async () => {
    const t = await makeTemplate('Blocked By Cancelled');
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
      data: { isActive: false },
    });

    const filled = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');
    expect(filled.ok).toBe(true);
    if (!filled.ok) throw new Error('expected ok');
    if (filled.action !== 'active') throw new Error('expected the active action');
    // Precondition: a full window stood before anything was cancelled, so the
    // 0s below are caused by the cancels, not by a starved fixture.
    expect(filled.added).toBe(4);

    await prisma.studioClass.updateMany({
      where: { templateId: t.id },
      data: { cancelledAt: new Date() },
    });

    await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');
    const resumed = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(resumed).toMatchObject({
      ok: true,
      action: 'active',
      added: 0,
      scheduled: 0,
      blockedByCancelled: 4,
    });
  });

  /**
   * The two filters inside `scheduled`'s count, each pinned by a row the other
   * filter would not move: one dated exactly on the `gte` boundary, one
   * cancelled and comfortably inside it. Both sit off the template's own
   * weekday, so generation neither creates nor touches them.
   */
  it('counts a class dated today, and excludes a cancelled one', async () => {
    const t = await makeTemplateOn('Resume Counts Boundary', dayOfWeekNeverToday());
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
      data: { isActive: false },
    });

    // Exactly on the `gte: today` boundary.
    await makeClass(t.id, new Date(), '07:00');
    // Inside the boundary but cancelled. `futureOn(1)` cannot collide with the
    // generated window, which starts two days out by construction.
    await prisma.studioClass.create({
      data: {
        teacherId,
        templateId: t.id,
        classType: 'Pause Rule',
        date: futureOn(1),
        startTime: '07:30',
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
        cancelledAt: new Date(),
      },
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
    expect(await prisma.studioClass.count({ where: { templateId: t.id } })).toBe(0);
  });

  /**
   * The archived guard runs before the write, so an archived template must
   * come back refused with nothing generated — not merely un-flipped. This is
   * the case where generating would be worst: archiving just deleted the
   * window on purpose.
   */
  it('refuses to resume an archived template, and generates nothing', async () => {
    const t = await makeTemplate('Archived Resume');
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
      data: { isActive: false, isArchived: true },
    });

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'archived' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(false);
    expect(await prisma.studioClass.count({ where: { templateId: t.id } })).toBe(0);
  });

  /**
   * The race a reviewer of this fix reproduced against
   * `pauseOrResumeStudioTemplate`'s own "provably unreachable" claim: that
   * function's two fast-path guards are read outside any lock, so a
   * concurrent archive can commit in the gap between those reads and its own
   * transaction. Constructed the same way as this
   * file's `archiveOrUnarchiveStudioTemplate` concurrent-archive test — a
   * third transaction holds the row lock so both requests queue behind it —
   * except archive is started and confirmed queued first, so Postgres's FIFO
   * lock grant hands it the row before resume's CAS gets a turn. Resume must
   * then see the row already archived and answer `{ reason: 'archived' }`,
   * not throw the "claim predicate diverged" error the old comment warned
   * about.
   */
  it('a concurrent archive mid-resume is reported as archived, not thrown', async () => {
    const t = await makeTemplate('Resume Vs Archive Race');
    await prisma.studioClassTemplate.update({ where: { id: t.id }, data: { isActive: false } });

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
    expect(await prisma.studioClass.count({ where: { templateId: t.id } })).toBe(0);
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
    // `ResumeTransactionOutcome`'s docstring singles out when it claims none
    // of its arms ever carries the stale pre-transaction snapshot; without
    // these two lines that claim has nothing holding it.
    expect(pauseResult.template.isArchived).toBe(true);
    expect(pauseResult.template.isActive).toBe(false);
  });
});

describe('updateStudioClassTemplate (DB)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let counter = 0;

  const makeTemplate = async (owner: string, classType: string) => {
    counter += 1;
    return prisma.studioClassTemplate.create({
      data: {
        teacherId: owner,
        classType,
        dayOfWeek: 4,
        startTime: slotTime(counter),
        durationMinutes: 60,
        location: 'Update Studio',
        hourlyRate: 45,
      },
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
      await prisma.studioClass.deleteMany({ where: { teacherId: t } });
      await prisma.studioClassTemplate.deleteMany({ where: { teacherId: t } });
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
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.classType).toBe('Not Yours');
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

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.classType).toBe('Undefined Only');
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
  });

  it('returns slot_conflict when the edit lands on a live sibling slot, and logs it', async () => {
    const occupant = await makeTemplate(teacherId, 'Slot Occupant');
    const mover = await makeTemplate(teacherId, 'Slot Mover');

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const result = await updateStudioClassTemplate(prisma, mover.id, teacherId, {
        startTime: occupant.startTime,
      });

      expect(result).toEqual({ ok: false, reason: 'slot_conflict' });

      // #231: a RETURNED failure never reaches `withErrorHandler`, and
      // `respondError` does not log. Catching this P2002 is what would delete
      // the line `classifyApiError` emits when it escapes, so the catch has to
      // put one back.
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: mover.id, teacherId }),
        'studio template edit refused by the slot index',
      );
    } finally {
      warn.mockRestore();
    }

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: mover.id } });
    expect(after.startTime).toBe(mover.startTime);
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
        expect(waited).toBeGreaterThanOrEqual(1_800);
        expect(waited).toBeLessThan(5_000);

        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ templateId: t.id, teacherId }),
          'studio template edit lost a lock race (its own row, or the slot index against a concurrent write) — nothing committed',
        );
      } finally {
        warn.mockRestore();
        release();
        await blocking.catch(() => {});
      }

      const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.classType).toBe('Busy Edit');
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
   * housekeeping, **not** a constraint, and this comment used to claim
   * otherwise. Both families' instance FK is `onDelete: SetNull` —
   * `prisma/schema.prisma:432` for `Class.template`, `:533` for
   * `StudioClass.template`, and `ON DELETE SET NULL` in both migrations. A
   * reader who trusted the old wording would conclude the two schemas differ
   * where they are identical.
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
   * #194, pinned rather than merely asserted in prose.
   *
   * `updateStudioClassTemplate`'s docblock says editing `dayOfWeek` or
   * `startTime` leaves generated `StudioClass` rows on the superseded
   * schedule, because this family has no `syncTemplateInstances` equivalent —
   * and says the omission "is stated rather than left to be discovered". Until
   * this test, the statement was the only thing enforcing it: nothing in the
   * suite created instances, edited the template and checked what happened to
   * them, so adding a sync would have broken no test.
   *
   * Deliberately a pin on today's behaviour, NOT an endorsement of it. #194
   * carries two open product decisions (withdraw or leave standing; reuse
   * `syncTemplateInstances` or mirror it), and whichever way they go this test
   * is expected to be *rewritten* — that is the point. It fails loudly when
   * someone changes the behaviour, which is what turns a prose claim into a
   * decision someone has to make on purpose.
   *
   * Also covers the two allowlisted fields nothing else writes: `dayOfWeek`
   * and `location` appear in no other update payload in this file.
   */
  it('leaves generated classes on the superseded schedule when dayOfWeek moves (#194)', async () => {
    const t = await makeTemplate(teacherId, 'No Sync On Edit');

    const instance = await prisma.studioClass.create({
      data: {
        teacherId,
        templateId: t.id,
        classType: 'No Sync On Edit',
        date: futureOn(7),
        startTime: t.startTime,
        durationMinutes: 60,
        location: 'Update Studio',
        hourlyRate: 45,
      },
    });

    const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
      dayOfWeek: t.dayOfWeek === 4 ? 5 : 4,
      location: 'Moved Studio',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.dayOfWeek).not.toBe(t.dayOfWeek);
    expect(result.template.location).toBe('Moved Studio');

    // The instance is untouched: same day, same time, same location, not
    // cancelled, still attached. Four assertions rather than one because a
    // future sync could plausibly move it, cancel it, re-point it or delete
    // it, and each would be a different product answer to #194.
    const after = await prisma.studioClass.findUnique({ where: { id: instance.id } });
    expect(after).not.toBeNull();
    expect(after?.startTime).toBe(instance.startTime);
    expect(after?.location).toBe('Update Studio');
    expect(after?.cancelledAt).toBeNull();
    expect(after?.templateId).toBe(t.id);
  });
});
