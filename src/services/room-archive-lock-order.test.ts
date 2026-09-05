/**
 * @serial-tier lock-contention — holds a real row lock for seconds at a time,
 * which is noise every other file in a parallel tier would have to survive.
 *
 * `setTeacherRoomArchived`'s lock discipline (issue 272): the bound on its
 * pre-lock, and the order that pre-lock exists to impose.
 *
 * SEPARATE FROM `room-archive.test.ts` FOR A REASON THE FILENAME CANNOT CARRY.
 * Both cases below hold a real row lock for about two seconds, and this tier
 * runs its files in parallel. `template-lock-order.test.ts` asserts its own
 * race ends in neither `40P01` nor `55P03`, and a concurrent multi-second hold
 * pushes it into the second — measured: it passes alone, passes run beside
 * this file alone, and fails in the full tier. That is why this file is on
 * `LOCK_CONTENTION_TESTS` in `vitest.tiers.ts`. Both files are on it, so both
 * left the parallel tier; what protects the assertion is `unit-sweeps` running
 * its files one at a time, not the two being separated.
 *
 * WHAT THE SIBLING FILE'S RACE CASE DOES NOT COVER. Its
 * "answers busy when the archive already holds the child row" holds the child
 * by hand and watches a RESUME lose, which says nothing about what the archive
 * itself does — it passes with the pre-lock deleted outright, measured on the
 * full suite. These two put the archive on the waiting side, where the guard
 * is what decides the outcome.
 *
 * Both assert on elapsed time, which is unusual here and is the point: what is
 * being pinned is a BOUND and an ORDER, neither of which leaves a trace in a
 * row afterwards. The margins are wide enough that only the guard's absence
 * fits between them, and each case was verified to fail when its own guard is
 * removed.
 *
 * ISSUE 339 ADDED A SECOND FILE-RESIDENT EDGE, for the same reason as the
 * first: `CalendarEntry → Class` runs backward against this repo's fixed
 * order (`Class` then its entry — `docs/lock-order.md`, "Ordering BETWEEN
 * `Class` and its `CalendarEntry`"), and showing a writer that gets the order
 * backwards deadlocking against it means holding a real `Class` row lock open
 * on a second connection for the length of the shared lock-timeout bound —
 * the same multi-second hold the paragraphs above already argue belongs in
 * this serial file rather than the parallel tier.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { fixtureRun, type RoomFixture, type ClassFixtureStatus } from '../../tests/room-fixtures';
import { setTeacherRoomArchived } from './room-archive';
import { lockClassRow, setLockTimeout } from '@/lib/db-locks';

const prisma = new PrismaClient();
// `ral-` distinguishes this file's rows from `room-archive.test.ts`'s (`ra-`)
// and `room-archive-doors.test.ts`'s, so each file's cleanup sweeps only its
// own.
const fx = fixtureRun('ral');
const makeFixture = () => fx.makeFixture(prisma);
const addTemplate = (f: RoomFixture, opts: { isActive: boolean; isArchived: boolean }) =>
  fx.addTemplate(prisma, f, opts);
const addClass = (f: RoomFixture, status: ClassFixtureStatus) => fx.addClass(prisma, f, status);

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

describe('setTeacherRoomArchived — lock discipline (issue 272)', () => {
  // Both cases outlive vitest's 5s default: each waits out the bound under
  // test, then waits for the holder to let go.
  const HELD_CASE_TIMEOUT_MS = 20_000;

  // The holder's own ceiling. The hold normally ends when the body is done —
  // about a bound's worth — so this is reached only when the guard under test
  // is missing and the archive never gives up on its own. It exists so that
  // failure surfaces as a failed assertion at a known moment rather than as a
  // vitest timeout: without it the holder waits for the body, the body waits
  // for the archive, and the archive waits for the holder.
  const HOLD_CEILING_MS = 4_000;

  /**
   * Runs `body` while one of the room's child templates is held `FOR UPDATE`
   * on a connection of its own. This is the row `claimTemplateForGeneration`
   * holds for the length of a generation sweep — the archive under test
   * contends with exactly it.
   *
   * The hold is released by the body finishing rather than by a fixed sleep:
   * these cases run inside the full suite, and a lock held for a flat five
   * seconds is load every other file pays for. It also removes a race the
   * fixed-sleep version had — `body` now cannot start until the `FOR UPDATE`
   * has actually landed.
   */
  async function withHeldChild<T>(templateId: string, body: () => Promise<T>): Promise<T> {
    const holder = new PrismaClient();
    await holder.$connect();
    let acquired!: () => void;
    let release!: () => void;
    const acquiredSignal = new Promise<void>((r) => { acquired = r; });
    const releaseSignal = new Promise<void>((r) => { release = r; });
    let ceiling: ReturnType<typeof setTimeout> | undefined;

    try {
      const held = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "ClassTemplate" WHERE id = ${templateId} FOR UPDATE`;
          acquired();
          await Promise.race([
            releaseSignal,
            new Promise<void>((r) => { ceiling = setTimeout(r, HOLD_CEILING_MS); }),
          ]);
          return 'released';
        },
        { timeout: HOLD_CEILING_MS + 10_000 },
      );
      // A rejection handler attached now, not later: on the failure path below
      // `held` is never awaited, and an unobserved rejection would surface as
      // an unhandled one instead of the body's own failure.
      held.catch(() => {});

      await acquiredSignal;
      let result: T;
      try {
        result = await body();
      } finally {
        release();
      }
      // AFTER the try, deliberately. Inside its `finally` this assertion runs
      // even when `body` threw — and both cases below assert inside `body`, so
      // a real regression would be reported as "the holder did not release"
      // rather than as the guard that actually failed.
      expect(await held).toBe('released');
      return result;
    } finally {
      if (ceiling) clearTimeout(ceiling);
      await holder.$disconnect();
    }
  }

  // THE BOUND. Without `setLockTimeout` the pre-lock waits as long as the
  // holder takes — Prisma's transaction budget cannot cut short a statement
  // already blocked inside Postgres, only refuse to start a new one
  // (`db-locks.ts`), so the request would sit on a pool connection for the
  // whole sweep. With it the wait ends at the shared bound and the failure is
  // The assertion is that it gave up on the lock rather than waiting out
  // the holder. Bounded, it fails at the shared bound with `55P03`; unbounded,
  // it waits out the holder and SUCCEEDS, failing the `55P03` assertion.
  // There is deliberately no wall-clock upper bound (#323, waitlist.test.ts:525-555).
  it('gives up on the shared bound rather than waiting out the holder', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: false, isArchived: false });

    await withHeldChild(tpl.id, async () => {
      const startedAt = Date.now();
      await expect(
        setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived'),
      ).rejects.toThrow(/55P03|lock timeout/i);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_800);
    });

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.isArchived).toBe(false);
  }, HELD_CASE_TIMEOUT_MS);

  // THE ORDER, and the only assertion that can see it. While the archive is
  // blocked on the child it must NOT yet hold the room row — that is the whole
  // content of "children before the room". A third connection asking for the
  // room therefore gets it.
  //
  // Delete the pre-lock and this fails: `teacherRoom.update` takes the room
  // row first and blocks on the cascade to the held child while still holding
  // it, so the probe below times out instead. That is the backward edge the
  // generator deadlocked against (`40P01`, `docs/lock-order.md`, "The room
  // mirror's foreign keys are wait edges").
  //
  // ONE MECHANISM, BOTH CASCADES (issue 339 widened this case rather than
  // duplicating it). The pre-lock takes every `ClassTemplate` row in the room
  // `FOR UPDATE` before the room row itself, and that ordering is what this
  // test proves — but the eventual `teacherRoom.update`, when it runs,
  // cascades into every `Class` row in the room exactly as it cascades into
  // every `ClassTemplate` row, via the same statement's `ON UPDATE CASCADE`.
  // "Children before the room" is a property of WHEN the room lock is taken,
  // not of which children the pre-lock names, so it protects a cascade it
  // never explicitly locks. The `Class` row added to the fixture below is
  // there so that claim has something concrete to point at: the room stays
  // free while the archive is blocked on the (unrelated) held `ClassTemplate`
  // row, regardless of what else the room's eventual cascade would rewrite.
  //
  // DRAFT, not `open` — deliberately. `setTeacherRoomArchived`'s pre-write
  // count (`countBlockingClasses`) runs BEFORE the transaction this case is
  // about, and it counts `BLOCKING_CLASS_STATUSES` (`open`/`in_progress`)
  // only. An `open` class here would refuse the archive at that count and the
  // transaction under test — the pre-lock, the cascade, all of it — would
  // never run. `draft` is uncounted there and still `entryLive: true,
  // roomArchived: false`, so it is exactly as live a cascade target as an
  // `open` class would be, without tripping the earlier door this case is not
  // about.
  it('has not taken the room row while it waits on a child — the same order protects the Class cascade too (#339)', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: false, isArchived: false });
    const cls = await addClass(f, 'draft');
    const prober = new PrismaClient();
    await prober.$connect();

    try {
      await withHeldChild(tpl.id, async () => {
        const archiving = setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');
        // Long enough for the archive to reach its pre-lock and block, short
        // enough that the probe lands inside the bound it will expire on.
        await new Promise((r) => setTimeout(r, 800));

        await expect(
          prober.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
            await tx.$queryRaw`SELECT id FROM "TeacherRoom" WHERE id = ${f.linkId} FOR UPDATE`;
            return 'room was free';
          }),
        ).resolves.toBe('room was free');

        await expect(archiving).rejects.toThrow(/55P03|lock timeout/i);
      });
    } finally {
      await prober.$disconnect();
    }

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.isArchived).toBe(false);
    // The failed archive never reached its cascade, so the Class mirror is
    // exactly where it started — the same "refused, not half-applied" shape
    // `after.isArchived` above already checks for the room and the template.
    const clsAfter = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(clsAfter.roomArchived).toBe(false);
  }, HELD_CASE_TIMEOUT_MS);
});

/**
 * The `CalendarEntry → Class` edge (issue 339): `ON UPDATE CASCADE` into
 * `Class.entryLive` makes a cancel take the `Class` row lock while it holds
 * the entry — the reverse of this repo's fixed order (`Class` first, then its
 * entry; `docs/lock-order.md`, "Ordering BETWEEN `Class` and its
 * `CalendarEntry`"). What makes that safe is that every regular-entry
 * `cancelledAt` writer already takes the `Class` lock FIRST, so the cascade
 * re-locks a row its own transaction already owns rather than waiting on
 * anything. The two cases below pin that property and its failure mode.
 */
describe('CalendarEntry → Class cascade — lock discipline (issue 339)', () => {
  const HELD_CASE_TIMEOUT_MS = 20_000;
  const HOLD_CEILING_MS = 4_000;

  /**
   * Runs `body` while a `Class` row (and, via `lockClassRow`, its entry) is
   * held open on a connection of its own — the counterpart the second case
   * below needs: a real writer legitimately holding the `Class` lock, so a
   * hypothetical `cancelledAt` writer that skipped `lockClassRow` can be shown
   * blocking on it.
   *
   * Same acquire-signal / release-signal / ceiling shape as `withHeldChild`
   * in the describe above, parameterized on a `Class` row (via `lockClassRow`)
   * instead of a raw `ClassTemplate` `FOR UPDATE`. Kept local to this describe
   * rather than merged with `withHeldChild`: the two hold different rows via
   * different statements, and a shared abstraction over "which row" would
   * have to reach back into the sibling describe's `ClassTemplate`-specific
   * literal SQL for no reader's benefit.
   */
  async function withHeldClassRow<T>(classId: string, body: () => Promise<T>): Promise<T> {
    const holder = new PrismaClient();
    await holder.$connect();
    let acquired!: () => void;
    let release!: () => void;
    const acquiredSignal = new Promise<void>((r) => { acquired = r; });
    const releaseSignal = new Promise<void>((r) => { release = r; });
    let ceiling: ReturnType<typeof setTimeout> | undefined;

    try {
      const held = holder.$transaction(
        async (tx) => {
          // The `Class` row ONLY — deliberately not `lockClassRow`, which also
          // locks the entry directly. Locking the entry too would give the
          // backward writer below a direct lock to block on, the same one it
          // is about to write, which would mask the thing this test exists to
          // pin: that the wait comes from `ON UPDATE CASCADE` into
          // `Class.entryLive`, not from a second explicit statement here.
          await setLockTimeout(tx);
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
          acquired();
          await Promise.race([
            releaseSignal,
            new Promise<void>((r) => { ceiling = setTimeout(r, HOLD_CEILING_MS); }),
          ]);
          return 'released';
        },
        { timeout: HOLD_CEILING_MS + 10_000 },
      );
      held.catch(() => {});

      await acquiredSignal;
      let result: T;
      try {
        result = await body();
      } finally {
        release();
      }
      expect(await held).toBe('released');
      return result;
    } finally {
      if (ceiling) clearTimeout(ceiling);
      await holder.$disconnect();
    }
  }

  it('a cancel that takes the class lock first does not deadlock its own cascade', async () => {
    const f = await makeFixture();
    const cls = await addClass(f, 'open');
    const classId = cls.id;
    const entryId = cls.calendarEntryId;

    // The shape every production writer uses: lockClassRow, then write the
    // entry. The cascade back into Class.entryLive re-locks a row this
    // transaction already holds, so it waits on nothing.
    const cancelling = prisma.$transaction(async (tx) => {
      await lockClassRow(tx, classId);
      await tx.calendarEntry.update({
        where: { id: entryId },
        data: { cancelledAt: new Date() },
      });
    });

    // Concurrently, a writer that wants the same class row.
    const competing = prisma.$transaction(async (tx) => {
      await lockClassRow(tx, classId);
      await tx.class.update({ where: { id: classId }, data: { description: 'x' } });
    });

    const results = await Promise.allSettled([cancelling, competing]);
    const errs = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
    // Neither a deadlock nor a lock timeout: one waits for the other.
    expect(errs.join('\n')).not.toMatch(/40P01|55P03/);
  });

  // THE MUTATION, as a test rather than a manual step: this is what a fifth
  // `cancelledAt` writer added without `lockClassRow` would do, and it is the
  // regression the ordering rule exists to prevent. It documents the edge by
  // showing it biting.
  //
  // Measured: this is a one-directional wait, not a genuine circular
  // deadlock — the holder below takes the `Class`/entry lock and then simply
  // waits on an external release signal, so it is never itself blocked on
  // anything the backward writer holds. There is nothing for Postgres's
  // deadlock detector to find a cycle in, so the backward writer's own
  // `setLockTimeout` is what ends the wait: `55P03`, not `40P01`. Recorded
  // here rather than assumed, and the exact text is in the task's report.
  it('a cancel that writes the entry FIRST blocks on a class-lock holder and times out', async () => {
    const f = await makeFixture();
    const cls = await addClass(f, 'open');
    const classId = cls.id;
    const entryId = cls.calendarEntryId;

    await withHeldClassRow(classId, async () => {
      const backwards = prisma.$transaction(async (tx) => {
        await setLockTimeout(tx);
        await tx.calendarEntry.update({
          where: { id: entryId },
          data: { cancelledAt: new Date() },
        });
      });

      await expect(backwards).rejects.toThrow(/40P01|55P03/);
    });

    const entryAfter = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(entryAfter.cancelledAt).toBeNull();
  }, HELD_CASE_TIMEOUT_MS);
});
