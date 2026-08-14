# Atomic Template Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `PUT /api/class-templates/[id]` commit its template write, its
instance sync and its window refill as one transaction, and close the reproduced
`40P01` cycle that doing so would otherwise widen.

**Architecture:** `updateClassTemplate` opens one `$transaction`; `syncTemplateInstances`
stops opening its own and composes the refill into the caller's. Before that,
both heap-ordered `Class` lock sites gain an ordered pre-lock, so the atomic
version never ships on top of a live deadlock.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma 6.19.3 on
PostgreSQL, Vitest (three projects: `unit`, `integration`, `components`).

**Spec:** `docs/superpowers/specs/2026-08-14-atomic-template-update-design.md`.
Read §2.3, §2.4 and §2.4.1 before Task 2; read §1.1 before Task 6.

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types.
- **Never start or restart the dev server on :3000.** The user runs it; the
  `integration` project talks to it over HTTP.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths
  containing parentheses.
- **`docs/backlog-roadmap.md` is untracked and stays untracked.** Never stage it.
- **Commit per task.** The PR is rebase-merged; the commit-per-task history is
  the record.
- **Never write a closing keyword (`close`/`fixes`/`resolves`, any tense)
  immediately before a `#`-reference in a commit message or PR body**, even to
  deny it. Write "issue N is unaffected". This has closed the wrong issue twice.
- **Lock bound:** `LOCK_TIMEOUT_SQL` (`src/lib/db-locks.ts:76`) — `SET LOCAL
  lock_timeout = '2s'`. Never a fresh literal.
- **Transaction budgets:** `updateClassTemplate` → `{ timeout: 15_000 }`.
  `archiveOrUnarchiveTemplate` stays `{ timeout: 10_000 }` (spec §2.4).
- **`@/lib/log` is pino and server-only.** Do not import it into a module a
  `'use client'` component value-imports.
- **Migrations:** none in this branch. If one becomes necessary, stop and report.

## Measured baseline

Run on this branch at `68ce9aa`, dev server live:

```
unit         51 files   735 tests
integration  28 files   396 tests
components   37 files   202 tests
             ──────────────────────
             116 files  1333 executable
```

`51 + 28 + 37 = 116` and `735 + 396 + 202 = 1333`, reconciling with
`npx vitest run`'s "Test Files 116 passed (116) / Tests 1333 passed | 2 todo
(1335)". The two `todo` are the markers at `src/services/gdpr.test.ts:1359-1364`,
which Task 5 deletes.

**Predicted after: 1333 − 2 todo + new tests.** Measure it; do not inherit this
number. Branch reviews routinely add tests a prediction cannot know about.

## Verify-don't-assume

Run these before Task 1. Every line number below is one this plan leans on. If
one has drifted, fix the reference **and report the drift**.

```bash
sed -n '46,49p'     src/services/template-sync.ts            # syncTemplateInstances(db: PrismaClient, ...)
sed -n '55p'        src/services/template-sync.ts            # const result = await db.$transaction(async (tx) => {
sed -n '66,69p'     src/services/template-sync.ts            # const future = await tx.class.findMany({
sed -n '139,142p'   src/services/template-sync.ts            # const refill = ...
sed -n '237,238p'   src/services/class-template-lifecycle.ts # export async function updateClassTemplate(db: PrismaClient,
sed -n '285,291p'   src/services/class-template-lifecycle.ts # try { update ... sync }
sed -n '503p'       src/services/class-template-lifecycle.ts # SCHEDULED_STATUSES = ['draft','open']
sed -n '516,520p'   src/services/class-template-lifecycle.ts # scheduledWhere
sed -n '955,960p'   src/services/class-template-lifecycle.ts # "Locking every candidate class would work and is simply worse"
sed -n '986,991p'   src/services/class-template-lifecycle.ts # tx.class.deleteMany
sed -n '1075p'      src/services/class-template-lifecycle.ts # { timeout: 10_000 },
sed -n '58p'        src/lib/db-locks.ts                      # TransactionClientOnly
sed -n '902,911p'   src/services/waitlist.ts                 # the ordered FOR UPDATE OF c pattern to copy
sed -n '1359,1364p' src/services/gdpr.test.ts                # the two it.todo markers
sed -n '396p'       src/services/class-generator.test.ts     # 'opens the archive transaction with { timeout: 10_000 }'
sed -n '1127,1130p' tests/integration/class-templates-api.test.ts # the test Task 6 inverts
docker ps --filter name=fairyoga-db-1 --format '{{.Names}} {{.Status}}'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/    # expect 307
```

## Task order is load-bearing

**The pre-lock tasks (1–5) come before the atomicity tasks (6–8), and the order
is not a preference.**

1. Issue 180's reproduction transcript in `docs/lock-order.md:292-295` was
   measured against `syncTemplateInstances` *as it is today*, with its own inner
   transaction. Writing the deadlock test against that structure puts it on
   ground where the reproduction is known to work. Task 6 restructures the
   function; a test written after it would be new territory.
2. If the branch stalls, the deadlock fix has landed rather than the change that
   widens it.

Task 0 comes before everything: it can invalidate the 15 s budget.

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/services/template-lock-order.test.ts` | **new** — the two deadlock reproductions, modelled on `invitations-lock-order.test.ts` | 1, 3 |
| `src/services/template-sync.ts` | pre-lock, then loses its inner transaction and its `PrismaClient` | 2, 6 |
| `src/services/class-template-lifecycle.ts` | archive pre-lock; `updateClassTemplate` gains the transaction, `busy`, and the new catch order | 4, 6, 7 |
| `src/app/api/class-templates/[id]/route.ts` | `sync_conflict` copy, `busy` branch | 6, 7 |
| `src/lib/db-locks.ts` | register entry for `syncTemplateInstances` | 6 |
| `src/services/gdpr.test.ts` | delete the two `it.todo` markers | 5 |
| `tests/integration/class-templates-api.test.ts` | the desync pin inverts | 6 |
| `docs/lock-order.md` | table rows, delete the "live and unfixed" section, repoint "Known violation" | 8 |

---

### Task 0: Probe whether `lock_timeout` bounds an index-entry `ShareLock`

**This is a measurement, not code.** Spec §2.4 rows 4 and 5 assume it does. If
it does not, two of the update transaction's five waits are unbounded and 15 s
is arbitrary — **stop and report** rather than proceeding.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-14-atomic-template-update-design.md` (§2.4, record the transcript)

- [ ] **Step 1: Open two `psql` sessions in the DB container**

```bash
docker exec -it fairyoga-db-1 psql -U postgres -d fairyoga
```

- [ ] **Step 2: In session A, take an uncommitted slot-key index entry**

Pick any teacher and a free future date. `Class_teacher_slot_unique` is
`(teacherId, date, startTime) WHERE status <> 'cancelled'`.

```sql
BEGIN;
INSERT INTO "Class" ("id","teacherId","classType","date","startTime","durationMinutes",
                     "roomCost","minRate","targetRate","minStudents","maxStudents","status",
                     "createdAt","updatedAt")
SELECT 'probe-a', t.id, 'Probe', DATE '2027-01-04', '07:03', 60, 0, 0, 0, 1, 8, 'open', now(), now()
FROM "Teacher" t LIMIT 1;
-- leave open, do not commit
```

- [ ] **Step 3: In session B, set the bound and collide on the same key**

```sql
BEGIN;
SET LOCAL lock_timeout = '2s';
INSERT INTO "Class" ("id","teacherId","classType","date","startTime","durationMinutes",
                     "roomCost","minRate","targetRate","minStudents","maxStudents","status",
                     "createdAt","updatedAt")
SELECT 'probe-b', t.id, 'Probe', DATE '2027-01-04', '07:03', 60, 0, 0, 0, 1, 8, 'open', now(), now()
FROM "Teacher" t LIMIT 1;
```

Expected if the assumption holds: session B fails after ~2 s with
`ERROR: canceling statement due to lock timeout` (SQLSTATE `55P03`).

Expected if it does **not** hold: session B blocks indefinitely until session A
is resolved.

- [ ] **Step 4: Clean up**

```sql
-- session B
ROLLBACK;
-- session A
ROLLBACK;
```

- [ ] **Step 5: Record the outcome in the spec and commit**

Replace §2.4's "Rows 4 and 5 are an assertion, not a measurement" paragraph with
the transcript and the verdict. If the bound did **not** fire, write that,
**stop, and report** — the budget question reopens.

```bash
git add docs/superpowers/specs/2026-08-14-atomic-template-update-design.md
git commit -m "spec: measure whether the 2s bound reaches an index-entry wait"
```

---

### Task 1: Reproduce the `syncTemplateInstances` deadlock

**Files:**
- Create: `src/services/template-lock-order.test.ts`

**Interfaces:**
- Consumes: `syncTemplateInstances(db, templateId)` and `deleteStudentAccount`
  as they exist today.
- Produces: a test file Task 3 extends and Task 2 turns green.

Model on `src/services/invitations-lock-order.test.ts` — read it first. The
established shape is two concurrent transactions through `Promise.allSettled`,
asserting `/40P01|deadlock/i` over the rejections. That regex does **not** match
`55P03`, which is exactly the specificity issue 180 requires: a `lock_timeout`
expiry fails the assertion rather than satisfying it.

- [ ] **Step 1: Read the model file**

```bash
sed -n '1,80p'    src/services/invitations-lock-order.test.ts
sed -n '249,300p' src/services/invitations-lock-order.test.ts
```

- [ ] **Step 2: Write the failing-today reproduction**

Trigger, from `docs/lock-order.md:297-299`: a student waitlisted on **two**
instances of one recurring template deletes their account while the teacher
edits that template. Two classes are required — one row cannot invert an order.

```ts
/**
 * Issue 180. `syncTemplateInstances` takes its `Class` row locks in heap order;
 * `deleteStudentAccount` takes them ascending by id (`gdpr.ts`, the
 * `lockClassRow` loop). Two rows, opposite orders, one cycle.
 *
 * Asserted by SQLSTATE, not by "it failed": a `lock_timeout` expiry is `55P03`
 * and must FAIL this test rather than satisfy it (issue 180, acceptance 1).
 */
it('syncTemplateInstances and deleteStudentAccount deadlock on two instances', async () => {
  const { templateId, studentId } = await makeTemplateWithTwoWaitedInstances();

  const a = prisma.$transaction(async () => {
    await syncTemplateInstances(prisma, templateId);
  });
  const b = deleteStudentAccount(prisma, studentId);

  const results = await Promise.allSettled([a, b]);
  const rejections = results.filter((r) => r.status === 'rejected');
  expect(rejections).toHaveLength(1);
  expect(String((rejections[0] as PromiseRejectedResult).reason)).toMatch(/40P01|deadlock/i);
});
```

Write `makeTemplateWithTwoWaitedInstances` in this file: a teacher, a template,
two future `open` instances with `settingsLocked: false`, and a student with a
`waiting` `WaitlistEntry` on each. Follow the fixture style in
`invitations-lock-order.test.ts:77-170`.

- [ ] **Step 3: Run it and confirm it fails the RIGHT way**

Run: `npx vitest run --project unit src/services/template-lock-order.test.ts`

Expected: **PASS** — the deadlock reproduces today, which is the point. This
test is red-after-fix, not red-before-fix.

**If it does not reproduce, stop and report.** Issue 180 measured the reason:
a btree `ScalarArrayOp` index scan visits in **ascending id order**, so on some
table shapes the cycle silently does not form and the test would go green after
Task 2 for a reason unrelated to the fix. Confirm the plan shape first:

```sql
-- in psql, against the two class ids the fixture made
SET enable_seqscan = off;
EXPLAIN UPDATE "Class" SET "startTime" = '09:00' WHERE id = ANY(ARRAY['<id1>','<id2>']);
-- expect: Index Scan using "Class_pkey"
```

- [ ] **Step 4: Commit**

```bash
git add src/services/template-lock-order.test.ts
git commit -m "test: reproduce the template-sync deadlock before fixing it"
```

---

### Task 2: Ordered pre-lock in `syncTemplateInstances`

**Files:**
- Modify: `src/services/template-sync.ts:55-74`
- Test: `src/services/template-lock-order.test.ts`

**Interfaces:**
- Consumes: `setLockTimeout(tx)` from `@/lib/db-locks` (`:99`).
- Produces: no signature change. `syncTemplateInstances(db: PrismaClient, templateId)`
  is unchanged until Task 6.

- [ ] **Step 1: Invert the Task 1 assertion**

The test must now assert the **absence** of a deadlock, matching
`invitations-lock-order.test.ts:551`. Rename it and change the assertion:

```ts
it('syncTemplateInstances and deleteStudentAccount coexist on two instances', async () => {
  const { templateId, studentId } = await makeTemplateWithTwoWaitedInstances();

  const a = prisma.$transaction(async () => {
    await syncTemplateInstances(prisma, templateId);
  });
  const b = deleteStudentAccount(prisma, studentId);

  for (const settled of await Promise.allSettled([a, b])) {
    if (settled.status === 'rejected') {
      expect(String(settled.reason)).not.toMatch(/40P01|deadlock/i);
    }
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/template-lock-order.test.ts`
Expected: FAIL — one side rejects with `40P01`.

- [ ] **Step 3: Add the pre-lock**

In `template-sync.ts`, inside the existing `db.$transaction(async (tx) => {`.
Hoist `now` to a single value: the lock set and the read set must be derived
from the *same* instant, or a class can slip between them.

```ts
const result = await db.$transaction(
  async (tx) => {
    // One instant for both the lock and the read below. Two separate
    // `new Date()` calls would let a class enter the read set that the
    // pre-lock never covered — which is the ordering hole this closes.
    const now = new Date();

    // Ordered pre-lock (#180). `syncTemplateInstances` used to take its
    // `Class` locks in heap order, cycling against `deleteStudentAccount`'s
    // ascending `lockClassRow` loop — reproduced as `40P01` in
    // `docs/lock-order.md`. Sorting the id array is inert: the write visits
    // in plan order, never array order. Only a separate ordered statement
    // fixes it. Same shape as `withdrawWaitingEntriesForTeacher`
    // (`waitlist.ts`), including the re-read that follows.
    await setLockTimeout(tx);
    await tx.$queryRaw`
      SELECT c.id
      FROM "Class" c
      WHERE c."templateId" = ${templateId}
        AND c."teacherId" = ${template.teacherId}
        AND c.date > ${now}
      ORDER BY c.id
      FOR UPDATE OF c
    `;

    // Re-read UNDER the lock now held. Before the pre-lock this read decided
    // `settingsLocked`/`status` from an unlocked snapshot, so a registration
    // committing between here and the `updateMany` let the propagation
    // rewrite a class it was supposed to keep — the `kept` guarantee was
    // advisory. It is now real, which the tripwire comment below depends on.
    const future = await tx.class.findMany({
      where: { templateId, teacherId: template.teacherId, date: { gt: now } },
      select: { id: true, date: true, settingsLocked: true, status: true },
    });
```

Add the import: `import { setLockTimeout } from '@/lib/db-locks';`

- [ ] **Step 4: Give the inner transaction an explicit budget**

It runs on Prisma's 5 s default today (spec §1.5) and now carries a 2 s pre-lock
wait. **Temporary — Task 6 deletes this transaction entirely.**

```ts
  },
  { timeout: 15_000 },
);
```

- [ ] **Step 5: Run the test and the sync's own suite**

```bash
npx vitest run --project unit src/services/template-lock-order.test.ts src/services/template-sync.test.ts
```
Expected: PASS.

- [ ] **Step 6: Mutation — prove the pre-lock is what fixed it**

Comment out the `$queryRaw` pre-lock (keep `setLockTimeout`). Re-run.
Expected: FAIL with `40P01`. Restore, re-run, PASS. Record the exact error text
in the commit message.

- [ ] **Step 7: Pin the re-read, which the pre-lock also bought**

The lock now makes the `kept` guarantee real rather than advisory (Step 3's
comment claims this; a comment is not a guard). Add to
`src/services/template-sync.test.ts`:

```ts
/**
 * Before the ordered pre-lock, `future` was read from an unlocked snapshot, so
 * a registration committing between that read and the `updateMany` let the
 * propagation rewrite a class it was supposed to keep. The pre-lock plus the
 * re-read under it closes that window — this pins the re-read, not the lock.
 */
it('does not propagate to a class that became settingsLocked after the pre-lock read', async () => {
  // Build a template with one mutable future instance, then latch
  // `settingsLocked: true` on it before syncTemplateInstances runs, and assert
  // the instance keeps its old startTime and lands in `kept`.
});
```

Mutation: move the `findMany` back **above** the `$queryRaw` pre-lock, so it
reads before the lock. Expected: FAIL. Restore.

If the mutation cannot be made to fail, the re-read is not observable from this
level — say so rather than keeping a test that proves nothing, and drop the
claim from Step 3's comment too.

- [ ] **Step 8: Commit**

```bash
git add src/services/template-sync.ts src/services/template-lock-order.test.ts
git commit -m "fix: template sync takes its class locks in one order"
```

---

### Task 3: Reproduce the `archiveOrUnarchiveTemplate` deadlock

**Files:**
- Modify: `src/services/template-lock-order.test.ts`

Issue 180: a fix at one site leaves the pairing live through the other. This
site needs its own reproduction and its own fix.

- [ ] **Step 1: Add the second reproduction**

```ts
/**
 * The second half of issue 180. `archiveOrUnarchiveTemplate`'s multi-row
 * `class.deleteMany` takes its locks in heap order for the same reason, and
 * has no id array to sort even in principle — its delete takes a predicate.
 */
it('archiveOrUnarchiveTemplate and deleteStudentAccount deadlock on two instances', async () => {
  const { templateId, studentId, teacherId } = await makeTemplateWithTwoWaitedInstances();

  // Fourth argument is the target state string, not a boolean — verified
  // against `class-generator.test.ts:507`.
  const a = archiveOrUnarchiveTemplate(prisma, templateId, teacherId, 'archived');
  const b = deleteStudentAccount(prisma, studentId);

  const results = await Promise.allSettled([a, b]);
  const rejections = results.filter((r) => r.status === 'rejected');
  expect(rejections).toHaveLength(1);
  expect(String((rejections[0] as PromiseRejectedResult).reason)).toMatch(/40P01|deadlock/i);
});
```

Check `archiveOrUnarchiveTemplate`'s real signature before writing the call —
it returns a result object rather than throwing for business outcomes, so the
rejection must come from the deadlock, not from a refusal.

- [ ] **Step 2: Run it and confirm it reproduces**

Run: `npx vitest run --project unit src/services/template-lock-order.test.ts`
Expected: this test PASSES (deadlock reproduces); Task 2's test still passes.

If it does not reproduce, apply Task 1 Step 3's `EXPLAIN` check before
concluding anything.

- [ ] **Step 3: Commit**

```bash
git add src/services/template-lock-order.test.ts
git commit -m "test: reproduce the archive deadlock, the second half of the pairing"
```

---

### Task 4: Ordered pre-lock in `archiveOrUnarchiveTemplate`

**Files:**
- Modify: `src/services/class-template-lifecycle.ts:955-991`
- Test: `src/services/template-lock-order.test.ts`

**Read spec §2.4.1 first.** This task collides with a documented decision at
`:955-960` and the resolution is written there.

**Interfaces:**
- Consumes: `scheduledWhere(templateId, date)` (`:516-520`),
  `SCHEDULED_STATUSES = ['draft','open']` (`:503`), `setLockTimeout` (already
  called at `:824`).
- Produces: no signature change. `{ timeout: 10_000 }` at `:1075` stays.

- [ ] **Step 1: Invert the Task 3 assertion**

Same shape as Task 2 Step 1 — rename to "coexist", assert `.not.toMatch(/40P01|deadlock/i)`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/template-lock-order.test.ts`
Expected: FAIL with `40P01` on the archive test; the sync test still passes.

- [ ] **Step 3: Add the pre-lock above the candidate read**

`setLockTimeout(tx)` is already issued at `:824`, so do not repeat it. Insert
immediately **before** the `waitlistEntry.findMany` at `:961`:

```ts
        // Ordered pre-lock (#180). The `deleteMany` below re-evaluates its
        // predicate at execution time — deliberately, see its own comment —
        // so ANY scheduled future class of this template may match and must
        // already be held, in ascending id order, before it runs. Narrowing
        // this set to the deletable rows would leave a candidate the delete
        // re-evaluates into scope unlocked, and the cycle returns.
        //
        // The comment below used to argue against locking every candidate,
        // on the grounds that a second read buys the same thing for free.
        // That weighed the lock against a read for NOTIFICATION correctness,
        // where it was right — and the second read is still here and still
        // needed. A lock buys one thing a read cannot buy at any price: a
        // canonical order. The cost it named is real and is now paid — an
        // archive blocks booking on this template's future classes for its
        // duration, bounded by the 2s `SET LOCAL lock_timeout` at the head of
        // this transaction and its 10s budget.
        await tx.$queryRaw`
          SELECT c.id
          FROM "Class" c
          WHERE c."templateId" = ${templateId}
            AND c.date > ${today}
            AND c.status IN ('draft', 'open')
          ORDER BY c.id
          FOR UPDATE OF c
        `;
```

Then rewrite the objection at `:955-960` so it no longer contradicts the code
above it. Keep its explanation of why the **second read** exists.

- [ ] **Step 4: Run the test, the archive suite, and the untouched pin**

```bash
npx vitest run --project unit \
  src/services/template-lock-order.test.ts \
  src/services/class-template-lifecycle.test.ts \
  src/services/class-generator.test.ts
```

Expected: PASS, **including** `class-generator.test.ts:396` ("opens the archive
transaction with `{ timeout: 10_000 }`") **unedited**. If that pin now fails,
spec §2.4's consolidation argument is wrong: **stop and report**, do not edit
the pin to match.

- [ ] **Step 5: Mutation A — the pre-lock is load-bearing**

Comment out the `$queryRaw`. Expected: FAIL with `40P01`. Restore.

- [ ] **Step 6: Mutation B — the row set must not be narrowed**

Add `AND NOT EXISTS (SELECT 1 FROM "Registration" r WHERE r."classId" = c.id
AND r.status IN ('registered','attended','late_cancel'))` to the pre-lock, so it
covers only deletable classes. Expected: FAIL — this is spec §2.4.1's claim that
the full `scheduledWhere` set is required. Restore.

If it does **not** fail, say so: the spec's stated reason for the wide set is
then unproven, and the wide set needs a different justification or a narrower
one is acceptable. Report rather than silently keeping either.

- [ ] **Step 7: Commit**

```bash
git add src/services/class-template-lifecycle.ts src/services/template-lock-order.test.ts
git commit -m "fix: the archive takes its class locks in one order too"
```

---

### Task 5: Delete the `it.todo` markers

**Files:**
- Modify: `src/services/gdpr.test.ts:1320-1365`

Their own docblock says "Delete both when 180 lands". They exist to keep an open
cycle visible; the cycle is now closed and pinned by real tests.

- [ ] **Step 1: Delete both markers and the parts of the docblock that describe an open cycle**

Delete `it.todo` at `:1359` and `:1362`. The docblock above them argues why the
cycles are recorded rather than resolved — that argument is now false. Replace
it with a pointer to `src/services/template-lock-order.test.ts`, or delete the
whole block if nothing in it survives. **Do not** leave a narrowed version that
still implies the cycle is open.

- [ ] **Step 2: Confirm the todo count drops to zero**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`
Expected: PASS, and no `todo` in the summary line.

- [ ] **Step 3: Commit**

```bash
git add src/services/gdpr.test.ts
git commit -m "test: the two markers for a cycle that is now closed"
```

---

### Task 6: One transaction across write, sync and refill

**Files:**
- Modify: `src/services/template-sync.ts` (signature, drop inner transaction)
- Modify: `src/services/class-template-lifecycle.ts:237-364`
- Modify: `src/app/api/class-templates/[id]/route.ts:86-106`
- Modify: `src/lib/db-locks.ts:17-52` (register entry)
- Test: `tests/integration/class-templates-api.test.ts:1118-1190`

**Read spec §1.1 first** — it records why this composition is safe, against an
issue that says it is not.

**Interfaces:**
- Consumes: `generateInstancesForTemplate(db: PrismaClient | Prisma.TransactionClient, template, from?)`
  (`class-generator.ts:116-120`) — already accepts a transaction client.
- Produces: `syncTemplateInstances(tx: TransactionClientOnly, templateId): Promise<TemplateSyncResult>`.
  `updateClassTemplate`'s signature is **unchanged** — it opens the transaction,
  it is not composed into one.

- [ ] **Step 1: Invert the integration pin**

`tests/integration/class-templates-api.test.ts:1127` currently asserts the
desync as correct. Change the two post-conditions and the comment above them:

```ts
    // The template write is now in the same transaction as the sync that
    // failed, so it rolled back with it (#83, #209). This assertion is the
    // inverse of the one that stood here before: it asserted `'11:18'`,
    // pinning the half-applied write as intended behaviour.
    const template = await prisma.classTemplate.findUniqueOrThrow({ where: { id } });
    expect(template.startTime).toBe('11:17');

    const instance = await prisma.class.findUniqueOrThrow({ where: { id: instances[0]!.id } });
    expect(instance.startTime).toBe('11:17');
```

Also update the message assertion at `:1173-1175` to the new copy in Step 5.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts`
Expected: FAIL — the template is at `'11:18'`, because it still commits.

- [ ] **Step 3: Collapse `syncTemplateInstances`'s transaction**

Change the signature and delete the `db.$transaction` wrapper added in Task 2,
promoting its body. Every `tx.` becomes the parameter.

```ts
import type { Prisma } from '@prisma/client';
import { setLockTimeout, type TransactionClientOnly } from '@/lib/db-locks';

export async function syncTemplateInstances(
  tx: TransactionClientOnly,
  templateId: string,
): Promise<TemplateSyncResult> {
```

`TransactionClientOnly`, not the plain union: this function issues `SET LOCAL`
and `FOR UPDATE`, and on a bare `PrismaClient` both would apply to an autocommit
transaction that no longer exists by the next statement. The brand is what makes
that a compile error (`db-locks.ts:106-127`).

The refill at the end now passes `tx`:

```ts
  const refill =
    result.regenerated > 0 && template.isActive
      ? await generateInstancesForTemplate(tx, template)
      : { created: 0, skipped: [] };
```

- [ ] **Step 4: Open the transaction in `updateClassTemplate`**

Guards stay outside — they are reads that must not hold locks.

```ts
  let updated: ClassTemplate;
  let sync: TemplateSyncResult;
  try {
    ({ updated, sync } = await db.$transaction(
      async (tx) => {
        const template = await tx.classTemplate.update({ where: { id: templateId }, data });
        // Composed into this transaction, not opening its own. Safe since
        // #164/#192 (PR #204): `generateInstancesForTemplate` has no `catch`
        // and inserts with a bare `ON CONFLICT DO NOTHING`, so the refill
        // cannot abort the transaction it now runs inside.
        return { updated: template, sync: await syncTemplateInstances(tx, templateId) };
      },
      // Five statements here can wait on a lock at 2s each (spec §2.4);
      // 10_000 would be consumed entirely by lock waits.
      { timeout: 15_000 },
    ));
  } catch (err) {
```

The existing catch is unchanged in this task. It already sits outside the
`$transaction` call, which is what makes a P2002 mappable after rollback.

- [ ] **Step 5: Correct the `sync_conflict` copy**

In `route.ts`, replace the message. Spec §3.1: this keeps PR #208's remedy
clause and its distinct code, and replaces only the now-false state clause,
using the "Nothing was changed." convention already at `:178` and `:235`.

```ts
  if (result.reason === 'sync_conflict') {
    return respondError(
      'Your scheduled classes could not be moved — you already have a class at that time. Nothing was changed. Move or cancel that class, then edit this recurring class again.',
      409,
      'TEMPLATE_SYNC_SLOT_CONFLICT',
    );
  }
```

Rewrite the comment above it: it currently explains that the template committed
and only the sync rolled back. Both halves are now false.

- [ ] **Step 6: Add the `db-locks` register entry**

`db-locks.ts:17-52` maintains a deliberately complete register. Add
`syncTemplateInstances` under `adopt`, with its reason (it issues
`LOCK_TIMEOUT_SQL` and a `FOR UPDATE`). Leave the `skip` entry for
`generateInstancesForTemplate` — still correct, it delegates its lock.

- [ ] **Step 7: Run the integration test, then the whole suite**

```bash
npx vitest run --project integration tests/integration/class-templates-api.test.ts
npm run verify
```
Expected: PASS. `verify` needs :3000 live.

- [ ] **Step 8: Mutation — prove the rollback is what the test sees**

Move the `classTemplate.update` back outside the `$transaction`. Expected: the
inverted integration test FAILS, reporting `'11:18'`. Restore.

- [ ] **Step 9: Commit**

```bash
git add src/services/template-sync.ts src/services/class-template-lifecycle.ts \
        "src/app/api/class-templates/[id]/route.ts" src/lib/db-locks.ts \
        tests/integration/class-templates-api.test.ts
git commit -m "fix: the template edit and its instance sync commit together"
```

---

### Task 7: Bound the new lock exposure and name the outcome

**Files:**
- Modify: `src/services/class-template-lifecycle.ts:199-206` (result type), `:285-361` (catch)
- Modify: `src/app/api/class-templates/[id]/route.ts`
- Test: `src/services/class-generator.test.ts` — **not**
  `class-template-lifecycle.test.ts`. The `busy` tests for the sibling functions
  live in the generator's test file, beside the claim that creates the
  contention (`:486` archive, `:564` pause). Put this one with them.

The transaction Task 6 opened holds locks with no bound. This adds the bound and
the outcome, matching the four functions the lock-race branch gave one yesterday.

**Interfaces:**
- Consumes: `isTransientDbError(err)` — the same helper `:689` and `:1100` use.
- Produces: `UpdateClassTemplateResult` gains `{ ok: false; reason: 'busy' }`.

- [ ] **Step 1: Write the failing test**

Copy the contention fixture from `class-generator.test.ts:485-521` — do not
invent one. `claimTemplateForGeneration` holds the template row `FOR UPDATE`
inside a transaction the test releases by hand.

```ts
it(
  'answers busy when the generation claim holds the row past the lock timeout',
  async () => {
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

    // Let the claim acquire the lock before the edit contends for it.
    await new Promise((r) => setTimeout(r, 100));

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const startedAt = Date.now();
      const result = await updateClassTemplate(prisma, templateId, teacherId, {
        classType: 'Yin',
      });
      const waited = Date.now() - startedAt;

      expect(result).toEqual({ ok: false, reason: 'busy' });

      // Same bounds and same reasoning as the archive's test above: the lower
      // bound proves it really waited, the upper that it answered well inside
      // the 15s budget. Neither pins the bound's VALUE — `db-locks.test.ts`
      // does that.
      expect(waited).toBeGreaterThanOrEqual(1_800);
      expect(waited).toBeLessThan(5_000);

      // A RETURNED failure never reaches `withErrorHandler`, and
      // `respondError` does not log — so without this line the race is silent.
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      release();
      await claiming;
    }
  },
  { timeout: 20_000 },
);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/class-generator.test.ts -t busy`
Expected: FAIL — the error propagates instead of returning `busy`.

- [ ] **Step 3: Add the variant, the bound, and the catch branch**

```ts
export type UpdateClassTemplateResult =
  | { ok: true; template: ClassTemplate; sync: TemplateSyncResult }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'no_fields' }
  | { ok: false; reason: 'invalid_room' }
  | { ok: false; reason: 'slot_conflict' }
  | { ok: false; reason: 'sync_conflict' }
  | { ok: false; reason: 'busy' };
```

`setLockTimeout(tx)` as the transaction's first statement, before the
`classTemplate.update`.

The catch branch goes **first**, matching `:1100`'s order in the sibling
function. P2025 and P2002 are disjoint from the transient codes so order is not
correctness-critical here, but divergence between two functions doing the same
thing is what review has to re-derive every time:

```ts
    if (isTransientDbError(err)) {
      log.warn(
        { err, templateId, teacherId },
        'recurring class edit lost the template lock race',
      );
      return { ok: false, reason: 'busy' };
    }
```

- [ ] **Step 4: Add the route branch**

The `never` guard at `:110` makes this a compile error until handled. The copy
must **not** collide with the pause/resume copy at `:235` ("could not update
this recurring class") — this is the edit, that is the pause:

```ts
  if (result.reason === 'busy') {
    return respondError(
      'The system was busy and could not save your changes to this recurring class. Nothing was changed. Wait a moment, then try again.',
      503,
      'TEMPLATE_BUSY',
    );
  }
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts
npx vitest run --project integration tests/integration/class-templates-api.test.ts
```
Expected: PASS.

- [ ] **Step 6: Mutation — prove the branch can fire**

Replace `isTransientDbError(err)` with `false`. Expected: the Step 1 test FAILS.
Restore. A `busy` branch that cannot be reached is the defect this project has
shipped six times.

- [ ] **Step 7: Pin the budget, as the sibling transactions are pinned**

`class-generator.test.ts:396` records the archive's options and asserts
`{ timeout: 10_000 }`. Add the same for this transaction — spec §2.4 derives
15 s from `5 × 2 s` plus headroom, and an underived budget silently drifting
back to 10 s would re-open a defect nothing else detects.

```ts
it('opens the template-edit transaction with { timeout: 15_000 }', async () => {
  // Same recording shape as ':396' — spy on $transaction, capture the second
  // argument, assert it equals { timeout: 15_000 }.
});
```

Mutation: change the source to `{ timeout: 10_000 }`. Expected: FAIL. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/services/class-template-lifecycle.ts "src/app/api/class-templates/[id]/route.ts" \
        src/services/class-generator.test.ts
git commit -m "fix: the template edit answers busy instead of hanging on a lock"
```

---

### Task 8: Correct every document this branch made false

**Files:**
- Modify: `docs/lock-order.md`
- Modify: `src/services/template-sync.ts` (header + refill comment)
- Modify: `src/services/class-template-lifecycle.ts:208-236`
- Modify: `src/services/class-generator.ts:104-110`
- Modify: `src/services/gdpr.ts:378-391`

Spec §3.3 lists these. A claim corrected in one artifact and left standing in
its twin is this project's most repeated failure — **grep each phrase across
spec, plan, source, tests and the issues before calling it done.**

- [ ] **Step 1: `docs/lock-order.md`**

Four separate edits:
1. `:79` — `syncTemplateInstances` row: "none — statement order first, then heap
   order within each statement" → ascending, naming the pre-lock.
2. `:80` — `archiveOrUnarchiveTemplate` row: same.
3. `:286-345` — the whole "The two that do not — live, unfixed, and partly
   branch-caused" section is **deleted, not narrowed** (issue 180, acceptance 3).
   A narrowed version still reads as an open cycle.
4. `:785-799` — "Known violation, not fixed here": keep it, add that this branch
   made `updateClassTemplate` a **fifth** site on the `ClassTemplate → Class`
   side (spec §2.5's re-count: `1 generator + 4 template paths`), and point it at
   the decision issue filed at the end of the branch.
5. `:319` — "`syncTemplateInstances` runs under Prisma's 5s default" is now
   false; it has no transaction of its own.

- [ ] **Step 2: The four docblocks**

- `class-template-lifecycle.ts:215-235` — delete "The write and the propagation
  are deliberately NOT one transaction…" and the "That is not the only seam"
  paragraph. Replace with what is now true: one transaction, the catch outside
  it, and why the refill can be composed in (spec §1.1).
- `template-sync.ts:118-138` — the refill comment predicts this branch ("which
  is what would close the seam described above, if that ever happens"). Rewrite
  in the past tense; keep the reasoning about why the per-template generator is
  used rather than the teacher-wide one, which is still true.
- `class-generator.ts:104-110` — "`syncTemplateInstances` … is the one that does
  not, and passes a bare `PrismaClient`" is now false. That sentence supports a
  different claim (why the roster says "in production"), so **rewrite it, do not
  delete it**.
- `gdpr.ts:378-391` — names both sites as locking in heap order. Now false.

- [ ] **Step 3: Sweep for stragglers**

```bash
grep -rn "not one transaction\|NOT one transaction\|heap order\|5s default\|5 s default" src/ docs/ tests/
grep -rn "would move one of your" src/ tests/
```

Every hit is either corrected or justified. Report any left standing.

- [ ] **Step 4: Full verify**

```bash
npm run verify
```
Expected: PASS — typecheck, lint, and all three projects.

- [ ] **Step 5: Commit**

```bash
git add docs/lock-order.md src/services/template-sync.ts \
        src/services/class-template-lifecycle.ts src/services/class-generator.ts \
        src/services/gdpr.ts
git commit -m "docs: five claims this branch made false"
```

---

## Done means

- `npm run verify` green, with the after-count **measured** and reconciled
  against the baseline above (`116` files / `1333` executable / `2` todo → todo
  is now `0`).
- Every mutation in Tasks 2, 4, 6 and 7 run, with its exact error text recorded
  in the commit message or the PR body.
- Task 0's probe transcript in the spec.
- The `{ timeout: 10_000 }` pin at `class-generator.test.ts:396` passing
  **unedited**.

## What the PR body must record

- The premise corrections from spec §1 — especially that issue 209's stated
  blocker expired with PR 204, and that this was checked rather than assumed.
- The arithmetic: `5 × 2 s = 10 s` for the update path, and why the archive's
  pre-lock **substitutes for** later waits rather than adding one (§2.4).
- That the pre-lock at the archive **reverses a documented decision** (§2.4.1)
  and what it costs: an archive now blocks booking on that template's future
  classes for its duration.
- That the copy change **keeps** PR 208's remedy and replaces only its state
  clause — not a revert.
- Which suites ran. `npm run verify` runs all three projects, so a green verify
  **is** the whole integration suite: state the arithmetic that proves it, and
  name the integration file this branch touched by path
  (`tests/integration/class-templates-api.test.ts`).
- Issues 83, 209 and 180 are closed by this branch. For anything **not** closed,
  write "issue N is unaffected" — never a closing keyword before a `#`.

## After merge

File one issue, framed as a **decision, not work**: the `{Class, ClassTemplate}`
order (spec §2.5). Both candidate orders with their costs; note that
`deleteTeacherAccount` is the single site on the minority side and carries its
own timeout arithmetic. Point `docs/lock-order.md`'s "Known violation" section
at it. Then update `docs/backlog-roadmap.md` — three closed, one filed — and
leave it untracked.
