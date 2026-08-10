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
   */
  const dayOfWeekNeverToday = () => {
    const jsDay = new Date().getUTCDay(); // 0=Sun … 6=Sat
    const schemaToday = (jsDay + 6) % 7; // schema: 0=Mon … 6=Sun
    return (schemaToday + 2) % 7;
  };

  const makeTemplateOn = (classType: string, dayOfWeek: number) =>
    prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType,
        dayOfWeek,
        startTime: '09:30',
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
      },
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
    expect(archived.deleted).toBe(2);
    await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'unarchived');

    const resumed = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    if (resumed.action !== 'active') throw new Error('expected the active action');
    // Two, not four. Only the dates the archive emptied come back.
    expect(resumed.added).toBe(2);
    expect(resumed.scheduled).toBe(2);
    // `scheduled >= added` — every added row is future-dated and uncancelled,
    // so it necessarily falls inside `scheduled`'s range.
    expect(resumed.scheduled).toBeGreaterThanOrEqual(resumed.added);

    // The spared pair still stands: the archive left them and the resume did
    // not resurrect them.
    expect(
      await prisma.studioClass.count({
        where: { templateId: t.id, cancelledAt: { not: null } },
      }),
    ).toBe(2);
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
    // Four generated plus today's = 5. The cancelled one does not count.
    expect(resumed.scheduled).toBe(5);
    expect(resumed.scheduled).toBeGreaterThanOrEqual(resumed.added);
  });

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
    const c = await makeClass(t.id, futureOn(3), '08:00');

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
