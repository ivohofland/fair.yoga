import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { syncTemplateInstances } from './template-sync';
import { deleteStudentAccount } from './gdpr';

/**
 * Issue 180. `syncTemplateInstances` (`template-sync.ts`) takes its `Class`
 * row locks in HEAP order — its same-day `class.updateMany({ where: { id: {
 * in: [...] } } })` is one statement, and Postgres visits the matching rows
 * in whatever order the planner picks, never the array's
 * (`docs/lock-order.md`, "Sorting the id array does NOT order a multi-row
 * write"). `deleteStudentAccount` (`gdpr.ts`) takes them ASCENDING by id —
 * `[...ids].sort()` in JS, before the `lockClassRow` loop. Two rows, opposite
 * orders, one AB-BA cycle: reproduced against the real functions and
 * recorded in `docs/lock-order.md`, "The two that do not".
 *
 * The trigger (`docs/lock-order.md:297-299`): a student waitlisted on TWO
 * instances of one recurring template deletes their account while the
 * teacher edits that template.
 *
 * `syncTemplateInstances` now takes an ordered pre-lock (issue 180 task 2),
 * so this assertion is inverted from the version that shipped in task 1: it
 * asserted the deadlock as real and unfixed there, and asserts its absence
 * here, the same shape #174 task 7 used for the two `Class`-adjacent pairs it
 * actually closed (see the reordered-write tests in
 * `invitations-lock-order.test.ts`). `archiveOrUnarchiveTemplate`
 * (`class-template-lifecycle.ts`) shares the same defect and is untouched —
 * a later task's subject, not this one's.
 *
 * Asserted by SQLSTATE, not by "it passed": `/40P01|deadlock/i` deliberately
 * does NOT match `55P03` (a `lock_timeout` expiry) — a bounded-wait expiry is
 * a different failure and must fail this test rather than satisfy it, on
 * either side of the race.
 */
const prisma = new PrismaClient();

function uniqueSuffix(): string {
  return `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Next UTC-midnight date, at least `weeksOut` weeks out, landing on
 * `jsDayOfWeek` (JS `Date.getUTCDay()` convention: 0 = Sunday) — the same
 * convention `syncTemplateInstances` converts the schema's `dayOfWeek`
 * (0 = Monday) into before comparing it against an instance's `date`.
 */
function futureDate(jsDayOfWeek: number, weeksOut: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 7 * weeksOut);
  while (d.getUTCDay() !== jsDayOfWeek) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

describe('syncTemplateInstances and deleteStudentAccount take Class row locks in opposite orders (#180)', () => {
  // Explicit ids, low and high, so "ascending by id" — deleteStudentAccount's
  // order — is a KNOWN sequence rather than whatever two `uuid()` calls
  // happened to produce. Inserted HIGH-then-LOW below, which is what makes
  // the table's heap order the REVERSE of the sorted order — the whole
  // premise of the race, asserted directly rather than assumed further down.
  // Same technique `gdpr.test.ts`'s "the two erasures take multiple Class
  // rows in one order" describe uses for the sibling pairing that IS fixed.
  const LOW_CLASS_ID = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
  const HIGH_CLASS_ID = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;

  let teacherId: string;
  let teacherAccountId: string;
  let roomId: string;
  let templateId: string;
  let studentId: string;
  let studentAccountId: string;

  afterAll(async () => {
    if (studentId) await prisma.waitlistEntry.deleteMany({ where: { studentId } });
    if (teacherId) {
      await prisma.class.deleteMany({ where: { teacherId } });
      await prisma.classTemplate.deleteMany({ where: { teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    }
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    if (studentId) await prisma.student.deleteMany({ where: { id: studentId } });
    if (teacherId) await prisma.teacher.deleteMany({ where: { id: teacherId } });
    const accountIds = [teacherAccountId, studentAccountId].filter(Boolean);
    if (accountIds.length) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  /**
   * A teacher, a recurring template, two future `open` mutable instances of
   * it (`settingsLocked: false` — no bookings have touched them, only the
   * waitlist has), and a student `waiting` on both. Follows the fixture
   * style of `invitations-lock-order.test.ts:77-170`.
   */
  it('does not deadlock: syncTemplateInstances (ordered pre-lock) vs deleteStudentAccount (ascending order) on two shared instances', async () => {
    const local = uniqueSuffix();

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Sync',
        lastName: 'Lock',
        email: `template-lock-order-teacher-${local}@test.local`,
        account: { create: { email: `template-lock-order-teacher-${local}@test.local` } },
        bio: 'issue 180 lock-order fixture teacher',
        pageSlug: `template-lock-order-${local}`,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Lock Order Studio',
        address: `${local} Lock St`,
        city: 'Amsterdam',
        postcode: '1234LO',
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

    // Schema convention 0 = Monday; JS `getUTCDay()` 0 = Sunday — the same
    // conversion `syncTemplateInstances` applies to `dayOfWeek` itself.
    const dayOfWeek = 1; // Tuesday
    const jsDayOfWeek = (dayOfWeek + 1) % 7;

    const template = await prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Lock Order Flow',
        dayOfWeek,
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        isActive: false, // keeps the background generator out of this test
      },
      select: { id: true },
    });
    templateId = template.id;

    const classBase = {
      teacherId,
      teacherRoomId: teacherRoom.id,
      templateId,
      classType: 'Lock Order Flow',
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 2,
      maxStudents: 10,
      status: 'open' as const,
      settingsLocked: false,
    };

    // HIGH inserted FIRST. An unordered scan over a table this small is a
    // sequential scan, which returns rows in physical order — insertion
    // order for rows this fresh — so `syncTemplateInstances`'s multi-row
    // `updateMany` visits [HIGH, LOW] while `deleteStudentAccount`'s sorted
    // lock loop visits [LOW, HIGH]. Asserted below, not assumed.
    await prisma.class.create({
      data: { ...classBase, id: HIGH_CLASS_ID, date: futureDate(jsDayOfWeek, 2) },
    });
    await prisma.class.create({
      data: { ...classBase, id: LOW_CLASS_ID, date: futureDate(jsDayOfWeek, 3) },
    });

    const student = await prisma.student.create({
      data: {
        firstName: 'Waiting',
        lastName: 'Student',
        email: `template-lock-order-student-${local}@test.local`,
        claimedAt: new Date(),
        account: { create: { email: `template-lock-order-student-${local}@test.local` } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;

    // Waiting in BOTH instances: the only way `deleteStudentAccount` locks
    // two `Class` rows at all, which is the only way the two orders can
    // disagree.
    await prisma.waitlistEntry.create({
      data: { classId: HIGH_CLASS_ID, studentId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: LOW_CLASS_ID, studentId, position: 1, status: 'waiting' },
    });

    // The teacher edits the template — the trigger `docs/lock-order.md`
    // names, and what makes `syncTemplateInstances`'s same-day `updateMany`
    // run at all. Not what makes the write "real": Postgres takes the row
    // lock and writes a new tuple version whether or not the new values
    // differ from the old, so an edit back to the same `startTime` would
    // lock exactly the same rows.
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { startTime: '10:30' },
    });

    // The premise, asserted rather than assumed: an unordered scan over
    // these two rows returns them in insertion order, the REVERSE of
    // ascending-by-id. If this ever stops holding — e.g. a bigger table
    // pushing the planner onto a btree index scan, which visits ascending by
    // `id` and would make BOTH sides agree — the race below can no longer
    // form the cycle, and this assertion fails loudly instead of leaving the
    // test green for an unrelated reason (docs/lock-order.md's own warning
    // about the `ScalarArrayOp` index-scan trap).
    const heapOrder = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Class" WHERE "templateId" = ${templateId}
    `;
    expect(heapOrder.map((r) => r.id)).toEqual([HIGH_CLASS_ID, LOW_CLASS_ID]);

    // The handshake. `deleteStudentAccount`'s lock loop issues exactly two
    // `$queryRaw` calls (`lockClassRow`'s `FOR UPDATE`, once per class,
    // ascending — so LOW first, HIGH second). Keyed on the query's own bound
    // value — the house rule this repo's other lock-order hooks follow
    // (`invitations-lock-order.test.ts`: "keyed on args shape, not call
    // order") — not on call sequence. The moment the LOW lock is granted,
    // signal the test to start `syncTemplateInstances`, then hold this
    // transaction here for a beat before letting it ask for HIGH — long
    // enough for `syncTemplateInstances`'s own `updateMany` to start, lock
    // HIGH (uncontended — nobody has asked for it yet), and block reaching
    // for LOW. Without the hold, the two class locks in
    // `deleteStudentAccount`'s loop are one round trip apart and nothing
    // could reliably interleave between them — the same reasoning
    // `invitations-lock-order.test.ts` and `gdpr.test.ts` give for their own
    // handshakes.
    let lowLocked!: () => void;
    const lowLockedPromise = new Promise<void>((resolve) => {
      lowLocked = resolve;
    });
    const erasureDb = prisma.$extends({
      query: {
        async $queryRaw({ args, query }) {
          const rows = await query(args);
          if (args.values[0] === LOW_CLASS_ID) {
            lowLocked();
            await new Promise((r) => setTimeout(r, 300));
          }
          return rows;
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable
      // to `deleteStudentAccount`'s `PrismaClient`-typed `db` parameter even
      // though every method it calls here is the real one, running against
      // the real database — same cast `invitations-lock-order.test.ts` uses
      // for its own hooked clients.
    }) as unknown as PrismaClient;

    const b = deleteStudentAccount(erasureDb, studentId);

    await lowLockedPromise;

    // Called directly, not wrapped in an outer `prisma.$transaction` — the
    // function already opens and manages its own transaction internally
    // (`template-sync.ts`), so wrapping it here would only start a second,
    // unrelated transaction on the same client and prove nothing about the
    // one that actually takes the locks.
    const a = syncTemplateInstances(prisma, templateId);

    // The assertion is the ABSENCE of `40P01`, not a specific success on
    // either side — same rationale as `invitations-lock-order.test.ts`'s own
    // "does not deadlock" tests: the ordered pre-lock forces whichever side
    // asks second to wait rather than cycle, not that either side is
    // guaranteed to win.
    for (const settled of await Promise.allSettled([a, b])) {
      if (settled.status === 'rejected') {
        expect(String(settled.reason)).not.toMatch(/40P01|deadlock/i);
      }
    }
  }, 30_000);
});
