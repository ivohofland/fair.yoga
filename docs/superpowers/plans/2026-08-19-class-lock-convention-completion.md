# Completing the `Class` Row-Lock Convention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the four remaining inline `SELECT … FOR UPDATE` `Class` row locks to `lockClassRow`, so every production `Class` row lock in `src/` goes through `src/lib/db-locks.ts` and the exception list can be deleted rather than maintained.

**Architecture:** Each of the four sites replaces one raw statement with a call to the existing `lockClassRow(tx, classId)` helper, which issues `setLockTimeout` (`SET LOCAL lock_timeout = '2s'`) and then the identical `FOR UPDATE`. No signature changes, no new constants, no migration. Every site gains a guard proving the wait is now bounded, and each guard is mutation-verified against the code that is there today. The documentation that describes the old two-tier split is then deleted or rewritten in one final task, because none of its replacement claims are true until all four conversions have landed.

**Tech Stack:** TypeScript strict, Prisma, PostgreSQL, Vitest (three projects: `unit`, `integration`, `components`).

**Spec:** `docs/superpowers/specs/2026-08-19-class-lock-convention-completion-design.md`

## Global Constraints

- **The bound is the existing shared `LOCK_TIMEOUT_SQL`** — `SET LOCAL lock_timeout = '2s'`, defined at `src/lib/db-locks.ts`. Do **not** introduce a second timeout constant. Spec §3.3 gives the arithmetic; a larger bound leaves too little of Prisma's 5 s transaction budget for the 8–12 statements that follow the lock.
- **No signature changes.** All four sites already have a `tx` inside their own `db.$transaction`, which satisfies `TransactionClientOnly`.
- **No migration.** Nothing in `prisma/schema.prisma` changes.
- **TypeScript strict.** No `any`, no implicit types.
- **Never start or restart the dev server on :3000.** The user runs it; the `integration` project talks to it over HTTP. Verify it is up with `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` (expect `307`).
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Never write the auto-close keyword immediately before a `#` reference** in any commit message or PR body. Write "**#N is unaffected**". This has closed an issue twice in this repo, the second time in the commit written to document the first.
- **Commit per task.** The PR is rebase-merged, so the per-task history is the record.

## Load-Bearing Task Order

Two constraints, both verified rather than assumed:

1. **Task 3 must carry the reconciliation re-pin in the same commit.** `handleSpotFreed` rethrows anything that is not a `WaitlistPromotionError` (`src/services/waitlist.ts`, the `auto_promote` branch), so once `promoteNext` is bounded a `55P03` propagates to the caller. The test `repairs an auto-promotion dropped by the transaction budget` then reaches its `expect(dropped.err).toMatch(/P2028|Transaction already closed/i)` with a `55P03` in hand and **fails**. Splitting the re-pin into its own task leaves the suite red between commits.
2. **Task 5 must be last.** Every claim it writes — "all five `readSeatCount` callers go through `lockClassRow`", "no inline `Class` row lock survives" — is false until Tasks 1–4 have all landed.

Tasks 1, 2 and 4 are independent of each other and may be done in any order.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/services/waitlist.ts` | Three conversions (`addToWaitlist`, `claimSpot`, `promoteNext`) plus three set-describing comments | 1, 2, 3, 5 |
| `src/services/waitlist.test.ts` | Three new guards, one per converted service function | 1, 2, 3 |
| `src/services/waitlist-reconciliation.ts` | Module docblock — the `P2028` mechanism claim (contains no `#104`) | 3 |
| `src/services/waitlist-reconciliation.test.ts` | Re-pin: one test's name, docblock, hold value and assertion; one cross-reference | 3 |
| `src/app/api/registrations/route.ts` | The fourth conversion, plus its `#107` comment (contains no `#104`) | 4 |
| `tests/integration/registrations-api.test.ts` | The fourth guard, doubling as the end-to-end 503 proof | 4 |
| `src/services/class-template-lifecycle.ts` | Comment naming the booking as an unbounded site | 4 |
| `src/lib/db-locks.ts` | Delete the exception-list paragraphs | 5 |
| `src/lib/scheduler.ts` | Comment naming `promoteNext`'s unbounded wait | 5 |
| `src/services/capacity.ts` | Two paragraphs — caller inventory, and a rationale that evaporates | 5 |
| `docs/lock-order.md` | The inline-list paragraph | 5 |

---

## The canonical guard, and why it is shaped this way

Tasks 1–3 each add one test of this shape. Read this once; the per-task steps give the fixture-specific version.

```ts
const holderClient = new PrismaClient();
let signalHeld!: () => void;
const held = new Promise<void>((r) => {
  signalHeld = r;
});

const holder = holderClient.$transaction(
  async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
    signalHeld();
    await new Promise((r) => setTimeout(r, 3_500));
  },
  { timeout: 30_000 },
);
await held;

const startedAt = Date.now();
const outcome = await CALL_UNDER_TEST.then(
  () => ({ ok: true as const }),
  (err: unknown) => ({ ok: false as const, err: String(err) }),
);
const waited = Date.now() - startedAt;

await holder;
await holderClient.$disconnect();

expect(outcome.ok).toBe(false);
if (!outcome.ok) expect(outcome.err).toMatch(/55P03/);
expect(waited).toBeGreaterThan(1_000);
expect(waited).toBeLessThan(3_400);
```

Four choices here are load-bearing, and each exists because the obvious alternative fails to bite:

- **A 3.5 s hold, not an indefinite one.** The neighbouring test in `src/services/class-lifecycle.test.ts` (`gives up on the 2s bound when another transaction holds the class row`) holds until the test releases it. That works, but under the mutation the call blocks forever and the test fails by *20-second timeout*. A fixed 3.5 s hold makes the mutation fail by **assertion** instead: without the bound the call acquires the lock at 3.5 s and **succeeds**, so `expect(outcome.ok).toBe(false)` fails immediately and legibly. The hold must sit above 2 s and below Prisma's 5 s default budget; 3.5 s matches the existing sibling in `waitlist-reconciliation.test.ts`.
- **`toBeLessThan(3_400)` — below the hold, not merely below 5 s.** This is what proves the call *gave up* rather than waiting the holder out. An upper bound of 4 000 against a 3 500 hold would pass either way and certify nothing.
- **`expect(outcome.ok).toBe(false)` unconditionally, before the message match.** `waitlist-reconciliation.test.ts` asserts its error text under `if (!dropped.ok)`, so if the call ever stopped failing that assertion would be silently skipped rather than failing. Do not copy that shape.
- **A separate `PrismaClient` for the holder**, so it cannot share the caller's connection.

**`/55P03/`, not `isTransientDbError`.** The helper accepts `40001`, `40P01`, `55P03` *and* `P2028`, so it cannot tell the bounded outcome from the unbounded one — which is the entire distinction under test.

---

## Task 1: `addToWaitlist` adopts `lockClassRow`

**Files:**
- Modify: `src/services/waitlist.ts` — the raw statement inside `addToWaitlist`
- Test: `src/services/waitlist.test.ts` — the `describe('addToWaitlist + removeFromWaitlist (DB)')` block

**Interfaces:**
- Consumes: `lockClassRow(tx: TransactionClientOnly, classId: string): Promise<void>` from `@/lib/db-locks` — **already imported** at the top of `waitlist.ts`; do not add a duplicate import.
- Produces: nothing new. `addToWaitlist`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

Add to the `describe('addToWaitlist + removeFromWaitlist (DB)')` block in `src/services/waitlist.test.ts`. In scope there: `makeClass(status, maxStudents)`, `studentIds` (3 students), `fillerIds` (the students filling the shared full class), and the module-level `prisma`.

The test builds its **own** class rather than reusing the block's shared `classId`, because other tests in the block add waitlist entries to that one and this test must not depend on their order. `addToWaitlist` rejects a class with free seats (`class_not_full`), so the new class must be full: `maxStudents: 1` with one registration on it.

The block's `afterAll` deletes classes, registrations and waitlist entries scoped by `teacherId` rather than by a fixed id list, so a class created inside a test is cleaned up — and its docblock says that shape exists precisely because "a test that dies before reaching its own inline cleanup … which the mutation-testing protocol guarantees will happen" must not break teardown. Re-using an existing `fillerIds` student for the filling registration keeps the student-teardown loop correct.

Add `PrismaClient` to the file's `@prisma/client` import if it is not already there.

```ts
  /**
   * #104. `addToWaitlist` took an unbounded inline `FOR UPDATE` until this
   * change; it now goes through `lockClassRow`, which issues the shared 2s
   * `SET LOCAL lock_timeout` first.
   *
   * The 3.5s hold is the guard, not scenery: it sits above the 2s bound and
   * below Prisma's 5s default transaction budget, so WITHOUT the bound this
   * call acquires the lock at 3.5s and succeeds. Reverting the site to its
   * inline statement therefore fails `expect(outcome.ok).toBe(false)` rather
   * than hanging the suite.
   *
   * `toBeLessThan(3_400)` is below the hold on purpose — that is what
   * distinguishes "gave up at 2s" from "waited the holder out". Neither bound
   * pins the timeout's VALUE, which belongs to `db-locks.ts`.
   */
  it('gives up on the 2s bound when another transaction holds the class row', async () => {
    // Its own full class: max 1, one registration. Not the block's shared
    // `classId`, whose waitlist other tests mutate.
    const lockedClassId = await makeClass('open', 1);
    await prisma.registration.create({
      data: {
        classId: lockedClassId,
        studentId: fillerIds[0]!,
        status: 'registered',
        tierAtBooking: 3,
      },
    });

    const holderClient = new PrismaClient();
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });

    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${lockedClassId} FOR UPDATE`;
        signalHeld();
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await held;

    const startedAt = Date.now();
    const outcome = await addToWaitlist(prisma, lockedClassId, studentIds[0]!).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err: String(err) }),
    );
    const waited = Date.now() - startedAt;

    await holder;
    await holderClient.$disconnect();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err).toMatch(/55P03/);
    expect(waited).toBeGreaterThan(1_000);
    expect(waited).toBeLessThan(3_400);
  }, 20_000);
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
npx vitest run --project unit src/services/waitlist.test.ts -t 'gives up on the 2s bound'
```

Expected: **FAIL**, with `outcome.ok` being `true` — the unmodified site waits the holder out and succeeds at ~3.5 s. Record the exact message. A failure for any *other* reason (a fixture problem, `class_not_full`) means the test is wrong, not the code.

- [ ] **Step 3: Convert the site**

In `src/services/waitlist.ts`, inside `addToWaitlist`, replace:

```ts
    await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
```

with:

```ts
    await lockClassRow(tx, classId);
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run --project unit src/services/waitlist.test.ts -t 'gives up on the 2s bound'
```

Expected: **PASS**, with `waited` between 1 000 and 3 400 ms.

- [ ] **Step 5: Mutation-verify the guard (do not skip)**

Revert Step 3 (put the inline statement back), re-run the test, and **record the exact failure text in the commit message or task report**. Then restore `lockClassRow` and re-run to confirm green.

A guard that still passes with the conversion reverted certifies nothing and must be rewritten, not explained.

- [ ] **Step 6: Run the whole waitlist file**

```bash
npx vitest run --project unit src/services/waitlist.test.ts
```

Expected: all pass. This file has other lock tests; confirm none regressed.

- [ ] **Step 7: Commit**

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts
git commit -m "fix: addToWaitlist bounds its class-lock wait, pinned against the inline statement (issue 104)"
```

---

## Task 2: `claimSpot` adopts `lockClassRow`

**Files:**
- Modify: `src/services/waitlist.ts` — the raw statement inside `claimSpot`
- Test: `src/services/waitlist.test.ts` — the `describe('claimSpot (DB)')` block

**Interfaces:**
- Consumes: `lockClassRow` from `@/lib/db-locks` (already imported).
- Produces: nothing new.

`claimSpot` is the broadcast path's first-come-first-claimed handler, so it only succeeds inside the claim window — the final hour before the cancel deadline — with a free spot and the claimant `waiting`. The `describe('claimSpot (DB)')` block already builds exactly that state for its passing tests.

**Before writing, read one passing test in that block** and copy how it reaches "in the claim window with a free spot and a waiting entry": which `now` it passes, and how it seeds the `WaitlistEntry`. Reuse those; do not invent a new window fixture. Substitute them at the two marked lines below.

- [ ] **Step 1: Write the failing test**

Add to `describe('claimSpot (DB)')` in `src/services/waitlist.test.ts`.

```ts
  /**
   * #104. `claimSpot` took an unbounded inline `FOR UPDATE` until this change;
   * it now goes through `lockClassRow` and its shared 2s bound.
   *
   * This is the site where contention is by DESIGN: the final-hour broadcast
   * tells every waiting student at once, so N claims land on one `Class` row
   * and serialize. That is not what the bound is for — each claim holds the
   * row only for its own short transaction, so 2s covers a deep queue
   * comfortably. What the bound stops is a claim arriving while an UNRELATED
   * long holder has the row: a GDPR erasure holds every class a student
   * touched for up to 20s.
   *
   * The 3.5s hold is the guard. It sits above the 2s bound and below Prisma's
   * 5s default budget, so WITHOUT the bound this call acquires at 3.5s and
   * succeeds — reverting the site fails `expect(outcome.ok).toBe(false)`
   * rather than hanging the suite. `toBeLessThan(3_400)` is below the hold on
   * purpose: that is what separates "gave up at 2s" from "waited it out".
   */
  it('gives up on the 2s bound when another transaction holds the class row', async () => {
    // Same state a passing test in this block builds: in the claim window,
    // one free spot, this student `waiting`.
    const { classId: lockedClassId, claimantId, now } = await makeClaimableFixture();

    const holderClient = new PrismaClient();
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });

    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${lockedClassId} FOR UPDATE`;
        signalHeld();
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await held;

    const startedAt = Date.now();
    const outcome = await claimSpot(prisma, lockedClassId, claimantId, now).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err: String(err) }),
    );
    const waited = Date.now() - startedAt;

    await holder;
    await holderClient.$disconnect();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err).toMatch(/55P03/);
    expect(waited).toBeGreaterThan(1_000);
    expect(waited).toBeLessThan(3_400);
  }, 20_000);
```

`makeClaimableFixture()` is a stand-in for whatever the block already does. If the block sets that state up inline in each test rather than through a helper, inline it here the same way rather than extracting a helper — this task should not refactor the block.

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run --project unit src/services/waitlist.test.ts -t 'claimSpot'
```

Expected: **FAIL** with `outcome.ok === true`. Record the message.

- [ ] **Step 3: Convert the site**

In `claimSpot`, replace the inline statement with `await lockClassRow(tx, classId);`.

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run --project unit src/services/waitlist.test.ts -t 'claimSpot'
```

- [ ] **Step 5: Mutation-verify** — revert, re-run, record the failure text, restore, re-run green.

- [ ] **Step 6: Commit**

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts
git commit -m "fix: claimSpot bounds its class-lock wait on the broadcast path (issue 104)"
```

---

## Task 3: `promoteNext` adopts `lockClassRow`, and the reconciliation re-pin

**This task is two changes in one commit, deliberately.** See "Load-Bearing Task Order" above: bounding `promoteNext` turns an existing reconciliation test red, because `handleSpotFreed` rethrows a `55P03`. Splitting them leaves the suite broken between commits.

**Files:**
- Modify: `src/services/waitlist.ts` — the raw statement inside `promoteNext`
- Modify: `src/services/waitlist-reconciliation.ts` — module docblock (spec §5.2, location 11)
- Test: `src/services/waitlist.test.ts` — new guard in `describe('promoteNext (DB)')`
- Test: `src/services/waitlist-reconciliation.test.ts` — re-pin (spec §5.2, locations 12 and 13)

**Interfaces:**
- Consumes: `lockClassRow` from `@/lib/db-locks` (already imported).
- Produces: nothing new. `promoteNext(db, classId, opts)` is unchanged.

**Deliberately deferred, so a reviewer does not flag it as missed:** this task makes `src/lib/scheduler.ts`'s comment — "`promoteNext`'s inline `FOR UPDATE` is unbounded (#104), so a contended tick can outlast its own interval" — false. It is corrected in **Task 5**, with every other set-describing claim, gated by one verification grep. Scattering those corrections across the tasks that trigger them is how a set gets half-corrected; reconciling them in one place against one measured census is the point of Task 5.

- [ ] **Step 1: Write the failing guard**

Add to `describe('promoteNext (DB)')` in `src/services/waitlist.test.ts`. In scope: the shared `classId`, `studentIds`, `fillerIds`, and `cancelRegistration(studentId)`.

`promoteNext` needs a free spot and at least one `waiting` entry. The block's passing tests reach that by seeding a `WaitlistEntry` and then calling `cancelRegistration(...)` to free a seat — **read one of them and mirror it**, substituting at the marked line.

```ts
  /**
   * #104. `promoteNext` is the one converted site that is NOT a route. It is
   * called by `handleSpotFreed` and by `reconcileWaitlists`, so its failure
   * surface is the reconciliation sweep repairing it later, not a 503 a
   * student reads.
   *
   * That is what makes the bound an improvement here rather than a trade:
   * before this change a contended promotion waited out the WHOLE hold and
   * then blew Prisma's 5s budget (`P2028`, measured at 7014ms against a 7s
   * hold — it cannot cancel a statement already blocked inside Postgres).
   * Now it aborts at 2s with `55P03`, and the sweep gets to retry sooner.
   *
   * The 3.5s hold sits above the 2s bound and below the 5s budget, so without
   * the bound this call acquires at 3.5s and succeeds.
   */
  it('gives up on the 2s bound when another transaction holds the class row', async () => {
    // Same state a passing test in this block builds: a `waiting` entry and a
    // freed seat, via `cancelRegistration`.
    await seedWaitingEntryAndFreeASeat();

    const holderClient = new PrismaClient();
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });

    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        signalHeld();
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await held;

    const startedAt = Date.now();
    const outcome = await promoteNext(prisma, classId).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err: String(err) }),
    );
    const waited = Date.now() - startedAt;

    await holder;
    await holderClient.$disconnect();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err).toMatch(/55P03/);
    expect(waited).toBeGreaterThan(1_000);
    expect(waited).toBeLessThan(3_400);
  }, 20_000);
```

`seedWaitingEntryAndFreeASeat()` is a stand-in for the block's existing inline setup. Inline it the same way the neighbouring tests do rather than extracting a helper.

**Note the resolved-value branch matters here.** `promoteNext` returns `WaitlistEntry | null`, and `null` is a legitimate success (empty queue). Both resolve paths map to `{ ok: true }` above, so a mutation that makes the call return `null` instead of throwing still fails the assertion. That is intended — this guard is about *throwing at the bound*, not about who got promoted.

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run --project unit src/services/waitlist.test.ts -t 'promoteNext'
```

Expected: **FAIL** with `outcome.ok === true`.

- [ ] **Step 3: Convert the site**

In `promoteNext`, replace the inline statement with `await lockClassRow(tx, classId);`.

- [ ] **Step 4: Confirm the guard passes AND the reconciliation test now fails**

```bash
npx vitest run --project unit src/services/waitlist.test.ts -t 'promoteNext'
npx vitest run --project unit src/services/waitlist-reconciliation.test.ts
```

Expected: the new guard **passes**; `repairs an auto-promotion dropped by the transaction budget` now **fails**, because `handleSpotFreed` rethrows a `55P03` and the test asserts `/P2028|Transaction already closed/i`.

**This failure is the point.** It is the evidence that bounding `promoteNext` really changed the mechanism. Record the exact failure text — it is what justifies the re-pin below.

- [ ] **Step 5: Re-pin the reconciliation test (spec §5.2, location 12)**

In `src/services/waitlist-reconciliation.test.ts`:

- **Rename** `repairs an auto-promotion dropped by the transaction budget` → `repairs an auto-promotion dropped by the 2s lock bound`. The old name is now false: it is no longer the transaction budget that drops it.
- **Change the hold** from `7_000` to `3_500`, and update the comment that currently reads "Longer than Prisma's 5s default transaction budget, well inside deleteStudentAccount's own 20s ceiling."
- **Change the assertion** from `/P2028|Transaction already closed/i` to `/55P03/`, and make it unconditional (`expect(dropped.ok).toBe(false)` first) rather than guarded by `if (!dropped.ok)`.
- **Rewrite the docblock.** It currently narrates the 7014 ms measurement as live behaviour. Keep the measurement as an explicitly-marked historical note — it is the evidence for the "Prisma cannot cancel a blocked statement" claim, which stays true and is relied on by `gdpr.ts` and by the spec's §3.1. Do not delete it silently.

- [ ] **Step 6: Fix the cross-reference (spec §5.2, location 13)**

In the same file, the test `promotes the queue head of a class with a free seat` has a docblock naming both drop tests by name *and* by mechanism:

> the two tests that CREATE the state by dropping a real hook are `repairs an auto-promotion dropped by the transaction budget` (`P2028`) and `reconciles the remaining classes when one loses its lock race` (`55P03`).

Update both the name and the mechanism. **Do not** flatten the two tests into one: they cover different *branches* of `handleSpotFreed` (auto-promote vs broadcast), and that split is what the sweep's design rests on. Only the mechanism converged.

- [ ] **Step 7: Rewrite the module docblock (spec §5.2, location 11)**

In `src/services/waitlist-reconciliation.ts`, the header currently says the auto-promote branch "blows Prisma's default 5s interactive-transaction budget with `P2028`, measured at 7014 ms against a 7 s hold". Both branches now abort at 2 s with `55P03`. Rewrite, preserving the 7014 ms measurement as a marked historical note and preserving the "Prisma cannot cancel a statement already blocked inside Postgres" claim, which is unchanged and still true.

- [ ] **Step 8: Run both files green**

```bash
npx vitest run --project unit src/services/waitlist.test.ts src/services/waitlist-reconciliation.test.ts
```

- [ ] **Step 9: Mutation-verify the guard** — revert Step 3, re-run, record the failure text, restore, re-run green.

- [ ] **Step 10: Commit**

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts \
        src/services/waitlist-reconciliation.ts src/services/waitlist-reconciliation.test.ts
git commit -m "fix: promoteNext bounds its wait, and the sweep test re-pinned to the mechanism that now drops it (issue 104)"
```

---

## Task 4: The booking route adopts `lockClassRow`

**Files:**
- Modify: `src/app/api/registrations/route.ts` — the raw statement, its import block, and the `#107` comment (spec §5.2, location 10)
- Modify: `src/services/class-template-lifecycle.ts` — the comment naming the booking as unbounded (spec §5.1, location 6)
- Test: `tests/integration/registrations-api.test.ts`

**Interfaces:**
- Consumes: `lockClassRow` from `@/lib/db-locks` — **not yet imported in this file.** Add it.
- Produces: nothing new.

This task's guard lives in the `integration` project rather than `unit`, and therefore doubles as the spec's §6.4 end-to-end proof: it asserts the real HTTP **503**, which is the user-visible contract the issue is actually about.

- [ ] **Step 1: Write the failing test**

Add to `describe('POST /api/registrations')` in `tests/integration/registrations-api.test.ts`. The file's `makeClass(maxStudents)` and `post(token, body)` helpers are in scope, as is `studentTokens`.

The holder uses this file's existing module-level `prisma` client. The blocked request goes over HTTP to the app on :3000, which uses its own pool — so no shared-connection problem arises here.

```ts
  /**
   * #104. The booking path took an unbounded inline `FOR UPDATE` until this
   * change. It is the case the issue calls sharpest: a student clicking Book,
   * on a path with no bound on its wait.
   *
   * Asserted at the HTTP surface rather than the service, because the point is
   * the contract a student meets — a retryable 503, not a 500 and not a
   * request that occupies a pool connection for the holder's full duration.
   * `withErrorHandler` routes the `55P03` through `isTransientDbError`.
   *
   * The 3.5s hold sits above the 2s bound and below Prisma's 5s default
   * budget, so reverting the route to its inline statement makes this request
   * SUCCEED at 3.5s with a 200 — which is what makes this a guard rather than
   * a description.
   */
  it('answers 503 rather than blocking when another transaction holds the class row', async () => {
    const classId = await makeClass(5);

    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        signalHeld();
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await held;

    const startedAt = Date.now();
    const res = await post(studentTokens[0]!, { classId });
    const waited = Date.now() - startedAt;

    await holder;

    expect(res.status).toBe(503);
    expect(waited).toBeLessThan(3_400);
  }, 20_000);
```

- [ ] **Step 2: Confirm the dev server is up, then run it and confirm it fails**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # expect 307
npx vitest run --project integration tests/integration/registrations-api.test.ts -t 'answers 503'
```

Expected: **FAIL** — the unmodified route waits the holder out and returns **200**. Record the exact message.

A wall of `ECONNREFUSED` means the app is not running on :3000. Do **not** start it; ask.

- [ ] **Step 3: Convert the site**

In `src/app/api/registrations/route.ts`, add to the import block:

```ts
import { lockClassRow } from '@/lib/db-locks';
```

and replace:

```ts
      await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${body.classId} FOR UPDATE`;
```

with:

```ts
      await lockClassRow(tx, body.classId);
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run --project integration tests/integration/registrations-api.test.ts -t 'answers 503'
```

Expected: **PASS**, 503 in under 3 400 ms.

**The dev server serves this checkout**, so the route change is picked up on recompile. If the run still returns 200, confirm the server recompiled before concluding the fix failed.

- [ ] **Step 5: Mutation-verify** — revert Step 3, re-run, record the failure text (expect a 200), restore, re-run green.

- [ ] **Step 6: Correct this file's `#107` comment (spec §5.2, location 10)**

The comment inside the transaction currently reads:

> `waitlist.ts` takes this same lock in four places and reads under it in all four — `addToWaitlist`, `promoteNext` and `claimSpot` inline, and the #212 broadcast via `lockClassRow`, which issues the identical statement. This is the fifth.

The inline/helper distinction it turns on no longer exists. Rewrite it so all five are described as one call. **Keep the surrounding #107 argument** — that the class is read *under* the lock rather than from a snapshot taken before it — which is unchanged and is why the comment exists.

This location contains no `#104`; it cites #107 and #212. A keyword sweep will not find it.

- [ ] **Step 7: Correct `class-template-lifecycle.ts` (spec §5.1, location 6)**

The paragraph currently calls the booking "one of the deliberately UNBOUNDED sites `db-locks.ts` names (#104)".

**Read this one carefully before editing.** The paragraph is about how long a booking *holds* the row, not how long it *waits* for it. Its conclusion — "So a student booking one instance can now time a teacher's edit out at 2s" — **stays true**, because this branch does not shorten the hold. Only the "deliberately UNBOUNDED" clause is wrong. Deleting the whole paragraph would remove a still-true hazard.

- [ ] **Step 8: Run the full integration file**

```bash
npx vitest run --project integration tests/integration/registrations-api.test.ts
```

- [ ] **Step 9: Commit**

```bash
git add src/app/api/registrations/route.ts src/services/class-template-lifecycle.ts \
        tests/integration/registrations-api.test.ts
git commit -m "fix: the booking path answers 503 at 2s instead of occupying a connection for the holder's duration (issue 104)"
```

---

## Task 5: Delete the exception list

**Must be last.** Every claim written here is false until Tasks 1–4 have landed.

**Files:**
- Modify: `src/lib/db-locks.ts` (spec §5.1, location 1)
- Modify: `src/lib/scheduler.ts` (location 2)
- Modify: `src/services/waitlist.ts` (locations 3, 4, 5)
- Modify: `src/services/capacity.ts` (locations 7, 8)
- Modify: `docs/lock-order.md` (location 9)

**Interfaces:** none — documentation only. No behaviour changes in this task.

- [ ] **Step 1: Verify the premise of everything you are about to write**

```bash
grep -rn "FOR UPDATE" src/ --include='*.ts' | grep -v "\.test\.ts:" | grep -vE ":[0-9]+: *(\*|//)"
```

Expected: **exactly 4 statements** — `lockClassRow` and `lockClassRowsOrdered` in `src/lib/db-locks.ts`, plus the two template claims in `class-generator.ts` and `studio-class-generator.ts`. Arithmetic: `8 at HEAD − 4 replaced = 4`.

If this returns anything else, **stop** — a conversion was missed, and the documentation below would be written as a lie.

```bash
grep -rn "lockClassRow(" src/ --include='*.ts' | grep -v "\.test\.ts:"
```

Expected: the four newly converted sites plus `handleSpotFreed`, `completeClass`, `removeFromWaitlist` and `autoTransitionToInProgress`. Do not hand-copy this list into any comment — `db-locks.ts` already records why caller lists rot, and says to grep for it instead.

- [ ] **Step 2: `db-locks.ts` — delete the exception paragraphs (location 1)**

Delete both the "Four pre-existing `FOR UPDATE` sites deliberately do NOT use this…" paragraph and the "It was FIVE until #237…" paragraph that follows it.

**Delete, do not update.** The point of this branch is that the list is gone; a list rewritten to say "zero sites" is still a list, and still rots. Replace with one sentence stating the convention is now total and pointing at the grep in Step 1 as the check.

Keep the `withdrawWaitingEntriesForTeacher` / #237 behaviour note about `DELETE /api/teacher-links/[teacherId]` answering 503 — that is a live fact about a route, not a membership claim.

- [ ] **Step 3: `scheduler.ts` (location 2)**

Currently: "`promoteNext`'s inline `FOR UPDATE` is unbounded (#104), so a contended tick can outlast its own interval, and the `job.running` guard then drops the ticks it overruns."

The lock wait is now bounded at 2 s, so a contended tick can no longer outlast its interval *on a lock wait*. Rewrite the first clause. **Keep the `job.running` sentence** — that guard still exists and still does its job for every other source of slowness.

- [ ] **Step 4: `waitlist.ts` — three set-describing comments (locations 3, 4, 5)**

- `removeFromWaitlist`'s comment contrasting its bounded wait with "those four inline sites' unbounded wait (#104; not this branch's to fix)" — the contrast is gone. Rewrite.
- `handleSpotFreed`'s "`lockClassRow`, not the inline `FOR UPDATE` the three functions above use … This site is new, so it takes the bounded 2s wait from the start" — all four now take it. **Keep the paragraph's other claim** — that a class row held longer than 2 s drops the broadcast entirely, and that both callers log and swallow. That is still true and is the reason `waitlist-reconciliation.ts` exists.
- `reorderWaitingEntries`' docblock, "see `src/lib/db-locks.ts` for the bounded-vs-unbounded split (#104) that remains among the ones that do lock" — there is no split. Rewrite.

- [ ] **Step 5: `capacity.ts` — two paragraphs, two different verdicts (locations 7, 8)**

- The caller inventory ("four via their own inline `SELECT … FOR UPDATE` … the waitlist broadcast via `lockClassRow`") — all five callers now go through `lockClassRow`. Rewrite.
- **The rationale paragraph is the consequential one.** It currently says `readSeatCount` does not take the lock itself because doing so "would retrofit `lockClassRow`'s bounded 2s wait onto those four pre-existing sites, which `db-locks.ts` reserves for #104". **That entire reason evaporates with this branch.** Either write a replacement reason or delete the paragraph — do not leave a justification whose premise is gone. The remaining honest reason is the one issue 219 is about, and the paragraph should point there rather than at this issue.

- [ ] **Step 6: `docs/lock-order.md` (location 9)**

Rewrite the paragraph beginning "The single-id `FOR UPDATE`s remain plural and inline" through the #237 four-to-three narrative.

Keep two things: the multi-row invariant (`lockClassRowsOrdered` is the only production `FOR UPDATE OF c`), and the standing warning that a count staying right while its membership changes is the error nothing that counts can catch. That warning is what makes the new, stronger claim checkable — and the spec's §5 preamble records a fresh instance of it firing during this very branch's design.

- [ ] **Step 7: Confirm no `#104` pointer was missed**

```bash
grep -rn "#104\|issue 104" src/ docs/ --include='*.ts' --include='*.md' \
  | grep -v "docs/backlog-roadmap.md" | grep -v "docs/superpowers/"
```

Expected: **no lines outside test files**, or only lines that deliberately reference the issue as history.

**This grep is necessary and not sufficient.** Spec §5.2's four locations do not contain `#104` and are handled in Tasks 3 and 4; confirm against the branch diff (`git diff main --stat`) that all four files were touched, rather than trusting this sweep.

- [ ] **Step 8: Full verification**

```bash
npm run verify
```

Runs typecheck, lint, and all three vitest projects. Needs :3000 up.

**Measure the after-figure; do not assert the prediction.** Baseline at HEAD `af6dda0` was 135 files / 1613 tests (unit 63/934, integration 31/437, components 41/242). This branch adds three unit guards and one integration guard and modifies one existing test, so the expected figure is **1617**. Record what the run actually reports — a branch's own review commonly adds tests the prediction cannot know about.

- [ ] **Step 9: Commit**

```bash
git add src/lib/db-locks.ts src/lib/scheduler.ts src/services/waitlist.ts \
        src/services/capacity.ts docs/lock-order.md
git commit -m "docs: the exception list deleted rather than updated, now that it is empty (issue 104)"
```

---

## What this branch does not do

State these in the PR body, in this phrasing. **Never** put an auto-close keyword immediately before a `#` reference.

- **#122 is unaffected** — a benign `55P03` still turns the hourly generation job red on `/api/health`. Issue 122 owns that with a better diagnosis; this branch adds no new `55P03` source inside the generator sweep.
- **#219 is unaffected** and stays open, but its cost drops: with all five `readSeatCount` callers going through `lockClassRow`, its recommended `ClassLock` option no longer needs the `unsafeClassLockTaken` escape hatch.
- **#229 is unaffected** — no lock set and no lock order changes here, only how long a wait may last.
- **#232 is unaffected**, though the pressure that produces its symptom is reduced.
- No migration, no schema change, no new timeout constant, and no change to how long any site *holds* a `Class` row.

## PR body must record

- The four premise corrections from spec §2, including that the issue's own update comment is the stale part and that the "no contention" premise is now false.
- That `P2028` already mapped to 503, so this is a connection-occupancy and convention fix rather than an error-quality one.
- The arithmetic: `8 statements at HEAD − 4 replaced = 4 remaining`, and the measured test figures with their reconciliation.
- The mutation failure text for each of the four guards.
- Which suites ran. `npm run verify` runs all three projects, so a green run **is** the whole integration suite — say so with the arithmetic, and still name `tests/integration/registrations-api.test.ts` as the integration file this branch touched.
- Any inherited claim that was checked, and whether it held.
