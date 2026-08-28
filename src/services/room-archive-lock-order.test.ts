/**
 * `setTeacherRoomArchived`'s lock discipline (issue 272): the bound on its
 * pre-lock, and the order that pre-lock exists to impose.
 *
 * SEPARATE FROM `room-archive.test.ts` FOR A REASON THE FILENAME CANNOT CARRY.
 * Both cases below hold a real row lock for about two seconds, and this tier
 * runs its files in parallel. `template-lock-order.test.ts` asserts its own
 * race ends in neither `40P01` nor `55P03`, and a concurrent multi-second hold
 * pushes it into the second — measured: it passes alone, passes run beside
 * this file alone, and fails in the full tier. That is why this file is on
 * `LOCK_CONTENTION_TESTS` in `vitest.config.ts` and runs serially, in the
 * invocation `template-lock-order.test.ts` is not part of.
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
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { fixtureRun, type RoomFixture } from '../../tests/room-fixtures';
import { setTeacherRoomArchived } from './room-archive';

const prisma = new PrismaClient();
// `ral-` distinguishes this file's rows from `room-archive.test.ts`'s (`ra-`)
// and `room-archive-doors.test.ts`'s, so each file's cleanup sweeps only its
// own.
const fx = fixtureRun('ral');
const makeFixture = () => fx.makeFixture(prisma);
const addTemplate = (f: RoomFixture, opts: { isActive: boolean; isArchived: boolean }) =>
  fx.addTemplate(prisma, f, opts);

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
      await acquiredSignal;
      try {
        return await body();
      } finally {
        release();
        expect(await held).toBe('released');
      }
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
  // `55P03`, which the route already classifies transient.
  //
  // The assertion is that it gave up on its own, well inside the holder's
  // ceiling. Bounded, it fails at the shared bound; unbounded, it waits out
  // the ceiling and then SUCCEEDS, failing both assertions below.
  it('gives up on the shared bound rather than waiting out the holder', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: false, isArchived: false });

    await withHeldChild(tpl.id, async () => {
      const startedAt = Date.now();
      await expect(
        setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived'),
      ).rejects.toThrow(/55P03|lock timeout/i);
      expect(Date.now() - startedAt).toBeLessThan(3500);
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
  it('has not taken the room row while it waits on a child', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: false, isArchived: false });
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
  }, HELD_CASE_TIMEOUT_MS);
});
