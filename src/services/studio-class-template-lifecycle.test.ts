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
    // ever fabricates a return value instead of persisting it.
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.withdrawnCount).toBe(2);
    expect(after.archivedAt).not.toBeNull();
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
   */
  it('records zero when there was nothing to withdraw', async () => {
    const t = await makeTemplate('Nothing To Withdraw');

    const archived = expectArchived(
      await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.template.withdrawnCount).toBe(0);
    expect(archived.template.archivedAt).not.toBeNull();
  });

  it('clears the record when un-archiving', async () => {
    const t = await makeTemplate('Cleared On Resume');
    await makeClass(t.id, { date: futureOn(5) });
    expectArchived(await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived'));

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
});

describe('pauseOrResumeStudioTemplate (DB)', () => {
  const DAY = 24 * 60 * 60 * 1000;
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

  it('resuming toggles isActive back on without deleting or generating anything', async () => {
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
});
