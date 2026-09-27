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
 * `'after-start'` releases once `body` has been STARTED, while the holder's
 * `onHeld` write is still uncommitted; `body` itself finishes only after that
 * write commits, once `waitUntilBlockedBy` below has confirmed `body` is
 * actually blocked on the held row and `release` has let the holder commit.
 *
 * NEITHER wait is a fixed sleep. `waitUntilBlockedBy` is
 * `route-race.test.ts`'s own poll (`src/app/api/teacher-rooms/[id]/route-race.test.ts`):
 * it reads `pg_stat_activity` for a backend genuinely blocked on the holder's
 * pid, and throws if none appears within its bound. A fixed sleep here would
 * let a test pass without racing — if the switch had not yet reached its wait
 * by the time a sleep elapsed, the assertions after it would see an
 * already-committed write and pass for the wrong reason, and a broken lock
 * order would go undetected.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { fixtureRun } from '../../tests/room-fixtures';
import { createClassFixture } from '../../tests/class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { switchToSharedRoom } from './room-switch';
import { claimTemplateForGeneration, generateInstancesForTemplate } from './class-generator';
import type { GenerationResult } from '@/lib/generation';

const prisma = new PrismaClient();
const fx = fixtureRun('rswl');
const HELD_CASE_TIMEOUT_MS = 20_000;
const HOLD_CEILING_MS = 4_000;
const BLOCKED_POLL_BOUND_MS = 1_500;

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

/** The current connection's own backend pid, for `waitUntilBlockedBy` below. */
async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/**
 * Resolves once some backend is waiting on a lock `holderPid` holds — the
 * same poll `route-race.test.ts` uses. Deliberately not who is waiting: only
 * the holder's own row contends in these cases, so any backend blocked on it
 * is the one under test.
 */
async function waitUntilBlockedBy(probe: PrismaClient, holderPid: number): Promise<void> {
  const deadline = Date.now() + BLOCKED_POLL_BOUND_MS;
  while (Date.now() < deadline) {
    const [row] = await probe.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`nothing waited behind backend ${holderPid} within ${BLOCKED_POLL_BOUND_MS}ms`);
}

/**
 * The backend pids currently blocked by `holderPid` — the same predicate
 * `waitUntilBlockedBy` polls, returning the pids instead of a count. Used
 * once a wait has already been confirmed, to name which backend it was.
 */
async function blockedPids(probe: PrismaClient, holderPid: number): Promise<number[]> {
  const rows = await probe.$queryRaw<Array<{ pid: number }>>`
    SELECT pid FROM pg_stat_activity
     WHERE wait_event_type = 'Lock'
       AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
  return rows.map((r) => r.pid);
}

/**
 * Holds the row `lockSql` selects `FOR UPDATE` on a connection of its own,
 * runs `onHeld` inside that transaction, then runs `body` with the holder's
 * own backend pid. The hold ends when `body` settles ('after-body') or once
 * `body` has been started AND `waitUntilBlockedBy` has confirmed it is
 * genuinely blocked on the held row ('after-start'). The ceiling turns a
 * missing bound into a failed assertion rather than a vitest timeout.
 */
async function withHeld<T>(
  lockSql: Prisma.Sql,
  body: (holderPid: number) => Promise<T>,
  opts: {
    onHeld?: (tx: Prisma.TransactionClient) => Promise<void>;
    release: 'after-body' | 'after-start';
  },
): Promise<T> {
  const holder = new PrismaClient();
  await holder.$connect();
  let acquired!: (pid: number) => void;
  let release!: () => void;
  const acquiredSignal = new Promise<number>((r) => { acquired = r; });
  const releaseSignal = new Promise<void>((r) => { release = r; });
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  // Declared outside the `try` so the `finally` below can always reach them —
  // `route-race.test.ts`'s own shape (`behindUncommittedDelete`): `release()`
  // runs unconditionally there, and `holding`/`pending` are awaited via
  // `Promise.allSettled` before the connection is dropped. Without that, a
  // `body` that throws before calling `release()` itself — `waitUntilBlockedBy`
  // timing out is exactly this path — leaves the holder's transaction still
  // open when `$disconnect` runs, and its own promise still unawaited.
  let held: Promise<string> | undefined;
  let pending: Promise<T> | undefined;
  try {
    held = holder.$transaction(
      async (tx) => {
        await tx.$queryRaw(lockSql);
        const holderPid = await ownPid(tx);
        if (opts.onHeld) await opts.onHeld(tx);
        acquired(holderPid);
        await Promise.race([
          releaseSignal,
          new Promise<void>((r) => { ceiling = setTimeout(r, HOLD_CEILING_MS); }),
        ]);
        return 'released';
      },
      { timeout: HOLD_CEILING_MS + 10_000 },
    );
    held.catch(() => {});
    const holderPid = await acquiredSignal;

    if (opts.release === 'after-start') {
      pending = body(holderPid);
      pending.catch(() => {});
      await waitUntilBlockedBy(prisma, holderPid);
      release();
      expect(await held).toBe('released');
      return await pending;
    }

    pending = body(holderPid);
    const result = await pending;
    release();
    expect(await held).toBe('released');
    return result;
  } finally {
    // Unconditional, and first: whatever failed above — including
    // `waitUntilBlockedBy`'s own timeout — must not leave the holder waiting
    // on a release signal nobody sends.
    release();
    await Promise.allSettled([held, pending]);
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
      await withHeld(Prisma.sql`SELECT id FROM "ClassTemplate" WHERE id = ${tpl.id} FOR UPDATE`, async (holderPid) => {
        const switching = switchToSharedRoom(prisma, {
          teacherId: f.teacherId, teacherRoomId: f.linkId, sharedRoomId: shared.id,
        });
        switching.catch(() => {});
        await waitUntilBlockedBy(prisma, holderPid);
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

  // What this pins: step 4 reads the moving set AFTER the wait, not before
  // it. The switch's own step 1 pre-lock always blocks on this held template
  // row regardless of order, so this case is not a lock-order probe the way
  // the one above is — a generator class inserted while step 1 waits is still
  // visible once step 4 finally runs its own predicate.
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
      .toBe(result.sharedTeacherRoomId);
  }, HELD_CASE_TIMEOUT_MS);

  // A cancel that commits while the switch waits on the class row. `entryLive`
  // is re-checked on the locked row, so the class stays.
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

  // Spec §6 item 8, the SWITCH-FIRST half (the generator-first half is the
  // "moves a class the generator inserted while the switch waited on its
  // template" case above). The switch takes T's step-1 pre-lock, then P and
  // S, then blocks at step 4 on a held class C — parking it with T still
  // held. The REAL generator claim for T
  // (`claimTemplateForGeneration`/`generateInstancesForTemplate`,
  // `class-generator.ts`) is started while the switch is parked like that: it
  // takes the same `FOR UPDATE OF tpl` the switch's step 1 already holds, so
  // it blocks on the switch rather than on C — confirmed by
  // `waitUntilBlockedBy` against the switch's own backend pid, not a fixed
  // sleep. Only once that is confirmed does the holder release, letting the
  // switch finish (steps 4-7) and commit; the generator's claim then
  // unblocks, re-reads T under its own fresh lock, and generates into the
  // window against the row the switch just moved.
  //
  // `dayOfWeek` is offset three days from today's weekday so the generated
  // occurrence can never land on C's date (always today + 21 days, the same
  // weekday as today) and be skipped as an overlap.
  //
  // Mutation to record: move room-switch.ts's step-1 template pre-lock to
  // after step 4. The switch then takes P and S and blocks on C WITHOUT
  // holding T, so the generator's claim for T proceeds immediately instead of
  // blocking on the switch — this test's own `waitUntilBlockedBy(prisma,
  // switchPid)` times out instead of resolving.
  it('generates onto the shared room when the generator claims T while the switch is parked on it', async () => {
    const f = await fx.makeFixture(prisma);
    const shared = await addSharedTwin(f);
    const dayOfWeek = (new Date().getUTCDay() + 3) % 7;
    const tpl = await fx.addTemplate(prisma, f, { isActive: true, isArchived: false, dayOfWeek });
    const open = await fx.addClass(prisma, f, 'open', { daysAhead: 21 });

    let switching!: ReturnType<typeof switchToSharedRoom>;
    let generating!: Promise<GenerationResult>;

    const parked = await withHeld(
      Prisma.sql`SELECT id FROM "Class" WHERE id = ${open.id} FOR UPDATE`,
      async (holderPid) => {
        switching = switchToSharedRoom(prisma, {
          teacherId: f.teacherId, teacherRoomId: f.linkId, sharedRoomId: shared.id,
        });
        switching.catch(() => {});
        await waitUntilBlockedBy(prisma, holderPid);
        const [switchPid] = await blockedPids(prisma, holderPid);
        if (switchPid === undefined) {
          throw new Error('no backend found blocked on the held class — the switch is not parked');
        }

        generating = prisma.$transaction(async (tx) => {
          const fresh = await claimTemplateForGeneration(tx, tpl.id);
          if (!fresh) throw new Error('generator claim found the template ineligible');
          return generateInstancesForTemplate(tx, fresh, new Date());
        }, { timeout: 10_000 });
        generating.catch(() => {});
        await waitUntilBlockedBy(prisma, switchPid);
        return 'both parked';
      },
      { release: 'after-body' },
    );
    expect(parked).toBe('both parked');

    const switchResult = await switching;
    expect(switchResult).toMatchObject({ ok: true, action: 'switched' });
    if (!switchResult.ok) throw new Error('unreachable');

    const genResult = await generating;
    expect(genResult.created).toBeGreaterThan(0);

    const created = await prisma.class.findMany({
      where: { calendarEntry: { scheduleRuleId: tpl.scheduleRuleId } },
      select: { teacherRoomId: true },
    });
    expect(created.length).toBeGreaterThan(0);
    for (const c of created) expect(c.teacherRoomId).toBe(switchResult.sharedTeacherRoomId);
  }, HELD_CASE_TIMEOUT_MS);
});
