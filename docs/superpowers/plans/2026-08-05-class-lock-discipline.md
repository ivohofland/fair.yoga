# Class-Lock Discipline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "a terminal class status never changes" true in Postgres rather than in seven call sites, and make every writer of `Class.status` or `WaitlistEntry.position` decide under the row it writes.

**Architecture:** Six site fixes land first, each with a test that can only pass because of that site's own change. The Postgres trigger lands last, so no lock test is ever written in a world where the trigger could satisfy it instead. A separate ordering fix removes the one lock-order inversion, which no mechanism can enforce.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma + PostgreSQL, Vitest (`unit` / `integration` / `components` projects).

**Spec:** `docs/superpowers/specs/2026-08-05-class-lock-discipline-design.md`

## Global Constraints

Every task's requirements implicitly include all of these.

- **TypeScript `strict: true`. No `any`, no implicit types.**
- **Never `git add -A` or `git add .`** — stage exact paths, listed in each commit step.
- **Never run `npx vitest run --project integration` without a file path.** One file in that project is IP rate-limited and a whole-project run trips it. Single files by explicit path are required.
- **Never start or restart the dev server on :3000.** The user runs it; the `integration` project talks to it.
- **Never edit an applied migration.** Prisma cannot express triggers or CHECK constraints, so hand-author following `prisma/migrations/20260721061528_student_claim_link_check/migration.sql`.
- **The `unit` project runs against `DATABASE_URL_TEST`** and `tests/setup/unit-db.ts` runs `prisma migrate deploy` on it automatically. A new migration reaches the unit test database without extra steps.
- **Every guard is mutation-proven:** break it, record the exact error text in the commit body, restore, re-verify. A guard that compiles but cannot fail certifies nothing.
- **Lock tests assert the *shape* of the refusal**, not merely that the bad state is absent. See Task 8's warning — after the trigger lands, "the class is still cancelled and there are no `Payment` rows" is satisfied by the trigger alone, so it cannot prove a lock.
- **`lock_timeout` is 2s on the three new lock sites.** Any test that holds a competing lock must hold it for **less than 2s**, or it will observe a lock timeout rather than the wait it is testing. `LOCK_HOLD_MS` in existing tests is 10s — do not copy that number into a test that contends with a new site.
- **Task order is load-bearing.** Tasks 1–7 must land before Task 8. The spec's hard constraint — gdpr's CAS ships with or before the trigger — is satisfied by Task 3 preceding Task 8; do not reorder them.

---

## File Structure

**Created:**
- `src/lib/db-locks.ts` — the one place that knows how to take the `Class` row lock with a bounded wait. Used by the three lock sites this branch adds. The five pre-existing sites keep their inline SQL; retrofitting them is #104's work, not this branch's.
- `prisma/migrations/<timestamp>_class_terminal_status_trigger/migration.sql` — the terminality trigger.
- `docs/lock-order.md` — the canonical table order, since nothing can enforce it.

**Modified:**
- `src/services/class-lifecycle.ts` — `transitionClass` (`:96-109`) to a CAS; `completeClass` (`:144`) gains the lock.
- `src/services/gdpr.ts` — cancel loop (`:434`) to a CAS; reorder loop (`:359-361`) gains the lock.
- `src/services/waitlist.ts` — `removeFromWaitlist` (`:296-311`) gains the lock; docblock at `:663-671` rewritten.
- `src/services/class-transitions.ts` — `autoCancelClasses` count (`:86`, `:107`) moves inside the transaction.
- `src/services/invitations.ts` — `acceptInvitation` (`:525-543`) reorders its two writes.
- `src/services/email-fallback.ts` — comment at `:69-80`.
- `src/lib/api-errors.ts` — classification for the trigger's SQLSTATE.

**Tests modified:** `src/services/class-lifecycle.test.ts`, `src/services/gdpr.test.ts`, `src/services/waitlist.test.ts`, `src/services/class-transitions.test.ts`, `tests/integration/invitations-api.test.ts`.

---

### Task 1: `transitionClass` decides by compare-and-swap

`transitionClass` reads at `:101`, validates at `:104`, and writes at `:107` — with **no transaction at all**, so the read and the write are separate autocommit statements. A teacher cancelling a class inside the 60-second auto-start sweep window (`src/lib/scheduler.ts:92`) gets `in_progress` written over `cancelled`; the next auto-complete tick then legitimately completes it and creates `Payment` rows.

**Files:**
- Modify: `src/services/class-lifecycle.ts:96-109`
- Test: `src/services/class-lifecycle.test.ts` (existing `describe('transitionClass (DB)')` at `:168`)

**Interfaces:**
- Consumes: `VALID_TRANSITIONS` (`src/services/class-lifecycle.ts:29-35`), `validateTransition` (`:59`), `TransitionDbResult` (`:88-90`).
- Produces: `sourceStatesFor(to: ClassStatus): ClassStatus[]`, exported from `src/services/class-lifecycle.ts`. `transitionClass`'s signature is unchanged: `(db: PrismaClient, classId: string, targetStatus: ClassStatus) => Promise<TransitionDbResult>`.

- [ ] **Step 1: Write the failing test**

Add to `src/services/class-lifecycle.test.ts`, inside `describe('transitionClass (DB)')`:

```ts
  it('refuses to write over a status that changed after the caller decided', async () => {
    const cls = await makeClass({ status: 'open' });

    // The interleaving, made deterministic: cancel the class, then ask for the
    // transition the sweep would have asked for holding a pre-cancel read.
    // A read-then-write implementation re-reads and refuses here, so that is
    // not what this pins. What it pins is the write itself being predicated:
    // the CAS matches zero rows and the class stays cancelled.
    await prisma.class.updateMany({
      where: { id: cls.id, status: 'open' },
      data: { status: 'cancelled' },
    });

    const result = await transitionClass(prisma, cls.id, 'in_progress');

    expect(result.ok).toBe(false);
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.status).toBe('cancelled');
  });

  it('reports a missing class differently from an illegal transition', async () => {
    const cls = await makeClass({ status: 'completed' });

    const illegal = await transitionClass(prisma, cls.id, 'open');
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.error).toMatch(/Invalid transition/);

    const missing = await transitionClass(prisma, 'no-such-class-id', 'open');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/Class not found/);
  });
```

`makeClass` is this file's existing fixture helper — read the top of the `describe` block and match how the neighbouring tests build a class. If it takes no `status` argument, create with the helper and then `prisma.class.update` to set the status, which is legal in both directions until Task 8.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts -t "refuses to write over a status"`

Expected: FAIL. The current implementation re-reads inside `transitionClass`, so the first test may in fact pass by accident — record which of the two fails and which does not. The second test is the one that must fail today, because the current code returns the `validateTransition` error for a missing class only after `findUnique` returns null, and both paths currently produce distinguishable errors. **If both tests pass before the change, the tests are wrong — say so and rewrite them rather than proceeding.** The falsification that matters is Step 6.

- [ ] **Step 3: Add the inverse of the state machine**

In `src/services/class-lifecycle.ts`, immediately after `canTransition` (`:50-53`):

```ts
/**
 * The states from which `to` is a legal move — the inverse of
 * `VALID_TRANSITIONS`, derived rather than hand-declared so the
 * compare-and-swap in `transitionClass` cannot drift from the state machine
 * when a transition is added or removed.
 */
export function sourceStatesFor(to: ClassStatus): ClassStatus[] {
  return (Object.keys(VALID_TRANSITIONS) as ClassStatus[]).filter((from) =>
    VALID_TRANSITIONS[from].includes(to),
  );
}
```

- [ ] **Step 4: Replace the read-then-write with a CAS**

Replace `src/services/class-lifecycle.ts:96-109` entirely:

```ts
/**
 * Transition a class to a new status in the database.
 *
 * Compare-and-swap, not read-then-write. The predicate IS the guard: under
 * READ COMMITTED the `UPDATE` re-evaluates `status` after it acquires the row
 * lock, so a cancel that commits between a caller's read and this write is
 * seen rather than written over. No `FOR UPDATE` and no transaction, because
 * the status is the only thing this decision depends on — the same reason
 * `POST /api/classes/[id]/transition`'s cancel branch and `autoCancelClasses`
 * are safe without one. Sites that read more state under the decision
 * (`completeClass`) take the lock instead; see `docs/lock-order.md`.
 */
export async function transitionClass(
  db: PrismaClient,
  classId: string,
  targetStatus: ClassStatus,
): Promise<TransitionDbResult> {
  const updated = await db.class.updateMany({
    where: { id: classId, status: { in: sourceStatesFor(targetStatus) } },
    data: { status: targetStatus },
  });
  if (updated.count === 1) return { ok: true, newStatus: targetStatus };

  // Nothing was written, so this read decides nothing that gets persisted —
  // it only tells the caller which refusal happened, and the route maps both
  // to a 409.
  const cls = await db.class.findUnique({ where: { id: classId }, select: { status: true } });
  if (!cls) return { ok: false, error: `Class not found: ${classId}` };

  const validation = validateTransition(cls.status, targetStatus);
  if (!validation.ok) return validation;

  // The CAS matched nothing, yet the status now permits the move: the row
  // changed twice while we were deciding. Refuse rather than retry — the
  // caller's decision was made against a world that no longer exists.
  return { ok: false, error: `Concurrent modification of class ${classId}` };
}
```

- [ ] **Step 5: Run the full file to verify nothing regressed**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts`
Expected: PASS, including the two new tests and the pre-existing `transitionClass (DB)` cases at `:238`, `:266`, `:278`.

- [ ] **Step 6: Mutation-prove the CAS**

Temporarily revert only the `where` clause to `{ id: classId }` (dropping the `status` predicate). Run the same file. Record the exact failure text in the commit body. Restore the predicate and re-run to confirm green.

Expected: the "refuses to write over a status that changed" test fails, showing `cancelled` became `in_progress`.

- [ ] **Step 7: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts
git commit -m "fix: transitionClass wrote its status from an unlocked read, in no transaction at all (#174)"
```

---

### Task 2: `completeClass` takes the class lock before the read it decides from

`completeClass` reads at `src/services/class-lifecycle.ts:149` and decides at `:156`/`:161`, but the row lock arrives only with the first `update` at `:159`. The same unlocked read also supplies `cls.registrations`, which drives the pricing engine and the `payment.create` at `:208`.

**Files:**
- Create: `src/lib/db-locks.ts`
- Modify: `src/services/class-lifecycle.ts:144-153`
- Test: `src/services/class-lifecycle.test.ts` (existing `describe('completeClass (DB)')` at `:286`)

**Interfaces:**
- Produces: `lockClassRow(tx: Prisma.TransactionClient, classId: string): Promise<void>`, exported from `src/lib/db-locks.ts`. Consumed again by Tasks 4 and 5.

- [ ] **Step 1: Write the failing test**

Add to `src/services/class-lifecycle.test.ts` inside `describe('completeClass (DB)')`:

```ts
  /**
   * The lock cannot be seen in the rows afterwards — it is the timing that
   * differs. Hold the class row in another transaction and `completeClass`
   * must not get past it. Held for well under the 2s `lock_timeout` the new
   * site sets, so this observes the wait and not the timeout.
   */
  it('waits for a class row another transaction holds, instead of deciding around it', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    let holderReleased = false;

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 900));
        holderReleased = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const completing = completeClass(prisma, cls.id).then(() => 'returned' as const);
    const outcome = await Promise.race([
      completing,
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
    ]);

    expect(outcome).toBe('waiting');
    expect(holderReleased).toBe(false);

    await holder;
    expect(await completing).toBe('returned');
  });

  /**
   * The refusal's SHAPE is the assertion, not the absence of Payment rows.
   * After the terminality trigger lands (Task 8), "no Payment rows" is
   * satisfied by the trigger alone and would no longer prove this lock.
   */
  it('refuses cleanly when the class was cancelled while it waited', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    await prisma.class.updateMany({
      where: { id: cls.id, status: 'in_progress' },
      data: { status: 'cancelled' },
    });

    const result = await completeClass(prisma, cls.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid transition/);
    expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);
  });
```

- [ ] **Step 2: Run to verify the wait test fails**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts -t "waits for a class row"`
Expected: FAIL — without the lock, `completeClass` proceeds past the holder and `outcome` is `'returned'`, not `'waiting'`.

- [ ] **Step 3: Create the shared lock helper**

Create `src/lib/db-locks.ts`:

```ts
import type { Prisma } from '@prisma/client';

/**
 * Takes the `Class` row lock with a bounded wait.
 *
 * `SET LOCAL` scopes the timeout to the calling transaction, so it is
 * released with it. 2s matches the two template-claim sites
 * (`class-generator.ts:140`, `studio-class-generator.ts:31`) — the only other
 * bounded lock waits in the codebase.
 *
 * The five pre-existing `FOR UPDATE` sites deliberately do NOT use this and
 * keep their inline SQL: three in `waitlist.ts`, one in
 * `withdrawWaitingEntriesForTeacher`, one in `POST /api/registrations`. All
 * five take an unbounded wait, which is #104's subject, and retrofitting them
 * from here would blur what that issue is accountable for. The three sites
 * added by #174 take the bound because one of them
 * (`deleteStudentAccount`'s reorder loop) runs inside the erasure
 * transaction, where an unbounded block on a row the 60-second transitions
 * sweep can hold would hang a legally time-bound operation.
 *
 * Must be given a transaction client. On a bare `PrismaClient` each statement
 * is its own transaction, so the lock would be released before it was useful
 * and `SET LOCAL` would apply to nothing.
 */
export async function lockClassRow(
  tx: Prisma.TransactionClient,
  classId: string,
): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
  await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
}
```

- [ ] **Step 4: Take the lock in `completeClass`**

In `src/services/class-lifecycle.ts`, add the import beside the existing service imports:

```ts
import { lockClassRow } from '@/lib/db-locks';
```

Then insert as the first statement inside the transaction, immediately before the `findUnique` at `:149`:

```ts
  return db.$transaction(async (tx) => {
    // Before the read, not with the first write. Everything below decides
    // from this row — the status gate, the registration set the pricing
    // engine consumes, and the Payment rows created from it — so the read
    // has to happen under the lock rather than the update acquiring it after
    // the decision is already made.
    await lockClassRow(tx, classId);

    const cls = await tx.class.findUnique({
```

- [ ] **Step 5: Run the file**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts`
Expected: PASS, including the pre-existing completion and billing tests at `:402`, `:464`, `:585`.

- [ ] **Step 6: Mutation-prove the lock**

Comment out the `await lockClassRow(tx, classId);` line. Run the file. Record the exact failure text. Restore and re-verify green.

Expected: "waits for a class row another transaction holds" fails with `outcome` `'returned'` instead of `'waiting'`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db-locks.ts src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts
git commit -m "fix: completeClass ran the pricing engine on a class it had not yet locked (#174)"
```

---

### Task 3: `deleteTeacherAccount` cancels by compare-and-swap

`src/services/gdpr.ts:423` reads classes filtered to `draft`/`open`/`in_progress`; `:434` then writes `cancelled` **unconditionally**. A class that reaches `completed` in between is force-cancelled after its `Payment` rows exist and its students have been told to pay.

**This task must land before Task 8.** With the trigger present and this CAS absent, the raise aborts the erasure transaction and a GDPR deletion request fails outright.

**Files:**
- Modify: `src/services/gdpr.ts:433-450`
- Test: `src/services/gdpr.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. `deleteTeacherAccount(db: PrismaClient, teacherId: string): Promise<void>` is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `src/services/gdpr.test.ts`, in the teacher-erasure describe block:

```ts
  it('leaves a class that completed after the erasure read alone, and still erases', async () => {
    const { teacherId, classId } = await makeTeacherWithClass({ status: 'in_progress' });

    // Stand in for the interleaving: the class is completed before erasure's
    // write runs. The unconditional update overwrote this; the CAS does not.
    await prisma.class.updateMany({
      where: { id: classId, status: 'in_progress' },
      data: { status: 'completed' },
    });

    await deleteTeacherAccount(prisma, teacherId);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('completed');

    // And the erasure itself still completed — the point is to skip the
    // class, not to abandon the request.
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.email).toMatch(/@deleted\.invalid$/);
  });
```

Match `makeTeacherWithClass` to whatever fixture helper this file already uses; read the top of the file and follow it rather than inventing one.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t "leaves a class that completed"`
Expected: FAIL — `after.status` is `'cancelled'`, because `:434` writes unconditionally.

- [ ] **Step 3: Replace the unconditional update with a CAS**

In `src/services/gdpr.ts`, replace the body of the `for (const cls of upcoming)` loop's first two statements (`:434-438`):

```ts
      for (const cls of upcoming) {
        // Compare-and-swap against the same statuses the read above filtered
        // on. The read is not under the row lock, so a class can reach
        // `completed` between it and here — a sweep's `completeClass` doing
        // exactly that is the window `email-fallback.ts` describes. Cancelling
        // it anyway would strip a class that already has Payment rows and
        // students who have been asked to pay.
        //
        // Skipping is the whole handling: a completed class is one erasure
        // deliberately leaves standing (see this function's docblock), so
        // landing on one late is not an error, it is the same outcome by a
        // different route.
        const cancelled = await tx.class.updateMany({
          where: { id: cls.id, status: { in: ['draft', 'open', 'in_progress'] } },
          data: { status: 'cancelled' },
        });
        if (cancelled.count === 0) continue;

        await tx.waitlistEntry.updateMany({
          where: { classId: cls.id, status: 'waiting' },
          data: { status: 'removed' },
        });
```

Leave the notification block below it unchanged — it is now only reached for classes this transaction actually cancelled, which is what it always meant.

- [ ] **Step 4: Run the file**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the erasure integration test too**

Run: `npx vitest run --project integration tests/integration/account-api.test.ts`
Expected: PASS. This file exercises `deleteTeacherAccount` end to end and its comments at `:253-258` already reason about `completeClass` failing and falling through.

- [ ] **Step 6: Mutation-prove the CAS**

Revert the `where` to `{ id: cls.id }` and drop the `continue`. Run `src/services/gdpr.test.ts`. Record the exact failure text. Restore and re-verify.

- [ ] **Step 7: Commit**

```bash
git add src/services/gdpr.ts src/services/gdpr.test.ts
git commit -m "fix: erasure cancelled classes it had read as upcoming, including ones that completed in between (#174)"
```

---

### Task 4: `removeFromWaitlist` takes the class lock

`src/services/waitlist.ts:296-311` marks an entry `removed` and calls `reorderWaitingEntries` with no lock. Three of the four locked writers call the same renumbering function inside their own locked transactions, so two renumberings of one queue can interleave, each having read a snapshot the other invalidated. `WaitlistEntry` has no unique on `(classId, position)` (`prisma/schema.prisma:521-522`), so the result is silent skew, and `promoteNext` picks its head by `orderBy: { position: 'asc' }` (`:375-378`).

**Files:**
- Modify: `src/services/waitlist.ts:296-311`
- Test: `src/services/waitlist.test.ts`

**Interfaces:**
- Consumes: `lockClassRow` from `src/lib/db-locks.ts` (Task 2).
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

**Deliberate deviation from the spec's acceptance 3, recorded rather than
silent.** The spec asks for a test "interleaving one with `promoteNext`". This
uses a raw lock holder instead, because racing a real `promoteNext` tests the
same property with a nondeterministic interleaving — which is how a lock test
ends up passing by luck. `tests/integration/invitations-api.test.ts:2752-2758`
says exactly this about the equivalent test for
`withdrawWaitingEntriesForTeacher`, and this follows it. The substance of
acceptance 3 is kept: positions are asserted `1..n` with no duplicates, and the
test fails when the lock is removed (Step 6).

Add to `src/services/waitlist.test.ts`:

```ts
  /**
   * Held for under the 2s `lock_timeout` this site now sets, so what this
   * observes is the wait and not the timeout.
   */
  it('waits for a class row another transaction holds before renumbering', async () => {
    const { classId, studentIds } = await makeQueue(3);
    let holderReleased = false;

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 900));
        holderReleased = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const removing = removeFromWaitlist(prisma, classId, studentIds[1]!).then(
      () => 'returned' as const,
    );
    const outcome = await Promise.race([
      removing,
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
    ]);

    expect(outcome).toBe('waiting');
    expect(holderReleased).toBe(false);

    await holder;
    expect(await removing).toBe('returned');

    // And the queue it renumbered under the lock is intact.
    const remaining = await prisma.waitlistEntry.findMany({
      where: { classId, status: 'waiting' },
      orderBy: { position: 'asc' },
    });
    expect(remaining.map((e) => e.position)).toEqual([1, 2]);
  });
```

`makeQueue` is this file's existing helper for building a class with N waiting students — read the file and use whatever it actually provides rather than adding a second one.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/services/waitlist.test.ts -t "waits for a class row another transaction holds before renumbering"`
Expected: FAIL — `outcome` is `'returned'`; without the lock the removal sails past the holder.

- [ ] **Step 3: Take the lock**

In `src/services/waitlist.ts`, add to the imports:

```ts
import { lockClassRow } from '@/lib/db-locks';
```

Replace the transaction body at `:301-310`:

```ts
  await db.$transaction(async (tx) => {
    // The same lock `addToWaitlist`, `promoteNext`, `claimSpot` and
    // `withdrawWaitingEntriesForTeacher` take. Without it two renumberings of
    // one queue interleave, each having read a snapshot the other
    // invalidated, and nothing errors: there is no unique on
    // `(classId, position)`, only a plain index. `promoteNext` then picks its
    // head by lowest position and promotes the wrong student.
    await lockClassRow(tx, classId);

    // Mark as removed
    await tx.waitlistEntry.update({
      where: { classId_studentId: { classId, studentId } },
      data: { status: 'removed' },
    });

    // Reorder remaining 'waiting' entries
    await reorderWaitingEntries(tx, classId);
  });
```

- [ ] **Step 4: Run the file**

Run: `npx vitest run --project unit src/services/waitlist.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the waitlist route tests**

Run: `npx vitest run --project integration tests/integration/waitlist-api.test.ts`
Expected: PASS. `DELETE /api/waitlist/[id]` (`src/app/api/waitlist/[id]/route.ts:34`) is this function's caller.

- [ ] **Step 6: Mutation-prove the lock**

Comment out `await lockClassRow(tx, classId);`. Run `src/services/waitlist.test.ts`. Record the exact failure text. Restore and re-verify.

- [ ] **Step 7: Commit**

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts
git commit -m "fix: DELETE /api/waitlist/[id] renumbered the queue with no class lock (#174)"
```

---

### Task 5: `deleteStudentAccount`'s reorder takes the class lock

`src/services/gdpr.ts:359-361` calls `reorderWaitingEntries` for each class the erased student was waiting in, with no class lock. **This is not covered by #174's escape argument** — that argument turns on `removeFromWaitlist` only moving entries *out* of `waiting`, but this renumbers rows belonging to *other* students, concurrently with the three locked writers that also write `position` on the same class.

**Files:**
- Modify: `src/services/gdpr.ts:359-361`
- Test: `src/services/gdpr.test.ts`

**Interfaces:**
- Consumes: `lockClassRow` from `src/lib/db-locks.ts` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `src/services/gdpr.test.ts`, in the student-erasure describe block:

```ts
  it('waits for a class row another transaction holds before renumbering other students', async () => {
    const { studentId, classId } = await makeStudentWaitingInClass();
    let holderReleased = false;

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 900));
        holderReleased = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const erasing = deleteStudentAccount(prisma, studentId).then(() => 'returned' as const);
    const outcome = await Promise.race([
      erasing,
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
    ]);

    expect(outcome).toBe('waiting');
    expect(holderReleased).toBe(false);

    await holder;
    expect(await erasing).toBe('returned');
  });
```

Use this file's existing student fixture helpers; add a waiting entry with `prisma.waitlistEntry.create` if no helper produces one.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t "waits for a class row another transaction holds before renumbering"`
Expected: FAIL — `outcome` is `'returned'`.

- [ ] **Step 3: Take the lock per class**

In `src/services/gdpr.ts`, ensure `lockClassRow` is imported, then replace `:359-361`:

```ts
    // Locked per class, in the order `waitingClassIds` came back in, so two
    // concurrent erasures take multiple classes in the same sequence and
    // cannot cycle. Not covered by the escape argument in
    // `waitlist.ts`'s `withdrawWaitingEntriesForTeacher` docblock: that turns
    // on only ever moving an entry OUT of `waiting`, and this renumbers rows
    // belonging to OTHER students, racing the three locked writers that also
    // write `position` on the same class.
    //
    // The 2s bound in `lockClassRow` matters most here: this runs inside the
    // erasure transaction, which by now holds locks on StudentPrivacy,
    // TeacherStudent, WaitlistEntry, Invitation and Notification. An
    // unbounded wait on a row the transitions sweep holds would hang a
    // legally time-bound request.
    for (const classId of [...waitingClassIds].sort()) {
      await lockClassRow(tx, classId);
      await reorderWaitingEntries(tx, classId);
    }
```

- [ ] **Step 4: Run the file**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the account route tests**

Run: `npx vitest run --project integration tests/integration/account-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-prove the lock**

Remove the `await lockClassRow(tx, classId);` line, keeping the loop. Run `src/services/gdpr.test.ts`. Record the exact failure text. Restore and re-verify.

- [ ] **Step 7: Commit**

```bash
git add src/services/gdpr.ts src/services/gdpr.test.ts
git commit -m "fix: student erasure renumbered other students' queue positions with no class lock (#174)"
```

---

### Task 6: `autoCancelClasses` counts inside its transaction

The CAS at `src/services/class-transitions.ts:113` predicates on `status = 'open'`, which is correct — but `activeCount` (`:107`) comes from `cls.registrations`, read by the `findMany` at `:86`, **outside** the transaction. A registration committing between `:86` and `:113` cancels a class that has just reached its minimum, and notifies every student that it is off.

Different invariant from the rest of this branch (a count, not a status), same file, and live.

**Files:**
- Modify: `src/services/class-transitions.ts:99-140`
- Test: `src/services/class-transitions.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/services/class-transitions.test.ts`:

```ts
  it('does not cancel a class a registration brought up to minimum after the sweep read it', async () => {
    // minStudents 2, one registration: inside the check window and below
    // minimum at the moment the sweep's outer read runs.
    const { classId, studentIds } = await makeClassInCancelWindow({ minStudents: 2, registered: 1 });

    // The interleaving, made deterministic: the second student registers
    // before the sweep's own transaction runs its count. With the count taken
    // from the outer snapshot this is invisible and the class is cancelled.
    await prisma.registration.create({
      data: { classId, studentId: studentIds[1]!, status: 'registered', tierAtBooking: 3 },
    });

    await autoCancelClasses(prisma, nowInsideWindow);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('open');
    expect(
      await prisma.notification.count({ where: { relatedClassId: classId, type: 'class_cancelled' } }),
    ).toBe(0);
  });
```

Build `makeClassInCancelWindow` and `nowInsideWindow` from this file's existing clock-injection helpers — every test here already passes an explicit `now`, so follow that. `tierAtBooking` must be 1–5; a CHECK constraint enforces it (`prisma/migrations/20260802150845_income_tier_range_check/`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/services/class-transitions.test.ts -t "does not cancel a class a registration brought up to minimum"`
Expected: FAIL — the class is `'cancelled'`, because the count came from the pre-registration snapshot.

- [ ] **Step 3: Move the count inside the transaction**

In `src/services/class-transitions.ts`, replace `:107-137` so the count is read under the transaction and the CAS is gated on it:

```ts
        // Cancel + notify atomically: a cancelled class nobody was told
        // about is worse than one that stays open one more sweep.
        const didCancel = await db.$transaction(async (tx) => {
          // Counted HERE, not from the sweep's outer `findMany` at the top of
          // this function. That read is a snapshot taken before this
          // transaction began, so a registration committing in between is
          // invisible to it — and cancelling a class that has just reached
          // its minimum tells every student it is off when it is not. The
          // status CAS below cannot catch this: the status is still `open`,
          // it is the count that moved.
          const activeCount = await tx.registration.count({
            where: { classId: cls.id, status: { in: ['registered', 'attended', 'no_show'] } },
          });
          if (activeCount >= cls.minStudents) return false;

          const updated = await tx.class.updateMany({
            where: { id: cls.id, status: 'open' },
            data: { status: 'cancelled' },
          });
          if (updated.count === 0) return false;

          const registrations = await tx.registration.findMany({
            where: { classId: cls.id, status: { in: ['registered', 'attended', 'no_show'] } },
            select: { studentId: true },
          });

          const notifications: CreateNotificationInput[] = registrations.map((r) => ({
            recipientType: 'student' as const,
            recipientId: r.studentId,
            type: 'class_cancelled' as const,
            title: 'Class cancelled',
            body: `${cls.classType} class has been cancelled due to insufficient registrations.`,
            relatedClassId: cls.id,
          }));
          notifications.push({
            recipientType: 'teacher',
            recipientId: cls.teacherId,
            type: 'class_cancelled',
            title: 'Class auto-cancelled',
            body: `${cls.classType} was cancelled — only ${activeCount} of ${cls.minStudents} minimum students registered.`,
            relatedClassId: cls.id,
          });
          await createBulkNotifications(tx, notifications);
          return true;
        });
```

Then delete the now-unused `const activeCount = cls.registrations.length;` at `:107` and its `if (activeCount < cls.minStudents) {` wrapper, keeping the window check at `:106`. The recipient list is now read inside the transaction too, so the notification set matches the count the decision used.

- [ ] **Step 4: Run the file**

Run: `npx vitest run --project unit src/services/class-transitions.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-prove the count**

Revert the in-transaction `tx.registration.count` to `cls.registrations.length`. Run the file. Record the exact failure text. Restore and re-verify.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-transitions.ts src/services/class-transitions.test.ts
git commit -m "fix: auto-cancel decided from a registration count read outside its own transaction (#174)"
```

---

### Task 7: One lock order for `Invitation` and `TeacherStudent`

`acceptInvitation` takes `Invitation` (`src/services/invitations.ts:526`) then `TeacherStudent` (`:535`). `unlinkTeacher` takes `TeacherStudent` (`:653`) then `Invitation` (`:696`). Two further sites agree with `unlinkTeacher`: `deleteStudentAccount` (`src/services/gdpr.ts:275` → `:297`) and `deleteTeacherAccount` (`:455` → `:475`). So three sites already take `TeacherStudent` first and `acceptInvitation` is the lone outlier — the canonical order is not a coin flip.

**#174's acceptance criterion 3 requires the deadlock be reproduced before it is fixed.** If it will not reproduce, that is a finding to record in the issue, not a reason to reorder on faith.

**Files:**
- Modify: `src/services/invitations.ts:525-543`
- Create: `docs/lock-order.md`
- Test: `tests/integration/invitations-api.test.ts`

- [ ] **Step 1: Reproduce the deadlock first**

Add to `tests/integration/invitations-api.test.ts`. Do **not** change `invitations.ts` yet.

```ts
  /**
   * Reproduces the cycle before it is closed (#174 acceptance 3). Two
   * transactions, forced to interleave: A takes Invitation then reaches for
   * TeacherStudent; B takes TeacherStudent then reaches for Invitation.
   * Postgres breaks the cycle with 40P01.
   *
   * Preconditions are both real: the link exists because the student booked a
   * class, and the invitation is still pending because the teacher added them
   * as a CRM contact separately.
   */
  it('deadlocks when Invitation and TeacherStudent are taken in opposite orders', async () => {
    const { teacherId, studentId, email, invitationId } = await makeLinkedStudentWithPendingInvite();

    let bReady!: () => void;
    const bHasLink = new Promise<void>((r) => { bReady = r; });

    const a = prisma.$transaction(async (tx) => {
      await tx.invitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      await bHasLink;
      await tx.teacherStudent.upsert({
        where: { teacherId_studentId: { teacherId, studentId } },
        update: {},
        create: { teacherId, studentId },
      });
    }, { timeout: 15_000 });

    const b = prisma.$transaction(async (tx) => {
      await tx.teacherStudent.deleteMany({ where: { teacherId, studentId } });
      bReady();
      await new Promise((r) => setTimeout(r, 200));
      await tx.invitation.updateMany({
        where: { teacherId, email },
        data: { status: 'declined', respondedAt: new Date() },
      });
    }, { timeout: 15_000 });

    const results = await Promise.allSettled([a, b]);
    const rejections = results.filter((r) => r.status === 'rejected');
    expect(rejections).toHaveLength(1);
    expect(String((rejections[0] as PromiseRejectedResult).reason)).toMatch(/40P01|deadlock/i);
  });
```

- [ ] **Step 2: Run it and record what actually happened**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts -t "deadlocks when Invitation and TeacherStudent"`

Expected: PASS — one transaction aborts with `40P01`.

**If it does not reproduce**, stop and report before changing any source. Record what was observed instead (both committed? one blocked and then succeeded?) and why. `upsert({ update: {} })` may not emit a row lock, which would mean the cycle never forms — that is a real finding and it changes the fix.

- [ ] **Step 3: Settle what `upsert({ update: {} })` actually emits**

Run one query-logged reproduction and read the SQL:

```bash
DEBUG=prisma:query npx vitest run --project integration tests/integration/invitations-api.test.ts -t "deadlocks when Invitation and TeacherStudent" 2>&1 | grep -i "insert\|on conflict\|select.*TeacherStudent" | head -20
```

Record whether the upsert became `INSERT … ON CONFLICT DO UPDATE` (takes the row lock) or degraded to a bare `SELECT` (takes none). This decides whether the `{TeacherBlock, Invitation}` pair described in the spec is protected by a shared prior `TeacherStudent` lock or is live. Put the answer in the commit body; if it is live, file it rather than widening this task.

- [ ] **Step 4: Reorder `acceptInvitation`**

Replace `src/services/invitations.ts:525-543`:

```ts
  const accepted = await db.$transaction(async (tx) => {
    // `TeacherStudent` BEFORE `Invitation`, and that ordering is a
    // correctness requirement rather than a style note. `unlinkTeacher`,
    // `deleteStudentAccount` and `deleteTeacherAccount` all take these two
    // rows in that order; taking them the other way round here made a genuine
    // cycle, which Postgres breaks with 40P01 and `withErrorHandler` turns
    // into a 500. See `docs/lock-order.md`.
    //
    // Upserting first is safe to do unconditionally: the link is not the
    // thing being decided. If the `updateMany` below then matches nothing —
    // a concurrent decline or unlink got there first — the transaction rolls
    // back and the upsert goes with it.
    await tx.teacherStudent.upsert({
      where: {
        teacherId_studentId: { teacherId: invitation.teacherId, studentId: input.studentId },
      },
      update: {},
      create: { teacherId: invitation.teacherId, studentId: input.studentId },
    });

    // The pending check lives in this `updateMany`'s `where`, not in a read
    // beforehand — a concurrent accept and decline from the same account
    // (the only account that can ever pass the email match above) would
    // otherwise both pass a separate status read and race to leave a
    // `TeacherStudent` link sitting beside a `declined` invitation.
    const updated = await tx.invitation.updateMany({
      where: { id: invitation.id, status: 'pending' },
      data: { status: 'accepted', respondedAt: new Date() },
    });
    if (updated.count === 0) throw new NotPendingError();

    return true;
  }).catch((err: unknown) => {
    if (err instanceof NotPendingError) return false;
    throw err;
  });
```

The early `return false` had to become a throw: returning normally would commit the upsert that the refusal is supposed to discard. Declare the sentinel beside the function:

```ts
/**
 * Rolls back `acceptInvitation`'s transaction when the invitation is no
 * longer pending. A plain `return false` would commit the `TeacherStudent`
 * upsert taken above it — the link would exist for an invitation that was
 * never accepted.
 */
class NotPendingError extends Error {}
```

- [ ] **Step 5: Turn the reproduction into a regression test**

Change the test from Step 1 so transaction A calls the real `acceptInvitation` instead of hand-rolling the write order, and assert **no** rejection:

```ts
    const results = await Promise.allSettled([
      acceptInvitation(prisma, { invitationId, studentId, accountEmail: email }),
      b,
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
```

Rename it to `'does not deadlock when an accept races an unlink'` and keep the original hand-rolled version alongside it, renamed `'the opposite order still deadlocks — pinning why acceptInvitation was changed'`, so the cycle stays demonstrated after the fix.

- [ ] **Step 6: Run both**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify the acceptance path still refuses correctly**

Run: `npx vitest run --project unit src/services/invitations.pending.test.ts src/services/invitations.revive.test.ts src/services/invitations.notify.test.ts`
Expected: PASS. The `NOT_PENDING` refusal must still be `{ ok: false, reason: 'NOT_PENDING' }` and must leave **no** `TeacherStudent` row — add that assertion if no existing test makes it.

- [ ] **Step 8: Write the lock order down**

Create `docs/lock-order.md`:

```markdown
# Lock order

Nothing enforces this. It is a convention, and the only defence against a
deadlock is that every transaction taking two of these rows takes them in this
order:

    Class → WaitlistEntry → Registration → TeacherStudent → Invitation → TeacherBlock

## Why it is written down rather than enforced

Postgres breaks a genuine cycle by aborting one transaction with `40P01`, which
reaches the user as a 500 through `withErrorHandler`. No constraint, trigger or
type can prevent the cycle forming — only the order can.

## Known conformance

- `unlinkTeacher` (`src/services/invitations.ts`) — Class/WaitlistEntry via
  `withdrawWaitingEntriesForTeacher`, then TeacherStudent, StudentPrivacy,
  Invitation, TeacherBlock. `withdrawWaitingEntriesForTeacher` must stay first;
  its docblock (`src/services/waitlist.ts:676-680`) explains why.
- `acceptInvitation` — TeacherStudent then Invitation. Was the other way round
  until #174; the deadlock is pinned in
  `tests/integration/invitations-api.test.ts`.
- `deleteStudentAccount`, `deleteTeacherAccount` (`src/services/gdpr.ts`) —
  TeacherStudent then Invitation.

## Known violation, not fixed here

`deleteTeacherAccount` takes Class before ClassTemplate; the generator
(`src/services/class-generator.ts`) and three template paths take them in the
opposite order, and that counterparty is a sweep that runs continuously.
Choosing a canonical order there touches the whole template family, so it is
filed as a decision rather than resolved from here.
```

- [ ] **Step 9: Commit**

```bash
git add src/services/invitations.ts tests/integration/invitations-api.test.ts docs/lock-order.md
git commit -m "fix: accept and unlink took Invitation and TeacherStudent in opposite orders (#174)"
```

---

### Task 8: The terminality invariant moves into Postgres

**Land this only after Tasks 1–7.** Every lock test above was written in a world where the trigger does not exist, which is what makes those tests prove their own site's change. Landing the trigger first would let it satisfy them and leave the locks unfalsifiable — the #167 shape this branch exists to avoid.

`VALID_TRANSITIONS` (`src/services/class-lifecycle.ts:29-35`) makes `completed` and `cancelled` terminal. Terminality only — deliberately not a mirror of the whole table, because `src/services/class-template-lifecycle.test.ts:592-597` sets a fresh class straight to `completed` and a full-table trigger would break it.

**Files:**
- Create: `prisma/migrations/<timestamp>_class_terminal_status_trigger/migration.sql`
- Modify: `src/lib/api-errors.ts`
- Test: `tests/integration/class-terminal-status.test.ts` (new)

- [ ] **Step 1: Write the migration**

Create the directory as `prisma/migrations/<YYYYMMDDHHMMSS>_class_terminal_status_trigger/`, using the 14-digit format every existing migration uses and a timestamp later than the current latest, `20260805074500_invitation_check_constraints`. Confirm the latest first with `ls prisma/migrations/ | tail -3`.

```sql
-- Invariant, DB-enforced: a terminal class status never changes. `completed`
-- and `cancelled` are terminal in VALID_TRANSITIONS (services/class-lifecycle.ts)
-- and three separate sites could write past one, each deciding from a read
-- taken before it held the row. Those three are fixed; this covers every
-- future one.
--
-- Terminality only, NOT a mirror of VALID_TRANSITIONS. Mirroring the whole
-- table would put a second source of truth in SQL, and it would reject
-- open -> completed, which class-template-lifecycle.test.ts:592-597 does
-- deliberately when building a fixture.
--
-- Fires only on an actual status change, so updates to other columns of a
-- completed class (description, financial totals written by completeClass in
-- the same statement as the status) are unaffected.
CREATE OR REPLACE FUNCTION class_reject_terminal_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION
      'Class % is %, which is terminal; cannot change status to %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_terminal_status_guard
  BEFORE UPDATE OF status ON "Class"
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION class_reject_terminal_status_change();
```

`ERRCODE = '23514'` is `check_violation` — a real SQLSTATE rather than the default `P0001`, so it is matchable without parsing the message.

- [ ] **Step 2: Apply it and confirm it is recorded**

Run: `npx prisma migrate dev`
Expected: the migration applies and appears in `_prisma_migrations`. Do not use `db push`.

- [ ] **Step 3: Write the test, and measure the error shape rather than assuming it**

Create `tests/integration/class-terminal-status.test.ts`:

```ts
  it('refuses to change the status of a cancelled class, and says so with a matchable code', async () => {
    const { classId } = await makeClass({ status: 'open' });
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'cancelled' },
    });

    let caught: unknown;
    try {
      await prisma.class.update({ where: { id: classId }, data: { status: 'open' } });
    } catch (err) {
      caught = err;
    }

    // Printed on purpose the first time this runs: the plan does not assume
    // which Prisma error class wraps a trigger's SQLSTATE. Read it, then
    // tighten this assertion to what was actually observed.
    console.log('[terminal-status] observed error:', caught);

    expect(caught).toBeDefined();
    expect(String(caught)).toMatch(/terminal/);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('cancelled');
  });

  it('leaves non-status updates to a completed class alone', async () => {
    const { classId } = await makeClass({ status: 'open' });
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'in_progress' },
    });
    await prisma.class.updateMany({
      where: { id: classId, status: 'in_progress' },
      data: { status: 'completed' },
    });

    await prisma.class.update({ where: { id: classId }, data: { description: 'Edited after' } });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.description).toBe('Edited after');
    expect(after.status).toBe('completed');
  });
```

- [ ] **Step 4: Run it and read the observed error**

Run: `npx vitest run --project integration tests/integration/class-terminal-status.test.ts`
Expected: PASS, with the `console.log` naming the concrete error class and code.

**Record the observed class and code.** Then replace the loose `String(caught)` assertion with a precise one against what was seen, and remove the `console.log`.

- [ ] **Step 5: Classify the error at the API boundary**

In `src/lib/api-errors.ts`, add a branch to `classifyApiError` **above** the P2002 branch, written against the error shape observed in Step 4:

```ts
  // The terminality trigger (migration 20260805120000) raises with SQLSTATE
  // 23514. Reaching here means a status write lost a race that its own CAS or
  // row lock should have caught — every writer has one since #174 — so this
  // is a 409 and a `warn`, the same reading as the P2002 branch below: not an
  // outage, but worth knowing a guard was bypassed.
  if (isTerminalStatusViolation(error)) {
    return {
      status: 409,
      message: 'That class can no longer change status',
      logMessage: 'terminal class status change reached the DB trigger',
      level: 'warn',
      detail: {},
    };
  }
```

Write `isTerminalStatusViolation` in the same file against the observed shape. If Step 4 showed `PrismaClientKnownRequestError` with a `meta.code` of `'23514'`, match that; if it showed `PrismaClientUnknownRequestError`, match on the message containing the SQLSTATE. **Do not guess — use what Step 4 printed.**

- [ ] **Step 6: Test the classification directly**

Add to `src/lib/api-errors.test.ts` (create it if this file has no test yet — check first):

```ts
  it('maps the terminal-status trigger to a 409, not a 500', () => {
    const failure = classifyApiError(terminalStatusErrorFixture);
    expect(failure.status).toBe(409);
    expect(failure.level).toBe('warn');
  });
```

Build `terminalStatusErrorFixture` from the real error captured in Step 4 rather than a hand-written approximation.

- [ ] **Step 7: Mutation-prove the trigger**

In a scratch psql session against the **test** database (`DATABASE_URL_TEST`), drop the trigger, re-run `tests/integration/class-terminal-status.test.ts`, and confirm the first test fails. Then re-apply by running `npx prisma migrate reset` against the test database, or `CREATE TRIGGER` by hand from the migration file.

```bash
docker exec -i fairyoga-db-1 psql -U postgres -d <test-db-name> \
  -c 'DROP TRIGGER class_terminal_status_guard ON "Class";'
```

Record the exact failure text. **Never do this against the dev database, and never edit the applied migration.**

- [ ] **Step 8: Run the whole unit project and the touched integration files**

Run: `npx vitest run --project unit`
Run: `npx vitest run --project integration tests/integration/class-terminal-status.test.ts tests/integration/account-api.test.ts tests/integration/classes-api.test.ts tests/integration/waitlist-api.test.ts tests/integration/invitations-api.test.ts`
Expected: PASS. The spec measured zero fixtures breaking; if one does, that measurement was wrong — say so rather than editing the fixture to suit.

- [ ] **Step 9: Commit**

```bash
git add prisma/migrations src/lib/api-errors.ts src/lib/api-errors.test.ts tests/integration/class-terminal-status.test.ts
git commit -m "feat: a terminal class status can no longer change, enforced in Postgres (#174)"
```

---

### Task 9: Correct the comments that say something untrue

Two comments describe the world before this branch. §4 of the process: once a claim is wrong, correct it in every artifact, not just the one in front of you.

**Files:**
- Modify: `src/services/waitlist.ts:663-671`
- Modify: `src/services/email-fallback.ts:69-85`

- [ ] **Step 1: Rewrite the `withdrawWaitingEntriesForTeacher` docblock**

`src/services/waitlist.ts:663-671` currently says `removeFromWaitlist` "writes `status` — and `position`, through `reorderWaitingEntries` — with no lock at all" and that "It is filed as #174". Both are now false. Replace that paragraph:

```
 * Every writer of this queue now opens with the class row lock:
 * `addToWaitlist`, `promoteNext`, `claimSpot`, `removeFromWaitlist` and this
 * one, plus `deleteStudentAccount`'s renumbering loop in `gdpr.ts`. That was
 * not true until #174 — `removeFromWaitlist` took none, and neither did the
 * erasure loop, which renumbers OTHER students' entries and so was never
 * covered by the argument below.
 *
 * The three sites #174 added take a 2s `lock_timeout` via `lockClassRow`
 * (`src/lib/db-locks.ts`); the four older ones still wait unbounded, which is
 * #104.
```

Keep the paragraph after it — the one explaining that `removeFromWaitlist` can only move an entry out of `waiting` — but reframe it as why this function never needed to serialize against it, rather than as an escape from a gap that no longer exists.

- [ ] **Step 2: Correct the `email-fallback.ts` guarantee**

`src/services/email-fallback.ts:69-85` says two writers gate under the class row lock and "**`completeClass` is the exception: it reads its class without `FOR UPDATE`**", then hedges in (2). Replace `:70-85` with:

```
      //    those statuses under the class row lock that transaction holds, so
      //    no fresh one can be written afterwards. All three now do:
      //    `POST /api/registrations` and `completeClass` take the lock
      //    explicitly, and `class-transitions`' auto-cancel gates on a
      //    status-predicated `updateMany`, which re-evaluates under the lock
      //    the UPDATE itself acquires. `completeClass` was the exception
      //    until #174.
      // 2. The same transaction rewrites `Teacher.email` to
      //    `deleted-<id>@deleted.invalid`, so a row that somehow slipped
      //    through would carry no real address to send to. Kept as a second
      //    line rather than deleted: (1) is now structural, but it depends on
      //    three call sites continuing to hold, and this does not.
```

- [ ] **Step 3: Verify the claims you just wrote are true**

Run: `grep -n "FOR UPDATE\|lockClassRow" src/services/waitlist.ts src/services/gdpr.ts src/services/class-lifecycle.ts`

Confirm by reading each hit that the docblock's list of five-plus-one lock sites matches the code. A comment claiming a lock that is not there is the defect fe9c009 was written to fix; do not reintroduce it one level over.

- [ ] **Step 4: Run the touched suites**

Run: `npx vitest run --project unit src/services/waitlist.test.ts src/services/email-fallback.test.ts src/services/email-fallback.consent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/waitlist.ts src/services/email-fallback.ts
git commit -m "docs: two comments described the locks as they were before this branch (#174)"
```

---

## After the tasks

Not plan steps — these belong to the process, after the branch is green.

- **Whole-branch review** on the most capable model, then one fix wave, then one scoped re-review.
- **Push and open the PR**, then `/pr-review-toolkit:review-pr <N>`. Skip type-design: no type is the subject here.
- **The PR body** records what was measured and where the errors were, including that the spec's own first lock-site count was wrong (7 statements, not 4; 2 timed, not 4; three added, not two). Name the integration files that ran by path — `integration` is never run in full.
- **Amend #174**: it names three gaps where there are seven sites, and its causal story for the headline defect is incomplete — `transitionClass` is the second and more reachable route.
- **Comment on #104**: its enumeration of four sites is stale (`withdrawWaitingEntriesForTeacher` is an untimed fifth, added by #166 after #104 was filed), and the split is now 5 with a timeout, 5 without.
- **File**, per the spec's "What this does not do": the queue-uniqueness spike, the `{Class, ClassTemplate}` order decision, and `template-sync.ts`'s read-then-delete. Check #103/#116/#117 before filing the `class-template-lifecycle.ts:446` `FOR NO KEY UPDATE` gap — prefer extending one of them.
- **Update `docs/backlog-roadmap.md`** with what was learned, the spin-outs, and the ratio with its reason stated. Never commit that file.
