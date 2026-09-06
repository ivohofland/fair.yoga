/**
 * @serial-tier lock-contention — every test below stages real Postgres
 * lock contention on a `ClassTemplate` or `ScheduleRule` row (a held
 * `FOR UPDATE`/`FOR KEY SHARE` spanning hundreds of milliseconds to several
 * seconds, or an injected `SET LOCAL lock_timeout = 1500`) and asserts on how
 * that contention resolves: real lock noise sharing a parallel tier with
 * them would land as a false failure or a false pass in either direction.
 *
 * Split out of `class-template-lifecycle.test.ts` (#459) for exactly that
 * reason. The guards below prove `updateClassTemplate`,
 * `archiveOrUnarchiveTemplate` and `pauseOrResumeTemplate` each genuinely
 * serialize against a concurrent writer through the row lock they claim to
 * hold — a lock outcome, not an update/archive/pause outcome.
 *
 * Each describe below seeds its own teacher rather than sharing one: the
 * three source blocks space their `ScheduleRule` fixture counters
 * differently (×75 against a 60-minute rule, ×60 against 60, ×10 against
 * 10), and `ScheduleRule_teacher_slot_excl`/`CalendarEntry_teacher_slot_excl`
 * are both scoped per teacher — a separate teacher per origin group
 * sidesteps any cross-group collision entirely rather than reconciling three
 * spacing schemes onto one counter.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  updateClassTemplate,
  archiveOrUnarchiveTemplate,
  pauseOrResumeTemplate,
} from './class-template-lifecycle';
import { isTransientDbError } from '@/lib/api-errors';
import { setLockTimeout } from '@/lib/db-locks';
import { hhmmToTime } from '@/lib/time-of-day';
import { log } from '@/lib/log';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`.
 * `CalendarEntry.startTime` is `@db.Time` and would refuse such a value
 * outright at the DB, which is a less useful failure here than this guard's
 * message naming the fixture counter that produced it. A copy of
 * `class-template-lifecycle.test.ts`'s own `slotTime`, not an import from
 * it — lock-order siblings duplicate fixture helpers rather than share them
 * (`docs/superpowers/specs/2026-09-05-lock-contention-extraction-design.md`
 * §2).
 */
function slotTime(totalMinutesFrom9am: number): string {
  const hour = 9 + Math.floor(totalMinutesFrom9am / 60);
  const minute = totalMinutesFrom9am % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  // Postgres's `time` accepts up to '24:00:00' and nothing later, but the
  // shape check below can't see that: `\d{2}` matches '25' and '99' exactly
  // as readily as '09'. Checked here instead, naming the `totalMinutesFrom9am`
  // this was called with — the caller derives that value from its own
  // counter, so the number here is what lets the next person find which call
  // ran the block out of slots.
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

// Hoisted to module scope, like `class-template-lifecycle.test.ts`'s own
// `seedTeacher`: a pure function of `label` (plus the module-scope
// `prisma`/`uniqueSuffix` above), so each describe below can seed its own,
// separate teacher/room/teacherRoom fixture from it.
const seedTeacher = async (label: string) => {
  const email = `tpl-lock-${label}-${uniqueSuffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: label,
      lastName: 'Teacher',
      email,
      account: { create: { email } },
      bio: `Teacher for ${label} template lock-order tests`,
      pageSlug: `tpl-lock-${label}-${uniqueSuffix}`,
      defaultTimezone: 'UTC',
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

  // Counter-derived startTime, ×75 against `durationMinutes: 60` — the same
  // spacing `class-template-lifecycle.test.ts`'s `updateClassTemplate (DB)`
  // block uses, kept because the only call below widens its own row to
  // `durationMinutes: 75` without moving it (see the test), and 60-wide
  // spacing would let that widened range reach into the next counter slot.
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
    const seeded = await seedTeacher('update');
    teacherId = seeded.teacherId;
    accountId = seeded.accountId;
    roomId = seeded.roomId;
    teacherRoomId = seeded.teacherRoomId;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue 298),
    // but this block's own test deletes the child directly and leaves the
    // parent behind — this sweep is what reaps it.
    await prisma.scheduleRule.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  /**
   * The replacement for the test task 6 deleted (see
   * `class-template-lifecycle.test.ts`'s docblock for `'maps a delete
   * landing between the read and the write to not_found'`).
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

      // Cast for the same reason every `$extends` client in
      // `class-template-lifecycle.test.ts` needs one: `$extends` is missing
      // `$on`, so it is not assignable to `updateClassTemplate`'s
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
  const DAY = 24 * 60 * 60 * 1000;
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;

  // Counter-derived startTime, ×10 against `durationMinutes: 10` — the same
  // spacing `class-template-lifecycle.test.ts`'s `archiveOrUnarchiveTemplate
  // (DB)` block uses for its own `makeTemplate`.
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

  // ONE MINUTE, spaced one minute per call, the same scheme the source
  // block's own `makeClass` uses: `CalendarEntry_teacher_slot_excl` is a
  // range overlap, so fixtures a minute apart must be a minute long or they
  // collide. Neither test below reads a created class's duration.
  let makeClassCounter = 0;
  const makeClass = (scheduleRuleId: string, opts: { date: Date }) => {
    makeClassCounter += 1;
    return createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      scheduleRuleId,
      classType: 'Archive Rule',
      date: opts.date,
      startTime: hhmmToTime(slotTime(makeClassCounter)),
      durationMinutes: 1,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'open',
    });
  };

  /**
   * Narrows to the archiving arm. `deleted`/`remaining` exist only there —
   * un-archiving reports no counts rather than two zeros that would read
   * like "archived, and nothing matched" — so every count assertion has to
   * say which direction it expected. That is the discriminant earning its
   * keep.
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
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.scheduleRule.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
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
    try {
      // Both are blocked in their first write. If either had settled here, the
      // two never contended and the rest of this test would prove nothing.
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
    } finally {
      // In a `finally`, so a failed assertion above still releases the
      // blocking transaction's `FOR UPDATE` hold rather than parking it —
      // until its own 15s `timeout` — on the very row the describe's
      // `afterAll` deletes next.
      release();
      await blocking;
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
   * The migration's `live` mirror column retired this scenario's staging. The
   * old version interposed a raw `scheduleRule.update` to reverse the
   * archive's CAS between its miss and its re-read so the re-read found the
   * row in the state this request asked to move AWAY from. That write no
   * longer commits mid-flight: `live` is FK-referenced, so it cascades to the
   * child row the archive transaction already holds `FOR UPDATE` and WAITS on
   * that hold until the archive's own re-read releases it (272). The reversal
   * can't land in the [-CAS, re-read] window at all.
   *
   * So this test measures the serialization the old staging slipped through:
   * the interposed flip gets a `lock_timeout` of its own and times out (55P03)
   * against the in-flight archive, the archive's CAS then matches and
   * completes, and the reversed-warning channel stays silent — the re-read can
   * no longer find a transition interrupted by a sibling.
   */
  it('refuses a concurrent rule-state flip that would reverse an in-flight archive', async () => {
    const t = await makeTemplate('No Reverse Window');

    let straddled = false;
    const flipFailure: unknown[] = [];
    const interposing = prisma.$extends({
      query: {
        scheduleRule: {
          async updateMany({ args, query }) {
            if (straddled) return query(args);
            straddled = true;
            // Staged where the pre-272 test staged its un-archive: after the
            // transaction has already taken the child row `FOR UPDATE`. The
            // migrate-time flip is refused below rather than thrown, so the
            // archive's own CAS runs against the untouched state.
            const flip = prisma.$transaction(
              async (tx) => {
                await tx.$executeRawUnsafe('SET LOCAL lock_timeout = 1500');
                await tx.scheduleRule.update({
                  where: { id: t.scheduleRuleId },
                  data: { isArchived: true },
                });
              },
              { timeout: 20_000 },
            );
            await flip.then(
              () => undefined,
              (error: unknown) => {
                flipFailure.push(error);
              },
            );
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const result = await archiveOrUnarchiveTemplate(interposing, t.id, teacherId, 'archived');

      expect(straddled).toBe(true);

      // REFUSED, not applied: the flip needed the child row the archive holds,
      // hit its own lock_timeout, and so never reversed anything.
      expect(flipFailure).toHaveLength(1);
      expect(isTransientDbError(flipFailure[0])).toBe(true);
      expect(String(flipFailure[0])).toMatch(/55P03|lock timeout/);

      // With nothing reversed the CAS matches and the archive completes.
      expect(result).toMatchObject({ ok: true, action: 'archived' });

      // The 503-warning channel is silent: no interposed flip can reverse the
      // transition between the archive's CAS and its re-read.
      const reversedLog = warn.mock.calls.find(
        (call) =>
          call[1] === 'recurring class archive CAS missed and the re-read found the transition reversed',
      );
      expect(reversedLog).toBeUndefined();
    } finally {
      warn.mockRestore();
    }

    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: t.id },
      include: { scheduleRule: true },
    });
    expect(after.scheduleRule.isArchived).toBe(true);
    expect(after.scheduleRule.archivedAt).not.toBeNull();
    expect(after.scheduleRule.withdrawnCount).not.toBeNull();
  });
});

describe('pauseOrResumeTemplate (DB)', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;

  // Counter-derived startTime, ×60 against `durationMinutes: 60` — the same
  // spacing `class-template-lifecycle.test.ts`'s `pauseOrResumeTemplate (DB)`
  // block uses for its own `makeTemplate`.
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
            startTime: hhmmToTime(slotTime(30 + makeTemplateCounter * 60)),
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
    const seeded = await seedTeacher('pause');
    teacherId = seeded.teacherId;
    accountId = seeded.accountId;
    roomId = seeded.roomId;
    teacherRoomId = seeded.teacherRoomId;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.scheduleRule.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  /**
   * The claim's observable effect, stated as a race rather than as a lock:
   * while `pauseOrResumeTemplate` generates, a concurrent `Class` insert for
   * this template cannot proceed — and with the claim removed, it can.
   *
   * The mechanism is the mode, and the row it is on. `claimTemplateForGeneration`
   * takes `FOR UPDATE` on the `ClassTemplate` row, which conflicts with a
   * concurrent `FOR KEY SHARE` on it. The CAS reaches that same row only
   * through the rule's `ON UPDATE CASCADE`, and what it writes there
   * (`ruleLive`) is not part of any unique index ON `ClassTemplate` — so the
   * cascade takes `FOR NO KEY UPDATE` on the child and does not conflict.
   * (The CAS's lock on the RULE row was upgraded to `FOR UPDATE` by issue 272;
   * that is a different row and does not change what this test measures.) So the claim is the only thing in this transaction that can
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
   * resume touches the child row only through the cascade, at
   * `FOR NO KEY UPDATE`, never conflicts with the holder, and succeeds.
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
        // The lower bound proves the wait was a lock wait cut short by
        // `setLockTimeout`, not an instant refusal. The 2s value is pinned by
        // `db-locks.test.ts` (#323).
        expect(waited).toBeGreaterThanOrEqual(1_800);

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
   * The residual-fourth-state arm had the same staging dependence as the
   * reversed arm above, so the migration retired that window too: a pause that
   * lands after the resume's CAS but before its re-read can no longer commit
   * at all, because the flip cascades to the child row the resume transaction
   * already holds `FOR UPDATE` (272). The stale flip now waits on that hold
   * and times out, the resume's own CAS matches the untouched state and wins,
   * and the class window is created instead of the old `busy` answer.
   */
  it('refuses a concurrent rule-state flip that would pre-empt an in-flight resume', async () => {
    const t = await makeTemplate('No Pre-empt Window');
    await prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { isActive: false } });

    let straddled = false;
    const flipFailure: unknown[] = [];
    const interposing = prisma.$extends({
      query: {
        scheduleRule: {
          async updateMany({ args, query }) {
            if (straddled) return query(args);
            straddled = true;
            // Staged where the pre-272 test staged its pause: after the
            // transaction has already taken the child row `FOR UPDATE`. The
            // flip is refused below rather than thrown, so the resume's CAS
            // runs against the untouched paused state and wins.
            const flip = prisma.$transaction(
              async (tx) => {
                await tx.$executeRawUnsafe('SET LOCAL lock_timeout = 1500');
                await tx.scheduleRule.update({
                  where: { id: t.scheduleRuleId },
                  data: { isActive: true },
                });
              },
              { timeout: 20_000 },
            );
            await flip.then(
              () => undefined,
              (error: unknown) => {
                flipFailure.push(error);
              },
            );
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'active');

    expect(straddled).toBe(true);

    // REFUSED, not applied: the flip needed the child row the resume held,
    // timed out, and so never flipped the CAS's predicate out from under it.
    expect(flipFailure).toHaveLength(1);
    expect(isTransientDbError(flipFailure[0])).toBe(true);
    expect(String(flipFailure[0])).toMatch(/55P03|lock timeout/);

    // With nothing pre-empted, the resume's CAS matches the paused row and the
    // resume completes — generating the class window instead of `busy`.
    expect(result).toMatchObject({ ok: true, action: 'active' });

    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: t.id },
      include: { scheduleRule: true },
    });
    expect(after.scheduleRule.isActive).toBe(true);
    expect(
      await prisma.class.count({
        where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: t.id } } } } },
      }),
    ).toBeGreaterThan(0);
  });
});
