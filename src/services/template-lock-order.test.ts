import { describe, it, expect, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { archiveOrUnarchiveTemplate } from './class-template-lifecycle';
import { deleteStudentAccount } from './gdpr';
import { log } from '@/lib/log';

/**
 * Issue 180 had two halves, and this file covers the one that still has code
 * to cover. `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts`) USED
 * TO take its `Class` row locks in HEAP order — read past this first
 * paragraph before its tense misleads you. Its `class.deleteMany` is one
 * statement, and Postgres visits the matching rows in whatever order the
 * planner picks (`docs/lock-order.md`, "Sorting the id array does NOT order a
 * multi-row write"); it has no id array to sort even in principle, since the
 * delete takes a predicate. `deleteStudentAccount` (`gdpr.ts`) also used to
 * disagree, via a JS `[...ids].sort()` feeding a per-class `lockClassRow`
 * loop. Two rows, opposite orders, one AB-BA cycle: reproduced against the
 * real functions and recorded in issue 180, before either site had the
 * ordered pre-lock this file now pins. `docs/lock-order.md`'s within-`Class`
 * rule records the fix, not the original reproduction — the section that used
 * to hold that transcript was deleted rather than narrowed once both sites
 * closed (issue 180 acceptance 3), per this project's own convention against
 * leaving a trimmed-but-still-open-looking cycle on the page.
 *
 * The trigger (issue 180): a student waitlisted on TWO instances of one
 * recurring template deletes their account while the teacher archives that
 * template.
 *
 * The other half was `syncTemplateInstances` (`template-sync.ts`), whose
 * same-day `class.updateMany` had the identical defect and got the identical
 * ordered pre-lock in issue 180 task 2. A third `it` in this file pinned it.
 * #194 deleted that function outright — a template edit no longer touches any
 * generated class, so the edit path takes no `Class` locks and cannot be one
 * side of a `Class`-row cycle at all — and its `it` went with it, because it
 * asserted a property of a mechanism that no longer exists rather than a
 * property of the schedule. The fixture below is unchanged and still shared;
 * only the number of `it`s using it dropped.
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
 * the race. Both `it`s below carry that two-assertion split on their own
 * erasure branch, and no positive `toMatch` remains anywhere in this file.
 */
const prisma = new PrismaClient();

function uniqueSuffix(): string {
  return `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Next UTC-midnight date, at least `weeksOut` weeks out, landing on
 * `jsDayOfWeek` (JS `Date.getUTCDay()` convention: 0 = Sunday) — the same
 * convention `class-generator.ts` converts the schema's `dayOfWeek`
 * (0 = Monday) into before laying instances on the calendar.
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
      // Explicit rather than left to the `Class` cascade below: the wide-row-set
      // test's archive DELETES the classes its registration hangs off, so by
      // this point the cascade may already have taken it — but only if that
      // test reached its delete. On a mid-test failure it did not, and the
      // student delete further down would then fail its FK.
      await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
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
   * Shared by both `it`s below, not duplicated: each drives
   * `archiveOrUnarchiveTemplate` into a different corner of the same race,
   * and both need this exact shape for its heap-order `deleteMany` to
   * disagree with `deleteStudentAccount`'s ascending sort — two rows, one
   * student waiting on both, inserted so their heap order is the
   * deterministic REVERSE of ascending-by-id (explicit ids below, not
   * `uuid()` defaults — see the insertion-order comment inline). A third
   * `it` shared it until #194, for `syncTemplateInstances`; the fixture did
   * not change when that one went.
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
    // conversion the generator applies to `dayOfWeek` itself.
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
    // explicit order (`archiveOrUnarchiveTemplate`'s `deleteMany`) visits
    // [HIGH, LOW] while
    // `deleteStudentAccount`'s sorted lock loop visits [LOW, HIGH]. Asserted
    // by each `it` below, not assumed.
    await prisma.class.create({
      data: { ...classBase, id: highClassId, date: futureDate(jsDayOfWeek, 2) },
    });
    // LOW is `draft`, HIGH is `open` — one of each of `SCHEDULED_STATUSES`,
    // deliberately, and specifically `draft` on the row that must be locked
    // FIRST for the order to hold.
    //
    // Both statuses are equally valid here (`draft` and `open` are both
    // delete candidates for the archive, so every count below is unchanged),
    // but a fixture that used
    // only `open` could not observe the pre-lock's status list at all.
    // `archiveOrUnarchiveTemplate`'s pre-lock renders that list from
    // `SCHEDULED_STATUSES` into raw SQL, and dropping `'draft'` from it left
    // every test covering that function green while the deadlock reopened —
    // measured during issue 180 task 4, and still true of this file until
    // this line: with two `open` rows, a `'open'`-only pre-lock locks exactly
    // what the full one locks. With LOW as `draft`, a narrowed list skips the
    // row the erasure takes first, and the archive `it` below fails.
    await prisma.class.create({
      data: { ...classBase, id: lowClassId, status: 'draft', date: futureDate(jsDayOfWeek, 3) },
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

  /**
   * The second half of issue 180. `archiveOrUnarchiveTemplate`'s multi-row
   * `class.deleteMany` took its locks in heap order for the same reason the
   * sync's `updateMany` did (issue 180's first half, deleted with the
   * function in #194) — and had no id array to sort even in principle,
   * because its delete takes a predicate, not an
   * `id: { in: [...] } }` filter (`docs/lock-order.md`: "`archiveOrUnarchiveTemplate`
   * does not even pass ids — its `deleteMany` takes a predicate, so it has no
   * array to sort in the first place").
   *
   * INVERTED here (issue 180 task 4), the same way task 2 inverted the sync's
   * own `it` — the sibling this docblock keeps comparing itself to, which
   * lived in this file until #194 deleted the function under it.
   * `archiveOrUnarchiveTemplate` now opens with an ordered pre-lock —
   * `SELECT ... FOR UPDATE OF c ... ORDER BY c.id` over the full
   * `scheduledWhere(templateId, { gt: today })` set, immediately before the
   * `waitlistEntry.findMany` candidate read (`class-template-lifecycle.ts`) —
   * so this assertion now asserts the deadlock's ABSENCE, not its presence.
   * Leaving this `it` unfixed while task 2 fixed the sibling was task 1/3's
   * whole point (a fix at one site would otherwise leave the pairing live
   * through the other, unnoticed); closing this one is task 4's.
   *
   * The handshake mirrors the sync test's, for the same reason: neither
   * `deleteMany` (here) nor that `updateMany` is JS-observable
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
   * **Not a plain rejection race, unlike the sync test was — measured, not
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
   *    the sync test's shape — would pass unconditionally for this
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
   *    `class-template-lifecycle.ts`, the `log.warn` in
   *    `archiveOrUnarchiveTemplate`'s `isTransientDbError` branch), so a
   *    rename there would make
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
   * a bare lock-timeout expiry explicitly, for the reason this file's top
   * docblock gives.
   */
  it(
    'does not deadlock: archiveOrUnarchiveTemplate (ordered pre-lock) vs deleteStudentAccount (ascending order) on two shared instances',
    async () => {
      const { templateId, studentId, teacherId, lowClassId, highClassId } =
        await makeTemplateWithTwoWaitedInstances();

      // The premise, asserted rather than assumed: the fixture's HIGH-then-LOW
      // insertion is what makes heap order the reverse of ascending-by-id, and
      // without that the race is not adversarial. Re-read per `it` because
      // each builds its own fixture with fresh ids, not a rerun of one read.
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
            // Keyed on `studentId`, because that is what `deleteStudentAccount`
            // now binds: since the #216/#182 review its class locks are taken by
            // ONE ordered `SELECT … FOR UPDATE OF c` joined through
            // `WaitlistEntry`, not by a `lockClassRow` per class. The old hook
            // keyed on `lowClassId` and simply never fired against that shape,
            // so this test hung on its own handshake for 30s rather than
            // failing — the harness broke, not the property.
            //
            // The interleaving therefore INVERTS, and so does what this test
            // can prove. There is no window between the LOW and HIGH locks to
            // slip the other writer into any more, so this signals BEFORE the
            // statement runs and holds, letting `archiveOrUnarchiveTemplate`
            // take its own ordered pre-lock first; the erasure then asks for
            // both rows at once and blocks behind it.
            //
            // BE HONEST ABOUT THE COST. With both sides taking every class lock
            // in a single ordered statement, the AB-BA cycle cannot form — but
            // it also cannot be CONSTRUCTED, so this test no longer detects a
            // missing `ORDER BY` on the erasure side. That reduction is not
            // real: deleting the clause FAILS `gdpr.test.ts`'s deadlock test
            // ("does not deadlock when a teacher erasure and a student erasure
            // overlap on two classes"), measured 5/5 with `40P01` on
            // 2026-08-16 — the erasure's ordering is guarded by a
            // reproduction the whole time, in that file. That measurement was
            // machine-specific when it was written: the reproduction needs the
            // student side driven from `WaitlistEntry`, which was left to the
            // planner, and CI on the same commit could not even establish the
            // premise. It holds generally only since #239 forced the plan
            // there. What still fails in
            // THIS file is a reverted pre-lock on the archive side (no
            // `FOR UPDATE`, no pre-lock at all, or a narrowed row set), which
            // is where this file's mutations were always aimed. The general
            // guard both files' tests are specific instances of is
            // `db-locks-lock-order.test.ts`, which pins the helper's own
            // `ORDER BY c.id`.
            if (args.values[0] === studentId) {
              lowLocked();
              await new Promise((r) => setTimeout(r, 300));
            }
            return query(args);
          },
        },
        // `$extends` returns a client missing `$on`, so it is not assignable
        // to `deleteStudentAccount`'s `PrismaClient`-typed `db` parameter even
        // though every method it calls here is the real one, running against
        // the real database — same cast `invitations-lock-order.test.ts` uses
        // for its own hooked clients.
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
        // verified against `class-generator.test.ts`'s own archive call in
        // "answers busy when an ordinary booking holds a class row".
        //
        // Called directly, not wrapped in an outer `prisma.$transaction` —
        // this function opens and manages its own transaction internally
        // (`class-template-lifecycle.ts`), on the same `db` argument it is
        // passed, so wrapping it here would only start a second, unrelated
        // transaction and prove nothing about the one that actually takes
        // the locks. (The sync test that used to sit above DID wrap its call
        // in `prisma.$transaction`, because task 6 of the
        // atomic-template-update work made that function take an externally
        // supplied transaction client. Do not copy that shape here from
        // memory or from `docs/lock-order.md`'s transcripts: this function
        // owns its transaction, and wrapping it proves nothing.)
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
        // No `else` asserting `'fulfilled'`: `PromiseSettledResult` has
        // exactly two states, so inside an `else` on `status === 'rejected'`
        // that assertion cannot fail. It reads as coverage and is not.
        if (bSettled.status === 'rejected') {
          expect(String(bSettled.reason)).not.toMatch(/40P01|deadlock/i);
          expect(String(bSettled.reason)).not.toMatch(/55P03/);
        }
      } finally {
        warn.mockRestore();
      }
    },
    30_000,
  );

  /**
   * The archive pre-lock's ROW SET, which the two `it`s above cannot probe.
   *
   * They lock the same rows whether the pre-lock uses the full
   * `scheduledWhere(templateId, { gt: today })` predicate or the narrower
   * "deletable only" one (`AND NOT EXISTS (… charged Registration …)`),
   * because their fixture creates no `Registration` rows at all — so that
   * clause is vacuously true for both classes and the two predicates
   * coincide. Narrowing the shipped pre-lock therefore left every test
   * covering `archiveOrUnarchiveTemplate` green, which is not evidence the
   * wide set is unnecessary; it is evidence the fixture cannot tell.
   *
   * This is the negative control that can. It was built and measured during
   * issue 180 task 4's review, run as a throwaway, and then NOT committed —
   * the spec called it "a mutation harness, not a regression guard". That
   * reasoning does not hold up: both `it`s above are the same shape (each
   * hooks `deleteStudentAccount`'s `lockClassRow` loop to land a write
   * mid-transaction), and the design decision this protects is the branch's
   * most-defended one — about forty lines of comment argue for the wide set,
   * and narrowing it for performance is a natural-looking optimisation that
   * silently reopens a reproduced `40P01`.
   *
   * The mechanism, and why it needs a charged registration specifically:
   *
   * 1. LOW carries a `registered` registration when the pre-lock runs, so a
   *    NARROW pre-lock skips it — it is not a delete candidate yet.
   * 2. The candidate read is hooked to cancel that registration from OUTSIDE
   *    the archive transaction — `registration.updateMany` on `status` alone,
   *    the same write `DELETE /api/registrations/[id]` makes, and like it one
   *    that writes no FK column and so takes no `Class` row lock. That is what
   *    lets it land while the archive holds locks.
   * 3. The `deleteMany` re-evaluates its predicate at execution time (by
   *    design), now matches LOW, and reaches for a row a narrow pre-lock never
   *    held — out of order, against the erasure's ascending loop.
   *
   * Under the shipped wide pre-lock: `{ ok: true, deleted: 2, remaining: 0 }`.
   * Under a narrowed one: `40P01` at the `deleteMany`, swallowed by
   * `archiveOrUnarchiveTemplate`'s own `catch` into `{ ok: false, reason:
   * 'busy' }` — which is why this asserts the positive shape and the absence
   * of the lock-race log line, exactly as the archive `it` above does, and
   * never a rejection.
   */
  it(
    'does not deadlock when the archive pre-lock must cover a class that only becomes deletable mid-transaction',
    async () => {
      const { templateId, studentId, teacherId, lowClassId, highClassId } =
        await makeTemplateWithTwoWaitedInstances();

      const heapOrder = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Class" WHERE "templateId" = ${templateId}
      `;
      expect(heapOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);

      // A SECOND student, registered rather than waitlisted, so the erasure
      // below (which erases the waitlisted one) leaves this row standing for
      // the hook to cancel.
      const local = uniqueSuffix();
      const booker = await prisma.student.create({
        data: {
          firstName: 'Booked',
          lastName: 'Student',
          email: `template-lock-order-booker-${local}@test.local`,
          claimedAt: new Date(),
          account: { create: { email: `template-lock-order-booker-${local}@test.local` } },
        },
        select: { id: true, accountId: true },
      });
      studentIds.push(booker.id);
      studentAccountIds.push(booker.accountId as string);

      const reg = await prisma.registration.create({
        data: { classId: lowClassId, studentId: booker.id, tierAtBooking: 3, status: 'registered' },
        select: { id: true },
      });

      let lowLocked!: () => void;
      const lowLockedPromise = new Promise<void>((resolve) => {
        lowLocked = resolve;
      });
      const erasureDb = prisma.$extends({
        query: {
          async $queryRaw({ args, query }) {
            // Keyed on `studentId`, because that is what `deleteStudentAccount`
            // now binds: since the #216/#182 review its class locks are taken by
            // ONE ordered `SELECT … FOR UPDATE OF c` joined through
            // `WaitlistEntry`, not by a `lockClassRow` per class. The old hook
            // keyed on `lowClassId` and simply never fired against that shape,
            // so this test hung on its own handshake for 30s rather than
            // failing — the harness broke, not the property.
            //
            // The interleaving therefore INVERTS, and so does what this test
            // can prove. There is no window between the LOW and HIGH locks to
            // slip the other writer into any more, so this signals BEFORE the
            // statement runs and holds, letting `archiveOrUnarchiveTemplate`
            // take its own ordered pre-lock first; the erasure then asks for
            // both rows at once and blocks behind it.
            //
            // BE HONEST ABOUT THE COST. With both sides taking every class lock
            // in a single ordered statement, the AB-BA cycle cannot form — but
            // it also cannot be CONSTRUCTED, so this test no longer detects a
            // missing `ORDER BY` on the erasure side. That reduction is not
            // real: deleting the clause FAILS `gdpr.test.ts`'s deadlock test
            // ("does not deadlock when a teacher erasure and a student erasure
            // overlap on two classes"), measured 5/5 with `40P01` on
            // 2026-08-16 — the erasure's ordering is guarded by a
            // reproduction the whole time, in that file. That measurement was
            // machine-specific when it was written: the reproduction needs the
            // student side driven from `WaitlistEntry`, which was left to the
            // planner, and CI on the same commit could not even establish the
            // premise. It holds generally only since #239 forced the plan
            // there. What still fails in
            // THIS file is a reverted pre-lock on the archive side (no
            // `FOR UPDATE`, no pre-lock at all, or a narrowed row set), which
            // is where this file's mutations were always aimed. The general
            // guard both files' tests are specific instances of is
            // `db-locks-lock-order.test.ts`, which pins the helper's own
            // `ORDER BY c.id`.
            if (args.values[0] === studentId) {
              lowLocked();
              await new Promise((r) => setTimeout(r, 300));
            }
            return query(args);
          },
        },
      }) as unknown as PrismaClient;

      // The archive's own hook: cancel the charge once the candidate read has
      // returned, from outside the archive's transaction.
      let candidateReads = 0;
      const archiveDb = prisma.$extends({
        query: {
          waitlistEntry: {
            async findMany({ args, query }) {
              candidateReads++;
              const rows = await query(args);
              if (candidateReads === 1) {
                await prisma.registration.updateMany({
                  where: { id: reg.id },
                  data: { status: 'cancelled' },
                });
              }
              return rows;
            },
          },
        },
      }) as unknown as PrismaClient;

      const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
      try {
        const b = deleteStudentAccount(erasureDb, studentId);
        await lowLockedPromise;
        const a = archiveOrUnarchiveTemplate(archiveDb, templateId, teacherId, 'archived');

        const [aSettled, bSettled] = await Promise.allSettled([a, b]);

        const archiveLostRaceLog = warn.mock.calls.find(
          (call) => call[1] === 'recurring class archive lost the template lock race',
        );

        expect(aSettled.status).toBe('fulfilled');
        if (aSettled.status === 'fulfilled') {
          // `deleted: 2` is the whole point: LOW was NOT a delete candidate
          // when the pre-lock ran and became one before the delete, so a
          // narrow pre-lock reaches it unheld. Both rows going means the
          // re-evaluation really did pull it into scope.
          expect(aSettled.value).toMatchObject({
            ok: true,
            action: 'archived',
            deleted: 2,
            remaining: 0,
          });
        }
        expect(archiveLostRaceLog).toBeUndefined();
        // The hook fired on the candidate read, not somewhere else — without
        // this the cancel could have landed on an unrelated read and the
        // race would never have been set up.
        expect(candidateReads).toBe(1);

        if (bSettled.status === 'rejected') {
          expect(String(bSettled.reason)).not.toMatch(/40P01|deadlock/i);
          expect(String(bSettled.reason)).not.toMatch(/55P03/);
        }
      } finally {
        warn.mockRestore();
      }
    },
    30_000,
  );
});
