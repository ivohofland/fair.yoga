# Waitlist erasure gate (#183) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `WaitlistEntry`'s waiting-position uniqueness an enforced invariant, and stop `deleteStudentAccount` writing `WaitlistEntry` rows outside the classes it has locked, by refusing a waitlist join that races its own student's erasure.

**Architecture:** A new lock node, the `Student` row, taken first by both the erasure (`FOR NO KEY UPDATE`) and `addToWaitlist` (`FOR SHARE`, refusing an erased profile), through two helpers in `src/lib/db-locks.ts`. The erasure's `WaitlistEntry` delete is scoped to its locked classes, with a count after it that aborts if anything sits outside. Separately, an immediate partial unique index on `(classId, position) WHERE status = 'waiting'`, with a migration that first renumbers existing waiting rows.

**Tech Stack:** Next.js 16 route handlers, Prisma 6.19.3 on PostgreSQL 16, Vitest (projects `unit`, `unit-sweeps`, `integration`), TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-09-16-waitlist-erasure-gate-design.md` — read it first; every design decision below is argued there.

## Global Constraints

- TypeScript `strict: true`; no `any`.
- CLAUDE.md *Comment Discipline*: a comment annotates the code it sits on; counts, rosters and facts about other modules go in `docs/` with the command that re-derives them; comments state what is true now (history goes in the PR body).
- Never edit an applied migration, comments included. The new migration's name is fixed: `prisma/migrations/20260916120000_waitlist_waiting_position_unique/`.
- Every `--` in a migration opens its own line; a post-cutoff migration containing `UPDATE "…"` must carry a live `RAISE NOTICE` (enforced by `src/lib/migration-remediation-trace.test.ts`).
- Stage exact paths; never `git add -A` / `git add .`.
- Never kill or restart the dev server on `:3000`. This worktree's own app runs on the port `pnpm run worktree:up` prints (`INTEGRATION_BASE_URL` in `.env`); that one may be restarted with `pnpm run worktree:down` / `worktree:up`.
- Every lock wait in this code is bounded by `SET LOCAL lock_timeout = '2s'`. A staged race must release its holder, and the released side must finish, inside 2s of the waiter starting to wait — otherwise the waiter fails `55P03`, which reads as a different defect.
- Spies on `@/lib/db-locks` exports intercept calls made from OTHER modules (`gdpr.ts`, `waitlist.ts`) only, never calls inside `db-locks.ts` itself. Capture `original` before `vi.spyOn`, make stalls one-shot and filtered, and register `onTestFinished(() => spy.mockRestore())` immediately.
- **Mutation protocol (every "Prove it bites" step):** commit first (a `git checkout` restore discards every uncommitted edit in that file); apply the mutation; warm nothing (these are service tests) or, for the integration test, request the route once; run the named test; record the exact failure text in the task report; restore with `git checkout -- <file>`; confirm `git status` shows the file clean; re-run and see it pass.
- Test tiers: `src/services/gdpr-lock-order.test.ts`, `src/lib/db-locks-lock-order.test.ts` and the new `src/services/waitlist-position-migration.test.ts` run in `unit-sweeps` (serial). `waitlist.test.ts`, `db-locks.test.ts` and the new `waitlist-position-index.test.ts` run in `unit`. `tests/integration/account-api.test.ts` runs in `integration` against this worktree's app.

**Task order is load-bearing: Task 3 must land before Task 4.** Task 4 makes `addToWaitlist` take `Student FOR SHARE` before its `Class` lock. Against today's erasure — which takes its classes first and the `Student` row last (its closing email `UPDATE` escalates to `FOR UPDATE`) — a rejoin (the student already holds a closed entry in the class) would deadlock: the join holds `Student SHARE` and waits on the class; the erasure holds the class and waits on `Student`. Task 3 moves the erasure's `Student` lock to the front, which removes that cycle. Task 1 is independent of the rest.

**Controller step before Task 4:** file the two follow-up issues (spec, *Follow-ups*) — the implementer subagents must not perform GitHub writes — and pass their numbers into Task 4's brief as `FOLLOWUP_BOOKING` and `FOLLOWUP_LINKS`.

---

### Task 1: The partial unique index on waiting positions

**Files:**
- Create: `prisma/migrations/20260916120000_waitlist_waiting_position_unique/migration.sql`
- Modify: `prisma/schema.prisma` (docblock above `model WaitlistEntry`, ~line 991)
- Create: `src/services/waitlist-position-index.test.ts`
- Create: `src/services/waitlist-position-migration.test.ts`
- Modify: `vitest.tiers.ts` (`LOCK_CONTENTION_TESTS`)
- Modify: `docs/data-model.md` (`### WaitlistEntry (overflow)`, ~line 508)
- Modify: `src/lib/waitlist-status.ts:41`, `src/services/waitlist.ts:1165-1168`, `src/services/gdpr.ts:449-453` (the "(#183)" citations)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the database index `"WaitlistEntry_waiting_position_key"`. A violation surfaces as Prisma `P2002` with `meta.target` `['classId', 'position']`.

- [ ] **Step 1: Write the constraint tests (C1, C2)**

Create `src/services/waitlist-position-index.test.ts`:

```ts
/**
 * `WaitlistEntry_waiting_position_key`: a partial unique index on
 * `(classId, position) WHERE status = 'waiting'`. Hand-authored — Prisma cannot
 * express the predicate — so these tests are the only thing that notices it
 * missing. Why it is partial and immediate: `docs/data-model.md` (WaitlistEntry).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type WaitlistStatus } from '@prisma/client';
import crypto from 'crypto';
import { hhmmToTime } from '@/lib/time-of-day';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const suffix = `wl-pos-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

let teacherId: string;
let accountId: string;
let roomId: string;
let classA: string;
let classB: string;
const studentIds: string[] = [];

beforeAll(async () => {
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Position',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Waiting-position index fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;
  const room = await prisma.room.create({
    data: {
      venueName: 'Position Studio',
      address: `${suffix} St`,
      city: 'Amsterdam',
      postcode: '1234PS',
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
  const makeClass = async (date: string) =>
    (
      await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Position class',
        date: new Date(date),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 1,
        status: 'open',
      })
    ).id;
  classA = await makeClass('2099-06-01');
  classB = await makeClass('2099-06-02');
  for (let i = 0; i < 6; i++) {
    const s = await prisma.student.create({
      data: { firstName: 'Position', lastName: `S${i}`, email: `${suffix}-s${i}@test.local`, incomeTier: 3 },
      select: { id: true },
    });
    studentIds.push(s.id);
  }
});

afterAll(async () => {
  await prisma.calendarEntry.deleteMany({ where: { teacherId } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.deleteMany({ where: { id: roomId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

const entry = (classId: string, student: number, position: number, status: WaitlistStatus) =>
  prisma.waitlistEntry.create({
    data: { classId, studentId: studentIds[student]!, position, status },
  });

describe('WaitlistEntry_waiting_position_key', () => {
  it('refuses a second waiting row at a position its class already holds', async () => {
    await entry(classA, 0, 1, 'waiting');
    const err = await entry(classA, 1, 1, 'waiting').catch((e: unknown) => e);
    expect(isUniqueConflictOn(err, ['classId', 'position'])).toBe(true);
  });

  it('accepts a waiting row at a position a closed row still holds', async () => {
    await entry(classA, 2, 2, 'removed');
    await expect(entry(classA, 3, 2, 'waiting')).resolves.toBeTruthy();
  });

  it('accepts two closed rows at one position', async () => {
    await entry(classA, 4, 3, 'removed');
    await expect(entry(classA, 5, 3, 'expired')).resolves.toBeTruthy();
  });

  it('accepts one waiting position in two different classes', async () => {
    await expect(entry(classB, 0, 1, 'waiting')).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and see C1 fail**

Run: `pnpm exec vitest run --project unit src/services/waitlist-position-index.test.ts`
Expected: the first test FAILS (`expected false to be true` — the second `create` succeeded); the other three pass.

- [ ] **Step 3: Write the migration**

Create `prisma/migrations/20260916120000_waitlist_waiting_position_unique/migration.sql`:

```sql
-- Hand-authored: Prisma cannot express a partial unique index.
-- Why partial, why immediate, and why gaps stay legal: docs/data-model.md (WaitlistEntry).

DO $$
DECLARE
  affected INT;
BEGIN
  UPDATE "WaitlistEntry" w
     SET "position" = r.rn
    FROM (
      SELECT "id",
             (row_number() OVER (
               PARTITION BY "classId"
               ORDER BY "position", "createdAt", "id"
             ))::int AS rn
        FROM "WaitlistEntry"
       WHERE "status" = 'waiting'
    ) r
   WHERE w."id" = r."id"
     AND w."position" <> r.rn;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE NOTICE 'issue 183 remediation: renumbered % waiting WaitlistEntry row(s) to 1..n per class', affected;
  END IF;
END $$;

CREATE UNIQUE INDEX "WaitlistEntry_waiting_position_key"
  ON "WaitlistEntry" ("classId", "position")
  WHERE "status" = 'waiting';
```

Apply it to this worktree's dev database: `pnpm exec prisma migrate dev` (it applies the pending migration; the schema change in Step 4 is a docblock only, so it must report no new migration to create). The unit tiers apply it to the test database on their next run.

- [ ] **Step 4: Name the index in the schema**

In `prisma/schema.prisma`, directly above `model WaitlistEntry {`, add a `///` docblock in the shape of the `Room` one (`schema.prisma:291`):

```prisma
/// Carries a partial unique index Prisma cannot express and therefore cannot
/// show: `WaitlistEntry_waiting_position_key` on (classId, position) WHERE
/// status = 'waiting' (#183). Invisible to `migrate diff`, so it never appears
/// as drift. Why it is partial and immediate: docs/data-model.md (WaitlistEntry).
```

Then run `pnpm exec prisma validate` — expect success.

- [ ] **Step 5: Run C1/C2 and see them pass**

Run: `pnpm exec vitest run --project unit src/services/waitlist-position-index.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Write the migration test (M1)**

Create `src/services/waitlist-position-migration.test.ts`:

```ts
/**
 * @serial-tier lock-contention — drops `WaitlistEntry_waiting_position_key`
 * inside a transaction, which holds ACCESS EXCLUSIVE on `WaitlistEntry` until
 * the rollback, a table the parallel tier's waitlist tests write to.
 *
 * Runs the migration file's own two statements against a class seeded with a
 * duplicate and a gap — the state the index refuses, so it can only be seeded
 * with the index dropped — then rolls everything back, index drop included.
 */
import { it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

const MIGRATION = new URL(
  '../../prisma/migrations/20260916120000_waitlist_waiting_position_unique/migration.sql',
  import.meta.url,
);

function migrationStatements(): { renumber: string; createIndex: string } {
  const sql = readFileSync(MIGRATION, 'utf8');
  const renumber = sql.match(/DO \$\$[\s\S]*?END \$\$;/)?.[0];
  const createIndex = sql.match(/CREATE UNIQUE INDEX[\s\S]*?;/)?.[0];
  if (renumber === undefined || createIndex === undefined) {
    throw new Error('the migration no longer has the two statements this test executes');
  }
  return { renumber, createIndex: createIndex.replace(/;\s*$/, '') };
}

/** Carries the observations out of a transaction that must not commit. */
class Rollback extends Error {
  constructor(
    readonly rows: Array<{ label: string; position: number; status: string }>,
    readonly indexCount: number,
  ) {
    super('rollback');
  }
}

it('renumbers a duplicate and a gap to 1..n, then builds the index over the result', async () => {
  const suffix = `wl-mig-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Migration',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Waiting-position migration fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  const room = await prisma.room.create({
    data: {
      venueName: 'Migration Studio',
      address: `${suffix} St`,
      city: 'Amsterdam',
      postcode: '1234MG',
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
    classType: 'Migration class',
    date: new Date('2099-06-01'),
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 1,
    maxStudents: 1,
    status: 'open',
  });
  const labels = ['a', 'b', 'c', 'd'] as const;
  const ids: Record<(typeof labels)[number], string> = { a: '', b: '', c: '', d: '' };
  for (const label of labels) {
    ids[label] = (
      await prisma.student.create({
        data: { firstName: 'Migration', lastName: label, email: `${suffix}-${label}@test.local`, incomeTier: 3 },
        select: { id: true },
      })
    ).id;
  }
  const labelOf = new Map(labels.map((l) => [ids[l], l] as const));
  const { renumber, createIndex } = migrationStatements();
  const t0 = new Date('2099-01-01T00:00:00Z');
  const t1 = new Date('2099-01-01T00:00:01Z');

  // A box, not a `let`: an assignment inside the `.catch` callback below is
  // invisible to the compiler's narrowing of a local.
  const box: { observed?: Rollback } = {};
  try {
    await prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('DROP INDEX "WaitlistEntry_waiting_position_key"');
          // a and b share position 2 (a is older); c sits after a gap; d is
          // closed at 1 and must be left alone.
          const seed = [
            { label: 'a', position: 2, status: 'waiting', createdAt: t0 },
            { label: 'b', position: 2, status: 'waiting', createdAt: t1 },
            { label: 'c', position: 5, status: 'waiting', createdAt: t0 },
            { label: 'd', position: 1, status: 'removed', createdAt: t0 },
          ] as const;
          for (const row of seed) {
            await tx.waitlistEntry.create({
              data: {
                classId: cls.id,
                studentId: ids[row.label],
                position: row.position,
                status: row.status,
                createdAt: row.createdAt,
              },
            });
          }
          await tx.$executeRawUnsafe(renumber);
          await tx.$executeRawUnsafe(createIndex);
          const rows = await tx.waitlistEntry.findMany({
            where: { classId: cls.id },
            select: { studentId: true, position: true, status: true },
            orderBy: { studentId: 'asc' },
          });
          const [index] = await tx.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_indexes
             WHERE indexname = 'WaitlistEntry_waiting_position_key'`;
          throw new Rollback(
            rows.map((r) => ({ label: labelOf.get(r.studentId) ?? '?', position: r.position, status: r.status })),
            index?.n ?? 0,
          );
        },
        { timeout: 10_000 },
      )
      .catch((err: unknown) => {
        if (err instanceof Rollback) box.observed = err;
        else throw err;
      });

    const observed = box.observed;
    expect(observed).toBeDefined();
    const byLabel = Object.fromEntries(observed!.rows.map((r) => [r.label, r]));
    expect(byLabel).toEqual({
      a: { label: 'a', position: 1, status: 'waiting' },
      b: { label: 'b', position: 2, status: 'waiting' },
      c: { label: 'c', position: 3, status: 'waiting' },
      d: { label: 'd', position: 1, status: 'removed' },
    });
    expect(observed!.indexCount).toBe(1);

    // The rollback restored the index the transaction dropped.
    const [after] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_indexes
       WHERE indexname = 'WaitlistEntry_waiting_position_key'`;
    expect(after?.n).toBe(1);
  } finally {
    await prisma.calendarEntry.deleteMany({ where: { teacherId: teacher.id } });
    await prisma.student.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: teacher.id } });
    await prisma.room.deleteMany({ where: { id: room.id } });
    await prisma.teacher.deleteMany({ where: { id: teacher.id } });
    await prisma.account.deleteMany({ where: { id: teacher.accountId } });
  }
});
```

Add the file to `LOCK_CONTENTION_TESTS` in `vitest.tiers.ts`, after `'src/services/template-room-race.test.ts'`, with a one-line comment in that list's existing style:

```ts
  // #183: drops and restores an index inside a transaction — the
  // `class-lifecycle-tier-guard.test.ts` shape; its header carries the reason.
  'src/services/waitlist-position-migration.test.ts',
```

- [ ] **Step 7: Run M1 and the tier-membership check**

Run: `pnpm exec vitest run --project unit-sweeps src/services/waitlist-position-migration.test.ts`
Expected: 1 passed.
Run: `pnpm exec vitest run --project unit src/lib/serial-tier-membership.test.ts src/lib/migration-remediation-trace.test.ts`
Expected: all pass (the marker matches the list; the migration carries a live `RAISE NOTICE`).

- [ ] **Step 8: Update the "(#183)" citations and `docs/data-model.md`**

- `src/lib/waitlist-status.ts:41`, `src/services/waitlist.ts:1165-1168` (`closeQueueOnStart` docblock) and `src/services/gdpr.ts:449-453`: each says closed rows keep stale positions "by design (#183)". Keep the fact; replace the issue citation with the thing that now encodes it — the index is partial on `status = 'waiting'`, named `WaitlistEntry_waiting_position_key` — without restating the reasoning (that is `docs/data-model.md`'s).
- `docs/data-model.md`, under `### WaitlistEntry (overflow)`: add a paragraph covering: the index and its predicate; that it is immediate, not deferred, and why (every class-locked writer renumbers downward or appends at max+1, so no transient duplicate exists — `reorderWaitingEntries` ascending: the i-th of distinct positive positions is ≥ i); that a deferrable partial `EXCLUDE USING btree … WHERE … DEFERRABLE` is accepted by Postgres 16 and was not needed; that a partial unique index cannot be promoted to a constraint and so can never be deferred; that gaps are legal (a gap preserves promotion order; gap-freedom is cross-row and no constraint expresses it); that the migration renumbers existing waiting rows by `(position, createdAt, id)` first and announces the count; and the spike's evidence: with an equivalent index applied by hand, 2095 unit + 711 integration = 2806 database-backed tests passed with zero violations, and a mutation forcing `nextPosition = 1` in `addToWaitlist` failed 5 tests with `P2002`.

- [ ] **Step 9: Commit**

```bash
git add prisma/migrations/20260916120000_waitlist_waiting_position_unique/migration.sql prisma/schema.prisma src/services/waitlist-position-index.test.ts src/services/waitlist-position-migration.test.ts vitest.tiers.ts docs/data-model.md src/lib/waitlist-status.ts src/services/waitlist.ts src/services/gdpr.ts
git commit -m "feat(waitlist): a partial unique index on waiting positions, with a renumbering migration (#183)"
```

- [ ] **Step 10: Prove it bites (mutation protocol)**

Run the SQL below with `psql` inside the `fairyoga-db-1` container (user `yoga`) against this worktree's TEST database (the database name in `.env`'s `DATABASE_URL_TEST`), then restore it exactly as shown.

1. C1: `DROP INDEX "WaitlistEntry_waiting_position_key";` → run `waitlist-position-index.test.ts` → the first test must fail. Restore: re-run the migration's `CREATE UNIQUE INDEX` statement verbatim.
2. C2: `DROP INDEX "WaitlistEntry_waiting_position_key"; CREATE UNIQUE INDEX "WaitlistEntry_waiting_position_key" ON "WaitlistEntry" ("classId", "position");` (non-partial) → run → at least one "accepts…" test must fail. (If the non-partial index cannot be created because leftover closed rows collide, record that and use a fresh run of the test file's own fixture instead.) Restore: drop it and re-run the migration's statement verbatim.
3. M1, renumber ordering: in the committed migration file, change `ORDER BY "position", "createdAt", "id"` to `ORDER BY "position", "createdAt" DESC, "id"` → run M1 → must fail (`a`/`b` swap). Restore with `git checkout -- <migration.sql>`. **Do not run `prisma migrate dev` while the file is mutated.**
4. M1, renumber removed: in the migration file, delete the whole `DO $$ … END $$;` block → M1 must throw its "no longer has the two statements" error. Restore with `git checkout`.
5. After all restores: `git status` clean; confirm with `pg_indexes` that the test database has exactly one `WaitlistEntry_waiting_position_key`, partial; re-run both test files green.

---

### Task 2: The `Student` lock helpers

**Files:**
- Modify: `src/lib/db-locks.ts` (header brand register ~lines 16-66; new export after `lockClassRow`, ~line 285)
- Modify: `src/lib/db-locks.test.ts`
- Modify: `src/lib/db-locks-lock-order.test.ts`
- Modify: `docs/lock-order.md` (`### Every site that bounds a lock wait`, ~line 847)

**Interfaces:**
- Consumes: `setLockTimeout`, `TransactionClientOnly` (same module).
- Produces:
  - `export class StudentErasedError extends Error { readonly studentId: string }`
  - `export async function lockStudentForErasure(tx: TransactionClientOnly, studentId: string): Promise<void>` — `SET LOCAL lock_timeout`, then `SELECT id FROM "Student" WHERE id = $1 FOR NO KEY UPDATE`.
  - `export async function lockLiveStudent(tx: TransactionClientOnly, studentId: string): Promise<void>` — `SET LOCAL lock_timeout`, then `SELECT "deletedAt" FROM "Student" WHERE id = $1 FOR SHARE`; throws `StudentErasedError` when no row comes back or `deletedAt` is non-null.

- [ ] **Step 1: Write the helper tests (parallel tier)**

In `src/lib/db-locks.test.ts`:

(a) add `lockLiveStudent`, `lockStudentForErasure`, `StudentErasedError` to the `./db-locks` import;

(b) append to `_theBrandRejectsABareClient`:

```ts
  // @ts-expect-error `SET LOCAL` then `FOR NO KEY UPDATE` on `Student` (#183).
  await lockStudentForErasure(client, 'never-called');
  // @ts-expect-error `SET LOCAL` then `FOR SHARE` on `Student` (#183).
  await lockLiveStudent(client, 'never-called');
```

(c) inside `describe('the shared lock timeout', …)`, add:

```ts
  it('is in force after lockStudentForErasure, which sets it itself', async () => {
    const observed = await prisma.$transaction(async (tx) => {
      await lockStudentForErasure(tx, '00000000-0000-4000-8000-000000000000');
      const rows = await tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;
      return rows[0]?.lock_timeout;
    });

    expect(observed).toBe('2s');
  });

  it('is in force after lockLiveStudent, which sets it itself', async () => {
    const observed = await prisma.$transaction(async (tx) => {
      await lockLiveStudent(tx, '00000000-0000-4000-8000-000000000000').catch((err: unknown) => {
        if (!(err instanceof StudentErasedError)) throw err;
      });
      const rows = await tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;
      return rows[0]?.lock_timeout;
    });

    expect(observed).toBe('2s');
  });
```

(d) add a new describe at the end of the file:

```ts
describe('lockLiveStudent', () => {
  const suffix = `live-student-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let liveId: string;
  let erasedId: string;

  beforeAll(async () => {
    liveId = (
      await prisma.student.create({
        data: { firstName: 'Live', lastName: 'Student', email: `${suffix}-live@test.local`, incomeTier: 3 },
        select: { id: true },
      })
    ).id;
    erasedId = (
      await prisma.student.create({
        data: { firstName: 'Erased', lastName: 'Student', email: `${suffix}-erased@test.local`, incomeTier: 3 },
        select: { id: true },
      })
    ).id;
    await prisma.student.update({ where: { id: erasedId }, data: { deletedAt: new Date() } });
  });

  afterAll(async () => {
    await prisma.student.deleteMany({ where: { id: { in: [liveId, erasedId] } } });
  });

  it('returns for a live student', async () => {
    await expect(prisma.$transaction((tx) => lockLiveStudent(tx, liveId))).resolves.toBeUndefined();
  });

  it('throws StudentErasedError for an erased student', async () => {
    const err = await prisma.$transaction((tx) => lockLiveStudent(tx, erasedId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudentErasedError);
    expect((err as StudentErasedError).studentId).toBe(erasedId);
  });

  it('throws StudentErasedError for an id with no row', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(prisma.$transaction((tx) => lockLiveStudent(tx, missing))).rejects.toBeInstanceOf(
      StudentErasedError,
    );
  });
});
```

- [ ] **Step 2: Write the lock-mode tests (serial tier, L1–L3)**

In `src/lib/db-locks-lock-order.test.ts`, add `lockLiveStudent, lockStudentForErasure` to the `./db-locks` import and append:

```ts
/**
 * The two halves of the `Student` gate (#183) must conflict with each other,
 * and the erasure's half must NOT conflict with the `FOR KEY SHARE` a child-row
 * insert takes on its `Student` parent. Why each mode: `docs/lock-order.md`
 * ("The `Student` row is the erasure's gate").
 */
describe('the Student gate: lock modes (#183)', () => {
  const suffix = `student-gate-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let studentId: string;
  let teacherId: string;
  let accountId: string;

  beforeAll(async () => {
    studentId = (
      await prisma.student.create({
        data: { firstName: 'Gate', lastName: 'Student', email: `${suffix}-student@test.local`, incomeTier: 3 },
        select: { id: true },
      })
    ).id;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gate',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Student-gate mode fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
  });

  afterAll(async () => {
    await prisma.teacherStudent.deleteMany({ where: { studentId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
  });

  /**
   * Opens a transaction that takes `lock`, then holds it until `release` is
   * called. `done` flips just before the holder's COMMIT, so a waiter that
   * reads it after its own wait ended sees `true` only if it really waited.
   */
  function hold(lock: (tx: Prisma.TransactionClient) => Promise<void>) {
    let release!: () => void;
    let held!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const isHeld = new Promise<void>((r) => { held = r; });
    const state = { done: false };
    const finished = prisma.$transaction(
      async (tx) => {
        await lock(tx);
        held();
        await released;
        state.done = true;
      },
      { timeout: 10_000 },
    );
    return { release, isHeld, state, finished };
  }

  it('makes lockLiveStudent wait for lockStudentForErasure (L1)', async () => {
    const h = hold((tx) => lockStudentForErasure(tx, studentId));
    await h.isHeld;
    const waited = prisma.$transaction(async (tx) => {
      await lockLiveStudent(tx, studentId);
      return h.state.done;
    });
    try {
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      h.release();
    }
    const [, sawCommit] = await Promise.all([h.finished, waited]);
    expect(sawCommit).toBe(true);
  });

  it('lets a child-row insert through while lockStudentForErasure is held (L2)', async () => {
    const h = hold((tx) => lockStudentForErasure(tx, studentId));
    await h.isHeld;
    // A safety release, so a blocked insert (the defect) cannot hang the test:
    // it then lands after the holder commits and reports `false` below.
    const safety = setTimeout(h.release, 1_000);
    let insertedWhileHeld = false;
    try {
      insertedWhileHeld = await prisma.teacherStudent
        .create({ data: { teacherId, studentId } })
        .then(() => !h.state.done);
    } finally {
      clearTimeout(safety);
      h.release();
      await h.finished;
    }
    expect(insertedWhileHeld).toBe(true);
  });

  it('makes lockStudentForErasure wait for lockLiveStudent (L3)', async () => {
    const h = hold((tx) => lockLiveStudent(tx, studentId));
    await h.isHeld;
    const waited = prisma.$transaction(async (tx) => {
      await lockStudentForErasure(tx, studentId);
      return h.state.done;
    });
    try {
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      h.release();
    }
    const [, sawCommit] = await Promise.all([h.finished, waited]);
    expect(sawCommit).toBe(true);
  });
});
```

The `hold` helper passes a `Prisma.TransactionClient` to helpers typed `TransactionClientOnly`; the interactive-transaction callback's `tx` already satisfies that brand everywhere else in this file, so type the parameter the same way the rest of the file does if the compiler asks for it.

- [ ] **Step 3: Run both files and see them fail**

Run: `pnpm exec vitest run --project unit src/lib/db-locks.test.ts`
Run: `pnpm exec vitest run --project unit-sweeps src/lib/db-locks-lock-order.test.ts`
Expected: FAIL — `lockStudentForErasure`/`lockLiveStudent`/`StudentErasedError` are not exported. `pnpm run typecheck` fails the same way.

- [ ] **Step 4: Implement the helpers**

In `src/lib/db-locks.ts`, after `lockClassRow`:

```ts
/**
 * Thrown by `lockLiveStudent` when the student it was asked to lock is not
 * live: the row is erased (`deletedAt` set) or absent.
 */
export class StudentErasedError extends Error {
  constructor(readonly studentId: string) {
    super(`student ${studentId} is erased`);
    this.name = 'StudentErasedError';
  }
}

/**
 * The erasure's half of the `Student` gate (#183): the student's row
 * `FOR NO KEY UPDATE`, with the shared bounded wait.
 *
 * Conflicts with `lockLiveStudent`'s `FOR SHARE` below, which is the gate. Does
 * not conflict with the `FOR KEY SHARE` a child-row insert takes on its parent —
 * the reason the mode is this one and not `FOR UPDATE` is
 * `docs/lock-order.md`, "The `Student` row is the erasure's gate".
 */
export async function lockStudentForErasure(
  tx: TransactionClientOnly,
  studentId: string,
): Promise<void> {
  await setLockTimeout(tx);
  await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${studentId} FOR NO KEY UPDATE`;
}

/**
 * The writer's half of the `Student` gate (#183): the student's row
 * `FOR SHARE`, with the shared bounded wait, and a `StudentErasedError` unless
 * the row exists and is not erased.
 *
 * The read happens under the lock, so a caller that waited behind
 * `lockStudentForErasure` sees that erasure's committed `deletedAt`. Take it
 * before the transaction's first `Class` lock — the order is
 * `docs/lock-order.md`'s.
 */
export async function lockLiveStudent(
  tx: TransactionClientOnly,
  studentId: string,
): Promise<void> {
  await setLockTimeout(tx);
  const rows = await tx.$queryRaw<Array<{ deletedAt: Date | null }>>`
    SELECT "deletedAt" FROM "Student" WHERE id = ${studentId} FOR SHARE`;
  const row = rows[0];
  if (row === undefined || row.deletedAt !== null) throw new StudentErasedError(studentId);
}
```

In the header brand register, add an `adopt` entry in the existing style:

```
 *   adopt  `lockStudentForErasure` and `lockLiveStudent` below — each issues
 *          `SET LOCAL` and then a row lock on `Student` (#183).
```

- [ ] **Step 5: Run the tests and typecheck**

Run the two test commands from Step 3, then `pnpm run typecheck`.
Expected: all pass.

- [ ] **Step 6: Re-derive the lock-wait census**

Run the command in `docs/lock-order.md`'s `### Every site that bounds a lock wait`:

```bash
grep -rn 'setLockTimeout\|LOCK_TIMEOUT_SQL' src/ --include='*.ts' \
  | grep -v "\.test\.ts:" \
  | grep -vE ":[0-9]+: *(\*|//)" \
  | grep -vE ":[0-9]+:import "
```

Before this task it returned 16 lines (the section still records 14 from 2026-08-29); after it, expect 18 = 16 + the two `await setLockTimeout(tx);` lines the new helpers add in `db-locks.ts`. Two of the 18 are not transactions arming the bound but members of multi-line `import { … }` blocks (`gdpr.ts`'s and `class-template-lifecycle.ts`'s `  setLockTimeout,` lines), which the `import ` filter cannot drop. Update the section's figure paragraph to the re-derived number with today's date and `#183`, name the files the list now spans, and state the multi-line-import caveat. Verify the arithmetic against the actual output — do not copy these numbers if the command disagrees.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db-locks.ts src/lib/db-locks.test.ts src/lib/db-locks-lock-order.test.ts docs/lock-order.md
git commit -m "feat(db-locks): the two halves of a Student-row gate for erasure (#183)"
```

- [ ] **Step 8: Prove it bites (mutation protocol)**

1. `lockLiveStudent`: `FOR SHARE` → `FOR KEY SHARE`. Run `db-locks-lock-order.test.ts`: L1 and L3 must fail (`expected false to be true`).
2. `lockStudentForErasure`: `FOR NO KEY UPDATE` → `FOR UPDATE`. Run it: L2 must fail.
3. `lockLiveStudent`: drop the `row.deletedAt !== null` disjunct. Run `db-locks.test.ts`: "throws StudentErasedError for an erased student" must fail.
4. `lockStudentForErasure`: delete its `await setLockTimeout(tx);`. Run `db-locks.test.ts`: its `SHOW lock_timeout` test must fail.

Record each failure's text; restore; re-run green.

---

### Task 3: The erasure takes the `Student` row first and deletes only what it locked

**Depends on Task 2.** Must land before Task 4 (see the order note at the top).

**Files:**
- Modify: `src/services/gdpr.ts` (`AlreadyErasedError` docblock ~299-313; new `ErasureLockSetError`; `deleteStudentAccount` ~334-725)
- Modify: `src/services/gdpr-lock-order.test.ts`

**Interfaces:**
- Consumes: `lockStudentForErasure` (Task 2); `lockClassRowsOrdered` returns `Promise<string[]>` (the locked ids, ascending, deduped).
- Produces: `export class ErasureLockSetError extends Error { readonly studentId: string; readonly strays: number }`, thrown from inside `deleteStudentAccount`'s transaction. Also, in `gdpr-lock-order.test.ts`, a describe `'the erasure takes the Student row before any Class row (#183)'` with helpers `makeQueue()`, `cleanupQueue(fx)` and `waitUntilBlockedBy(pid)` that Task 4 adds tests to.

- [ ] **Step 1: Write the failing tests**

In `src/services/gdpr-lock-order.test.ts`: add `ErasureLockSetError` to the `./gdpr` import, add `import { promoteNext } from './waitlist';`, and append:

```ts
describe('the erasure takes the Student row before any Class row (#183)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * One teacher, two open 2099 classes of one seat each, nobody registered.
   * `classId`: the subject waits at 1 and a second student at 2.
   * `otherClassId`: full (a filler holds its seat), the subject holds nothing
   * in it — the class a late entry can appear in.
   */
  async function makeQueue() {
    const suffix = `gdpr-gate-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gate',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Student-gate fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    const room = await prisma.room.create({
      data: {
        venueName: 'Gate Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234GT',
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
    const makeClass = async (date: string) =>
      (
        await createClassFixture(prisma, {
          teacherId: teacher.id,
          teacherRoomId: teacherRoom.id,
          classType: 'Gate class',
          date: new Date(date),
          startTime: hhmmToTime('09:00'),
          durationMinutes: 60,
          roomCost: 20,
          minRate: 15,
          targetRate: 25,
          minStudents: 1,
          maxStudents: 1,
          status: 'open',
        })
      ).id;
    const classId = await makeClass('2099-06-01');
    const otherClassId = await makeClass('2099-06-02');
    const makeStudent = async (label: string) =>
      (
        await prisma.student.create({
          data: { firstName: 'Gate', lastName: label, email: `${suffix}-${label}@test.local`, incomeTier: 2 },
          select: { id: true },
        })
      ).id;
    const studentId = await makeStudent('subject');
    const waiterId = await makeStudent('waiter');
    const fillerId = await makeStudent('filler');
    await prisma.waitlistEntry.create({ data: { classId, studentId, position: 1, status: 'waiting' } });
    await prisma.waitlistEntry.create({
      data: { classId, studentId: waiterId, position: 2, status: 'waiting' },
    });
    await prisma.registration.create({
      data: { classId: otherClassId, studentId: fillerId, status: 'registered', tierAtBooking: 2 },
    });
    return {
      teacherId: teacher.id,
      accountId: teacher.accountId,
      roomId: room.id,
      classId,
      otherClassId,
      studentId,
      waiterId,
      extraStudentIds: [fillerId],
    };
  }

  type Queue = Awaited<ReturnType<typeof makeQueue>>;

  async function cleanupQueue(fx: Queue): Promise<void> {
    const students = [fx.studentId, fx.waiterId, ...fx.extraStudentIds];
    await prisma.notification.deleteMany({ where: { recipientId: { in: [...students, fx.teacherId] } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId: fx.teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: fx.teacherId } });
    await prisma.room.deleteMany({ where: { id: fx.roomId } });
    await prisma.student.deleteMany({ where: { id: { in: students } } });
    await prisma.teacher.deleteMany({ where: { id: fx.teacherId } });
    await prisma.account.deleteMany({ where: { id: fx.accountId } });
  }

  /**
   * Resolves once some backend is waiting on a lock `holderPid` holds — the
   * `template-room-race.test.ts` probe. Bounded well inside the 2s
   * `lock_timeout` the waiter is running under.
   */
  async function waitUntilBlockedBy(holderPid: number): Promise<void> {
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
      if ((row?.n ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`nothing waited behind backend ${holderPid} within 1500ms`);
  }

  const ownPid = async (tx: Prisma.TransactionClient): Promise<number> => {
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
    return row!.pid;
  };

  // Shape shared by every staged test below: an OUTER try/finally that always
  // reaps the fixture, and an INNER finally that releases the stall and joins
  // every racer (each racer is turned into a value, so the join never throws
  // on its own and a staging failure still leaves nothing running).

  it('waits for a holder of the student row before it locks any class', async () => {
    const fx = await makeQueue();
    try {
      let holderPid = 0;
      let parked!: () => void;
      const isParked = new Promise<void>((r) => { parked = r; });
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      let holderReleased = false;
      const holder = prisma.$transaction(
        async (tx) => {
          holderPid = await ownPid(tx);
          await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${fx.studentId} FOR SHARE`;
          parked();
          await released;
          holderReleased = true;
        },
        { timeout: 10_000 },
      );

      let preLockSawRelease: boolean | undefined;
      const original = dbLocks.lockClassRowsOrdered;
      const spy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
        if (source.join === dbLocks.CLASS_TO_WAITLIST_JOIN && preLockSawRelease === undefined) {
          preLockSawRelease = holderReleased;
        }
        return original(tx, source);
      });
      onTestFinished(() => spy.mockRestore());

      let erasing: Promise<'erased' | { error: string }> | undefined;
      try {
        await awaitHandshake(isParked, 'Student FOR SHARE holder');
        erasing = deleteStudentAccount(prisma, fx.studentId).then(
          () => 'erased' as const,
          (err: unknown) => ({ error: String(err) }),
        );
        await waitUntilBlockedBy(holderPid);
      } finally {
        release();
        await Promise.all([holder, erasing]);
      }

      expect(await erasing).toBe('erased');
      // The discriminating half: the pre-lock ran only after the holder
      // committed, so the erasure waited at its `Student` lock — not merely at
      // its closing `UPDATE`, which would also conflict with this holder.
      expect(preLockSawRelease).toBe(true);
    } finally {
      await cleanupQueue(fx);
    }
  }, 20_000);

  it('refuses to commit when an entry for the student appears outside its lock set', async () => {
    const fx = await makeQueue();
    try {
      let reached!: () => void;
      const atPreLock = new Promise<void>((r) => { reached = r; });
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const original = dbLocks.lockClassRowsOrdered;
      const spy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
        const ids = await original(tx, source);
        if (source.join === dbLocks.CLASS_TO_WAITLIST_JOIN) {
          reached();
          await held;
        }
        return ids;
      });
      onTestFinished(() => spy.mockRestore());

      const erasing = deleteStudentAccount(prisma, fx.studentId).then(
        () => 'erased' as const,
        (err: unknown) => err,
      );
      try {
        await awaitHandshake(atPreLock, 'student erasure pre-lock');
        // Bypasses the join's gate on purpose — this is the writer the count
        // exists to catch. Its `FOR KEY SHARE` on `Student` passes the
        // erasure's `FOR NO KEY UPDATE`, and nobody holds `otherClassId`.
        await prisma.waitlistEntry.create({
          data: { classId: fx.otherClassId, studentId: fx.studentId, position: 1, status: 'waiting' },
        });
      } finally {
        release();
        await erasing;
      }

      expect(await erasing).toBeInstanceOf(ErasureLockSetError);
      const student = await prisma.student.findUniqueOrThrow({ where: { id: fx.studentId } });
      expect(student.deletedAt).toBeNull();
      expect(await prisma.waitlistEntry.count({ where: { studentId: fx.studentId } })).toBe(2);
    } finally {
      await cleanupQueue(fx);
    }
  }, 20_000);

  it('lets a promotion of the student finish while it waits, then passes the freed seat on', async () => {
    const fx = await makeQueue();
    try {
      let promoterPid = 0;
      let holding!: () => void;
      const promoterHolds = new Promise<void>((r) => { holding = r; });
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      let stalled = false;
      const original = dbLocks.lockClassRow;
      const spy = vi.spyOn(dbLocks, 'lockClassRow').mockImplementation(async (tx, classId) => {
        await original(tx, classId);
        if (classId === fx.classId && !stalled) {
          stalled = true;
          promoterPid = await ownPid(tx);
          holding();
          await released;
        }
      });
      onTestFinished(() => spy.mockRestore());

      const promoting = promoteNext(prisma, fx.classId).then(
        (entry) => ({ promoted: entry?.studentId ?? null }),
        (err: unknown) => ({ error: String(err) }),
      );
      let erasing: Promise<'erased' | { error: string }> | undefined;
      try {
        await awaitHandshake(promoterHolds, 'promoteNext class lock');
        erasing = deleteStudentAccount(prisma, fx.studentId).then(
          () => 'erased' as const,
          (err: unknown) => ({ error: String(err) }),
        );
        // The erasure holds the subject's row and waits on the class the
        // promoter holds. Released promptly: the cycle a wrong lock mode
        // closes is detected at `deadlock_timeout` (1s), which must beat the
        // 2s `lock_timeout` for the mutation below to read as `40P01`.
        await waitUntilBlockedBy(promoterPid);
      } finally {
        release();
        await Promise.all([promoting, erasing]);
      }

      const [promoteOutcome, eraseOutcome] = await Promise.all([promoting, erasing]);
      for (const [label, outcome] of [
        ['promoteNext', promoteOutcome],
        ['erasure', eraseOutcome],
      ] as const) {
        if (typeof outcome === 'object' && outcome !== null && 'error' in outcome) {
          expect(`${label}: ${outcome.error}`).not.toMatch(/40P01|deadlock detected/);
          expect(`${label}: ${outcome.error}`).not.toMatch(/55P03|lock timeout/);
          throw new Error(`${label} rejected unexpectedly: ${outcome.error}`);
        }
      }
      expect(promoteOutcome).toEqual({ promoted: fx.studentId });
      expect(eraseOutcome).toBe('erased');

      // The erasure cancelled the seat the promotion had just given the
      // subject, and — having read its registrations under the class lock —
      // handed it to the next in line.
      const subject = await prisma.registration.findUniqueOrThrow({
        where: { classId_studentId: { classId: fx.classId, studentId: fx.studentId } },
      });
      expect(subject.status).toBe('cancelled');
      const waiter = await prisma.registration.findUnique({
        where: { classId_studentId: { classId: fx.classId, studentId: fx.waiterId } },
      });
      expect(waiter?.status).toBe('registered');
    } finally {
      await cleanupQueue(fx);
    }
  }, 20_000);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts -t "before any Class row"`
Expected: compile/import failure on `ErasureLockSetError`; once that is stubbed, "waits for a holder" fails on `preLockSawRelease` (`false`), "refuses to commit" fails (`'erased'`), and "lets a promotion…" fails on the waiter's registration (`undefined`).

- [ ] **Step 3: Implement**

In `src/services/gdpr.ts`:

1. Add `lockStudentForErasure` to the `@/lib/db-locks` import.

2. After `AlreadyErasedError`, add:

```ts
/**
 * Thrown when `deleteStudentAccount` finds a `WaitlistEntry` for its subject in
 * a class its ordered pre-lock did not lock. The transaction aborts whole, so
 * nothing is erased; a retry's pre-lock covers the class that appeared. Why no
 * writer should be able to cause it: `docs/lock-order.md`, "The `Student` row
 * is the erasure's gate".
 */
export class ErasureLockSetError extends Error {
  constructor(
    readonly studentId: string,
    readonly strays: number,
  ) {
    super(`student ${studentId} holds ${strays} waitlist entries outside the erasure's lock set`);
    this.name = 'ErasureLockSetError';
  }
}
```

3. Rewrite `AlreadyErasedError`'s docblock paragraph that says the throw prevents a second `spot_available` broadcast and cites the concurrent-erasure test for it. What is true now: a second concurrent erasure waits at `lockStudentForErasure` until the first commits, so it reads an empty `upcoming` and has nothing to broadcast — the `Student` lock prevents the doubled broadcast. The throw is what stops that second, redundant transaction committing, and what `DELETE /api/account` answers with the same 200. Name the test ("erases once when the same student erasure runs twice concurrently") as pinning the throw through its rejection-count assertion.

4. In `deleteStudentAccount`'s transaction, the new statement order (keep `setLockTimeout` first and its comment as is):

```ts
    await setLockTimeout(tx);

    // The `Student` row first, before any `Class` row (#183). A waitlist join
    // takes the other half of this gate before its own class lock, so from
    // here on no entry for this student can be created that the pre-lock
    // below does not see. Mode and order: `docs/lock-order.md`, "The `Student`
    // row is the erasure's gate".
    await lockStudentForErasure(tx, studentId);

    // …the existing long comment block for the pre-lock, corrected per step 5,
    // ending with the unchanged `VERDICT (#327)` paragraph IMMEDIATELY above:
    const lockedClassIds = await lockClassRowsOrdered(tx, {
      join: CLASS_TO_WAITLIST_JOIN,
      where: Prisma.sql`w."studentId" = ${studentId}`,
    });

    // …the existing `upcoming` comment, moved here, plus one sentence: read
    // under the class locks, so a promotion of this student that committed
    // while the pre-lock waited is in it (#367's lock-then-read shape).
    const upcoming = await tx.registration.findMany({ /* unchanged */ });

    const waitingClassIds = (
      await tx.waitlistEntry.findMany({
        where: { studentId, status: 'waiting', classId: { in: lockedClassIds } },
        select: { classId: true },
      })
    ).map((w) => w.classId);
```

and, replacing the unscoped delete:

```ts
    await tx.waitlistEntry.deleteMany({ where: { studentId, classId: { in: lockedClassIds } } });
    // Refuses to commit rather than write outside the lock set. Unreachable
    // while every creator of entries takes `lockLiveStudent`; if one stops, the
    // erasure fails whole instead of deleting an entry whose class it never
    // held (`ErasureLockSetError`).
    const strays = await tx.waitlistEntry.count({ where: { studentId } });
    if (strays > 0) throw new ErasureLockSetError(studentId, strays);
```

The `VERDICT (#327)` comment must stay directly above the `lockClassRowsOrdered` statement (`db-locks-verdict-census.test.ts` pairs them); put nothing but comments between them.

5. Correct the comments this change falsifies inside `deleteStudentAccount` — read every comment block in the function in full; a grep finds names, not descriptions. Known ones:
   - The pre-lock block (~386-435): "because the delete below is `deleteMany({ where: { studentId } })` — every entry, unscoped" and "EVERY status, matching the unscoped `deleteMany` below" — the delete is now scoped to the locked classes, still unscoped by status; the `Student` lock above is what guarantees the lock set contains every entry. "the lock taken BY the statement that chooses the rows, so there is no window between choosing them and holding them" — true for the rows that statement returns; entries that did not yet exist are the `Student` lock's job. Say that.
   - The `waitingClassIds` comment (~449-453): it is now restricted to `lockedClassIds` by its own predicate; the "(#183)" citation was replaced in Task 1.
   - The reorder loop comment (~683-687): the classes are held because the list is restricted to `lockedClassIds`, not by coincidence of two reads.
   - The budget comment's statement-cost inventory (~800-810): "`waitlistEntry.findMany`/`deleteMany` … key on `studentId` alone" is no longer true of those two (both also filter `classId IN (…)`); the new `count` does key on `studentId` alone. Correct the inventory to the statements as they now are, and do not claim any of them is index-backed without measuring it.

6. In the same test file, correct the comments this change falsifies:
   - `:760-762` (the #174 test's `$executeRawUnsafe` hook): `setLockTimeout` is now issued three times per student erasure (its own call, `lockStudentForErasure`'s, `lockClassRowsOrdered`'s). Re-read the hook's assertions to confirm none counts the firings; if one does, it is a failing test to fix, not a comment.
   - "erases once when the same student erasure runs twice concurrently" (`:1863-1868` and the lever paragraph above them): both erasures now park at `lockStudentForErasure` behind the holder's `FOR UPDATE`, and the loser reads `upcoming` only after the winner commits — so it is empty. State what the test now pins: the rejection-count/`AlreadyErasedError` assertions pin the abort; the notification assertion stays green if EITHER the abort or the `Student` lock is removed alone, and fails only if both go. Keep the 700ms/lever-asserted structure; rewrite the prose to the new mechanism.

- [ ] **Step 4: Run the file and see it pass**

Run: `pnpm exec vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts`
Run: `pnpm exec vitest run --project unit src/services/gdpr.test.ts src/lib/db-locks-verdict-census.test.ts`
Run: `pnpm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/gdpr.ts src/services/gdpr-lock-order.test.ts
git commit -m "fix(gdpr): take the Student row first and delete only the waitlist entries the erasure locked (#183)"
```

- [ ] **Step 6: Prove it bites (mutation protocol)**

In `src/services/gdpr.ts`, one at a time:
1. Delete the `await lockStudentForErasure(tx, studentId);` line → "waits for a holder…" must fail on `preLockSawRelease`.
2. Replace `lockStudentForErasure`'s SQL in `src/lib/db-locks.ts` with `FOR UPDATE` → "lets a promotion…" must fail with a message matching `40P01|deadlock detected`. (If it reads `55P03` instead, the release came too late — shorten nothing else; report it.)
3. Move the `upcoming` read back to directly after `lockStudentForErasure` (before the pre-lock) → "lets a promotion…" must fail on the waiter's registration (`undefined`).
4. Delete the `strays` count and its `throw` → "refuses to commit…" must fail (`'erased'`).
5. Restore the count, and change the delete back to `{ where: { studentId } }` → "refuses to commit…" must fail.
6. Delete the `throw new AlreadyErasedError('student')` line → "erases once when the same student erasure runs twice concurrently" must fail on its rejection count. Separately, with the throw in place, delete the `lockStudentForErasure` line → that test must stay green (record it — it is the division of labour step 3.6 documents).

Record each failure's text; restore; re-run green.

---

### Task 4: `addToWaitlist` takes the gate

**Depends on Tasks 2 and 3.** The controller files the two follow-up issues first and passes their numbers in as `FOLLOWUP_BOOKING` and `FOLLOWUP_LINKS`.

**Files:**
- Modify: `src/services/waitlist.ts` (`WaitlistJoinError` ~56-64; `addToWaitlist` docblock and body ~189-337; `removeFromWaitlist` docblock ~340-380, re-read only)
- Modify: `src/services/waitlist.test.ts`
- Modify: `src/services/gdpr-lock-order.test.ts` (the describe Task 3 added)
- Modify: `docs/lock-order.md`
- Modify: `docs/data-model.md`
- Modify: `src/services/class-transitions.ts` (~379-397 and ~514-516)

**Interfaces:**
- Consumes: `lockLiveStudent`, `StudentErasedError` (Task 2); the Task 3 describe's `makeQueue`, `cleanupQueue`, `waitUntilBlockedBy`, `ownPid`.
- Produces: `WaitlistJoinError.reason` gains `'student_erased'` (message `'This account has been deleted'`). `POST /api/waitlist` already answers every `WaitlistJoinError` with 409 and needs no change.

- [ ] **Step 1: Write the failing tests**

(a) `src/services/waitlist.test.ts` — a new, self-contained describe at the end of the file (the existing `addToWaitlist` describe is order-dependent; do not add to it):

```ts
describe('addToWaitlist refuses an erased student (#183)', () => {
  const suffix = `waitlist-erased-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let classId: string;
  const studentIds: string[] = [];
  let erasedId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Erased',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Erased-join fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    const room = await prisma.room.create({
      data: {
        venueName: 'Erased Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234ER',
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
    classId = (
      await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Hatha',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 1,
        status: 'open',
      })
    ).id;
    const filler = await prisma.student.create({
      data: { firstName: 'Filler', lastName: 'Test', email: `${suffix}-filler@test.local`, incomeTier: 3 },
      select: { id: true },
    });
    studentIds.push(filler.id);
    await prisma.registration.create({
      data: { classId, studentId: filler.id, status: 'registered', tierAtBooking: 3 },
    });
    const erased = await prisma.student.create({
      data: { firstName: 'Erased', lastName: 'Test', email: `${suffix}-erased@test.local`, incomeTier: 3 },
      select: { id: true },
    });
    erasedId = erased.id;
    studentIds.push(erasedId);
    await prisma.student.update({ where: { id: erasedId }, data: { deletedAt: new Date() } });
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
  });

  it('refuses the join and writes neither an entry nor a roster link', async () => {
    await expect(addToWaitlist(prisma, classId, erasedId)).rejects.toMatchObject({
      reason: 'student_erased',
    });
    expect(await prisma.waitlistEntry.count({ where: { studentId: erasedId } })).toBe(0);
    expect(await prisma.teacherStudent.count({ where: { studentId: erasedId } })).toBe(0);
  });
});
```

(b) `src/services/gdpr-lock-order.test.ts` — add `import { addToWaitlist, WaitlistJoinError } from './waitlist';` (extend the Task 3 import) and two tests inside the `'the erasure takes the Student row before any Class row (#183)'` describe:

```ts
  it('refuses a rejoin that waits behind it, and leaves nothing of the join behind', async () => {
    const fx = await makeQueue();
    try {
      // A REJOIN: the subject already holds a closed entry in `otherClassId`,
      // so that class is in the erasure's lock set. That is what makes the
      // join's gate-before-class order observable — with the class taken
      // first, the join would hold `otherClassId` while waiting on the
      // `Student` row the erasure holds, and the erasure's pre-lock would then
      // wait on `otherClassId`: `40P01`.
      await prisma.waitlistEntry.create({
        data: { classId: fx.otherClassId, studentId: fx.studentId, position: 1, status: 'removed' },
      });

      let erasurePid = 0;
      let atGate!: () => void;
      const gateHeld = new Promise<void>((r) => { atGate = r; });
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const original = dbLocks.lockStudentForErasure;
      const spy = vi.spyOn(dbLocks, 'lockStudentForErasure').mockImplementation(async (tx, id) => {
        await original(tx, id);
        erasurePid = await ownPid(tx);
        atGate();
        await held;
      });
      onTestFinished(() => spy.mockRestore());

      const erasing = deleteStudentAccount(prisma, fx.studentId).then(
        () => 'erased' as const,
        (err: unknown) => ({ error: String(err) }),
      );
      let joining: Promise<unknown> | undefined;
      try {
        await awaitHandshake(gateHeld, 'erasure Student lock');
        // `otherClassId` is full and the subject holds no active registration
        // in it, so the join is valid on every other count.
        joining = addToWaitlist(prisma, fx.otherClassId, fx.studentId).then(
          (entry) => entry,
          (err: unknown) => err,
        );
        await waitUntilBlockedBy(erasurePid);
      } finally {
        release();
        await Promise.all([erasing, joining]);
      }

      const [eraseOutcome, joinOutcome] = await Promise.all([erasing, joining]);
      expect(eraseOutcome).toBe('erased');
      expect(joinOutcome).toBeInstanceOf(WaitlistJoinError);
      expect((joinOutcome as WaitlistJoinError).reason).toBe('student_erased');
      expect(await prisma.waitlistEntry.count({ where: { studentId: fx.studentId } })).toBe(0);
      expect(await prisma.teacherStudent.count({ where: { studentId: fx.studentId } })).toBe(0);
    } finally {
      await cleanupQueue(fx);
    }
  }, 20_000);

  it('waits behind a join that holds the gate, then erases and renumbers what the join wrote', async () => {
    const fx = await makeQueue();
    try {
      // A gap in `otherClassId`'s queue ahead of where the join will append
      // (4): the renumber closes it only if the erasure renumbers that class,
      // which it does only if that class is in its lock set.
      const suffix = crypto.randomBytes(3).toString('hex');
      const makeWaiter = async (label: string, position: number) => {
        const s = await prisma.student.create({
          data: { firstName: 'Gate', lastName: label, email: `gate-${label}-${suffix}@test.local`, incomeTier: 2 },
          select: { id: true },
        });
        fx.extraStudentIds.push(s.id);
        await prisma.waitlistEntry.create({
          data: { classId: fx.otherClassId, studentId: s.id, position, status: 'waiting' },
        });
        return s.id;
      };
      const firstId = await makeWaiter('first', 1);
      const thirdId = await makeWaiter('third', 3);

      let joinPid = 0;
      let atGate!: () => void;
      const gateHeld = new Promise<void>((r) => { atGate = r; });
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let joinReleased = false;
      let stalled = false;
      const originalGate = dbLocks.lockLiveStudent;
      const gateSpy = vi.spyOn(dbLocks, 'lockLiveStudent').mockImplementation(async (tx, id) => {
        await originalGate(tx, id);
        if (id === fx.studentId && !stalled) {
          stalled = true;
          joinPid = await ownPid(tx);
          atGate();
          await held;
        }
      });
      onTestFinished(() => gateSpy.mockRestore());
      let preLockSawRelease: boolean | undefined;
      const originalPreLock = dbLocks.lockClassRowsOrdered;
      const preLockSpy = vi
        .spyOn(dbLocks, 'lockClassRowsOrdered')
        .mockImplementation(async (tx, source) => {
          if (source.join === dbLocks.CLASS_TO_WAITLIST_JOIN && preLockSawRelease === undefined) {
            preLockSawRelease = joinReleased;
          }
          return originalPreLock(tx, source);
        });
      onTestFinished(() => preLockSpy.mockRestore());

      const joining = addToWaitlist(prisma, fx.otherClassId, fx.studentId).then(
        (entry) => ({ position: entry.position }),
        (err: unknown) => ({ error: String(err) }),
      );
      let erasing: Promise<'erased' | { error: string }> | undefined;
      try {
        await awaitHandshake(gateHeld, 'join Student lock');
        erasing = deleteStudentAccount(prisma, fx.studentId).then(
          () => 'erased' as const,
          (err: unknown) => ({ error: String(err) }),
        );
        await waitUntilBlockedBy(joinPid);
      } finally {
        joinReleased = true;
        release();
        await Promise.all([joining, erasing]);
      }

      const [joinOutcome, eraseOutcome] = await Promise.all([joining, erasing]);
      expect(joinOutcome).toEqual({ position: 4 });
      expect(eraseOutcome).toBe('erased');
      expect(preLockSawRelease).toBe(true);
      expect(await prisma.waitlistEntry.count({ where: { studentId: fx.studentId } })).toBe(0);
      const queue = await prisma.waitlistEntry.findMany({
        where: { classId: fx.otherClassId, status: 'waiting' },
        select: { studentId: true, position: true },
        orderBy: { position: 'asc' },
      });
      expect(queue).toEqual([
        { studentId: firstId, position: 1 },
        { studentId: thirdId, position: 2 },
      ]);
    } finally {
      await cleanupQueue(fx);
    }
  }, 20_000);
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run --project unit src/services/waitlist.test.ts -t "erased student"`
Expected: FAIL — the join succeeds (`resolved` instead of rejecting).
Run: `pnpm exec vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts -t "before any Class row"`
Expected: the two new tests FAIL — "refuses a rejoin…" with `nothing waited behind backend …` (the join is not gated); "waits behind a join…" at `awaitHandshake` (`lockLiveStudent` is never called).

- [ ] **Step 3: Implement the gate**

In `src/services/waitlist.ts`:

```ts
export class WaitlistJoinError extends Error {
  constructor(
    message: string,
    public readonly reason: 'class_not_open' | 'class_not_full' | 'already_registered' | 'student_erased',
  ) {
```

Import `lockLiveStudent` and `StudentErasedError` from `@/lib/db-locks`. In `addToWaitlist`, as the transaction's first statement:

```ts
  return db.$transaction(async (tx) => {
    // The `Student` gate, before the class lock (#183): an erasure of this
    // student holds the other half, so a join that waited here reads its
    // committed `deletedAt` and writes nothing. Mode and order:
    // `docs/lock-order.md`, "The `Student` row is the erasure's gate".
    try {
      await lockLiveStudent(tx, studentId);
    } catch (err) {
      if (err instanceof StudentErasedError) {
        throw new WaitlistJoinError('This account has been deleted', 'student_erased');
      }
      throw err;
    }

    await lockClassRow(tx, classId);
```

Update the docblock's guard list (a fourth guard: the student must not be erased, read under the gate), and the lock-order paragraph above the roster-link write (~274-278), which names `Class` then `TeacherStudent`: the order is now `Student`, then `Class`, then `TeacherStudent`. Re-read `removeFromWaitlist`'s docblock (~352-370, the concurrent-erasure race) and correct anything the gate falsifies — it is about removal, which is not gated, so expect it to stand.

- [ ] **Step 4: Run and see them pass**

Run the two commands from Step 2, then `pnpm exec vitest run --project unit src/services/waitlist.test.ts` and `pnpm run typecheck`.
Expected: all pass.

- [ ] **Step 5: Documentation and cross-file comments**

`docs/lock-order.md`:
1. The canonical line becomes `Student → Class → WaitlistEntry → Registration → StudentPrivacy → TeacherStudent → Invitation → TeacherBlock`, followed by one sentence: `Student` binds only the sites that lock it explicitly (the new section below names them); a child-row insert's automatic `FOR KEY SHARE` on its `Student` parent conflicts with neither gate mode, so it creates no ordering obligation.
2. *`Class` is the real gate; the rest is not* — replace the sentence citing `deleteStudentAccount` as the case where the second condition fails (its `Class` lock set smaller than its `WaitlistEntry` write set, cycle reproduced) with what is true now: that is where the condition used to fail for `WaitlistEntry`, what closed it is recorded under *Known conformance*, and its `Registration` writes still reach classes it never locked — so the section is still not a blanket escape.
3. A new section, *The `Student` row is the erasure's gate (#183)*, placed after *Ordering BETWEEN `StudioClass` and its `CalendarEntry`*. Content:
   - the problem in two sentences (two READ COMMITTED snapshots: an entry created between the pre-lock and the delete was deleted outside the lock set, or, still uncommitted, survived the erasure);
   - a table: `deleteStudentAccount` → `lockStudentForErasure`, its second statement, `FOR NO KEY UPDATE`; `addToWaitlist` → `lockLiveStudent`, its first statement, `FOR SHARE`, refusing an erased profile;
   - the order `Student → Class` at both, and what each side sees when it waited;
   - **why these modes**: they must conflict with each other, and the erasure's must not conflict with `FOR KEY SHARE`; `promoteNext` holds a class and then inserts the promoted student's `Registration`, so an erasure holding `FOR UPDATE` on that student while waiting on that class would close a cycle; pinned by `db-locks-lock-order.test.ts` ("the Student gate: lock modes") and end to end by `gdpr-lock-order.test.ts` ("lets a promotion of the student finish while it waits…"), which fails with `40P01` under `FOR UPDATE`;
   - **why gating one writer at a time is safe**: an ungated writer takes only `FOR KEY SHARE` on the row;
   - **what still escalates**: the erasure's closing `student.updateMany` changes `email` (plain unique index), so it takes `FOR UPDATE` and waits for `FOR KEY SHARE` holders; by then it holds every class in its lock set, so no promotion of the student is in flight; an ungated booking's roster-link insert can be, which is #FOLLOWUP_BOOKING;
   - the remaining ungated inserters and where they are tracked: `POST /api/registrations` (#FOLLOWUP_BOOKING); `acceptInvitation`, `PUT /api/students/[id]/privacy`, `unlinkTeacher` (#FOLLOWUP_LINKS);
   - the re-derivation command: `grep -rn 'lockStudentForErasure\|lockLiveStudent' src/ --include='*.ts' | grep -v '\.test\.ts:'`.
4. *Known conformance*, the `deleteStudentAccount` entry (from "It is the outlier on `WaitlistEntry`, though" through "All three left open, not resolved: no code changed for any of them."): keep the three-ways-outlier fact and the "inside the gate — no cycle" measurement; replace "Its `waitlistEntry.deleteMany` is keyed on `studentId` alone, so the gap is now purely a TIME one…" and the "outside the gate — a live cycle" consequence with what closed them: the `Student` lock (no entry can appear outside the lock set) and the scoped delete plus count (the erasure never requests the row lock of an entry whose class it does not hold — the wait edge both recorded `40P01` cycles needed). Keep the `Registration` paragraph, and add that a booking racing the erasure is #FOLLOWUP_BOOKING. Replace "All three left open" with the accurate status: the `WaitlistEntry` window is closed (#183); the `Registration` half stays open.

`docs/data-model.md`, `### WaitlistEntry (overflow)`: add the policy paragraph — a join that races its own student's erasure is refused (`WaitlistJoinError` `student_erased`, 409): the erasure wins, serialised on the `Student` row; why refusal rather than delete-and-rescan or accept (rescan takes class locks after writes and still cannot see an uncommitted join; accepting leaves an entry and roster link for an erased profile that `promoteNext` can later turn into a registration); link `docs/lock-order.md`'s new section for the mechanism.

`src/services/class-transitions.ts`:
- ~379-397: the paragraph ending "issue #183 is open precisely because `deleteStudentAccount`'s write set can exceed its lock set" — replace that clause with a pointer: which writers take which lock is `docs/lock-order.md`'s to say. Keep the rest of the paragraph's argument (it is about this function's own lock) and its re-derivation command.
- ~514-516: "every writer of `WaitlistEntry` takes this class's row lock first" is a claim about other modules. Replace it with the local fact — `lockClassRow` above holds this class's row, and a `WaitlistEntry` writer that holds this class's lock cannot interleave with these two statements — and link `docs/lock-order.md` for which writers do.

- [ ] **Step 6: Run the affected suites**

Run: `pnpm exec vitest run --project unit src/services/waitlist.test.ts src/services/class-transitions.test.ts`
Run: `pnpm exec vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts src/services/waitlist-lock-order.test.ts`
Run: `pnpm run typecheck && pnpm run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts src/services/gdpr-lock-order.test.ts docs/lock-order.md docs/data-model.md src/services/class-transitions.ts
git commit -m "fix(waitlist): refuse a join that races its own student's erasure (#183)"
```

- [ ] **Step 8: Prove it bites (mutation protocol)**

1. Delete the gate block in `addToWaitlist` → "refuses the join…" (`waitlist.test.ts`) fails, and "refuses a rejoin that waits behind it…" fails with `nothing waited behind backend …`.
2. `lockLiveStudent` → `FOR KEY SHARE` (in `db-locks.ts`) → "refuses a rejoin that waits behind it…" fails.
3. Delete `await lockStudentForErasure(tx, studentId);` in `gdpr.ts` → "waits behind a join that holds the gate…" fails on `preLockSawRelease`.
4. In `addToWaitlist`, move the gate block below `lockClassRow` → "refuses a rejoin that waits behind it…" must fail with an outcome matching `40P01|deadlock detected` on one side (either may be the victim). "waits behind a join…" is expected to stay green under this mutation — its subject holds nothing in the class it joins, so the order is not observable there; record both.

Record each outcome's text; restore; re-run green.

---

### Task 5: `DELETE /api/account` answers `ErasureLockSetError` as busy

**Depends on Task 3.**

**Files:**
- Modify: `src/app/api/account/route.ts` (`erasureFailure` ~63-97; import ~13-18)
- Modify: `tests/integration/account-api.test.ts`

**Interfaces:**
- Consumes: `ErasureLockSetError` from `@/services/gdpr` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Make sure this worktree's app runs the branch**

The integration tier talks to this worktree's app (`INTEGRATION_BASE_URL` in `.env`), against the worktree's dev database, which Task 1 migrated. If the app is not running: `pnpm run worktree:up`. If it predates Tasks 1–4 and anything looks stale: `pnpm run worktree:down && pnpm run worktree:up`. Never touch `:3000`. Request `DELETE /api/account` once without a cookie to warm the route (expect 401).

- [ ] **Step 2: Write the failing integration test**

In `tests/integration/account-api.test.ts`, inside the describe that defines `seedStudentOnly` and the seeded-id arrays, next to the `ERASURE_BUSY` test. Before writing, check which `date:` values the file already uses for `teacherId`'s classes (`grep -n "date: new Date('2099" tests/integration/account-api.test.ts`) and pick two unused days; the ones below assume `2099-07-01` and `2099-07-02` are free.

```ts
  it('reports ERASURE_BUSY when a waitlist entry appears outside the erasure lock set', async () => {
    const acc = await seedStudentOnly('lockset');

    const room = await prisma.room.create({
      data: {
        venueName: 'Lockset Venue',
        address: `${suffix} Lockset St`,
        city: 'Testville',
        postcode: '1234LS',
        floor: '1',
        roomName: 'Hall',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    seededRoomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    seededTeacherRoomIds.push(teacherRoom.id);
    const makeClass = async (date: string) => {
      const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Lockset Flow',
        date: new Date(date),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'open',
      });
      seededClassIds.push(cls.id);
      return cls.id;
    };
    const bookedClassId = await makeClass('2099-07-01');
    const lateClassId = await makeClass('2099-07-02');
    const registration = await prisma.registration.create({
      data: { classId: bookedClassId, studentId: acc.studentId, status: 'registered', tierAtBooking: 3 },
    });

    // Hold the subject's registration: the erasure's `registration.updateMany`
    // parks on it, which is after its pre-lock has chosen its classes.
    let holderPid = 0;
    let parked!: () => void;
    const isParked = new Promise<void>((r) => { parked = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const holding = prisma.$transaction(
      async (tx) => {
        const [own] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        holderPid = own!.pid;
        await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registration.id} FOR UPDATE`;
        parked();
        await released;
      },
      { timeout: 20_000 },
    );
    await isParked;

    const deleting = fetch(`${BASE_URL}/api/account`, { method: 'DELETE', headers: cookie(acc.token) });
    try {
      const deadline = Date.now() + 1_500;
      for (;;) {
        const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
        if ((row?.n ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error('the erasure never parked on the held registration');
        await new Promise((r) => setTimeout(r, 25));
      }
      // An entry the erasure's pre-lock never saw: written directly, as a
      // writer that bypassed the join's gate would.
      await prisma.waitlistEntry.create({
        data: { classId: lateClassId, studentId: acc.studentId, position: 1, status: 'waiting' },
      });
    } finally {
      release();
      await holding;
    }

    const res = await deleting;
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('ERASURE_BUSY');
    expect(body.error.message).toMatch(/again/i);
    const student = await prisma.student.findUniqueOrThrow({ where: { id: acc.studentId } });
    expect(student.deletedAt).toBeNull();

    // The retry the message promises: its pre-lock now covers `lateClassId`.
    const second = await fetch(`${BASE_URL}/api/account`, { method: 'DELETE', headers: cookie(acc.token) });
    expect(second.status).toBe(200);
    expect(await prisma.waitlistEntry.count({ where: { studentId: acc.studentId } })).toBe(0);
  }, 40_000);
```

- [ ] **Step 3: Run it and see it fail**

Run: `pnpm exec vitest run --project integration tests/integration/account-api.test.ts -t "outside the erasure lock set"`
Expected: FAIL — `expected 500 to be 503` (the error is answered as `ERASURE_FAILED`).

- [ ] **Step 4: Implement**

In `src/app/api/account/route.ts`, add `ErasureLockSetError` to the `@/services/gdpr` import, and in `erasureFailure`:

```ts
  // `ErasureLockSetError` is retryable: the retry's pre-lock covers the class
  // whose entry caused it (see where `gdpr.ts` throws it).
  const transient = isTransientDbError(err) || err instanceof ErasureLockSetError;
```

Leave the handler's log line as it is: its level comes from `isTransientDbError(err)` alone, which is `false` here, so the event logs at `error` — wanted, because reaching it means a writer bypassed the gate.

- [ ] **Step 5: Correct the stale docblocks**

In the same test file: the docblock of "answers both halves of a concurrent erasure with success" (~654-662) and the comments of "finishes the teacher half when the student half was erased underneath it" (~759) say the requests park at the erasure's closing write. They now park at the erasure's second statement, `lockStudentForErasure` — the holder's `FOR UPDATE` conflicts with its `FOR NO KEY UPDATE` — and the loser waits the hold plus the winner's whole transaction. Rewrite to that; the assertions stand.

- [ ] **Step 6: Run the file and see it pass**

Run: `pnpm exec vitest run --project integration tests/integration/account-api.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/account/route.ts tests/integration/account-api.test.ts
git commit -m "fix(account): answer an erasure lock-set refusal as busy, not failed (#183)"
```

- [ ] **Step 8: Prove it bites (mutation protocol)**

Remove `|| err instanceof ErasureLockSetError`; wait for the worktree app to recompile and request the route once; run the new test → must fail with `expected 500 to be 503`. Restore; request once; re-run green.

---

## After the tasks

- Whole-branch review (the plan has 5 tasks), one fix wave, one scoped re-review.
- `pnpm run verify` with this worktree's app up; the PR body cites the per-project counts that prove `verify` ran every tier.
- PR, `/pr-review-toolkit:review-pr`, fold/file/let-go, rebase-merge. After merge: `gh issue view 183 --json state`, and the two follow-ups stay open.
