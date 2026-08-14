import { describe, it, expect, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { syncTemplateInstances } from './template-sync';
import { archiveOrUnarchiveTemplate } from './class-template-lifecycle';
import { deleteStudentAccount } from './gdpr';
import { log } from '@/lib/log';

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
 * (`class-template-lifecycle.ts`) shared the same defect and now takes its
 * own ordered pre-lock too (issue 180 task 4); the second `it` below is
 * inverted the same way, for the same reason — see that `it`'s own docblock
 * for the extra care its inversion needed beyond this one's.
 *
 * Asserted by SQLSTATE, not by "it passed": `/40P01|deadlock/i` deliberately
 * does NOT match `55P03` (a `lock_timeout` expiry), so a second, separate
 * `not.toMatch(/55P03/)` catches that one explicitly below — folding it into
 * one regex would let `not.toMatch(/40P01|deadlock|55P03/i)` read the same
 * but a single miss anywhere in the alternation silently pass, where two
 * assertions fail independently. `55P03` is a plausible outcome here, not a
 * hypothetical one: the fix's own 2s `lock_timeout` means the side that asks
 * second for a row the other already holds can wait out that bound — behind
 * the erasure's deliberate 300ms hold plus the rest of its transaction — and
 * time out rather than deadlock. A bounded-wait expiry is a different
 * failure and must fail this test rather than satisfy it, on either side of
 * the race. The second `it` below needs no matching `not.toMatch` — its
 * positive `toMatch(/40P01|deadlock/i)` already excludes `55P03` on its own;
 * see that `it`'s own docblock for why an inverted version WOULD need one.
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

describe('Class row lock order: multi-row writers vs deleteStudentAccount (#180)', () => {
  // Array-of-ids, not single `let`s: two `it`s below each build their own
  // fixture through the shared helper, so cleanup has to track more than one
  // of everything. Follows `invitations-lock-order.test.ts`'s own pattern.
  const teacherIds: string[] = [];
  const teacherAccountIds: string[] = [];
  const roomIds: string[] = [];
  const studentIds: string[] = [];
  const studentAccountIds: string[] = [];

  afterAll(async () => {
    if (studentIds.length) {
      await prisma.waitlistEntry.deleteMany({ where: { studentId: { in: studentIds } } });
    }
    if (teacherIds.length) {
      await prisma.class.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.classTemplate.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    }
    if (roomIds.length) await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    if (studentIds.length) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (teacherIds.length) await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    const accountIds = [...teacherAccountIds, ...studentAccountIds];
    if (accountIds.length) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  /**
   * A teacher, a recurring template, two future `open` mutable instances of
   * it (`settingsLocked: false` — no bookings have touched them, only the
   * waitlist has), and a student `waiting` on both. Follows the fixture
   * style of `invitations-lock-order.test.ts:77-170`.
   *
   * Shared by both `it`s below, not duplicated: `syncTemplateInstances` and
   * `archiveOrUnarchiveTemplate` each take `Class` row locks in heap order
   * for a different multi-row statement, and both need this exact shape to
   * disagree with `deleteStudentAccount`'s ascending sort — two rows, one
   * student waiting on both, inserted so their heap order is the
   * deterministic REVERSE of ascending-by-id (explicit ids below, not
   * `uuid()` defaults — see the insertion-order comment inline).
   *
   * Also, incidentally, exactly what `archiveOrUnarchiveTemplate`'s
   * `class.deleteMany` predicate requires to touch these rows at all:
   * future-dated (`gt: today`), status `open` (one of `SCHEDULED_STATUSES`),
   * and no registration in a `CHARGED_STATUSES` status. This fixture creates
   * no `Registration` rows at all, only `WaitlistEntry`, so that `none`
   * clause matches vacuously. A fixture ineligible for that predicate would
   * make the archive `it` below deadlock on nothing — no rows matched, no
   * locks taken, no cycle possible.
   *
   * Returns fresh ids every call: each `it` below gets its own
   * teacher/template/student, not a shared one.
   */
  async function makeTemplateWithTwoWaitedInstances(): Promise<{
    teacherId: string;
    templateId: string;
    studentId: string;
    lowClassId: string;
    highClassId: string;
  }> {
    const local = uniqueSuffix();

    // Explicit ids, low and high, so "ascending by id" — deleteStudentAccount's
    // order — is a KNOWN sequence rather than whatever two `uuid()` calls
    // happened to produce. Inserted HIGH-then-LOW below, which is what makes
    // the table's heap order the REVERSE of the sorted order — the whole
    // premise of the race, asserted directly by each `it` rather than
    // assumed. Same technique `gdpr.test.ts`'s "the two erasures take
    // multiple Class rows in one order" describe uses for the sibling
    // pairing that IS fixed.
    const lowClassId = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
    const highClassId = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;

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
    teacherIds.push(teacher.id);
    teacherAccountIds.push(teacher.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Lock Order Studio',
        address: `${local} Lock St`,
        city: 'Amsterdam',
        postcode: '1234LO',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacher.id,
      },
      select: { id: true },
    });
    roomIds.push(room.id);

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    // Schema convention 0 = Monday; JS `getUTCDay()` 0 = Sunday — the same
    // conversion `syncTemplateInstances` applies to `dayOfWeek` itself.
    const dayOfWeek = 1; // Tuesday
    const jsDayOfWeek = (dayOfWeek + 1) % 7;

    const template = await prisma.classTemplate.create({
      data: {
        teacherId: teacher.id,
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

    const classBase = {
      teacherId: teacher.id,
      teacherRoomId: teacherRoom.id,
      templateId: template.id,
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
    // order for rows this fresh — so a multi-row `Class` writer with no
    // explicit order (`syncTemplateInstances`'s `updateMany`,
    // `archiveOrUnarchiveTemplate`'s `deleteMany`) visits [HIGH, LOW] while
    // `deleteStudentAccount`'s sorted lock loop visits [LOW, HIGH]. Asserted
    // by each `it` below, not assumed.
    await prisma.class.create({
      data: { ...classBase, id: highClassId, date: futureDate(jsDayOfWeek, 2) },
    });
    await prisma.class.create({
      data: { ...classBase, id: lowClassId, date: futureDate(jsDayOfWeek, 3) },
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
    studentIds.push(student.id);
    studentAccountIds.push(student.accountId as string);

    // Waiting in BOTH instances: the only way `deleteStudentAccount` locks
    // two `Class` rows at all, which is the only way the two orders can
    // disagree.
    await prisma.waitlistEntry.create({
      data: { classId: highClassId, studentId: student.id, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: lowClassId, studentId: student.id, position: 1, status: 'waiting' },
    });

    return { teacherId: teacher.id, templateId: template.id, studentId: student.id, lowClassId, highClassId };
  }

  it(
    'does not deadlock: syncTemplateInstances (ordered pre-lock) vs deleteStudentAccount (ascending order) on two shared instances',
    async () => {
      const { templateId, studentId, lowClassId, highClassId } = await makeTemplateWithTwoWaitedInstances();

      // The teacher edits the template — the trigger `docs/lock-order.md`
      // names, and what makes `syncTemplateInstances`'s same-day `updateMany`
      // run at all. Not what makes the write "real": Postgres takes the
      // row lock and writes a new tuple version whether or not the new values
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
      expect(heapOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);

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
            if (args.values[0] === lowClassId) {
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

      // Wrapped in `prisma.$transaction` now: `syncTemplateInstances`
      // (`template-sync.ts`) no longer opens its own transaction (task 6,
      // atomic-template-update) — it takes a transaction client and expects
      // the caller to supply one, composed into `updateClassTemplate`'s
      // transaction in production. This wrapper IS the transaction that
      // takes the locks, not a second, unrelated one wrapped around an inner
      // transaction that used to take them itself.
      const a = prisma.$transaction((tx) => syncTemplateInstances(tx, templateId));

      // The assertion is the ABSENCE of `40P01`, not a specific success on
      // either side — same rationale as `invitations-lock-order.test.ts`'s own
      // "does not deadlock" tests: the ordered pre-lock forces whichever side
      // asks second to wait rather than cycle, not that either side is
      // guaranteed to win.
      //
      // Also the absence of `55P03`, asserted separately from `40P01|deadlock`
      // (see this file's top docblock for why one regex would weaken the
      // guarantee rather than just shorten it) — a lock_timeout expiry means
      // the template edit did not happen, and that must fail this test, not
      // satisfy it.
      for (const settled of await Promise.allSettled([a, b])) {
        if (settled.status === 'rejected') {
          const reason = String(settled.reason);
          expect(reason).not.toMatch(/40P01|deadlock/i);
          expect(reason).not.toMatch(/55P03/);
        }
      }
    },
    30_000,
  );

  /**
   * The second half of issue 180. `archiveOrUnarchiveTemplate`'s multi-row
   * `class.deleteMany` took its locks in heap order for the same reason
   * `syncTemplateInstances`'s `updateMany` above did — and had no id array to
   * sort even in principle, because its delete takes a predicate, not an
   * `id: { in: [...] } }` filter (`docs/lock-order.md`: "`archiveOrUnarchiveTemplate`
   * does not even pass ids — its `deleteMany` takes a predicate, so it has no
   * array to sort in the first place").
   *
   * INVERTED here (issue 180 task 4), the same way task 2 inverted the `it`
   * above: `archiveOrUnarchiveTemplate` now opens with an ordered pre-lock —
   * `SELECT ... FOR UPDATE OF c ... ORDER BY c.id` over the full
   * `scheduledWhere(templateId, { gt: today })` set, immediately before the
   * `waitlistEntry.findMany` candidate read (`class-template-lifecycle.ts`) —
   * so this assertion now asserts the deadlock's ABSENCE, not its presence.
   * Leaving this `it` unfixed while task 2 fixed the sibling above was task
   * 1/3's whole point (a fix at one site would otherwise leave the pairing
   * live through the other, unnoticed); closing this one is task 4's.
   *
   * The handshake mirrors the one above, for the same reason: neither
   * `deleteMany` (here) nor `updateMany` (above) is JS-observable
   * mid-statement, so there is no moment to hook on the archive side itself.
   * The hook lives on `deleteStudentAccount`'s `lockClassRow` loop instead —
   * the same `erasureDb` shape, keyed on the LOW class id, signalling once
   * LOW is locked and holding 300ms before reaching for HIGH. Once the
   * signal fires, `archiveOrUnarchiveTemplate` starts fresh: its pre-lock now
   * asks for LOW first too — ascending, the same order the erasure already
   * takes — finds it held, and WAITS rather than reaching for HIGH out of
   * order first. That wait is what used to be the cycle: with the pre-lock,
   * it is bounded instead, by the transaction's own 2s `lock_timeout`
   * (`setLockTimeout`, issued once at this transaction's top) against the
   * erasure's 300ms artificial hold — comfortably inside the bound. Once the
   * erasure commits and releases both rows, the pre-lock finishes acquiring
   * them (LOW then HIGH, still ascending) and the rest of the transaction —
   * the candidate read, the `deleteMany`, the notifications, the record
   * write — runs uncontended, because every row it touches is already held.
   *
   * **Not a plain rejection race, unlike the sync test above — measured, not
   * assumed from the brief's illustrative snippet.** Before this task's fix
   * existed, a first run written to this file in the sync test's exact shape
   * (`Promise.allSettled` + a rejection-only negation) was tried directly
   * against the still-unfixed code and PASSED green while a genuine `40P01
   * deadlock detected` fired underneath it (confirmed via
   * `class-template-lifecycle.ts`'s own logged error) — because
   * `archiveOrUnarchiveTemplate`'s own `catch` maps `isTransientDbError`
   * matches, `40P01` among them, to a RESOLVED `{ ok: false, reason: 'busy'
   * }` and logs the real error via `log.warn` (the "recurring class archive
   * lost the template lock race" line) instead of letting it propagate. A
   * rejection-only negation never looks at that channel, so it can't tell a
   * real fix from no fix at all. The five requirements below are what a
   * negation on THIS pairing needs to actually mean something, in the order
   * that mattered while writing it — the first is the one that would have
   * made every other correct-looking assertion worthless if skipped:
   *
   * 1. **Never invert on rejections for this pairing.**
   *    `archiveOrUnarchiveTemplate` resolves `{ ok: false, reason: 'busy' }`
   *    on a deadlock rather than rejecting, so a rejection-only negation —
   *    the sync test's own shape — would pass unconditionally for this
   *    fixture, fixed or not (see the transcript above).
   * 2. **Keep the `log.warn` spy this `it` sets up, with its assertion
   *    flipped**: `expect(archiveLostRaceLog).toBeDefined()` becomes
   *    `expect(archiveLostRaceLog).toBeUndefined()`. One assertion covers
   *    `40P01`, `55P03` AND `P2028` at once, because all three reach this
   *    same `catch` via `isTransientDbError`.
   * 3. **Assert a positive success shape**:
   *    `expect(aSettled.value).toMatchObject({ ok: true, action: 'archived' })`
   *    in place of the old `toEqual({ ok: false, reason: 'busy' })`. With
   *    this exact fixture — a template the caller owns, not already
   *    archived, no slot it could collide on — `not_found`/`forbidden`/
   *    `slot_conflict` are unreachable, so `ok: true` here can only mean the
   *    transient-error `catch` never fired. That also de-vacuums point 2:
   *    the spy's `.find()` is keyed on the exact log-message string
   *    ("recurring class archive lost the template lock race",
   *    `class-template-lifecycle.ts:1104`), so a rename there would make
   *    `toBeUndefined()` pass for the wrong reason — silently, since a
   *    renamed message just never matches the old string again. The
   *    `ok: true` assertion has no such coupling and catches the same
   *    failure a different way.
   * 4. **Assert `deleted: 2` and `remaining: 0` on that same success value —
   *    mandatory, not optional.** This is the actual vacuity hole: an
   *    INELIGIBLE fixture (wrong status, wrong date, a stray charged
   *    registration) makes `archiveOrUnarchiveTemplate` return
   *    `{ ok: true, action: 'archived', deleted: 0, remaining: 0 }`, which
   *    satisfies an `ok: true`-only inversion perfectly while the
   *    `deleteMany` took ZERO `Class` row locks and no cycle was ever
   *    possible. A test that never contended for the rows is not "does not
   *    deadlock"; it is "never tried". `deleted: 2` is what proves both
   *    fixture classes were actually matched and actually locked by this
   *    statement — the same role the heap-order assertion below plays for
   *    lock ORDER, this plays for lock EXISTENCE.
   * 5. **Leave the erasure branch as a rejection check, and keep the
   *    heap-order assertion above.** Nothing in points 1-4 touches
   *    `deleteStudentAccount`'s side of the race — it has no transient-error
   *    `catch` of its own, so `bSettled.status === 'rejected'` stays a
   *    meaningful, direct signal there. And the heap-order read stays
   *    load-bearing under the fix for the same reason it was load-bearing
   *    before: if `HIGH`/`LOW` insertion ever stopped producing the
   *    reverse-of-ascending heap order this fixture depends on, "does not
   *    deadlock" would be true of a race that was never adversarial in the
   *    first place, proving nothing about the pre-lock.
   *
   * Asserted by SQLSTATE where the erasure side does reject, not by
   * rejection alone — `/40P01|deadlock/i` also happens to match Prisma's own
   * `P2034` wording ("write conflict or a deadlock"), substantively the same
   * class of event as `40P01`, and a separate `not.toMatch(/55P03/)` catches
   * a bare lock-timeout expiry explicitly, for the same reason the sync
   * test's own two-assertion split does (see this file's top docblock).
   */
  it(
    'does not deadlock: archiveOrUnarchiveTemplate (ordered pre-lock) vs deleteStudentAccount (ascending order) on two shared instances',
    async () => {
      const { templateId, studentId, teacherId, lowClassId, highClassId } =
        await makeTemplateWithTwoWaitedInstances();

      // The premise, asserted rather than assumed — same reasoning as the sync
      // test's own heap-order check above, re-run here because this is a
      // second, independent fixture with its own fresh ids, not a rerun of the
      // same read.
      const heapOrder = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Class" WHERE "templateId" = ${templateId}
      `;
      expect(heapOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);

      let lowLocked!: () => void;
      const lowLockedPromise = new Promise<void>((resolve) => {
        lowLocked = resolve;
      });
      const erasureDb = prisma.$extends({
        query: {
          async $queryRaw({ args, query }) {
            const rows = await query(args);
            if (args.values[0] === lowClassId) {
              lowLocked();
              await new Promise((r) => setTimeout(r, 300));
            }
            return rows;
          },
        },
        // Same cast rationale as the sync test above.
      }) as unknown as PrismaClient;

      // Spied so an unexpected transient-error `catch` is visible rather than
      // silently swallowed — see point 2 above. `mockImplementation` matches
      // `class-generator.test.ts`'s own use of this spy on the same log line,
      // so the real warning is suppressed from the test's console output
      // rather than merely observed.
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
      try {
        const b = deleteStudentAccount(erasureDb, studentId);

        await lowLockedPromise;

        // Fourth argument is the target state string, not a boolean —
        // verified against `class-generator.test.ts:507`.
        //
        // Called directly, not wrapped in an outer `prisma.$transaction` —
        // this function opens and manages its own transaction internally
        // (`class-template-lifecycle.ts`), on the same `db` argument it is
        // passed, so wrapping it here would only start a second, unrelated
        // transaction and prove nothing about the one that actually takes
        // the locks. `syncTemplateInstances` above no longer shares this
        // shape: task 6 of the atomic-template-update work made it take an
        // externally supplied transaction client instead, which is why its
        // own call site just above IS wrapped.
        const a = archiveOrUnarchiveTemplate(prisma, templateId, teacherId, 'archived');

        const [aSettled, bSettled] = await Promise.allSettled([a, b]);

        const archiveLostRaceLog = warn.mock.calls.find(
          (call) => call[1] === 'recurring class archive lost the template lock race',
        );

        // Points 1, 3 & 4: never a rejection-based negation on the archive
        // side — assert positive success, including deleted:2/remaining:0 so
        // an ineligible fixture (which would report deleted:0) cannot satisfy
        // this vacuously.
        expect(aSettled.status).toBe('fulfilled');
        if (aSettled.status === 'fulfilled') {
          expect(aSettled.value).toMatchObject({
            ok: true,
            action: 'archived',
            deleted: 2,
            remaining: 0,
          });
        }
        // Point 2: the transient-error catch never fired.
        expect(archiveLostRaceLog).toBeUndefined();

        // Point 5: the erasure side stays a genuine rejection check — it has
        // no transient-error catch of its own, so a rejection here would be a
        // real deadlock or lock-timeout, not a false negative to explain away.
        if (bSettled.status === 'rejected') {
          expect(String(bSettled.reason)).not.toMatch(/40P01|deadlock/i);
          expect(String(bSettled.reason)).not.toMatch(/55P03/);
        } else {
          expect(bSettled.status).toBe('fulfilled');
        }
      } finally {
        warn.mockRestore();
      }
    },
    30_000,
  );
});
