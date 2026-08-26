import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { hhmmToTime } from '@/lib/time-of-day';
import {
  ANNOUNCEMENT_DEDUPE_WINDOW_MS,
  LOCK_TIMEOUT_SQL,
  lockAnnouncementSlot,
  lockClassRow,
  lockClassRowsOrdered,
  setLockTimeout,
} from './db-locks';
import { claimTemplateForGeneration } from '@/services/class-generator';
import { claimStudioTemplateForGeneration } from '@/services/studio-class-generator';
import { closeQueueOnStart, withdrawWaitingEntriesForTeacher } from '@/services/waitlist';
import { readSeatCount } from '@/services/capacity';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The compile-time half of this file, and the reason it exists at all.
 *
 * `lockClassRow`'s `{ $transaction?: never }` brand is what stops a caller
 * passing the bare `PrismaClient`, which would compile cleanly and fail
 * silently: on a bare client each statement is its own autocommit
 * transaction, so `SET LOCAL` and `FOR UPDATE` would each apply to a
 * transaction that no longer exists by the time the next statement runs.
 * `Prisma.TransactionClient` alone does not stop it — it is
 * `Omit<PrismaClient, ITXClientDenyList>`, and `Omit` drops members from the
 * TYPE only, so a bare client stays structurally assignable.
 *
 * That was originally verified with a throwaway call site, which was then
 * deleted — throwing the verification away with it. This function is that
 * call site, kept: never called, so it costs nothing at runtime, and
 * `tsconfig.json` includes every `.ts` file in the repo, so weakening the
 * brand makes `tsc --noEmit` fail on the unused `@ts-expect-error` below
 * rather than leaving a green suite.
 *
 * One directive per branded function, not one for the type. Loosening
 * `TransactionClientOnly` itself fails all of them at once, but re-typing a
 * single parameter back to `Prisma.TransactionClient` fails only that
 * function's own line — which is the regression each of these is here to
 * catch. They live together because the brand does, not because one of them
 * covers the rest.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _theBrandRejectsABareClient(client: PrismaClient): Promise<void> {
  // @ts-expect-error A bare PrismaClient must never satisfy the brand: on it,
  // `SET LOCAL` and `FOR UPDATE` have no transaction to live in.
  await lockClassRow(client, 'never-called');
  // @ts-expect-error `SET LOCAL` then `FOR UPDATE OF c` — the multi-row twin
  // of the line above, and the same failure on a bare client.
  await lockClassRowsOrdered(client, { where: Prisma.sql`c."id" = ${'never-called'}` });
  // @ts-expect-error Same brand, same reason, on the split-out helper.
  await setLockTimeout(client);
  // @ts-expect-error `LOCK_TIMEOUT_SQL` then `FOR UPDATE`, both transaction-scoped.
  await claimTemplateForGeneration(client, 'never-called');
  // @ts-expect-error The studio mirror of the site above.
  await claimStudioTemplateForGeneration(client, 'never-called');
  // @ts-expect-error `FOR UPDATE OF c`, with the writes it protects after it.
  await withdrawWaitingEntriesForTeacher(client, { teacherId: 'x', studentId: 'y' });
  // @ts-expect-error Read-only, but meaningless off a bare client: it would
  // count outside the caller's lock, which is the defect it exists to prevent.
  await readSeatCount(client, 'never-called');
  // @ts-expect-error `pg_advisory_xact_lock` — taken and released by its own
  // autocommit transaction on a bare client, protecting nothing.
  await lockAnnouncementSlot(client, { teacherId: 'x', classId: null, message: 'never-called' });
  // @ts-expect-error Takes NO lock of its own — the strongest case on this
  // list, not the weakest. It is a write that relies entirely on its caller
  // already holding the `Class` row lock, so off a bare client it would close
  // a queue in its own autocommit transaction, unserialized against every
  // other `WaitlistEntry` writer and un-rolled-back if the status flip it is
  // supposed to be atomic with then fails.
  await closeQueueOnStart(client, 'never-called');
}

describe('the shared lock timeout', () => {
  /**
   * `SHOW` reads the setting as the session actually holds it, so this
   * observes the effect rather than re-asserting the string that was sent.
   * The distinction matters: `SET LOCAL lock_timeout = '2 sekunden'` would
   * also be "a string that was sent".
   */
  it('is in force for the rest of the transaction after setLockTimeout', async () => {
    const observed = await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      const rows = await tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;
      return rows[0]?.lock_timeout;
    });

    expect(observed).toBe('2s');
  });

  /**
   * `lockClassRow` must set it too, not merely assume a caller did. The class
   * id is deliberately one that does not exist: `SELECT ... WHERE id = $1 FOR
   * UPDATE` over zero rows takes no lock and errors on nothing, so this
   * needs no fixture and cannot contend with anything.
   */
  it('is in force after lockClassRow, which sets it itself', async () => {
    const observed = await prisma.$transaction(async (tx) => {
      await lockClassRow(tx, '00000000-0000-4000-8000-000000000000');
      const rows = await tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;
      return rows[0]?.lock_timeout;
    });

    expect(observed).toBe('2s');
  });

  /**
   * Called twice in one transaction — `deleteStudentAccount` (`gdpr.ts`) does
   * exactly this, once up front and again inside `lockClassRow` per class it
   * locks. The docblock claims the second call overwrites the first rather
   * than erroring or stacking; this is that claim, checked.
   */
  it('survives being set twice in one transaction', async () => {
    const observed = await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      await lockClassRow(tx, '00000000-0000-4000-8000-000000000000');
      const rows = await tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;
      return rows[0]?.lock_timeout;
    });

    expect(observed).toBe('2s');
  });

  /**
   * Outside a transaction the setting is not in force — which is the whole
   * reason the brand above exists. A bare-client caller would get this: no
   * error, no bound, nothing to notice.
   */
  it('is not in force outside a transaction', async () => {
    const rows = await prisma.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;

    expect(rows[0]?.lock_timeout).not.toBe('2s');
  });

  it('is the literal both template-claim sites share', () => {
    expect(LOCK_TIMEOUT_SQL).toBe("SET LOCAL lock_timeout = '2s'");
  });
});

describe('the announcement advisory lock', () => {
  /**
   * The shape of the lock, not merely that the call returned. Postgres names
   * the form it took in `pg_locks`: `objsubid = 2` is the two-int
   * `pg_advisory_xact_lock(int4, int4)` and `objsubid = 1` the single-bigint
   * one, and `classid` is the first of those two ints — the namespace. Both
   * are the reason a future unrelated advisory lock cannot collide with this
   * one by accident, and neither is observable from the call site.
   */
  it('takes one advisory lock, in the two-int form, under this project namespace', async () => {
    const held = await prisma.$transaction(async (tx) => {
      await lockAnnouncementSlot(tx, {
        teacherId: 'teacher',
        classId: 'class',
        message: 'Bring a blanket.',
      });
      return tx.$queryRaw<Array<{ classid: number; objsubid: number }>>`
        SELECT classid::int AS classid, objsubid::int AS objsubid
        FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid()`;
    });

    expect(held).toHaveLength(1);
    expect(held[0]!.objsubid).toBe(2);
    expect(held[0]!.classid).toBe(196);
  });

  /**
   * The property the announcements route buys with it, and the property that
   * separates `pg_advisory_xact_lock` from `pg_advisory_lock`: a second holder
   * of the same key waits, and it stops waiting when the first transaction
   * ENDS rather than when its connection is handed back to the pool. A
   * session-scoped lock would pass the first half of this and hang the second.
   *
   * A second `PrismaClient`, deliberately: advisory locks are held per session,
   * so two transactions that happened to share a pooled connection would not
   * contend at all and this would prove nothing.
   */
  it('makes a second transaction wait for the same key, and lets go on commit', async () => {
    const other = new PrismaClient();
    const slot = { teacherId: 'contended', classId: null, message: 'Same message.' };
    const order: string[] = [];
    let taken!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((r) => {
      taken = r;
    });
    const released = new Promise<void>((r) => {
      release = r;
    });

    const holding = prisma.$transaction(
      async (tx) => {
        await lockAnnouncementSlot(tx, slot);
        taken();
        await released;
      },
      { timeout: 20_000 },
    );
    await acquired;

    const waiting = other.$transaction(
      async (tx) => {
        await lockAnnouncementSlot(tx, slot);
        order.push('second acquired');
      },
      { timeout: 20_000 },
    );

    await new Promise((r) => setTimeout(r, 300));
    // Still parked: the assertion that fails if the lock is not taken at all.
    expect(order).toEqual([]);

    order.push('first committed');
    release();
    await holding;
    await waiting;
    await other.$disconnect();

    expect(order).toEqual(['first committed', 'second acquired']);
  });

  /**
   * The other half: it serialises one `(teacher, class, message)`, not every
   * announcement in the database. A lock keyed on a constant would pass the
   * test above and make every teacher's send queue behind every other's.
   *
   * All THREE fields, one at a time, because the helper now composes the key
   * from the tuple itself: a composition that dropped `classId` would still
   * pass a two-teacher version of this test while making a teacher's
   * class-scoped send queue behind their identical all-students one.
   */
  it('does not make two slots differing in any one field wait for each other', async () => {
    const other = new PrismaClient();
    const held = { teacherId: 'teacher-one', classId: 'class-one', message: 'Bring a blanket.' };
    const neighbours = [
      { ...held, teacherId: 'teacher-two' },
      { ...held, classId: 'class-two' },
      { ...held, message: 'Bring two blankets.' },
    ];
    let taken!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((r) => {
      taken = r;
    });
    const released = new Promise<void>((r) => {
      release = r;
    });

    const holding = prisma.$transaction(
      async (tx) => {
        await lockAnnouncementSlot(tx, held);
        taken();
        await released;
      },
      { timeout: 20_000 },
    );
    await acquired;

    // Each resolves while the first transaction is still open, which is the point.
    for (const neighbour of neighbours) {
      await other.$transaction(async (tx) => {
        await lockAnnouncementSlot(tx, neighbour);
      });
    }

    release();
    await holding;
    await other.$disconnect();
  });

  it('is a two-minute window, the same quantity the manual reminder cooldown uses', () => {
    expect(ANNOUNCEMENT_DEDUPE_WINDOW_MS).toBe(2 * 60 * 1000);
  });
});

describe('lockClassRowsOrdered', () => {
  const suffix = `dblocks-ordered-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let roomId: string;
  let lowClassId: string;
  let highClassId: string;
  let studentAId: string;
  let studentBId: string;

  beforeAll(async () => {
    // Ids chosen so ascending-by-id is knowable in advance, the convention
    // `template-lock-order.test.ts:154-155` uses.
    lowClassId = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
    highClassId = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;

    // `bio` and `pageSlug` are both required and unique-constrained — copied
    // from the working fixture at `gdpr.test.ts:1251`, not invented.
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Lock',
        lastName: 'Order',
        email: `${suffix}-teacher@test.local`,
        bio: 'Ordered-lock fixture',
        pageSlug: `${suffix}-teacher`,
        account: { create: { email: `${suffix}-teacher@test.local` } },
      },
      select: { id: true },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Venue',
        address: 'Street 1',
        city: 'Town',
        postcode: '1234AB',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const base = {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Ordered lock class',
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };
    // HIGH inserted FIRST, so an unordered scan of this small table returns
    // physical order — the REVERSE of ascending by id. Asserted below, not
    // assumed.
    await prisma.class.create({ data: { ...base, id: highClassId, date: new Date('2099-06-01') } });
    await prisma.class.create({ data: { ...base, id: lowClassId, date: new Date('2099-06-02') } });

    const studentA = await prisma.student.create({
      data: {
        firstName: 'A',
        lastName: 'Student',
        email: `${suffix}-a@test.local`,
        incomeTier: 2,
        claimedAt: new Date(),
        account: { create: { email: `${suffix}-a@test.local` } },
      },
      select: { id: true },
    });
    studentAId = studentA.id;

    const studentB = await prisma.student.create({
      data: {
        firstName: 'B',
        lastName: 'Student',
        email: `${suffix}-b@test.local`,
        incomeTier: 3,
        claimedAt: new Date(),
        account: { create: { email: `${suffix}-b@test.local` } },
      },
      select: { id: true },
    });
    studentBId = studentB.id;

    // TWO students on the SAME class, so a join that does not filter by
    // student returns that class twice. `@@unique([classId, studentId])`
    // means one student can never duplicate a class on their own, so this is
    // the only way to observe the dedupe.
    await prisma.waitlistEntry.create({
      data: { classId: lowClassId, studentId: studentAId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: lowClassId, studentId: studentBId, position: 2, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: highClassId, studentId: studentAId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: [lowClassId, highClassId] } } });
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: { in: [studentAId, studentBId] } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { email: { startsWith: suffix } } });
  });

  it('returns the locked ids ascending, whatever order the table stores them in', async () => {
    // The premise, asserted rather than assumed: unordered, this table hands
    // back insertion order, which is the REVERSE of ascending. If a planner
    // or storage change makes them agree, the assertion below stops proving
    // anything and this line fails loudly first.
    const heapOrder = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM "Class" c WHERE c."teacherId" = ${teacherId}
    `;
    expect(heapOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);

    const locked = await prisma.$transaction((tx) =>
      lockClassRowsOrdered(tx, { where: Prisma.sql`c."teacherId" = ${teacherId}` }),
    );

    expect(locked).toEqual([lowClassId, highClassId]);
  });

  it('collapses a join that matches one class more than once', async () => {
    // Two `waiting` entries on `lowClassId`, so the join yields it twice.
    // Postgres refuses `DISTINCT` alongside `FOR UPDATE`, so the helper has
    // to collapse them itself — a caller that got two ids for one row would
    // lock once and iterate twice.
    const raw = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM "Class" c
      JOIN "WaitlistEntry" w ON w."classId" = c.id
      WHERE c."teacherId" = ${teacherId}
    `;
    expect(raw.filter((r) => r.id === lowClassId)).toHaveLength(2);

    const locked = await prisma.$transaction((tx) =>
      lockClassRowsOrdered(tx, {
        join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`,
        where: Prisma.sql`c."teacherId" = ${teacherId}`,
      }),
    );

    expect(locked).toEqual([lowClassId, highClassId]);
  });

  it('locks the Class rows and NOT the WaitlistEntry rows the join reaches', async () => {
    // The `OF c`. It is one of the four things `lockClassRowsOrdered`'s
    // docblock says it exists to own, and until #239's review it was the only
    // one nothing could fail on: the whole unit project stayed green with the
    // clause reduced to a bare `FOR UPDATE`. Every other test in this block
    // reads the returned `Class` ids, and the extra `WaitlistEntry` locks a
    // bare `FOR UPDATE` takes are invisible in that return — they show up only
    // as wait edges `docs/lock-order.md` does not model, which is issue 180.
    const entry = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: lowClassId, studentId: studentAId },
      select: { id: true },
    });

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await lockClassRowsOrdered(tx, {
          join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`,
          where: Prisma.sql`c."teacherId" = ${teacherId}`,
        });
        locked();
        await released;
      },
      { timeout: 10_000 },
    );

    await isLocked;

    // `NOWAIT`, not a bounded wait: this asks whether the row is held right
    // now and answers in one round trip, instead of spending the helper's own
    // 2s discovering it.
    const probe = (sql: Prisma.Sql) =>
      prisma
        .$transaction((tx) => tx.$queryRaw(sql))
        .then(() => 'free' as const)
        .catch((err: unknown) => String(err));

    const entryProbe = await probe(
      Prisma.sql`SELECT id FROM "WaitlistEntry" WHERE id = ${entry.id} FOR UPDATE NOWAIT`,
    );
    // The counter-probe, and it is what stops this passing vacuously: a helper
    // that locked NOTHING AT ALL would satisfy the entry assertion perfectly.
    const classProbe = await probe(
      Prisma.sql`SELECT id FROM "Class" WHERE id = ${lowClassId} FOR UPDATE NOWAIT`,
    );

    release();
    await holder;

    expect(entryProbe).toBe('free');
    expect(classProbe).toMatch(/55P03|could not obtain lock/);
  });

  it('bounds the rest of the transaction at the shared lock timeout', async () => {
    // Observes the effect rather than re-asserting the string that was sent
    // — the distinction the `SHOW` tests above this describe block make.
    const seen = await prisma.$transaction(async (tx) => {
      await lockClassRowsOrdered(tx, { where: Prisma.sql`c."teacherId" = ${teacherId}` });
      return tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;
    });
    expect(seen[0]?.lock_timeout).toBe('2s');
  });

  it('returns an empty array without erroring when nothing matches', async () => {
    const locked = await prisma.$transaction((tx) =>
      lockClassRowsOrdered(tx, { where: Prisma.sql`c."teacherId" = ${'no-such-teacher'}` }),
    );
    expect(locked).toEqual([]);
  });
});
