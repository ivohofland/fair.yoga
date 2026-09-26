/**
 * @serial-tier lock-contention — holds a real row lock for seconds at a time,
 * the same reason `room-archive-lock-order.test.ts` is split out rather than
 * sharing the `unit` tier with a file that asserts nothing about timing.
 *
 * `switchToSharedRoom`'s lock order (issue 259): the private link's templates
 * are locked before the private link itself — the same order
 * `setTeacherRoomArchived` uses — and the switch's own `Class` lock
 * (`lockClassRowsOrdered`, step 4) re-checks `entryLive` on the row it holds
 * rather than trusting a join evaluated before the wait. The design's
 * reasoning is `docs/superpowers/specs/2026-09-26-switch-to-shared-room-design.md`
 * (§4, §4.1); the order itself is recorded in `docs/lock-order.md`
 * ("Switching to a shared room (#259)").
 *
 * Same holder shape as `room-archive-lock-order.test.ts`'s `withHeldChild`,
 * widened into `withHeld` with two additions this file needs and that one
 * does not: an `onHeld` callback that runs a second write inside the
 * holder's own transaction once its lock has landed, and a `release` mode.
 * `'after-body'` releases once `body` has settled — the probe case, which
 * needs the switch still waiting when it checks the private link is free.
 * `'after-start'` releases once `body` has *started*, so the switch can run
 * to completion while the holder's `onHeld` write is still uncommitted, and
 * hands back `body`'s own result.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { fixtureRun } from '../../tests/room-fixtures';
import { createClassFixture } from '../../tests/class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { switchToSharedRoom } from './room-switch';

const prisma = new PrismaClient();
const fx = fixtureRun('rswl');
const HELD_CASE_TIMEOUT_MS = 20_000;
const HOLD_CEILING_MS = 4_000;

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

/**
 * Holds the row `lockSql` selects `FOR UPDATE` on a connection of its own,
 * runs `onHeld` inside that transaction, then runs `body`. The hold ends when
 * `body` settles ('after-body') or as soon as `body` has been started and
 * `startDelayMs` has passed ('after-start'). The ceiling turns a missing
 * bound into a failed assertion rather than a vitest timeout.
 */
async function withHeld<T>(
  lockSql: Prisma.Sql,
  body: () => Promise<T>,
  opts: {
    onHeld?: (tx: Prisma.TransactionClient) => Promise<void>;
    release: 'after-body' | 'after-start';
    startDelayMs?: number;
  },
): Promise<T> {
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
        await tx.$queryRaw(lockSql);
        if (opts.onHeld) await opts.onHeld(tx);
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
    if (opts.release === 'after-start') {
      const pending = body();
      pending.catch(() => {});
      await new Promise((r) => setTimeout(r, opts.startDelayMs ?? 300));
      release();
      expect(await held).toBe('released');
      result = await pending;
    } else {
      try {
        result = await body();
      } finally {
        release();
      }
      expect(await held).toBe('released');
    }
    return result;
  } finally {
    if (ceiling) clearTimeout(ceiling);
    await holder.$disconnect();
  }
}

const addSharedTwin = (f: Parameters<typeof fx.addSharedTwin>[1]) => fx.addSharedTwin(prisma, f);

describe('switchToSharedRoom — lock order (issue 259)', () => {
  // THE ORDER. While the switch waits on a held template it must not yet hold
  // the private link: templates before links. Move the step-1 pre-lock below
  // step 2 and the probe times out instead.
  it('has not taken the private link while it waits on one of its templates', async () => {
    const f = await fx.makeFixture(prisma);
    const shared = await addSharedTwin(f);
    const tpl = await fx.addTemplate(prisma, f, { isActive: true, isArchived: false, dayOfWeek: 1 });
    const prober = new PrismaClient();
    await prober.$connect();
    try {
      await withHeld(Prisma.sql`SELECT id FROM "ClassTemplate" WHERE id = ${tpl.id} FOR UPDATE`, async () => {
        const switching = switchToSharedRoom(prisma, {
          teacherId: f.teacherId, teacherRoomId: f.linkId, sharedRoomId: shared.id,
        });
        await new Promise((r) => setTimeout(r, 800));
        await expect(prober.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
          await tx.$queryRaw`SELECT id FROM "TeacherRoom" WHERE id = ${f.linkId} FOR UPDATE`;
          return 'link was free';
        })).resolves.toBe('link was free');
        await expect(switching).rejects.toThrow(/55P03|lock timeout/i);
      }, { release: 'after-body' });
    } finally {
      await prober.$disconnect();
    }
    expect((await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } })).isArchived).toBe(false);
  }, HELD_CASE_TIMEOUT_MS);

  // The generator's interleaving: it holds a template on the private link and
  // inserts a class there, then commits. The switch waited on that template,
  // so the class is visible to step 4 and moves.
  it('moves a class the generator inserted while the switch waited on its template', async () => {
    const f = await fx.makeFixture(prisma);
    const shared = await addSharedTwin(f);
    const tpl = await fx.addTemplate(prisma, f, { isActive: true, isArchived: false, dayOfWeek: 1 });
    let generatedId = '';
    const date = new Date(); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() + 20);

    const result = await withHeld(
      Prisma.sql`SELECT id FROM "ClassTemplate" WHERE id = ${tpl.id} FOR UPDATE`,
      () => switchToSharedRoom(prisma, {
        teacherId: f.teacherId, teacherRoomId: f.linkId, sharedRoomId: shared.id,
      }),
      {
        release: 'after-start',
        onHeld: async (tx) => {
          const cls = await createClassFixture(tx, {
            teacherId: f.teacherId, teacherRoomId: f.linkId, classType: 'Hatha', date,
            startTime: hhmmToTime('07:00'), durationMinutes: 60,
            roomCost: new Prisma.Decimal(20), minRate: new Prisma.Decimal(15),
            targetRate: new Prisma.Decimal(25), minStudents: 2, maxStudents: 10, status: 'open',
            cancelledAt: null,
          });
          generatedId = cls.id;
        },
      },
    );

    expect(result).toMatchObject({ ok: true, action: 'switched' });
    if (!result.ok) throw new Error('unreachable');
    expect((await prisma.class.findUniqueOrThrow({ where: { id: generatedId } })).teacherRoomId)
      .toBe(result.teacherRoomId);
  }, HELD_CASE_TIMEOUT_MS);

  // Review Focus 1: a cancel that commits while the switch waits on the class
  // row. `entryLive` is re-checked on the locked row, so the class stays.
  it('leaves a class cancelled while the switch waited on its row', async () => {
    const f = await fx.makeFixture(prisma);
    const shared = await addSharedTwin(f);
    const open = await fx.addClass(prisma, f, 'open', { daysAhead: 21 });

    const result = await withHeld(
      Prisma.sql`SELECT id FROM "Class" WHERE id = ${open.id} FOR UPDATE`,
      () => switchToSharedRoom(prisma, {
        teacherId: f.teacherId, teacherRoomId: f.linkId, sharedRoomId: shared.id,
      }),
      {
        release: 'after-start',
        onHeld: async (tx) => {
          await tx.calendarEntry.update({
            where: { id: open.calendarEntryId }, data: { cancelledAt: new Date() },
          });
        },
      },
    );

    expect(result).toMatchObject({ ok: true, action: 'switched', moved: { classes: 0 } });
    expect((await prisma.class.findUniqueOrThrow({ where: { id: open.id } })).teacherRoomId).toBe(f.linkId);
  }, HELD_CASE_TIMEOUT_MS);
});
