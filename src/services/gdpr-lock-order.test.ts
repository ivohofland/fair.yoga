/**
 * @serial-tier lock-contention — every test below stages a real Postgres row
 * lock, deadlock, or `lock_timeout` race and asserts on how it resolves:
 * whether a wait actually happened, which SQLSTATE came back (or that neither
 * `40P01` nor `55P03` did), or whether a concurrent write queued behind a
 * lock this file holds open. A neighbour's lock noise in the parallel tier
 * would read as exactly the outcome one of these assertions watches for — a
 * false pass on a claim of absence, a false failure on one of presence —
 * which is what `LOCK_CONTENTION_TESTS` (`vitest.tiers.ts`) exists to keep
 * off this file and this file off it.
 *
 * Grouped by what each test stages, not by subject: `deleteStudentAccount`
 * and `deleteTeacherAccount` guards sit side by side below because both take
 * real row locks, not because they share a caller.
 *
 * Extracted out of `gdpr.test.ts` in two passes rather than moving that file
 * whole — the AB-BA probe below moved first; issue #459
 * (`docs/superpowers/specs/2026-09-05-lock-contention-extraction-design.md`)
 * carried the rest. Its `isClassPreLock`/`awaitHandshake` machinery stays
 * scoped to that one probe — nothing added by #459 uses either.
 */
import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { AlreadyErasedError, deleteStudentAccount, deleteTeacherAccount } from './gdpr';
import * as dbLocks from '@/lib/db-locks';
import { CLASS_TO_ENTRY_JOIN, CLASS_TO_WAITLIST_JOIN, LOCK_TIMEOUT_SQL } from '@/lib/db-locks';
import { claimTemplateForGeneration } from './class-generator';
import { claimStudioTemplateForGeneration } from './studio-class-generator';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';

/**
 * The `Class` pre-lock, identified by the statement's own shape.
 *
 * NOT by a bound value. `values[0] === teacherId` names a SET of statements —
 * every one whose first bind is that id — and this file keyed on exactly
 * that until the set grew underneath it: a sibling statement, added to
 * `deleteTeacherAccount` well after this handshake was written, came to bind
 * `teacherId` first too, so the handshake fired on THAT statement and
 * deleting the real `Class` pre-lock passed green. The count and the
 * PR/issue that added the sibling belong in the commit history, not here —
 * a number in this comment would rot the next time the set changes size.
 *
 * Among the statements PRODUCTION issues, `lockClassRowsOrdered`'s is the only
 * one carrying BOTH fragments, and together they exclude every sibling: the
 * template pre-locks are `FROM "ClassTemplate" ct` (which does contain
 * `FOR UPDATE OF c`, as a prefix of `OF ct`, so that fragment alone would
 * not exclude them), and the entries lock is `JOIN "Class" c … FOR UPDATE OF
 * e` (fails both). That reasoning is argued here and ASSERTED by the firing
 * counts below — a future statement that matches drives one past 1 and
 * fails by name.
 *
 * The two premise probes in the `#174` `it` match this predicate too, and are
 * not counterexamples: they run on the bare `prisma` client rather than on
 * either `$extends` client, so no hook ever sees them.
 */
const isClassPreLock = (sql: string): boolean =>
  sql.includes('FROM "Class" c') && sql.includes('FOR UPDATE OF c');

/**
 * How long a handshake may wait before the test says which one never fired.
 *
 * Measured 2026-09-05 against `ethical_yoga_test`: the `Class` pre-lock is
 * issued 5-13ms after the erasure call (13ms cold, 5-6ms warm, over five
 * runs), so this is ~150x the cold worst case. Its whole job is to replace a
 * 30_000ms vitest timeout that names nothing.
 */
const HANDSHAKE_TIMEOUT_MS = 2_000;

/**
 * Await a handshake, or fail naming the statement that never came.
 *
 * The bare `await` this replaces could not fail: a handshake that never fires
 * leaves the test hanging until vitest kills it at 30s, and the message it
 * dies with names the `it`, not the missing statement.
 */
async function awaitHandshake(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} never issued within ${HANDSHAKE_TIMEOUT_MS}ms`)),
          HANDSHAKE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * ITS OWN FILE BECAUSE OF ITS TIER, not because of its subject — the docblock
 * below covers that. The case here asserts a staged race ends in NEITHER
 * `40P01` NOR `55P03`, which is the second kind `LOCK_CONTENTION_TESTS`
 * (`vitest.tiers.ts`) exists to hold: lock noise from a concurrent file is a
 * false failure it cannot tell from the defect it watches for. It sat in
 * `gdpr.test.ts` until the preventive sweep that list's own comment asks for.
 *
 * SPLIT RATHER THAN MOVING THE WHOLE FILE, and the measurement is the reason.
 * At the time, `gdpr.test.ts` ran in ~26s, and moving all of it would have
 * taken the serial tier from 37.8s to 72.6s (+92%); extracting instead cost
 * 2.5s. Same shape as `class-lifecycle-tier-guard.test.ts`, which left
 * `class-lifecycle.test.ts` for the same kind of reason.
 */
/**
 * Whole-branch review of #174, Critical. Since #237 both erasures take their
 * `Class` locks through `lockClassRowsOrdered` — one ascending statement each.
 * Before #237 this branch gave `deleteStudentAccount` a `Class` row lock it
 * never used to take and sorted the ids before it, while `deleteTeacherAccount`
 * took one lock per iteration via its per-class cancel CAS, in the order a
 * `findMany` (no `orderBy`) returned. Two orders that disagree over the same
 * pair of classes is an AB-BA cycle, and Postgres answers it with `40P01`.
 *
 * The pre-lock closed the teacher side's read->CAS window (#237 Task 8), which
 * is why this test no longer hooks the CAS and instead races the two ordered
 * pre-lock statements directly. Both erasures are real here — no transaction
 * shaped "like" either one.
 */
describe('the two erasures take multiple Class rows in one order (#174)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-lockorder-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  // Explicit ids, low and high, so "ascending by id" is a known sequence
  // rather than whatever two `uuid()` calls happened to produce. The pair is
  // what makes the fixture's heap order (below) the reverse of its sorted
  // order, which is the whole premise of this test.
  const LOW_CLASS_ID = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
  const HIGH_CLASS_ID = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
  // Entry ids ANTI-correlated with the class ids they carry: the LOW class
  // gets the HIGH entry and vice versa. Both erasures run under a forced
  // plan, and under it every path the teacher's scan can take returns BTREE
  // index order — keyed on `Class.calendarEntryId`, on `CalendarEntry.id` or
  // on `CalendarEntry.date`, all three of which this fixture assigns, so the
  // order is this fixture's to choose rather than the heap's. Assigned rather
  // than defaulted, because a `uuid()` default would leave it to chance. The
  // `it` below asserts all three assignments before it reads anything under a
  // plan.
  const LOW_ENTRY_ID = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
  const HIGH_ENTRY_ID = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let studentId: string;
  let studentAccountId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Order',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Lock-order fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Order Studio',
        address: `${suffix} St`,
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

    const base = {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Order class',
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };
    // Insertion order is not load-bearing — the entry ids above are. Under an
    // unforced plan this would be a heap-ordered path — a sequential scan or a
    // bitmap heap one — handing back physical order, and heap order is not this
    // file's to own: `Class` is one 8 KB page shared with every other file in
    // this tier, so a neighbour's `DELETE` plus autovacuum frees a low line
    // pointer for the next insert to take.
    await createClassFixture(prisma, {
      ...base,
      id: HIGH_CLASS_ID,
      calendarEntryId: HIGH_ENTRY_ID,
      date: new Date('2099-06-01'),
    });
    await createClassFixture(prisma, {
      ...base,
      id: LOW_CLASS_ID,
      calendarEntryId: LOW_ENTRY_ID,
      date: new Date('2099-06-02'),
    });

    const student = await prisma.student.create({
      data: {
        firstName: 'Order',
        lastName: 'Student',
        email: `${suffix}-student@test.local`,
        incomeTier: 2,
        claimedAt: new Date(),
        account: { create: { email: `${suffix}-student@test.local` } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId!;

    // Waiting in BOTH classes: that is what makes `deleteStudentAccount`
    // lock two `Class` rows, which is the only way the orders can disagree.
    //
    // LOW first — the OPPOSITE order to the classes above, and since #237 that
    // opposition is what the test turns on. Both erasures take their locks
    // through `lockClassRowsOrdered`, so one `ORDER BY` orders both sides;
    // the only way its removal can still produce a cycle is if the two
    // callers' NATURAL orders differ, and they differ only because these two
    // tables are seeded in opposite orders. Insert these HIGH-first and the
    // mutation below stops reproducing anything.
    await prisma.waitlistEntry.create({
      data: { classId: LOW_CLASS_ID, studentId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: HIGH_CLASS_ID, studentId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { recipientId: studentId } });
    await prisma.waitlistEntry.deleteMany({ where: { studentId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: [accountId, studentAccountId] } } });
    await prisma.$disconnect();
  });

  /**
   * Runs one probe statement under the forced plan and hands back both the
   * order it produced and the plan that produced it.
   *
   * WHAT THE SETTINGS BUY, AND WHAT THEY DO NOT. Of Postgres's scan paths over
   * a plain table — sequential, index, index-only, bitmap heap and TID — the
   * two that return PHYSICAL heap order for the statements here are the
   * sequential and the bitmap heap scan; both are off, so the heap this file
   * cannot own stops deciding anything (#470,
   * `docs/superpowers/specs/2026-09-06-scan-order-premise-pin-design.md`). A
   * TID scan needs a `ctid` qual neither statement below has, so it is
   * unreachable rather than switched off — `enable_tidscan` is not one of the
   * four and is `on`.
   * What remains is index and index-only scans — but only a BTREE index scan
   * returns a key order a fixture can assign, and a GiST one does not. Every
   * GiST index this schema has is PARTIAL, so a statement reaches one only by
   * carrying its predicate: neither statement below carries one, which is why
   * the teacher probe drops the clause its comment names. `docs/lock-order.md`
   * owns the schema-wide account and the query that re-derives it.
   * `enable_hashjoin`/`enable_mergejoin` are aimed at join DIRECTION rather
   * than scan order, and they get it EMPIRICALLY rather than mechanically —
   * removing hash and merge joins leaves a nested loop, not one direction of
   * one. The measurement and its limits live in
   * `db-locks-lock-order.test.ts`'s `forceIndexOrderedPlan` — mirrored here
   * rather than imported, because a test helper crossing suites would couple
   * two files whose fixtures are independent.
   *
   * THE PLAN COMES BACK WITH THE ROWS because a bare
   * `expected [ …(2) ] to deeply equal [ …(2) ]` says nothing about WHY the
   * order moved, and both occurrences of that failure (2026-08-27 and #470)
   * cost an archaeology session to answer it. Callers pass it as the row-order
   * assertion's message.
   *
   * `EXPLAIN` plans without executing, so it takes no ROW locks — only the
   * relation-level locks the statement itself would take, released with this
   * transaction; the row-returning statement after it is what takes the row
   * locks. Measured, because "takes no locks" is what this said until #481 and
   * it is false: parse analysis of a `FOR UPDATE` target takes `RowShareLock`
   * on `Class` (`AccessShareLock` without the clause) and holds it to end of
   * transaction, while `pg_locks` shows no `tuple` entries at all. Harmless
   * here — `RowShareLock` conflicts only with `Exclusive`/`AccessExclusive`,
   * which nothing in this test takes, and this transaction commits before
   * either holder opens.
   *
   * It is a re-plan of the same text under the same settings in the same
   * transaction — not a record of the execution that follows, which Postgres
   * does not hand back.
   */
  async function probeUnderForcedPlan(
    statement: Prisma.Sql,
  ): Promise<{ ids: string[]; plan: string }> {
    return prisma.$transaction(async (tx) => {
      // The shared 2s bound, for the ROW locks the statement below takes. Its
      // `FOR UPDATE OF c` is uncontended by construction — fresh ids, serial
      // tier, and this transaction commits before either holder opens — so
      // this costs nothing on the happy path. It is here because the failure
      // it prevents is the one this file has already been bitten by: Prisma's
      // interactive-transaction timeout cannot roll back a statement already
      // blocked inside Postgres (`db-locks.ts`), so a contending probe would
      // hang to the 30s vitest timeout, which names the `it` and nothing else
      // — exactly what `awaitHandshake`/`HANDSHAKE_TIMEOUT_MS` were added here
      // to eliminate. With the bound, that becomes a `55P03` the assertion
      // below reports with the plan attached.
      await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
      await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
      await tx.$executeRaw`SET LOCAL enable_mergejoin = off`;
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      const explained = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(
        Prisma.sql`EXPLAIN ${statement}`,
      );
      const rows = await tx.$queryRaw<Array<{ id: string }>>(statement);
      // THROW rather than hand back unusable plan text. `plan` is the whole
      // reason this helper exists — it becomes the row-order assertion's
      // message, and a silent blank degrades that back to the bare
      // `expected [ …(2) ] to deeply equal [ …(2) ]` this work exists to
      // eliminate, at the one moment it is needed.
      //
      // PER LINE, not on the joined string, and that is the whole guard. A
      // renamed column makes every element `undefined`, and
      // `[undefined, undefined].join('\n')` is `'\n'` — not `''` — so a
      // `plan === ''` check passes a plan made entirely of newlines. Measured:
      // this guard was written that way first, and reading `'QUERY PLANX'`
      // instead left the suite GREEN. Zero rows, a renamed column and a blank
      // line all fail here now.
      const lines = explained.map((row) => row['QUERY PLAN']);
      if (lines.length === 0 || lines.some((line) => typeof line !== 'string' || line === '')) {
        throw new Error(
          `probeUnderForcedPlan: EXPLAIN returned no usable plan text (${explained.length} ` +
            `row(s), keys ${JSON.stringify(Object.keys(explained[0] ?? {}))}). The row-order ` +
            'assertion message would have been empty or blank. Check the "QUERY PLAN" column name.',
        );
      }
      return { ids: rows.map((row) => row.id), plan: lines.join('\n') };
    });
  }

  it('does not deadlock when a teacher erasure and a student erasure overlap on two classes', async () => {
    // Premise 0: what `beforeAll` ASSIGNED, read back off the stored rows and
    // compared in TypeScript — no query whose order a planner gets to choose.
    // The premises below are only as good as these three, and this is what
    // makes them a construction rather than an observation: given these
    // assignments, and given that every path the TEACHER statement can reach
    // is a btree index scan keyed on `CalendarEntry.date`, `CalendarEntry.id`
    // or `Class.calendarEntryId`, [HIGH, LOW] follows for every key those
    // plans order by.
    //
    // THE ELIGIBILITY CLAUSE IS LOAD-BEARING and the derivation is false
    // without it. `Class.id` is a key this fixture assigns the OTHER way, so
    // "every key those plans order by" would be untrue if a `Class_pkey`-driven
    // plan were among them. It is not one, and that is a property of the
    // statement rather than a cost accident — see the probe's own comment
    // below, which measures it.
    //
    // Three separate `expect`s so a failure names WHICH half moved. The third
    // looks backwards and is not: the student side's natural order is
    // `Class.id` ascending, and the whole premise is that the two sides
    // disagree, so HIGH — high in the TEACHER-side order — has to hold the
    // higher `Class.id`. That opposition is what the third `expect` pins, and
    // the probe comment below is where it stops being a fixture choice and
    // becomes a consequence of the two statements' join columns.
    const readAssignedKeys = (id: string) =>
      prisma.class.findUniqueOrThrow({
        where: { id },
        select: { id: true, calendarEntryId: true, calendarEntry: { select: { date: true } } },
      });
    const [highRow, lowRow] = await Promise.all([
      readAssignedKeys(HIGH_CLASS_ID),
      readAssignedKeys(LOW_CLASS_ID),
    ]);
    expect(
      highRow.calendarEntryId < lowRow.calendarEntryId,
      `HIGH must hold the lower calendarEntryId: HIGH ${highRow.calendarEntryId}, LOW ${lowRow.calendarEntryId}`,
    ).toBe(true);
    expect(
      highRow.calendarEntry.date < lowRow.calendarEntry.date,
      `HIGH's entry must hold the earlier date: HIGH ${highRow.calendarEntry.date.toISOString()}, LOW ${lowRow.calendarEntry.date.toISOString()}`,
    ).toBe(true);
    expect(
      highRow.id > lowRow.id,
      `HIGH must hold the higher Class.id: HIGH ${highRow.id}, LOW ${lowRow.id}`,
    ).toBe(true);

    // Premise 1: THE FIXTURE IS ADVERSARIAL — read through an ordered index,
    // this teacher's two classes come back HIGH first. That is what this
    // statement checks, and it is deliberately NOT a prediction of the plan
    // `deleteTeacherAccount` gets: see WHY THIS IS NOT A MODEL below. Unforced
    // the read can reach `Class` by a heap-ordered path and hand back physical
    // order, which this file cannot own — that is what failed on CI
    // (2026-08-27, the sibling copy in `db-locks.test.ts`). Forced, every
    // remaining path is a BTREE index scan and premise 0 above assigns every
    // key those plans order by, so the order is the one `beforeAll` ASSIGNED.
    // Which btree drives it is the planner's to move and this comment's not to
    // name; the plan that ran rides the assertion's message.
    //
    // WHY THE TWO SIDES DISAGREE BY CONSTRUCTION, and not by luck. Each
    // statement's own join column decides which index on `Class` Postgres will
    // even BUILD A PATH FOR, and the two statements join on different columns:
    //
    //   this one joins `c."calendarEntryId"` — so `Class_calendarEntryId_key`
    //   is eligible and `Class_pkey` is NOT, because `c.id` appears in no
    //   clause of it and nothing else makes that path worth generating;
    //
    //   the student statement below joins `c.id` — so the eligibility is
    //   exactly inverted: `Class_pkey` yes, `Class_calendarEntryId_key` no.
    //
    // `beforeAll` assigns those two columns in OPPOSITE directions, so the two
    // sides' natural orders differ for a reason no planner can revisit. That is
    // what makes premise 0 a derivation rather than a hopeful fixture.
    //
    // MEASURED, and by hiding the winner rather than by reading it. A chosen
    // plan says only which path won, so it cannot tell "never generated" from
    // "generated, tied, lost". Make `Class_calendarEntryId_key` invisible
    // instead (`pg_index.indisvalid = false`, inside a rolled-back
    // transaction), keeping `enable_seqscan = off` so the fallback carries
    // `disable_cost`: this statement then takes a `Seq Scan` priced at 1e10
    // over a `Class_pkey` that is present and would cost 8.14 — which happens
    // only if no path for it was built. The same statement carrying
    // `ORDER BY c.id` DOES reach `Class_pkey` under that identical treatment,
    // and that control is what makes the first result mean anything. The
    // student statement is the mirror: hide `Class_pkey` and it too falls back
    // to a `Seq Scan` rather than to `Class_calendarEntryId_key`.
    //
    // `enable_seqscan = off` is part of the method, not scenery — undiscouraged,
    // a seq scan of these single-page tables costs ~1.02 and would be the
    // fallback whether or not an index path existed. `docs/lock-order.md`
    // carries the recipe and the counterexample.
    //
    // AN ARGUMENT ABOUT TODAY'S TWO STATEMENTS ON TODAY'S SCHEMA, not a law. It
    // turns on which clauses each statement carries, so a new index on `Class`,
    // or a predicate mentioning `c.id` added to this one, can make the path
    // exist again — measured: adding a bare `c.id > …` to this statement's
    // WHERE is enough to generate it. Re-measure before relying on this after
    // either statement changes.
    //
    // COMPOSED FROM `CLASS_TO_ENTRY_JOIN`, the same fragment
    // `deleteTeacherAccount`'s pre-lock passes to `lockClassRowsOrdered`, so a
    // change to that fragment moves this statement with it. `FOR UPDATE OF c`
    // comes from the same call site; its row locks here are uncontended,
    // because this transaction runs and commits before either holder
    // transaction below starts. The status list stays a literal because
    // `CANCELLABLE_STATUSES_SQL` is module-private to `gdpr.ts`, and it is a
    // filter on `c` under every plan shape observed, so it is not the part
    // that decides order.
    //
    // WHY THIS IS NOT A MODEL OF THE PRODUCTION STATEMENT, and cannot be. Two
    // of that statement's clauses are absent, each for a measured reason:
    //
    //   `ORDER BY c.id` — the probe exists to read the UNORDERED order, so it
    //   can never carry the clause whose absence it is characterising. That
    //   omission is what makes `Class_pkey` ineligible here: the clause is the
    //   only thing in the production statement that mentions `c.id`, so it is
    //   the only thing that makes that path worth generating. Its presence
    //   selects `Class_pkey`; its absence removes the path. See WHY THE TWO
    //   SIDES DISAGREE above for the measurement.
    //
    //   `e."cancelledAt" IS NULL` — `CalendarEntry` carries a GiST index
    //   PARTIAL on exactly that predicate, and GiST has no key order at all
    //   (`pg_indexam_has_property(gist,'can_order')` is false). Carrying the
    //   qual makes that index eligible; dropping it makes it unreachable, and
    //   drops NO ROW here, since both of this fixture's entries are live.
    //
    //   MEASURED, both directions, by the same hiding method as above. Hide
    //   the btree the entry side normally drives from
    //   (`CalendarEntry_teacherId_date_idx`) under the four settings, and the
    //   two shapes go different ways: the production shape, carrying the qual,
    //   falls to a GiST `Index Scan` — a path with no key order — while this
    //   probe's shape, without it, falls to another BTREE and never reaches
    //   GiST at all. Eligibility, not cost, exactly as above.
    //
    //   What this line owns is that THIS statement stays clear of that path;
    //   which index it is, and how many the schema has, belong to the
    //   migrations that created them — `docs/lock-order.md` owns that account
    //   and ships the query that re-derives it.
    //
    // THE RESIDUAL THAT EXPOSES, and the only one — spec §4.2 is this
    // paragraph. The
    // production statement carries `cancelledAt IS NULL`, so the MUTATED
    // statement — the one with `ORDER BY c.id` deleted, which is what the
    // counterfactual below is about — can plan onto an index with no key order
    // whatsoever. No probe on this schema can establish that counterfactual —
    // not this one, and not one written later. What establishes it is deleting
    // the clause from `lockClassRowsOrdered` and watching this test redden, and
    // the run that did so is on the #470 PR.
    //
    // WHY THIS IS ASSERTABLE AT ALL, since the caller is production code: the
    // test does not need to reach inside it. `deleteTeacherAccount` issues
    // `setLockTimeout`, and a Prisma `$extends` hook on `$executeRawUnsafe`
    // rides that one statement to set the plan for its whole transaction —
    // exactly what the student side has always done. Both erasures are
    // production functions and BOTH are forcible; treating the teacher's as
    // unreachable is what left this premise unasserted for one commit.
    //
    // WHAT IT COSTS TO DROP THIS, measured rather than argued, because the
    // question comes up whenever it flakes: with the heap inverted so the two
    // natural orders agree, both erasures park on the same row and serialise
    // — and with `ORDER BY c.id` deleted from the helper the test still passes
    // 3/3. Not "vacuity in some weaker sense": a green run on broken code.
    // That is what asserting the premise buys, and why it is asserted rather
    // than assumed.
    const scanOrder = await probeUnderForcedPlan(Prisma.sql`
      SELECT c.id FROM "Class" c
      ${CLASS_TO_ENTRY_JOIN}
      WHERE e."teacherId" = ${teacherId}
        AND c.status IN ('draft', 'open', 'in_progress')
      FOR UPDATE OF c
    `);
    expect(scanOrder.ids, scanOrder.plan).toEqual([HIGH_CLASS_ID, LOW_CLASS_ID]);

    // Premise 2: the student side, which was always assertable and always
    // asserted. Asserting the scan proves nothing about it — different
    // tables, different plans.
    // `deleteStudentAccount` pre-locks via a `WaitlistEntry` join, and under
    // the forced plan the order comes from `classId`, which `beforeAll`
    // assigns, rather than from a heap nobody owns.
    //
    // Composed from `CLASS_TO_WAITLIST_JOIN` for the same reason as above.
    // That call site (`gdpr.ts`) passes no extra predicate, so `FOR UPDATE OF
    // c` is the only clause this statement gains over it — and its locks are
    // uncontended too, for the same reason. `WaitlistEntry` carries btree
    // indexes only, so this side has no counterpart to the GiST hazard the
    // teacher probe above has to route around.
    //
    // AND IT IS THE OTHER HALF OF THE TEACHER PROBE'S ELIGIBILITY ARGUMENT.
    // This join is on `c.id`, so on `Class` the eligibility is the mirror of
    // the teacher statement's: `Class_pkey` yes, `Class_calendarEntryId_key`
    // no. A `Class_pkey`-driven plan here is BENIGN — `w."classId"` IS `c.id`,
    // so it orders by the same column the `WaitlistEntry` indexes lead with,
    // and both give [LOW, HIGH]. What would break this side is a
    // `Class_calendarEntryId_key`-driven plan, and that path is not generated
    // for a statement mentioning `calendarEntryId` nowhere. Measured the same
    // way as above: hide `Class_pkey` and this statement falls back to a
    // `Seq Scan`, not to `Class_calendarEntryId_key`.
    //
    // BOTH PROBES MATCH `isClassPreLock` (`FROM "Class" c` plus
    // `FOR UPDATE OF c`), and that is deliberate but harmless: they run on the
    // bare `prisma` client, not on `teacherRacing`/`studentRacing`, so neither
    // reaches a hook and neither can move the firing counts asserted at the
    // end of this test.
    //
    // Left to the planner this join is not reliably driven by `WaitlistEntry`:
    // the choice is a cost knife-edge on `w."studentId"`, which no index leads
    // with, and it is non-monotonic in table size. CI proved it — this
    // assertion is what failed on 2026-08-16 with [HIGH, LOW], because
    // `enable_hashjoin = off` alone removes a join ALGORITHM, not a join
    // DIRECTION. All four settings are needed; the reasoning and the
    // measurements live in `db-locks-lock-order.test.ts`'s
    // `forceIndexOrderedPlan`, mirrored by `probeUnderForcedPlan` above.
    const joinOrder = await probeUnderForcedPlan(Prisma.sql`
      SELECT c.id FROM "Class" c
      ${CLASS_TO_WAITLIST_JOIN}
      WHERE w."studentId" = ${studentId}
      FOR UPDATE OF c
    `);
    expect(joinOrder.ids, joinOrder.plan).toEqual([LOW_CLASS_ID, HIGH_CLASS_ID]);

    // TWO third-party holder transactions, one per row — so each can be
    // released separately, which is what makes the collision deterministic.
    // Postgres grants a lock to queued waiters in FIFO order, so whichever
    // erasure queued on a row first is guaranteed to get it on release. The
    // choreography below exploits that to force the exact AB-BA state:
    //
    //   the teacher's scan asks [HIGH, LOW] and the student's join
    //   [LOW, HIGH] — both asserted above, and both under the same forced
    //   plan the erasures themselves get — so the two park on DIFFERENT
    //   rows: the teacher on HIGH, the student on LOW.
    //   Release LOW first: the student takes it and re-queues on HIGH,
    //   BEHIND the teacher parked there. Release HIGH: the teacher takes it,
    //   reaches for LOW — held by the student — and the two form the cycle.
    //   With the shared `ORDER BY` both ask [LOW, HIGH], park on the same row,
    //   and serialise instead. Same technique as `db-locks-lock-order.test.ts`,
    //   made deterministic where that test accepts the release race because
    //   its callers hand their lock order back to assert on.
    let releaseHigh!: () => void;
    const highReleased = new Promise<void>((resolve) => {
      releaseHigh = resolve;
    });
    let releaseLow!: () => void;
    const lowReleased = new Promise<void>((resolve) => {
      releaseLow = resolve;
    });
    let holderHighReady!: () => void;
    const holderHighHasRows = new Promise<void>((resolve) => {
      holderHighReady = resolve;
    });
    let holderLowReady!: () => void;
    const holderLowHasRows = new Promise<void>((resolve) => {
      holderLowReady = resolve;
    });

    const holderHigh = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${HIGH_CLASS_ID} FOR UPDATE`;
        holderHighReady();
        await highReleased;
      },
      { timeout: 10_000 },
    );
    const holderLow = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${LOW_CLASS_ID} FOR UPDATE`;
        holderLowReady();
        await lowReleased;
      },
      { timeout: 10_000 },
    );

    await Promise.all([holderHighHasRows, holderLowHasRows]);

    let teacherPreLockFirings = 0;
    let teacherLockedIds: string[] = [];
    let preLockReached!: () => void;
    const preLockReachedPromise = new Promise<void>((resolve) => {
      preLockReached = resolve;
    });

    const teacherRacing = prisma.$extends({
      query: {
        async $queryRaw({ args, query }) {
          // Keyed on the statement's shape, not on its binds — see
          // `isClassPreLock` above for the measurement that forced that.
          if (isClassPreLock(args.sql)) {
            teacherPreLockFirings += 1;
            preLockReached();
            const rows = await query(args);
            teacherLockedIds = (rows as Array<{ id: string }>).map((row) => row.id);
            return rows;
          }
          return query(args);
        },
        async $executeRawUnsafe({ args, query }) {
          // Force `deleteTeacherAccount`'s pre-lock scan onto an index-ORDERED
          // plan, the mirror of the student hook below and for the same
          // reason. Unforced this can be a heap-ordered scan of `Class` — a
          // sequential one or a bitmap heap one — and the heap belongs to
          // whichever neighbour in this parallel tier last churned the page,
          // so the premise asserted above would be an assertion on a
          // non-guarantee.
          //
          // WHAT THIS BUYS IS NARROWER THAN WHAT THE PROBE ABOVE GETS, and the
          // difference is the whole of `THE RESIDUAL THAT EXPOSES` up there.
          // The statement this hook plans for is `deleteTeacherAccount`'s own
          // pre-lock, and unlike the probe it DOES carry
          // `e."cancelledAt" IS NULL` (`gdpr.ts`) — so a GiST path, which
          // orders by nothing, is genuinely eligible to it. What these four
          // settings close here is only the HEAP-ordered paths; "every
          // remaining path is btree" is true of the probe above and NOT of
          // this statement.
          //
          // That costs the unmutated erasure nothing, because its order does
          // not come from the scan at all: `lockClassRowsOrdered` ends the
          // statement `ORDER BY c.id`, which fixes the acquisition order under
          // every plan. The residual is about the MUTATED form — the one with
          // that clause deleted — and no probe can reach it, which is why the
          // mutation run rather than a `SELECT` is what settles it.
          //
          // THE SAME FOUR THE PROBE RUNS UNDER, and that is the point rather
          // than a coincidence: the probe above measures the plan space the
          // PROBE runs in, so a hook that restricted a different space would
          // put the two statements back on different plans.
          //
          // Hookable at all because `deleteTeacherAccount` calls
          // `setLockTimeout` (`gdpr.ts`), which is one
          // `$executeRawUnsafe(LOCK_TIMEOUT_SQL)` — the same statement the
          // student hook keys on. Same `SET LOCAL` scope argument as that
          // hook: transaction-only, and the two scan settings discourage
          // rather than forbid, so the erasure's remaining statements are
          // planned differently and cannot fail on them.
          if (args[0] === LOCK_TIMEOUT_SQL) {
            const first = await query(args);
            await query([`SET LOCAL enable_hashjoin = off`]);
            await query([`SET LOCAL enable_mergejoin = off`]);
            await query([`SET LOCAL enable_seqscan = off`]);
            await query([`SET LOCAL enable_bitmapscan = off`]);
            return first;
          }
          return query(args);
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `deleteTeacherAccount`'s `PrismaClient`-typed `db` parameter even
      // though every method it calls here is the real one, running against
      // the real database — same cast as the other hooks in this file.
    }) as unknown as PrismaClient;

    let studentPreLockFirings = 0;
    let studentLockedIds: string[] = [];
    let studentPreLockReached!: () => void;
    const studentPreLockReachedPromise = new Promise<void>((resolve) => {
      studentPreLockReached = resolve;
    });

    const studentRacing = prisma.$extends({
      query: {
        async $queryRaw({ args, query }) {
          // Same discriminator as the teacher's hook. This side keyed on
          // `studentId` and fired correctly, but only because
          // `deleteStudentAccount` happens to have exactly one statement
          // binding it — a property of today's call graph, not a guarantee,
          // and one sibling statement away from the teacher side's failure.
          if (isClassPreLock(args.sql)) {
            studentPreLockFirings += 1;
            studentPreLockReached();
            const rows = await query(args);
            studentLockedIds = (rows as Array<{ id: string }>).map((row) => row.id);
            return rows;
          }
          return query(args);
        },
        async $executeRawUnsafe({ args, query }) {
          // Force `deleteStudentAccount`'s pre-lock join onto the
          // `WaitlistEntry`-driven plan, matching the premise above. Without
          // this the planner can drive the join from `Class` instead, which
          // agrees with the teacher side's scan and makes the mutation below
          // reproduce nothing. `setLockTimeout` is the statement the helper
          // runs immediately before the pre-lock; these `SET LOCAL`s land on
          // the SAME transaction session, so they are scoped to
          // `deleteStudentAccount`'s transaction only.
          //
          // Verified empirically during #237: `args` is an array of statements
          // (index 0), not a bare string, and separate calls on the session
          // work where one multi-statement string fails with `42601`.
          //
          // ALL FOUR, not just `enable_hashjoin` — that was the #239 CI
          // failure, and `enable_bitmapscan` is the one #470 added: without it
          // a bitmap heap scan survives, and a bitmap heap scan returns
          // physical heap order, which is what `enable_seqscan = off` was
          // added to rule out and did not. (The two join settings are aimed at
          // join DIRECTION, a separate job, and they get it empirically rather
          // than mechanically — `probeUnderForcedPlan`'s docblock splits the
          // four and `forceIndexOrderedPlan` has the limits.) Transaction-wide
          // scope is acceptable here because
          // the two scan settings discourage rather than forbid: Postgres
          // still takes those paths where no alternative exists, so the
          // erasure's remaining statements cannot fail on them, only be
          // planned differently. `deleteStudentAccount` calls `setLockTimeout`
          // twice (once itself, once inside the helper), so this fires twice;
          // a repeated `SET LOCAL` overwrites rather than stacks.
          if (args[0] === LOCK_TIMEOUT_SQL) {
            const first = await query(args);
            await query([`SET LOCAL enable_hashjoin = off`]);
            await query([`SET LOCAL enable_mergejoin = off`]);
            await query([`SET LOCAL enable_seqscan = off`]);
            await query([`SET LOCAL enable_bitmapscan = off`]);
            return first;
          }
          return query(args);
        },
      },
    }) as unknown as PrismaClient;

    const teacherErasure = deleteTeacherAccount(teacherRacing, teacherId)
      .then(() => 'teacher-ok' as const)
      .catch((err: unknown) => ({ error: String(err) }) as const);

    // From here on, a thrown handshake timeout must not leave `holderHigh`/
    // `holderLow` abandoned. Each is a real transaction under its own
    // `{ timeout: 10_000 }`; with `highReleased`/`lowReleased` never
    // resolved, Prisma eventually rejects it (`P2028`) with nothing attached
    // to catch it — an unhandled rejection ~10s after this test has already
    // failed and reported, landing on whatever the next file in this serial
    // tier happens to be running by then. `releaseLow`/`releaseHigh` are
    // idempotent (a second `resolve()` is a no-op), so calling them again in
    // the finally below costs nothing on the happy path, where they already
    // ran inline.
    let studentErasure!: Promise<'student-ok' | { readonly error: string }>;
    try {
      // Start the student erasure once the teacher's pre-lock is in flight, so
      // both statements are running against the holders before either releases.
      await awaitHandshake(preLockReachedPromise, 'teacher Class pre-lock');
      // Time for the teacher's pre-lock to reach and block on its first row.
      await new Promise((r) => setTimeout(r, 200));

      studentErasure = deleteStudentAccount(studentRacing, studentId)
        .then(() => 'student-ok' as const)
        .catch((err: unknown) => ({ error: String(err) }) as const);

      // Both pre-locks are now in flight. Wait for the student's to be issued
      // too, then give it time to reach and block on its first row. Then:
      //
      // 1. Release LOW first. The student (parked there under the mutation)
      //    takes it and re-queues on HIGH, where the teacher is already parked.
      // 2. Release HIGH. The teacher takes it, reaches for LOW — held by the
      //    student — and Postgres answers the cycle with `40P01`.
      //
      // With the shared `ORDER BY` both erasures ask [LOW, HIGH], park on the
      // same row, and serialise. All waits sit comfortably inside the helper's
      // shared 2s `lock_timeout`.
      await awaitHandshake(studentPreLockReachedPromise, 'student Class pre-lock');
      await new Promise((r) => setTimeout(r, 400));
      releaseLow();
      await holderLow;
      await new Promise((r) => setTimeout(r, 150));
      releaseHigh();
      await holderHigh;
    } finally {
      // Unconditional and `allSettled`, not `all` — a THROWN handshake means
      // one or both holders are still parked, and this must never itself
      // reject (that would replace the real error with a cleanup one). Once
      // both settle, neither can produce a later, disconnected rejection.
      releaseLow();
      releaseHigh();
      await Promise.allSettled([holderLow, holderHigh]);
    }

    const [teacherOutcome, studentOutcome] = await Promise.all([teacherErasure, studentErasure]);

    // SQLSTATE first, THEN the outcome — the same order and the same reason as
    // `db-locks-lock-order.test.ts`: a bare `toBe('teacher-ok')` reports
    // "expected { error: … } to be 'teacher-ok'" and makes two different
    // failures look alike. A `40P01` is the lock-order regression this test
    // exists to catch. A `55P03` is this choreography outrunning the 2s bound
    // #237 brought to the teacher's transaction — the fixed sleeps below the
    // handshakes (200 + 400 + 150ms) plus `deleteStudentAccount`'s startup all
    // burn against it while the teacher's pre-lock sits blocked on a holder, so
    // a cold pool can spend it. One of those is a finding and the other is a
    // retune, and the failure output has to say which.
    for (const [label, outcome] of [
      ['teacher erasure', teacherOutcome],
      ['student erasure', studentOutcome],
    ] as const) {
      if (typeof outcome !== 'string') {
        expect(`${label}: ${outcome.error}`).not.toMatch(/40P01|deadlock detected/);
        expect(`${label}: ${outcome.error}`).not.toMatch(/55P03|lock timeout/);
        throw new Error(`${label} rejected unexpectedly: ${outcome.error}`);
      }
    }

    // EXACTLY ONE firing each, and this is the assertion the rest of the file
    // rests on. `isClassPreLock` argues that no sibling statement matches it;
    // this is that argument checked, every run. A statement added to either
    // erasure that happens to match drives its count to 2 and fails here —
    // which is what the bound-value key could not do, and why deleting the
    // teacher's pre-lock used to pass green.
    expect({ teacher: teacherPreLockFirings, student: studentPreLockFirings }).toEqual({
      teacher: 1,
      student: 1,
    });

    // And each pre-lock asked for BOTH rows, ascending. A statement that still
    // runs but locks a narrower set satisfies every other assertion in this
    // file — the erasures still succeed, both classes still end cancelled, the
    // entries still go — so this is the only thing standing between a narrowed
    // `WHERE` and a green run.
    expect({ teacher: teacherLockedIds, student: studentLockedIds }).toEqual({
      teacher: [LOW_CLASS_ID, HIGH_CLASS_ID],
      student: [LOW_CLASS_ID, HIGH_CLASS_ID],
    });

    // Pre-fix one of these is `{ error: '... 40P01 ...' }` — Postgres picks
    // the victim, not this code, so both are asserted rather than one.
    expect(teacherOutcome).toBe('teacher-ok');
    expect(studentOutcome).toBe('student-ok');

    // Both classes were actually reached on both sides: the teacher cancelled
    // both, and the student's entries on both are gone. A fixture that never
    // contended satisfies the no-deadlock assertions above perfectly, so this
    // is what stops it doing that.
    const cancelled = await prisma.calendarEntry.count({
      where: { teacherId, cancelledAt: { not: null } },
    });
    expect(cancelled).toBe(2);
    const remainingEntries = await prisma.waitlistEntry.count({
      where: { studentId, classId: { in: [LOW_CLASS_ID, HIGH_CLASS_ID] } },
    });
    expect(remainingEntries).toBe(0);
  }, 30_000);

  // The two `Class` lock-order deadlock cycles once tracked here by `it.todo`
  // markers ("delete both when 180 lands") now have real tests, in
  // `src/services/template-lock-order.test.ts` — one per site, neither a bare
  // timeout.
  //
  // Stated precisely, because the two are pinned differently and "both
  // SQLSTATE-asserting" was the shorthand that replaced the markers: the sync
  // pairing is asserted by SQLSTATE negation on the erasure's rejection, while
  // the archive pairing cannot be, because `archiveOrUnarchiveTemplate`
  // RESOLVES `{ ok: false, reason: 'busy' }` on a `40P01` instead of
  // rejecting. That one is pinned by a positive `{ ok: true, deleted: 2 }`
  // plus the absence of its own lock-race log line. That file's docblock
  // records the transcript proving a rejection-based negation passes green
  // there with the deadlock intact.
  //
  // A line comment, not a `/** */` docblock: as a docblock immediately before
  // the closing `});` it documented no test, and tooling attached it to
  // nothing.
});

const prisma = new PrismaClient();

/**
 * Self-contained fixture: a fresh teacher, room, and open class with one
 * student holding a `waiting` `WaitlistEntry` on it. This file shares no
 * fixture across tests — every guard below builds its own teacher, room,
 * class and student rather than reaching for state a sibling test set up.
 *
 * `waiting: false` is the case "bounds its wait even when the student is
 * waiting in no classes at all" (below) needs: there is no loop, and the
 * ordered pre-lock statement runs unconditionally and simply matches zero
 * rows. That pre-lock's OWN `setLockTimeout` call (`lockClassRowsOrdered`,
 * `db-locks.ts`) is unconditional too — before its query runs, not gated on
 * what it matches — so this path is bounded twice over: the hoist above and
 * the pre-lock's own call both fire ahead of the `registration.updateMany`
 * this test contends on. `registered: true` gives that erasure a
 * `Registration` row of its own to contend over, since with no class lock
 * there is otherwise nothing for a counterparty to hold.
 */
async function makeStudentWaitingInClass(
  {
    waiting = true,
    registered = false,
    entryStatus = 'waiting',
  }: {
    waiting?: boolean;
    registered?: boolean;
    /**
     * The status of the entry `waiting: true` creates. Defaults to `waiting`
     * because that is what every caller wanted before `expired` had a writer.
     *
     * It matters that this is a knob rather than a constant: the erasure's
     * `waitlistEntry.deleteMany` is unscoped by status, so its `Class` lock set
     * has to cover entries of EVERY status, and a fixture that can only produce
     * `waiting` rows cannot tell a correct lock set from one that merely
     * happens to coincide with it.
     */
    entryStatus?: 'waiting' | 'promoted' | 'claimed' | 'expired' | 'removed';
  } = {},
) {
  const suffix = `gdpr-lock-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Lock',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Class-lock fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  const room = await prisma.room.create({
    data: {
      venueName: 'Lock Studio',
      address: `${suffix} St`,
      city: 'Amsterdam',
      postcode: '1234LK',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacher.id,
    },
    select: { id: true },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
    select: { id: true },
  });
  const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacherRoom.id,
      classType: 'Lock class',
      date: new Date('2099-06-01'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open',
    });
  const student = await prisma.student.create({
    data: {
      firstName: 'Lock',
      lastName: 'Student',
      email: `${suffix}-student@test.local`,
      incomeTier: 2,
    },
    select: { id: true },
  });
  if (waiting) {
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: student.id, position: 1, status: entryStatus },
    });
  }
  const registration = registered
    ? await prisma.registration.create({
        data: { classId: cls.id, studentId: student.id, status: 'registered', tierAtBooking: 2 },
        select: { id: true },
      })
    : null;
  return {
    studentId: student.id,
    classId: cls.id,
    teacherId: teacher.id,
    roomId: room.id,
    accountId: teacher.accountId,
    registrationId: registration?.id ?? null,
  };
}

/**
 * Tears down everything `makeStudentWaitingInClass` created. Called from a
 * `finally` in each test that uses the fixture (round 1 review, M5) — an
 * assertion failure between creating the fixture and this call must still
 * reap it, not leak the teacher/room/class/student/account rows into the
 * next run.
 */
async function cleanupStudentWaitingInClass(
  fixture: Awaited<ReturnType<typeof makeStudentWaitingInClass>>,
): Promise<void> {
  // `WaitlistEntry.class` is `onDelete: Cascade`, so any surviving entry
  // (e.g. the erasure never ran because an earlier assertion threw) goes
  // with the class below — no separate delete needed for it here.
  await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: fixture.classId } } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: fixture.teacherId } });
  await prisma.room.deleteMany({ where: { id: fixture.roomId } });
  await prisma.student.deleteMany({ where: { id: fixture.studentId } });
  await prisma.teacher.deleteMany({ where: { id: fixture.teacherId } });
  await prisma.account.deleteMany({ where: { id: fixture.accountId } });
}

/**
 * A student with a CLOSED waitlist entry in each of `classCount` classes, and
 * none `waiting`. The shape the old sized budget was worst at.
 *
 * `waitingCount` counted `waiting` entries only, so this student scored zero
 * and got the 5_000ms floor — against a pre-lock whose join carries no status
 * predicate and therefore asks for `classCount` row locks. That mismatch is
 * #240's first axis, and this fixture is the only thing in the suite that can
 * express it: `makeStudentWaitingInClass` builds exactly one class.
 *
 * `status: 'open'` on the classes and `'expired'` on the entries, matching
 * `makeStudentWaitingInClass({ entryStatus: 'expired' })` rather than being
 * more realistic than it. A closed entry in production sits on a class that
 * has started, but nothing in this erasure reads class status for the
 * pre-lock, and consistency with the fixture already in this file is worth
 * more than the realism.
 *
 * `classIds` comes back SORTED. The pre-lock is `ORDER BY c.id` and ids are
 * UUIDs, so creation order is not lock order — a caller staggering holders by
 * creation order would have the erasure block once on whichever row is
 * released last, and that single wait would blow the 2s `lock_timeout`.
 *
 * Distinct `startTime` per class so nothing trips a same-slot constraint.
 */
async function makeStudentWithClosedEntriesInClasses(classCount: number) {
  const suffix = `gdpr-budget-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Budget',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Budget fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  const room = await prisma.room.create({
    data: {
      venueName: 'Budget Studio',
      address: `${suffix} St`,
      city: 'Amsterdam',
      postcode: '1234BG',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacher.id,
    },
    select: { id: true },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
    select: { id: true },
  });
  const student = await prisma.student.create({
    data: {
      firstName: 'Budget',
      lastName: 'Student',
      email: `${suffix}-student@test.local`,
      incomeTier: 2,
    },
    select: { id: true },
  });
  const classIds: string[] = [];
  for (let i = 0; i < classCount; i++) {
    const cls = await createClassFixture(prisma, {
        teacherId: teacher.id,
        teacherRoomId: teacherRoom.id,
        classType: `Budget class ${i}`,
        date: new Date('2099-06-01'),
        startTime: hhmmToTime(`${String(9 + i).padStart(2, '0')}:00`),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 10,
        status: 'open',
      });
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: student.id, position: 1, status: 'expired' },
    });
    classIds.push(cls.id);
  }
  return {
    studentId: student.id,
    classIds: [...classIds].sort(),
    teacherId: teacher.id,
    roomId: room.id,
    accountId: teacher.accountId,
  };
}

/**
 * Tears down everything `makeStudentWithClosedEntriesInClasses` created.
 * Called from a `finally`, for the reason `cleanupStudentWaitingInClass`
 * above gives: an assertion failure mid-test must still reap the rows.
 *
 * `WaitlistEntry.class` is `onDelete: Cascade`, so surviving entries go with
 * their classes.
 */
async function cleanupStudentWithClosedEntries(
  fixture: Awaited<ReturnType<typeof makeStudentWithClosedEntriesInClasses>>,
): Promise<void> {
  await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: fixture.classIds } } } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: fixture.teacherId } });
  await prisma.room.deleteMany({ where: { id: fixture.roomId } });
  await prisma.student.deleteMany({ where: { id: fixture.studentId } });
  await prisma.teacher.deleteMany({ where: { id: fixture.teacherId } });
  await prisma.account.deleteMany({ where: { id: fixture.accountId } });
}

it('waits for a class row another transaction holds before renumbering other students', async () => {
  const fixture = await makeStudentWaitingInClass();
  const { studentId: fixtureStudentId, classId: fixtureClassId } = fixture;
  try {
    let holderReleased = false;

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${fixtureClassId} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 900));
        holderReleased = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const erasing = deleteStudentAccount(prisma, fixtureStudentId).then(() => 'returned' as const);
    const outcome = await Promise.race([
      erasing,
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
    ]);

    expect(outcome).toBe('waiting');
    expect(holderReleased).toBe(false);

    await holder;
    expect(await erasing).toBe('returned');
  } finally {
    await cleanupStudentWaitingInClass(fixture);
  }
}, 15_000);

/**
 * The same lever as the test above, on a CLOSED entry — and it is the closed
 * case this erasure got wrong.
 *
 * `waitlistEntry.deleteMany({ where: { studentId } })` deletes every entry the
 * student holds, of every status. The `Class` lock set was built from a read
 * scoped to `status: 'waiting'`. Those two sets coincided only by accident:
 * before #216 nothing closed a queue when a class STARTED, so a student who
 * never got in stayed `waiting` for ever and their class stayed in the lock
 * set. `closeQueueOnStart` flips exactly those rows to `expired` — which is
 * the fix — and in doing so dropped their classes out of the lock set while
 * the delete went on deleting them.
 *
 * Unlocked is not theoretical here. `POST /api/registrations` resolves an
 * `expired` entry when a teacher walks a queued student in, holding the class
 * row while it does; an erasure landing in that window deleted the row out
 * from under it, and the walk-in's `update` by id then raised `P2025` — which
 * `classifyApiError` has no branch for, so a bare 500 with the whole
 * registration rolled back.
 *
 * Run over EVERY status, not just `expired`. The stated invariant is write
 * set equals lock set, and a fixture that only ever produces one status
 * cannot distinguish that from a lock set that merely happens to include it —
 * scoping the pre-lock to `waiting` ∪ `expired` would pass a single-status
 * version of this test while still deleting `promoted`, `claimed` and
 * `removed` rows outside the lock. (`waiting` passes either way and is kept
 * as the control.)
 *
 * Without the widened lock set this test does not merely assert something
 * weaker — it goes GREEN by returning immediately, because the erasure never
 * asks for the row the holder is sitting on.
 */
it.each(['waiting', 'promoted', 'claimed', 'expired', 'removed'] as const)(
  'waits for a class row another transaction holds when the erased entry is %s',
  async (entryStatus) => {
  const fixture = await makeStudentWaitingInClass({ entryStatus });
  const { studentId: fixtureStudentId, classId: fixtureClassId } = fixture;
  try {
    let holderReleased = false;

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${fixtureClassId} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 900));
        holderReleased = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    // CAUSAL, not a wall-clock threshold. Resolving the erasure to the
    // holder's own flag asserts the ORDER of the two — the erasure finished
    // only after the holder let go — which is the property the lock provides.
    // A `Promise.race` against a fixed timer proves only "did not finish
    // within N ms", which a loaded runner can satisfy for reasons unrelated to
    // locking; and the `holderReleased` check that used to sit beside it was
    // sampled before the holder's own sleep elapsed, so it could not fail
    // either way and carried no information.
    const erasedAfterHolder = deleteStudentAccount(prisma, fixtureStudentId).then(
      () => holderReleased,
    );

    await holder;
    // False here would mean the erasure sailed past a held row lock, which is
    // exactly what a lock set scoped to `waiting` does: it never asks for this
    // class, so it finishes while the holder is still sleeping.
    expect(await erasedAfterHolder).toBe(true);

    // And the entry is still gone afterwards. The widened lock set changes
    // WHEN the delete happens, never whether it does — an erasure that locked
    // more but erased less would be a worse bug than the one being fixed.
    const remaining = await prisma.waitlistEntry.count({
      where: { studentId: fixtureStudentId },
    });
    expect(remaining).toBe(0);
  } finally {
    await cleanupStudentWaitingInClass(fixture);
  }
  },
  15_000,
);

/**
 * #174 four-specialist review, Important 5. The 2s bound *arrived* from a
 * `lockClassRow` loop that *ran* once per class the student held an entry
 * in — `waiting`-only in #174, every status by #216/#182 — and today
 * arrives unconditionally from TWO sites: the hoist at the top of the
 * transaction, and `lockClassRowsOrdered`'s own `setLockTimeout`
 * (`db-locks.ts`), which fires before its query runs regardless of what
 * it matches. Either alone bounds this path — measured by removing just
 * the hoist, which leaves the test below passing. Under the old loop, a
 * student holding no such entry, the common case, got an unbounded wait
 * on every statement in the erasure transaction. Prisma's own `timeout`
 * cannot rescue that: it refuses to START a statement past the budget, it
 * cannot cancel one already blocked inside Postgres, so the erasure
 * simply hung.
 *
 * Round 2 review measured exactly this and wrote the asymmetry down as
 * intended. It was not — nothing in the GDPR-clock reason for bounding an
 * erasure depends on the subject being on a waitlist.
 *
 * The contended row is the student's own `Registration`, unrelated to any
 * class lock, because with an empty lock set there is nothing else for a
 * counterparty to hold. Held for 4s, well past the 2s bound, so what this
 * observes is the timeout and not a wait.
 */
it('bounds its wait even when the student is waiting in no classes at all', async () => {
  const fixture = await makeStudentWaitingInClass({ waiting: false, registered: true });
  const { studentId: fixtureStudentId, registrationId } = fixture;
  try {
    // The premise: an empty lock set — `lockClassRowsOrdered`'s WHERE
    // matches zero rows for this student; the statement still runs.
    // MEASURED: this test's outcome does not depend on the
    // top-of-transaction hoist above. Deleting it alone still leaves this
    // test passing, because `lockClassRowsOrdered`'s own `setLockTimeout`
    // call is unconditional too — before its query runs, not gated on
    // what it matches — and it runs ahead of the `registration.updateMany`
    // below regardless of row count. What this test actually guards is
    // narrower than the docblock above states: that SOME bound reaches
    // this transaction before that statement, not that the hoist
    // specifically is load-bearing. The hoist's own necessity is
    // currently unverified by any test in this file — a coverage gap, not
    // a live defect, since a second unconditional call already covers
    // this exact path.
    expect(
      await prisma.waitlistEntry.count({
        where: { studentId: fixtureStudentId, status: 'waiting' },
      }),
    ).toBe(0);

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registrationId} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 4_000));
      },
      { timeout: 20_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const outcome = await deleteStudentAccount(prisma, fixtureStudentId)
      .then(() => 'returned' as const)
      .catch((err: unknown) => ({ error: String(err) }) as const);
    await holder;

    // Unbounded (pre-hoist) this is `'returned'`: the erasure waits out the
    // full 4s hold and succeeds.
    expect(outcome).not.toBe('returned');
    expect(typeof outcome === 'object' ? outcome.error : '').toMatch(/55P03|lock timeout/);

    // And the abort is atomic — nothing half-applied, which is what makes
    // the route's retry advice sound.
    const student = await prisma.student.findUniqueOrThrow({ where: { id: fixtureStudentId } });
    expect(student.deletedAt).toBeNull();
  } finally {
    await cleanupStudentWaitingInClass(fixture);
  }
}, 30_000);

/**
 * #240. The erasure's transaction budget used to be sized from a count of
 * `waiting` entries only, so a student with none scored zero and got the
 * 5_000ms floor — against a pre-lock that still asks for one row lock per
 * class the student holds an entry in, of any status.
 *
 * The construction is fiddly for reasons worth stating, because a simpler
 * version of it proves nothing:
 *
 * - Six holders releasing 1.5s apart, NOT all at once. Simultaneous
 *   releases produce one ~1.5s wait, not six; the statement then finishes
 *   inside 5s and the old budget passes.
 * - Staggered by SORTED class id, because the pre-lock is `ORDER BY c.id`.
 *   Stagger by creation order and the erasure blocks once on whatever is
 *   released last, that single wait exceeds the 2s `lock_timeout`, and the
 *   FIXED code fails with `55P03`.
 * - `pg_sleep` inside the holding transaction, on an ABSOLUTE schedule
 *   computed from `t0`, rather than a JS timer per holder. The two margins
 *   pull against each other — total elapsed must clear 5_000ms or the old
 *   budget survives, and no single wait may reach 2_000ms or the new one
 *   dies — and a JS timer firing late spends the second margin directly.
 *   1.5s steps leave 500ms of headroom under the bound and ≈3.7s over the
 *   old budget.
 * - A DEDICATED client with an explicit `connection_limit`. Prisma's
 *   default pool is `physical_cores * 2 + 1`; on a two-core CI runner that
 *   is five, and six holders plus the erasure would deadlock waiting for
 *   connections rather than for locks — a failure that looks nothing like
 *   what this test is about.
 *
 * What it proves, precisely: an erasure whose lock waits total more than
 * the old floor now completes. Restore
 * `Math.min(5_000 + waitingCount * 2_000, 20_000)` and it fails with
 * `P2028`, which is #240 reproduced.
 *
 * And it proves that by asserting it, not by finishing. Two assertions
 * carry the whole test — elapsed above the old floor, and the erasure
 * returning after the last hold ended — because the outcome assertions
 * (entries gone, `deletedAt` set) are equally true of an erasure that
 * contended for nothing. See their comments in the body for the two
 * realistic paths to that vacuous pass; the point of both assertions is
 * that this test fails loudly on the day it stops exercising #240 instead
 * of quietly continuing to pass.
 */
it('completes when its lock waits total more than the old 5s budget', async () => {
  const CLASSES = 6;
  const HOLD_STEP_MS = 1_500;
  const fixture = await makeStudentWithClosedEntriesInClasses(CLASSES);
  const baseUrl = process.env.DATABASE_URL ?? '';
  const holderDb = new PrismaClient({
    datasources: {
      db: { url: `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}connection_limit=10` },
    },
  });
  try {
    let lastHolderReleased = false;
    const t0 = Date.now();
    const holders = fixture.classIds.map((classId, i) =>
      holderDb.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
          const seconds = Math.max(0, (t0 + (i + 1) * HOLD_STEP_MS - Date.now()) / 1000);
          // Computed, never input — `$queryRawUnsafe` because a bound
          // parameter into `pg_sleep` needs an explicit cast to resolve.
          // The trailing `::text` is load-bearing, not decorative:
          // `pg_sleep` returns `void`, which Prisma cannot deserialize.
          // Without the cast every holder's `$transaction` REJECTS with
          // P2010 right after its sleep completes — invisible today,
          // because the erasure throws P2028 first and `Promise.all`
          // below is never reached, but fatal once the budget is fixed:
          // the erasure would then succeed, execution would reach
          // `Promise.all(holders)`, and it would reject with P2010,
          // failing this test against the very fix it exists to confirm.
          await tx.$queryRawUnsafe(`SELECT pg_sleep(${seconds.toFixed(3)})::text`);
          // `fixture.classIds` is sorted and the pre-lock is `ORDER BY c.id`,
          // so the highest index is both the last row the erasure can reach
          // and the last hold to end — the one whose release the erasure's
          // return has to follow. Set inside the callback, i.e. just before
          // the COMMIT that actually drops the lock, exactly as the sibling
          // test's `holderReleased` is; that is conservative in the right
          // direction, because the flag turns true slightly BEFORE the lock
          // is free, so a false reading below cannot be an artefact of the
          // flag arriving late.
          if (i === CLASSES - 1) lastHolderReleased = true;
        },
        { timeout: 30_000, maxWait: 10_000 },
      ),
    );

    // Every holder must be sitting on its row before the erasure asks for
    // any of them, or the pre-lock sails through the ones not yet taken.
    await new Promise((r) => setTimeout(r, 300));

    // The two assertions after this call are the test. Everything else it
    // checks — entries gone, `deletedAt` set — is equally true of an erasure
    // that contended for NOTHING and returned in 40ms, so "it passed" is
    // worthless evidence here: such a run would also have passed against the
    // 5_000ms budget this test exists to bury, and would have reported
    // nothing about it. Two realistic paths lead there. `holderDb` is a
    // freshly constructed `PrismaClient`, so its first six queries pay
    // engine start plus connect; if that ever outruns the 300ms settle, the
    // pre-lock reaches rows nobody is holding yet. And `Math.max(0, …)`
    // above collapses a hold to zero whenever its `FOR UPDATE` came back
    // late, degrading the stagger from the front. Both fail green unless the
    // properties that distinguish a real run are asserted outright.
    const tStart = Date.now();
    const erasure = deleteStudentAccount(prisma, fixture.studentId).then(() => ({
      elapsedMs: Date.now() - tStart,
      afterLastHolder: lastHolderReleased,
    }));
    // Marks a rejection handled at the moment it can occur, nine seconds
    // before `await erasure` below gets to it. A regression of #240 makes
    // this call reject with `P2028`, and without this line that rejection
    // sits unhandled across the `Promise.all` and surfaces as an unhandled
    // rejection — attributable to any file — instead of as this test failing
    // on the await. The await still throws it; only the reporting changes.
    void erasure.catch(() => undefined);

    await Promise.all(holders);
    const { elapsedMs, afterLastHolder } = await erasure;

    // CAUSAL, mirroring the `erasedAfterHolder` resolution in "waits for a
    // class row another transaction holds when the erased entry is %s" —
    // named rather than counted, because a relative count rots the moment
    // anyone inserts a test between the two, which is exactly how this
    // branch's other cross-references died. The erasure returned only after
    // the last hold ended. That is ORDER, which is the property a lock
    // provides and which a duration on its own — a loaded runner can spend
    // 6s on anything — does not establish.
    expect(afterLastHolder).toBe(true);

    // ELAPSED, and this is the assertion that is specifically about #240,
    // because it is the literal claim "this run would have failed under the
    // old budget". The threshold is that old floor, 5_000ms, and the margin
    // is stated rather than hoped for: six holds 1.5s apart end at
    // t0 + 9_000ms while the erasure starts at t0 + ~300ms, so observed
    // elapsed has been 8666-8821ms across runs — 3.7-3.8s of headroom over
    // the threshold, matching the ≈3.7s the construction notes above
    // predict. The window measured here is a superset of the transaction's
    // own (it includes the pre-transaction `student.findUniqueOrThrow` and
    // the post-commit `handleSpotFreed` loop), which is milliseconds against
    // that margin and errs toward passing; the causal assertion above is
    // what rules out an elapsed figure earned by anything other than waiting
    // for locks. Mutation-checked rather than assumed: `HOLD_STEP_MS = 500`
    // makes the whole run finish in 2780ms and this line fails with
    // "expected 2780 to be greater than 5000" instead of passing green.
    expect(elapsedMs).toBeGreaterThan(5_000);

    expect(
      await prisma.waitlistEntry.count({ where: { studentId: fixture.studentId } }),
    ).toBe(0);
    const erased = await prisma.student.findUniqueOrThrow({
      where: { id: fixture.studentId },
      select: { deletedAt: true },
    });
    expect(erased.deletedAt).not.toBeNull();
  } finally {
    await holderDb.$disconnect();
    await cleanupStudentWithClosedEntries(fixture);
  }
}, 40_000);

it('does not deadlock against a transaction that locks the class first and then writes the erased student\'s waiting entry', async () => {
  // Round 1 review, C1: the previous version of this fix took the row
  // locks below BEFORE requesting the Class lock — the inverse of every
  // other writer (`promoteNext` dropping a stale head,
  // `withdrawWaitingEntriesForTeacher` clearing every entry both lock the
  // Class row FIRST, then write `WaitlistEntry`). That inversion is a
  // classic AB-BA deadlock: this transaction holding a `WaitlistEntry` row
  // lock while requesting the Class lock, opposite another transaction
  // holding the Class lock while requesting that same `WaitlistEntry`
  // row. `OTHER` below plays that other transaction's exact shape — Class
  // `FOR UPDATE` first, `WaitlistEntry` write second — reproduced against
  // the previous version of this fix as Postgres error `40P01 deadlock
  // detected`, and fails this test (via one of the two outcomes below not
  // matching) if the class lock ever moves back below this transaction's
  // own writes.
  const fixture = await makeStudentWaitingInClass();
  const { studentId: fixtureStudentId, classId: fixtureClassId } = fixture;
  try {
    // Canary. Everything this test asserts is an absence — neither side
    // rejected — so it passes trivially if `deleteStudentAccount` never
    // takes a `Class` lock at all. It takes one whenever the student holds
    // a `WaitlistEntry` of any status, via the ordered pre-lock that runs
    // before any write — so drifting the fixture's status leaves the lock
    // in place. The assertion below is narrower than that mechanism
    // requires — it checks `status: 'waiting'` specifically, when any
    // status would do — but it is sufficient, not wrong: a `waiting`
    // entry on this fixture's class is still an entry, so the pre-lock
    // still takes the row. Its sibling above self-protects (a missing
    // lock means no wait, and the wait IS its assertion); this one does
    // not, so it says the premise out loud.
    expect(
      await prisma.waitlistEntry.count({
        where: { studentId: fixtureStudentId, status: 'waiting' },
      }),
    ).toBe(1);

    const other = prisma
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${fixtureClassId} FOR UPDATE`;
          // Give the erasure time to reach — and, pre-fix, complete — its
          // own write to this same `WaitlistEntry` row before this
          // transaction tries to touch it too. Comfortably under the 1s
          // Postgres `deadlock_timeout` this test relies on to resolve the
          // cycle it is trying to provoke.
          await new Promise((r) => setTimeout(r, 300));
          await tx.waitlistEntry.updateMany({
            where: { classId: fixtureClassId, studentId: fixtureStudentId },
            data: { status: 'removed' },
          });
        },
        { timeout: 10_000 },
      )
      .then(() => 'other-ok' as const)
      .catch((err: unknown) => ({ error: String(err) }) as const);

    // Small settle so `other`'s `FOR UPDATE` is in place before the
    // erasure starts — mirrors the settle in the wait test above.
    await new Promise((r) => setTimeout(r, 50));

    const erasing = deleteStudentAccount(prisma, fixtureStudentId)
      .then(() => 'returned' as const)
      .catch((err: unknown) => ({ error: String(err) }) as const);

    const [otherOutcome, erasureOutcome] = await Promise.all([other, erasing]);

    expect(erasureOutcome).toBe('returned');
    expect(otherOutcome).toBe('other-ok');
  } finally {
    await cleanupStudentWaitingInClass(fixture);
  }
}, 15_000);

// The bare `it`/`it.each` tests above this line share the module-scope
// `prisma` declared near the top of this section; every describe below opens
// and disconnects its own `PrismaClient` instead. Declared at the top level
// rather than nested in a `describe`, so it runs once, after every test in
// this file finishes.
afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Whole-branch review of #174, Important, closed further by #367.
 * Originally: `deleteTeacherAccount` read its classes — and, eager-loaded
 * alongside them, the registrations it would notify — before taking any
 * lock, then cancelled under the CAS's lock and built the notifications
 * from that pre-lock snapshot. A student who registered in between had
 * their class cancelled and was never told. #174's whole-branch review
 * fixed the notification half by re-reading recipients under the lock
 * (`class-transitions.ts`'s `autoCancelClasses` got the identical fix at
 * the same time, for the same reason its own comment states — "a
 * cancelled class nobody was told about is worse than one that stays
 * open one more sweep").
 *
 * #367 closes the registration half of the same gap structurally: the
 * class lock now runs before the read of the classes it cancels, so the
 * unlocked interval a registration used to be able to land in freely is
 * gone — there is no moment inside this transaction where a cancellable
 * class of this teacher's has been looked at but not held.
 *
 * THE TEST BELOW DOES NOT PROVE THAT REORDER, and saying so was this
 * describe's own overclaim. What it proves is the property the reorder
 * leans on, and only that: once `lockClassRowsOrdered` has taken its lock,
 * a concurrent registration on a locked class blocks until the transaction
 * ends (Postgres's automatic `FOR KEY SHARE` on the referencing `INSERT`
 * conflicting with the held `FOR UPDATE`). That property belongs to
 * `lockClassRowsOrdered`, not to #367 — the same call was made before the
 * reorder, from a later point in the same function — and this test cannot
 * see the difference, because it synchronises on the helper's
 * `entries === true` branch, which fires identically either way. Measured:
 * this test passes unedited with `gdpr.ts` reverted to its pre-#367
 * revision. Kept as a regression guard that the reorder did not break a
 * safety property that already held. What pins the reorder itself is
 * `gdpr.test.ts`'s "cancels a class that becomes cancellable immediately
 * before the class lock runs".
 */
describe('deleteTeacherAccount blocks concurrent registrations on classes it locks (#367)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-notify-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let classId: string;
  let earlyStudentId: string;
  let lateStudentId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Notify',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Notification recency fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Notify Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234NO',
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

    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Notify class',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 10,
        status: 'open',
      });
    classId = cls.id;

    const early = await prisma.student.create({
      data: { firstName: 'Early', lastName: 'Booker', email: `${suffix}-early@test.local`, incomeTier: 2 },
      select: { id: true },
    });
    earlyStudentId = early.id;
    const late = await prisma.student.create({
      data: { firstName: 'Late', lastName: 'Booker', email: `${suffix}-late@test.local`, incomeTier: 3 },
      select: { id: true },
    });
    lateStudentId = late.id;

    await prisma.registration.create({
      data: { classId, studentId: earlyStudentId, status: 'registered', tierAtBooking: 2 },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [earlyStudentId, lateStudentId, teacherId] } },
    });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: { in: [earlyStudentId, lateStudentId] } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('blocks a concurrent registration on a class it is about to cancel, until it commits', async () => {
    let reachedLock!: () => void;
    const atLock = new Promise<void>((resolve) => {
      reachedLock = resolve;
    });
    let releaseLock!: () => void;
    const heldOpen = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const original = dbLocks.lockClassRowsOrdered;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await original(tx, source);
        if (source.entries === true) {
          reachedLock();
          await heldOpen;
        }
        return ids;
      });
    onTestFinished(() => spy.mockRestore());

    const erasing = deleteTeacherAccount(prisma, teacherId).then(() => 'erased' as const);
    await atLock;

    let registrationLanded = false;
    const registering = prisma.registration
      .create({ data: { classId, studentId: lateStudentId, status: 'registered', tierAtBooking: 3 } })
      .then(() => {
        registrationLanded = true;
      });

    try {
      await new Promise((r) => setTimeout(r, 400));
      // Still blocked: the erasure holds the Class row's FOR UPDATE lock,
      // and the registration INSERT's automatic FOR KEY SHARE lock on that
      // same row conflicts with it. That conflict is `lockClassRowsOrdered`'s
      // own and predates #367; this asserts the reorder did not break it,
      // not that the reorder created it -- see the describe docblock.
      expect(registrationLanded).toBe(false);
    } finally {
      // In a `finally`, so a failed assertion above still releases the
      // erasure's held lock AND joins both racing operations, rather than
      // leaving them running unjoined against the describe's shared `prisma`
      // while its `afterAll` may already be deleting the rows they touch.
      releaseLock();
      await Promise.all([erasing, registering]);
    }

    expect(registrationLanded).toBe(true);

    // The registration that finally landed, after the class was already
    // cancelled, is still there -- the block above defers it, it does not
    // lose it.
    const reg = await prisma.registration.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: lateStudentId } },
    });
    expect(reg.status).toBe('registered');
  }, 15_000);
});

describe('student erasure is retry-safe against a concurrent duplicate (#196)', () => {
  const prisma = new PrismaClient();

  /**
   * A student holding the only seat in an open class, with one other student
   * waiting on it, and `now` half an hour inside the broadcast window.
   *
   * `target` = now + 48h30m against a HOURS_48 deadline puts `deadline` at
   * now + 30m and `cutoff` at now − 30m, so `now` falls inside
   * `first_come_first_claimed`. Computed from the clock rather than
   * hard-coded, because the window is relative to it. The teacher is `UTC` so
   * `date` + `startTime` map to the instant this arithmetic assumes — the
   * suite itself runs under `TZ=America/New_York` (vitest.config.ts).
   *
   * Its own teacher, room, class and students — this file shares no fixture
   * across describes, so there is nothing to reach for instead.
   */
  async function makeStudentWithFreedSpot() {
    const suffix = `gdpr-race-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Race',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Concurrent-erasure fixture',
        pageSlug: suffix,
        defaultTimezone: 'UTC',
      },
      select: { id: true, accountId: true },
    });
    const room = await prisma.room.create({
      data: {
        venueName: 'Race Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234RC',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacher.id,
      },
      select: { id: true },
    });
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const target = new Date(Date.now() + 48 * 60 * 60 * 1000 + 30 * 60 * 1000);
    const cls = await createClassFixture(prisma, {
        teacherId: teacher.id,
        teacherRoomId: teacherRoom.id,
        classType: 'Race class',
        date: new Date(`${target.toISOString().slice(0, 10)}T00:00:00Z`),
        startTime: hhmmToTime(target.toISOString().slice(11, 16)),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 1,
        cancelDeadline: 'HOURS_48',
        autoCancelCheck: 'HOURS_2',
        status: 'open',
      });
    const student = await prisma.student.create({
      data: {
        firstName: 'Race',
        lastName: 'Student',
        email: `${suffix}-student@test.local`,
        incomeTier: 2,
      },
      select: { id: true },
    });
    await prisma.registration.create({
      data: { classId: cls.id, studentId: student.id, status: 'registered', tierAtBooking: 2 },
    });
    const waiter = await prisma.student.create({
      data: {
        firstName: 'Race',
        lastName: 'Waiter',
        email: `${suffix}-waiter@test.local`,
        incomeTier: 2,
      },
      select: { id: true },
    });
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: waiter.id, position: 1, status: 'waiting' },
    });

    return {
      studentId: student.id,
      waiterId: waiter.id,
      classId: cls.id,
      teacherId: teacher.id,
      roomId: room.id,
      accountId: teacher.accountId,
    };
  }

  /** Reaps a fixture whether or not the erasures under test got that far. */
  async function cleanup(fixture: Awaited<ReturnType<typeof makeStudentWithFreedSpot>>) {
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [fixture.studentId, fixture.waiterId, fixture.teacherId] } },
    });
    await prisma.registration.deleteMany({ where: { classId: fixture.classId } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: fixture.classId } } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: fixture.teacherId } });
    await prisma.room.deleteMany({ where: { id: fixture.roomId } });
    await prisma.student.deleteMany({ where: { id: { in: [fixture.studentId, fixture.waiterId] } } });
    await prisma.teacher.deleteMany({ where: { id: fixture.teacherId } });
    await prisma.account.deleteMany({ where: { id: fixture.accountId } });
  }

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('erases once when the same student erasure runs twice concurrently', async () => {
    const fixture = await makeStudentWithFreedSpot();
    // A second client, so the lock below is held by a transaction neither
    // erasure can be scheduled inside.
    const holder = new PrismaClient();
    try {
      // A bare `Promise.allSettled` of the two calls is not a race: they can
      // serialise, and a serialised second call reads its `upcoming` AFTER the
      // first cancelled those registrations, so it comes back empty — the
      // erasure then commits nothing to broadcast about, `handleSpotFreed`
      // never runs, and the notification assertion below passes EVEN WITH THE
      // ABORT REMOVED. The whole test would be green against the bug it names.
      //
      // The lever (the pattern in `registrations-api.test.ts`'s cancel race):
      // a third transaction takes the `Student` row `FOR UPDATE` before either
      // call starts. Both erasures then read the same non-empty `upcoming`
      // (uncommitted state is invisible under READ COMMITTED) and both park at
      // a write — one on this lock at the closing CAS, the other behind it on
      // the shared `Registration` row.
      let release!: () => void;
      let locked!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      // The handshake: `$transaction` returns before its callback has run, and
      // a fresh client has to connect and start its engine first, so without
      // this the erasures can be finished before the lock is ever taken.
      const parked = new Promise<void>((r) => { locked = r; });
      const holding = holder.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${fixture.studentId} FOR UPDATE`;
        locked();
        await released;
      }, { timeout: 20_000 });
      await parked;

      const running = Promise.allSettled([
        deleteStudentAccount(prisma, fixture.studentId),
        deleteStudentAccount(prisma, fixture.studentId),
      ]);

      // 700ms: `deleteStudentAccount` opens with `setLockTimeout`, so a
      // statement parked past 2s is cancelled with `55P03` and the loser
      // rejects with a Postgres error instead of the sentinel. The loser waits
      // this hold plus the winner's remaining statements, so the margin is
      // smaller than the 2s suggests.
      let settled = false;
      void running.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 700));

      // The lever is asserted, not assumed. If both calls finished inside this
      // window they serialised, and everything below is measuring the
      // scheduler rather than the guard.
      expect(settled).toBe(false);
      release();
      await holding;
      const results = await running;

      // Asserted before the outcomes, deliberately: the doubled broadcast is
      // the defect — every waiting student told twice about one freed seat —
      // and this is the assertion whose failure message names it. With the
      // rejection count first, dropping the abort fails on "expected 1,
      // received 0", which says nothing about what it cost anyone.
      const notifications = await prisma.notification.findMany({
        where: {
          relatedClassId: fixture.classId,
          recipientId: fixture.waiterId,
          type: 'spot_available',
        },
      });
      expect(notifications).toHaveLength(1);

      // One erases; the other finds the row already erased and aborts whole.
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyErasedError);

      const student = await prisma.student.findUniqueOrThrow({ where: { id: fixture.studentId } });
      expect(student.deletedAt).not.toBeNull();
    } finally {
      await holder.$disconnect();
      await cleanup(fixture);
    }
  }, 30_000);
});

/**
 * Task 3c (#315), Step 6. `deleteTeacherAccount`'s bulk archive writes
 * `ScheduleRule` — `isActive`/`isArchived` moved off `ClassTemplate` in issue
 * 298 — and, before this fixed it, took no lock on `ClassTemplate` at all
 * first. `ACTIVE_TEMPLATE_WHERE` (`lib/template-selection.ts`), which the
 * hourly sweep's own candidate `findMany` selects with, carries no
 * `teacher.deletedAt` filter, so a sweep already mid-claim for this teacher's
 * template when an erasure opens is a real interleaving, not a theoretical
 * one — measured by this test, which holds the claim's own `FOR UPDATE OF ct`
 * and proves the erasure queues behind it exactly like the shared archive's
 * child row lock does (`archiveOrUnarchiveRule`, `rule-lifecycle.ts`). Not its
 * CAS: that writes `ScheduleRule`, which no sweep touches.
 */
describe('deleteTeacherAccount serialises against a claim in progress (#315)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-claim-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let templateId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Claim',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Erasure-vs-claim fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Claim Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234CD',
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
    teacherRoomId = teacherRoom.id;

    const template = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'regular',
            classType: 'Claim vs Erasure',
            dayOfWeek: 2,
            startTime: hhmmToTime('07:00'),
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
      select: { id: true },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });
    await prisma.classTemplate.deleteMany({ where: { id: templateId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('waits for a concurrent claim to release the child row before archiving the teacher templates', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const claiming = prisma.$transaction(
      async (tx) => {
        expect(await claimTemplateForGeneration(tx, templateId)).not.toBeNull();
        await held;
      },
      { timeout: 15_000 },
    );

    // Let the claim acquire the lock before the erasure contends for it.
    await new Promise((r) => setTimeout(r, 100));

    let erasureSettled = false;
    const erasing = deleteTeacherAccount(prisma, teacherId).then(() => {
      erasureSettled = true;
    });

    await new Promise((r) => setTimeout(r, 300));
    try {
      // Without the ordered child-row pre-lock this fixed, the erasure's
      // `ScheduleRule` write is unobstructed and this is true.
      expect(erasureSettled).toBe(false);
    } finally {
      // In a `finally`, so a failed assertion above still releases the
      // claim's `FOR UPDATE` hold rather than parking it — until its own
      // 15s `timeout` — on the very row the describe's `afterAll` deletes
      // next.
      release();
      await claiming;
      await erasing;
    }

    const rule = await prisma.scheduleRule.findUniqueOrThrow({
      where: { id: (await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } })).scheduleRuleId },
    });
    expect(rule.isArchived).toBe(true);
    expect(rule.isActive).toBe(false);
  }, 20_000);
});

/**
 * The studio twin of the suite above. `deleteTeacherAccount`'s bulk archive
 * takes an ordered pre-lock on `StudioClassTemplate` (`FOR UPDATE OF sct`)
 * separately from the `ClassTemplate` one (`FOR UPDATE OF ct`) proved there —
 * two statements, two tables, and the review round that added this test found
 * that the suite above's own mutation (removing both together) had proved
 * only the pair, not either lock individually. `claimStudioTemplateForGeneration`
 * (`studio-class-generator.ts`) takes its row lock on `StudioClassTemplate`,
 * not on `ClassTemplate`, so this is not redundant with the class-family case
 * above — it is what makes the `sct` lock's necessity a measurement rather
 * than an inference from the `ct` one.
 */
describe('deleteTeacherAccount serialises against a studio claim in progress (#315)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-studio-claim-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let templateId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Studio Claim',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Erasure-vs-studio-claim fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const template = await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'studio',
            classType: 'Studio Claim vs Erasure',
            dayOfWeek: 3,
            startTime: hhmmToTime('08:00'),
            durationMinutes: 60,
          },
        },
        location: 'Studio Claim Test',
        hourlyRate: 40,
      },
      select: { id: true },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });
    await prisma.studioClassTemplate.deleteMany({ where: { id: templateId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('waits for a concurrent studio claim to release the child row before archiving the teacher templates', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const claiming = prisma.$transaction(
      async (tx) => {
        expect(await claimStudioTemplateForGeneration(tx, templateId)).not.toBeNull();
        await held;
      },
      { timeout: 15_000 },
    );

    // Let the claim acquire the lock before the erasure contends for it.
    await new Promise((r) => setTimeout(r, 100));

    let erasureSettled = false;
    const erasing = deleteTeacherAccount(prisma, teacherId).then(() => {
      erasureSettled = true;
    });

    await new Promise((r) => setTimeout(r, 300));
    try {
      // Without the ordered child-row pre-lock this fixed, the erasure's
      // `ScheduleRule` write is unobstructed and this is true.
      expect(erasureSettled).toBe(false);
    } finally {
      // In a `finally`, so a failed assertion above still releases the
      // claim's `FOR UPDATE` hold rather than parking it — until its own
      // 15s `timeout` — on the very row the describe's `afterAll` deletes
      // next.
      release();
      await claiming;
      await erasing;
    }

    const rule = await prisma.scheduleRule.findUniqueOrThrow({
      where: {
        id: (await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } })).scheduleRuleId,
      },
    });
    expect(rule.isArchived).toBe(true);
    expect(rule.isActive).toBe(false);
  }, 20_000);
});
