/**
 * @serial-tier lock-contention — every case below opens a second connection,
 * takes `SELECT "id" FROM "StudioClassTemplate" … FOR UPDATE` on one template
 * row and holds it while the verb under test queues behind that row under the
 * 2s `lock_timeout` `setLockTimeout` (`db-locks.ts`) puts on it. Each is
 * therefore both a source of lock noise on a table the parallel tier writes
 * all over, and an assertion a tier-mate's noise can falsify — and the shapes
 * here fail in different directions.
 *
 * THE STAGED RACES — the cases that start two racers against the held row and
 * assert what each of them got. The hold ends on an explicit `release()` and
 * never on a budget of its own, so the holding transaction cannot free the row
 * by expiring; what decides WHEN that release fires is a fixed 300ms sleep,
 * roughly half a second into the racers' wait, and it is the expiry of that
 * same sleep the "both still unsettled" assertion is taken after. Noise cannot
 * break the unsettled half: a slower tier only keeps them queued longer. What
 * it endangers is the slack it leaves inside the 2s bound. Staging the race
 * spends 400-500ms of that bound deliberately, so roughly 1.5s stands between
 * the release path — the sleep resolving,
 * `release()`, the holder's `COMMIT` — and the point where the queued racers
 * stop waiting and answer `busy` instead of `archived` or `unchanged`. Past
 * that they report a broken guard while the guard is intact.
 *
 * A race whose two parties must arrive in a particular ORDER spends a second
 * margin on top of that: the 100ms between starting the archive and starting
 * the racer that must lose to it. Postgres grants the row FIFO, and that gap
 * is the whole reason the archive gets it first — invert it and the loser's
 * compare-and-swap runs before the archive commits, so the expected
 * `{ ok: false, reason: 'archived' }` arrives as an `ok` and the case indicts
 * the CAS-miss classification it was written to hold. A race that finds its
 * winner and loser by RESULT rather than by position is indifferent to
 * arrival order, so only the handshake margin below exposes that one.
 *
 * That handshake is the margin under every case here: 100ms for the holder's
 * `FOR UPDATE` to land before the first racer starts. Lose it and a racer
 * takes the row first and settles, and the case fails having never staged its
 * race at all.
 *
 * THE ONES THAT LET THE HOLD OUTLIVE THE BOUND, asserting the `busy` the
 * queued verb gives up with, the warn line that records it, and a floor of
 * 1_800ms on `waited`. Noise can only push `waited` up, so the floor cannot
 * break, and the `busy` survives even a Prisma `P2028` — `isTransientDbError`
 * (`api-errors.ts`) covers both codes. What such a case has instead are outer
 * bounds: the holder's own Prisma `{ timeout: … }` and the vitest budget on
 * the case, tens of seconds each here. A tier that stretches the span from
 * opening the holder to releasing it past the holder's budget makes Prisma
 * abort the holder, which frees the row and lets the queued verb commit and
 * answer `ok`. No CEILING on `waited` is asserted — #323 took the wall-clock
 * ceilings off this repo's lock-timeout cases so they could survive the
 * parallel tier — so a raised `LOCK_TIMEOUT_SQL` is not something this shape
 * can catch.
 *
 * SPLIT OUT OF `studio-class-template-lifecycle.test.ts` (#468), AND NOT ON
 * COST. A file named on `LOCK_CONTENTION_TESTS` (`vitest.tiers.ts`) becomes
 * the default home for every test added to it afterwards, and that file is
 * the general suite for `studio-class-template-lifecycle.ts`'s lifecycle
 * verbs — listing it would have pulled its whole future into the serial
 * tier, where this sibling grows only when someone writes another contention
 * case. What moving it whole would have cost was measured and is not what
 * decided this —
 * `docs/superpowers/specs/2026-09-06-lock-contention-rest-design.md` §2.1.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  archiveOrUnarchiveStudioTemplate,
  pauseOrResumeStudioTemplate,
  updateStudioClassTemplate,
} from './studio-class-template-lifecycle';
import { log } from '@/lib/log';
import { hhmmToTime } from '@/lib/time-of-day';
import { createStudioClassFixture } from '../../tests/class-fixtures';
import { joinOrThrow } from '../../tests/lock-order-teardown';

const prisma = new PrismaClient();
// PREFIXED, not just timestamped: this file shares one test database with
// `studio-class-template-lifecycle.test.ts`, which it was split from, and with
// its serial tier-mates, and they all mint their fixtures from a clock value,
// so a bare `Date.now()` could collide on a unique email or slug. The prefix is
// spelled from this file's own name rather than from the shared subject,
// which makes
// the namespaces disjoint by construction rather than by luck, and every
// `afterAll` below sweeps its own describe's teacher only.
const uniqueSuffix = `studiotpllock-${Date.now()}`;

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than emitting an invalid minute like `'09:60'` once a
 * block's counter crosses 30. `totalMinutes % 60` is always 0-59 by
 * construction, so the shape check is a cheap self-proof of that invariant
 * rather than a defence this formula can fail. The HOUR check is not:
 * Postgres's `time` accepts nothing past `'24:00:00'`, and `/\d{2}/` matches
 * `'25'` and `'99'` as readily as `'09'`. It throws naming the argument it
 * was called with, because the caller derives that from its own counter and
 * the number is what lets the next person find which block ran out of slots.
 */
function slotTime(totalMinutesFrom9am: number): string {
  const hour = 9 + Math.floor(totalMinutesFrom9am / 60);
  const minute = totalMinutesFrom9am % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
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

/**
 * One teacher per describe below, each under this file's own suffix.
 * `ScheduleRule_teacher_slot_excl` (#298) is scoped per teacher and weekday,
 * and each describe carries its own slot counter and its own arithmetic — a
 * teacher apiece is what keeps the three from having to be reasoned about
 * together.
 *
 * `defaultTimezone: 'UTC'` is pinned rather than left to the schema default
 * of `Europe/Amsterdam` (#123). The archive's boundary compares an `@db.Date`
 * column holding a UTC calendar date against `startOfLocalDay(new Date(),
 * tz)`, and from 22:00 UTC in summer those two disagree by a day. No case
 * here sits within a day of that boundary — the archive case dates its
 * classes five and six days out — so the pin buys margin rather than
 * correctness, and it is here so a case added later inherits the agreement
 * instead of rediscovering it.
 */
const seedTeacher = async (label: string) => {
  const email = `studio-tpl-${label}-${uniqueSuffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: label,
      lastName: 'Teacher',
      email,
      account: { create: { email } },
      bio: `Teacher for ${label} studio template lock-order tests`,
      pageSlug: `studio-tpl-${label}-${uniqueSuffix}`,
      defaultTimezone: 'UTC',
    },
  });
  return { teacherId: teacher.id, accountId: teacher.accountId };
};

/**
 * Teardown for one describe's own teacher, in dependency order. Deleting the
 * `ScheduleRule` takes its `StudioClassTemplate` with it — that edge is
 * `onDelete: Cascade` (#298) — and deleting the `CalendarEntry` takes its
 * `StudioClass` the same way, so the entries go first and the rules after.
 */
const sweepTeacher = async (teacherId: string, accountId: string) => {
  await prisma.calendarEntry.deleteMany({ where: { teacherId } });
  await prisma.scheduleRule.deleteMany({ where: { teacherId } });
  await prisma.session.deleteMany({ where: { accountId } });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.account.delete({ where: { id: accountId } });
};

// One disconnect for the file, after the last describe's teardown: three
// describes each closing the shared client would leave the next one to
// reconnect lazily mid-run.
afterAll(async () => {
  await prisma.$disconnect();
});

describe('archiveOrUnarchiveStudioTemplate — queued behind a held template row (DB)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // `date` truncates to a calendar day and its entry carries
  // `@@unique([scheduleRuleId, date])`, so two classes on one template need
  // distinct days.
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;

  // Counter-derived startTime, a full `durationMinutes` (60) on from the
  // last: `ScheduleRule_teacher_slot_excl` (#298) excludes on RANGE overlap,
  // so slots a minute apart on one teacher and weekday collide. The case
  // below does end with its template archived, which releases the slot — the
  // constraint is scoped to `isArchived = false` — so the counter is what
  // keeps that from being load-bearing for whatever is added here next.
  //
  // Two disjoint ranges, not one sequence: `counter * 60 - 30` walks `'09:30'`
  // up to `'23:30'` and then runs out, since counter 16 computes `'24:30'` and
  // `slotTime` refuses it by name. Counters past 15 fill the morning the first
  // range never reaches, on exact multiples of 60 — a negative argument that
  // is not one puts JavaScript's negative remainder into the minutes, which
  // `slotTime` refuses too — and stop before counter 25, which would compute
  // `'09:00'` and overlap the first range's opening slot.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string) => {
    makeTemplateCounter += 1;
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

  // Counter-derived startTime and a ONE-MINUTE duration, which are one
  // decision (#327): `CalendarEntry_teacher_slot_excl` is a range overlap too,
  // so fixtures a minute apart have to be a minute long. Nothing here reads
  // either value — what the case below is about is which classes an archive
  // withdraws.
  let makeClassCounter = 0;
  const makeClass = (scheduleRuleId: string, opts: { date: Date }) => {
    makeClassCounter += 1;
    return createStudioClassFixture(prisma, {
      teacherId,
      scheduleRuleId,
      classType: 'Archive Rule',
      date: opts.date,
      startTime: hhmmToTime(slotTime(makeClassCounter)),
      durationMinutes: 1,
      location: 'Studio Loft',
      hourlyRate: 45,
      cancelledAt: null,
    });
  };

  /**
   * Narrows to the archiving arm. `deleted` and `remaining` live only on
   * `ArchiveRuleResult`'s (`rule-lifecycle.ts`) `archived` action, not on the
   * ok branch as a whole, so the assertions below cannot be written without
   * this.
   */
  const expectArchived = (result: Awaited<ReturnType<typeof archiveOrUnarchiveStudioTemplate>>) => {
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.action !== 'archived') throw new Error('expected the archiving direction');
    return result;
  };

  beforeAll(async () => {
    ({ teacherId, accountId } = await seedTeacher('lock-archive'));
  });

  afterAll(async () => {
    await sweepTeacher(teacherId, accountId);
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
    try {
      // Both are blocked in their first write. If either had settled here, the
      // two never contended and the rest of this test would prove nothing.
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
    } finally {
      // In a `finally`, so a failure above fails this test alone. Without it
      // the `FOR UPDATE` on this template row stands for the holder's full 15s
      // Prisma budget, this describe's `afterAll` (`sweepTeacher`) queues
      // behind it to delete that same template, and a broken guard is reported
      // as this test's own assertion failure plus an `afterAll` hook timeout
      // that names nothing about the guard.
      //
      // The two archives are joined here rather than below so a failure cannot
      // leave them writing this template against the shared `prisma` while
      // that sweep is already deleting it.
      release();
      await joinOrThrow(blocking, first, second);
    }

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
});

describe('pauseOrResumeStudioTemplate — queued behind a held template row (DB)', () => {
  let teacherId: string;
  let accountId: string;

  // Counter-derived startTime, a full `durationMinutes` (60) on from the last:
  // `ScheduleRule_teacher_slot_excl` (#298) excludes on RANGE overlap per
  // teacher and weekday, and pausing never sets `isArchived`, so a
  // merely-paused template goes on holding its slot for the rest of the run.
  //
  // Two disjoint ranges. The first walks `'12:00'` up to `'23:00'` and then
  // reaches counter 13, which computes `'24:00'` — a string `slotTime` allows
  // as Postgres's own last `time`, but which `hhmmToTime` parses as
  // `Date('1970-01-01T24:00:00Z')` and JavaScript normalizes to
  // `1970-01-02T00:00:00.000Z`: the date rolls forward and only the time
  // reaches the `@db.Time` column, so counter 13's row is stored at `'00:00'`
  // rather than at the `'24:00'` its own expression reads as. Counters past 13
  // therefore open their range at `'01:00'` and not at `'00:00'`, which
  // counter 13 silently holds. The exclusion constraint is the authority on
  // whether a slot is free; the arithmetic alone cannot see that rollover.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string) => {
    makeTemplateCounter += 1;
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

  beforeAll(async () => {
    ({ teacherId, accountId } = await seedTeacher('lock-pause'));
  });

  afterAll(async () => {
    await sweepTeacher(teacherId, accountId);
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
    try {
      // Both blocked in their own transaction's first statement. If either had
      // settled here, it never queued behind the held lock and the rest of
      // this test proves nothing about the race it targets.
      expect(archiveSettled).toBe(false);
      expect(resumeSettled).toBe(false);
    } finally {
      // In a `finally`, so a failure above fails this test alone. Without it
      // the `FOR UPDATE` on this template row stands for the holder's full 15s
      // Prisma budget, this describe's `afterAll` (`sweepTeacher`) queues
      // behind it to delete that same template, and a broken guard is reported
      // as this test's own assertion failure plus an `afterAll` hook timeout
      // that names nothing about the guard.
      //
      // The archive and the resume are joined here rather than below so a
      // failure cannot leave them writing this template against the shared
      // `prisma` while that sweep is already deleting it.
      release();
      await joinOrThrow(blocking, archive, resume);
    }

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
    // asserts this too — "refuses to resume an archived template, and
    // generates nothing", in `studio-class-template-lifecycle.test.ts` — and
    // the racing case is where getting it wrong is easier.
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: t.id } } } } } })).toBe(0);
  });

  /**
   * The other half of the same race, and the one the guard order in
   * `pauseOrResumeRule` (`rule-lifecycle.ts`) exists for — `unchanged`
   * checked ahead of `archived`: a *pause* racing an archive must answer
   * `unchanged`, not the `archived` a racing *resume* gets, because archiving
   * forces `isActive: false` and a paused-or-pausing template is therefore
   * already in the state a pause wants. The non-racing case for that order is
   * "an archived template is already paused — pausing it again is unchanged,
   * not a 409", in `studio-class-template-lifecycle.test.ts`.
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
    try {
      expect(archiveSettled).toBe(false);
      expect(pauseSettled).toBe(false);
    } finally {
      // In a `finally`, so a failure above fails this test alone. Without it
      // the `FOR UPDATE` on this template row stands for the holder's full 15s
      // Prisma budget, this describe's `afterAll` (`sweepTeacher`) queues
      // behind it to delete that same template, and a broken guard is reported
      // as this test's own assertion failure plus an `afterAll` hook timeout
      // that names nothing about the guard.
      //
      // The archive and the pause are joined here rather than below so a
      // failure cannot leave them writing this template against the shared
      // `prisma` while that sweep is already deleting it.
      release();
      await joinOrThrow(blocking, archive, pause);
    }

    const [archiveResult, pauseResult] = await Promise.all([archive, pause]);

    expect(archiveResult.ok).toBe(true);
    if (!archiveResult.ok) throw new Error('expected ok');
    expect(archiveResult.action).toBe('archived');

    // Not `{ ok: false, reason: 'archived' }` — the guard order named in this
    // case's docblock.
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
});

describe('updateStudioClassTemplate — queued behind a held template row (DB)', () => {
  let teacherId: string;
  let accountId: string;

  // Counter-derived startTime, spaced a full `durationMinutes` (60) apart:
  // `ScheduleRule_teacher_slot_excl` (#298) excludes on RANGE overlap per
  // teacher and weekday, and an edited template stays live and holds its slot
  // for the rest of the run. `counter * 60 - 30` puts the first call at
  // `'09:30'` and climbs an hour each time, until counter 16 computes
  // `'24:30'` and `slotTime` refuses it by name — a block that reaches that
  // needs a second, disjoint range to fall back to.
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
    });
  };

  beforeAll(async () => {
    ({ teacherId, accountId } = await seedTeacher('lock-update'));
  });

  afterAll(async () => {
    await sweepTeacher(teacherId, accountId);
  });

  /**
   * The bound, proved the way `studio-class-generator.test.ts`'s twin proves
   * the archive's: a second transaction holds the row — that twin holds it
   * through the generation claim, this one with a raw `SELECT … FOR UPDATE`,
   * so the shared part is the shape, not the locking call. The edit queues
   * behind it, and the floor on `waited` is what carries the claim.
   *
   * ONE BOUND, AND IT IS THE FLOOR. `waited >= 1_800` proves the edit really
   * waited on the row rather than sailing through — measured:
   * `LOCK_TIMEOUT_SQL` `'2s'` → `'1s'` fails it at 1024 ms, against an
   * unmutated 2025-2030 ms. There is deliberately no ceiling, so a *raised*
   * bound clears the floor and passes here — measured, `'2s'` → `'6s'` answers
   * `busy` at about 6 s. That mutation is caught by the literal pin in
   * `db-locks.test.ts` instead, which is where the bound's VALUE lives and
   * where every sibling case in this repo sends it.
   *
   * The 10s transaction budget can never be what answers instead, so nothing
   * here has to tell the two apart: Prisma cannot roll back a statement
   * already blocked inside Postgres. Removing `setLockTimeout` does not slide
   * the answer later — it stops the edit settling at all, so the case dies on
   * its own 20s timeout. That is the mutation record, not a prediction.
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
        // Lower bound proves it waited on the lock. Pinned by db-locks.test.ts (#323,
        // `waitlist-lock-order.test.ts`'s "gives up on the 2s bound when another
        // transaction holds the class row" docblock).
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
});
