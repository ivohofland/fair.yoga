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
 * (`class-template-lifecycle.ts`) shares the same defect. Its own
 * reproduction is the second `it` below, still in the task-1 shape —
 * asserting the deadlock as real and unfixed, not yet inverted — because the
 * fix itself is untouched here; that inversion is task 4's job, the same way
 * this file's inversion above was task 2's.
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
   * `class.deleteMany` takes its locks in heap order for the same reason
   * `syncTemplateInstances`'s `updateMany` above does — and has no id array
   * to sort even in principle, because its delete takes a predicate, not an
   * `id: { in: [...] } }` filter (`docs/lock-order.md`: "`archiveOrUnarchiveTemplate`
   * does not even pass ids — its `deleteMany` takes a predicate, so it has no
   * array to sort in the first place").
   *
   * UNFIXED here, deliberately: this assertion is in the task-1 shape, not
   * yet inverted — it asserts the deadlock is real, which it is. Task 4 adds
   * the ordered pre-lock to `archiveOrUnarchiveTemplate` and inverts this the
   * same way task 2 inverted the `it` above; leaving this one alone is this
   * task's whole point (a fix at one site would otherwise leave the pairing
   * live through the other, unnoticed).
   *
   * The handshake mirrors the one above, for the same reason: neither
   * `deleteMany` (here) nor `updateMany` (above) is JS-observable
   * mid-statement, so there is no moment to hook on the archive side itself.
   * The hook lives on `deleteStudentAccount`'s `lockClassRow` loop instead —
   * the same `erasureDb` shape, keyed on the LOW class id, signalling once
   * LOW is locked and holding 300ms before reaching for HIGH. Once the
   * signal fires, `archiveOrUnarchiveTemplate` starts fresh: its `deleteMany`
   * locks HIGH first (uncontended — heap order, same as the `updateMany`
   * above), blocks reaching for LOW (the erasure already holds it), and the
   * cycle closes when the erasure's own hold elapses and it asks for HIGH.
   *
   * **Not a plain rejection race, unlike the sync test above — measured, not
   * assumed from the brief's illustrative snippet.** A first run written to
   * this file in the sync test's exact shape (`Promise.allSettled` +
   * `toHaveLength(1)` rejection) produced a genuine `40P01 deadlock detected`
   * (confirmed via `class-template-lifecycle.ts:986`'s own logged error) and
   * then FAILED with zero rejections. The reason is `archiveOrUnarchiveTemplate`'s
   * own `catch`: `isTransientDbError` matches `40P01` (`docs/lock-order.md`'s
   * `ArchiveTemplateResult.busy` arm names the deadlock explicitly among the
   * codes it catches) and maps it to a RESOLVED `{ ok: false, reason: 'busy' }`,
   * logging the real error via `log.warn` — the "recurring class archive lost
   * the template lock race" line — instead of letting it propagate. So when
   * archiving is the side Postgres picks as the cycle's victim, the SQLSTATE
   * has to be read off that log call, not off a rejection. When
   * `deleteStudentAccount` is the victim instead, it still rejects directly —
   * it has no such catch — so both shapes are handled below rather than
   * assuming one.
   *
   * Which side is the victim is Postgres's choice, not this test's or this
   * code's (same caveat the sync test's own comment states) — recorded
   * empirically anyway: `archiveOrUnarchiveTemplate` was the victim in every
   * run measured for this task (see the report), which is the same pattern
   * task 1's report measured for `syncTemplateInstances` against this same
   * erasure — the side whose 300ms artificial hold is NOT the erasure's own
   * starts waiting on the contested row first, so its wait crosses
   * Postgres's `deadlock_timeout` first.
   *
   * Asserted by SQLSTATE, not by rejection alone. `/40P01|deadlock/i` also
   * happens to match Prisma's own `P2034` wording ("write conflict or a
   * deadlock") — substantively the same class of event as `40P01`, not a
   * false positive, but the regex is not strictly SQLSTATE-exact and a
   * future reader should not have to rediscover that by tracing Prisma's own
   * error text. Separately: `55P03` (the archive's own
   * `SET LOCAL lock_timeout = '2s'` expiring instead of the cycle being
   * detected) does not contain "40P01" or "deadlock", so the positive
   * `toMatch(/40P01|deadlock/i)` calls below already exclude it without a
   * paired `not.toMatch`. That exclusion is a property of THIS direction
   * only — see the handover below for what changes once the assertion is
   * inverted.
   *
   * ---
   *
   * **HANDOVER TO TASK 4 — read this before writing the inversion, not
   * after.** The obvious move is to take the sync test's inverted
   * rejection-loop above (`for (const settled of ...) { if (rejected)
   * expect(...).not.toMatch(/40P01|deadlock/i) }`) and point it at this
   * fixture instead. That was tried directly, against the STILL-UNFIXED
   * code below, and it PASSED:
   *
   * ```
   * PROBE_B_RESULT {"aStatus":"fulfilled","aValue":{"ok":false,"reason":"busy"},
   *                 "bStatus":"fulfilled","deadlockInLog":true}
   * ✓ B: naive inverted "does not deadlock" (rejection-loop only) against UNFIXED code
   * ```
   *
   * The deadlock fired — same as every run recorded in the report — and the
   * naive inversion was green anyway, because it only ever looks at
   * `Promise.allSettled`'s rejection channel, and this function's `catch`
   * empties that channel out on the side that matters. A "fix" that does
   * nothing at all would still pass a test written that way. Five
   * requirements for the inversion, not one, stated in order because the
   * first is the one that makes every other correct-looking piece worthless
   * if skipped:
   *
   * 1. **Never invert on rejections for this pairing.** Say it first.
   *    `archiveOrUnarchiveTemplate` resolves `{ ok: false, reason: 'busy' }`
   *    on the deadlock rather than rejecting, so a rejection-only negation —
   *    the sync test's own shape — passes unconditionally for this fixture,
   *    fixed or not. The transcript above is that exact mistake, made once
   *    on purpose, to prove it catches nothing.
   * 2. **Keep the `log.warn` spy this `it` already sets up, and flip its
   *    assertion**: today's `expect(archiveLostRaceLog).toBeDefined()`
   *    becomes `expect(archiveLostRaceLog).toBeUndefined()`. One assertion
   *    is enough to cover `40P01`, `55P03` AND `P2028` at once, because all
   *    three reach this same `catch` via `isTransientDbError` — no need to
   *    enumerate them separately the way `not.toMatch` has to on the
   *    erasure's own rejection channel.
   * 3. **Flip today's `expect(aSettled.value).toEqual({ ok: false, reason:
   *    'busy' })` to a positive success shape**:
   *    `expect(aSettled.value).toMatchObject({ ok: true, action: 'archived' })`.
   *    With this exact fixture — a template the caller owns, not already
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
   *    lock ORDER, this plays for lock EXISTENCE. (Cannot be asserted in
   *    THIS direction, unfixed: the archive returns `{ ok: false, reason:
   *    'busy' }` here and carries no `deleted` field at all.)
   * 5. **Leave the erasure branch as a rejection check, and keep the
   *    heap-order assertion above.** Nothing in points 1-4 touches
   *    `deleteStudentAccount`'s side of the race — it has no transient-error
   *    `catch` of its own, so `bSettled.status === 'rejected'` stays a
   *    meaningful, direct signal there, same as in the unfixed version
   *    below. And the heap-order read stays load-bearing under the fix for
   *    the same reason it is load-bearing here: if `HIGH`/`LOW` insertion
   *    ever stopped producing the reverse-of-ascending heap order this
   *    fixture depends on, "does not deadlock" would be true of a race that
   *    was never adversarial in the first place, proving nothing about the
   *    pre-lock.
   */
  it('archiveOrUnarchiveTemplate and deleteStudentAccount deadlock on two instances', async () => {
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

    // Spied so the SQLSTATE behind a resolved `busy` outcome is readable —
    // see this `it`'s own docblock for why that path exists at all.
    // `mockImplementation` matches `class-generator.test.ts`'s own use of
    // this spy on the same log line, so the real warning is suppressed from
    // the test's console output rather than merely observed.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const b = deleteStudentAccount(erasureDb, studentId);

      await lowLockedPromise;

      // Fourth argument is the target state string, not a boolean — verified
      // against `class-generator.test.ts:507`.
      //
      // Called directly, not wrapped in an outer `prisma.$transaction` — like
      // `syncTemplateInstances` above, this function already opens and
      // manages its own transaction internally (`class-template-lifecycle.ts`),
      // on the same `db` argument it is passed, so wrapping it here would
      // only start a second, unrelated transaction and prove nothing about
      // the one that actually takes the locks.
      const a = archiveOrUnarchiveTemplate(prisma, templateId, teacherId, 'archived');

      const [aSettled, bSettled] = await Promise.allSettled([a, b]);

      const archiveLostRaceLog = warn.mock.calls.find(
        (call) => call[1] === 'recurring class archive lost the template lock race',
      );

      if (bSettled.status === 'rejected') {
        // `deleteStudentAccount` was the cycle's victim: it rejects
        // directly, and `archiveOrUnarchiveTemplate` — no longer contending
        // for a row the erasure's rolled-back transaction released —
        // committed rather than hitting its own transient-error `catch`.
        expect(aSettled.status).toBe('fulfilled');
        if (aSettled.status === 'fulfilled') {
          expect(aSettled.value.ok).toBe(true);
        }
        expect(archiveLostRaceLog).toBeUndefined();
        expect(String(bSettled.reason)).toMatch(/40P01|deadlock/i);
      } else {
        // `archiveOrUnarchiveTemplate` was the cycle's victim: per this
        // `it`'s own docblock, it resolves `{ ok: false, reason: 'busy' }`
        // instead of rejecting, and the erasure — no longer contending —
        // committed (`deleteStudentAccount` resolves `void`, so a fulfilled
        // settlement here IS the erasure succeeding, not merely "not a
        // rejection").
        expect(bSettled.status).toBe('fulfilled');
        expect(aSettled.status).toBe('fulfilled');
        if (aSettled.status === 'fulfilled') {
          expect(aSettled.value).toEqual({ ok: false, reason: 'busy' });
        }
        expect(archiveLostRaceLog).toBeDefined();
        const loggedErr = (archiveLostRaceLog?.[0] as { err?: unknown } | undefined)?.err;
        expect(String(loggedErr)).toMatch(/40P01|deadlock/i);
      }
    } finally {
      warn.mockRestore();
    }
  }, 30_000);
});
