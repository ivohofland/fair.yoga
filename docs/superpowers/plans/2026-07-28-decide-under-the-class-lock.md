# Decide Under The Class Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /api/registrations` decide from the class row it locked, not from one read before the lock existed (#107).

**Architecture:** The route already takes `SELECT id FROM "Class" … FOR UPDATE` inside its transaction, then discards the row and decides from a `findUnique` issued on the bare client beforehand. The outer read is deleted; the class is read once, inside the transaction, immediately after the lock, and every decision derives from that row. The three checks that used to run before the transaction become typed throws mapped by the `catch` the route already has.

**Tech Stack:** Next.js App Router route handler, Prisma, PostgreSQL, Vitest (`integration` project against a live app on `:3000`).

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no type assertions to silence errors, no eslint suppressions.
- **One class read, inside the transaction, after the `FOR UPDATE`.** The outer `prisma.class.findUnique` is deleted, not kept alongside. Two class objects in scope — one safe, one not, distinguished by nothing the type system can see — is how this bug arrived.
- **`findUnique` plus an explicit null check**, not `findUniqueOrThrow`. This is deliberately the opposite of #102's choice: there the row provably existed because the `FOR UPDATE` had just matched it, so `| null` was impossible. Here the id comes from the request body, so a missing class is the ordinary 404 path.
- **Response bodies and status codes are unchanged** from today's, including the exact string `Cannot register for a class with status "<status>"`.
- **The student lookup and roster-link check stay outside the transaction.** They concern the student, not the class; holding the class lock across them would widen it for no gain.
- **Do not touch `src/services/waitlist.ts`.** Its three lock sites already read under the lock and are the pattern being copied, not work.
- **Do not touch `autoCancelClasses`.** The weaker analogue, out of scope, gets its own issue.
- **Mutation-verify the fix**, and per the #66 lesson confirm the mutation actually applied inside the function under test before trusting its result.

---

## File Structure

| File | Change |
|---|---|
| `src/app/api/registrations/route.ts` | Three new error classes; the outer class read deleted; the class read once inside the transaction with every decision derived from it |
| `tests/integration/registrations-api.test.ts` | Two race tests — a cancellation and a lowered cap, each committed while the request waits on the lock |

One task: the error classes, the moved read and the tests are a single deliverable. Splitting them would leave an intermediate state where the route throws errors nothing maps, or tests exist for a fix that does not.

---

### Task 1: Decide under the lock

**Files:**
- Modify: `src/app/api/registrations/route.ts`
- Test: `tests/integration/registrations-api.test.ts`

**Interfaces:**
- Produces: nothing other modules import. `ClassNotFoundError`, `NotYourClassError` and `ClassStatusError` are module-private, exactly like the existing `ClassFullError` and `AlreadyRegisteredError`.

- [ ] **Step 1: Write the two failing race tests**

Add to `tests/integration/registrations-api.test.ts`, inside the existing `describe('POST /api/registrations')` block. It already provides `makeClass(maxStudents)`, `post(token, body)`, `studentTokens` (two of them) and `ownerToken`, and pushes every created class into `classIds` for teardown:

```ts
  /**
   * #107. The route took the class row lock and then decided from a row read
   * before the lock existed, so a class cancelled in the gap was still booked.
   *
   * Deterministic by the lever #95 and #102 used, adapted to HTTP: an
   * uncommitted write is invisible under READ COMMITTED, and the dev server
   * holds its own connection, so a transaction held open here genuinely blocks
   * the request.
   */
  it('refuses a booking for a class cancelled while the request waited for the lock', async () => {
    const classId = await makeClass(5);

    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });

    // Cancel, uncommitted. Holds the class row lock; invisible to the server.
    const cancelling = prisma.$transaction(
      async (tx) => {
        await tx.class.update({ where: { id: classId }, data: { status: 'cancelled' } });
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let settled = false;
    const booking = post(studentTokens[0]!, { classId }).then((res) => {
      settled = true;
      return res;
    });

    // Liveness, not teeth: this holds before and after the fix, because the
    // pre-fix route also reaches the FOR UPDATE and blocks — it has just
    // already read the class by then. It is here to prove the request is
    // genuinely waiting on the lock, which is what makes the assertion below
    // mean something.
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);

    commit();
    await cancelling;
    const res = await booking;

    // Pre-fix: 201. The server read `status: 'open'` before the lock, could not
    // see the uncommitted cancellation, and booked a cancelled class.
    expect(res.status).toBe(409);
    expect(await prisma.registration.count({ where: { classId } })).toBe(0);
  });

  it('refuses a booking that exceeds a cap lowered while the request waited', async () => {
    const classId = await makeClass(2);

    const first = await post(studentTokens[0]!, { classId });
    expect(first.status).toBe(201);

    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });

    // Lower the cap to 1, uncommitted — the one existing registration now
    // fills the class.
    const capping = prisma.$transaction(
      async (tx) => {
        await tx.class.update({ where: { id: classId }, data: { maxStudents: 1 } });
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let settled = false;
    const booking = post(studentTokens[1]!, { classId }).then((res) => {
      settled = true;
      return res;
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);

    commit();
    await capping;
    const res = await booking;

    // Pre-fix: 201. The count was fresh (1) but was compared against the stale
    // cap of 2, so the second booking fit a class that now holds one.
    expect(res.status).toBe(409);
    expect(await prisma.registration.count({ where: { classId } })).toBe(1);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: both new tests FAIL with `expected 201 to be 409`. If `signup-api` tests elsewhere return 429 that is the local rate limiter, unrelated — but this command runs only the one file, so it should not appear.

- [ ] **Step 3: Add the three error classes**

In `src/app/api/registrations/route.ts`, beside the two that already exist near the top:

```ts
/** Thrown inside the transaction when the locked class row does not exist. */
class ClassNotFoundError extends Error {}

/** Thrown inside the transaction when the caller does not own the class. */
class NotYourClassError extends Error {}

/**
 * Thrown inside the transaction when the class's status forbids registration.
 * Carries the status so the response can name it, exactly as it did when this
 * check ran before the transaction.
 */
class ClassStatusError extends Error {
  constructor(readonly classStatus: string) {
    super(`Cannot register for a class with status "${classStatus}"`);
  }
}
```

- [ ] **Step 4: Delete the outer class read and its two checks**

Remove this whole block — the `findUnique`, the 404, the ownership 403, and the status 409. All four move inside the transaction in Step 6:

```ts
  // Look up the class
  const cls = await prisma.class.findUnique({
    where: { id: body.classId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!cls) return respondError('Class not found', 404);

  // Teachers may only manage registrations for their own classes —
  // registering also locks the class's economic settings.
  if (actingTeacherId && cls.teacherId !== actingTeacherId) {
    return respondError('Not your class', 403);
  }

  // Check class status. Students book open classes; the teacher can also
  // add someone who shows up while the class is in progress.
  const allowedStatuses = isTeacher ? ['open', 'in_progress'] : ['open'];
  if (!allowedStatuses.includes(cls.status)) {
    return respondError(`Cannot register for a class with status "${cls.status}"`, 409);
  }
```

Also remove the walk-in derivation that follows the roster check, since it reads the class — it moves inside too:

```ts
  const WALK_IN_WINDOW_MS = 15 * 60 * 1000;
  const classStart = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
  const isWalkIn =
    isTeacher &&
    (cls.status === 'in_progress' || Date.now() >= classStart.getTime() - WALK_IN_WINDOW_MS);
```

Leave the student lookup and the roster-link check exactly where they are, and add this comment above the student lookup so the new ordering is deliberate on the page:

```ts
  // The student and the roster link concern the student, not the class, so
  // they stay outside the transaction — holding the class lock across them
  // would widen it for nothing. One consequence, accepted: a request with both
  // an unknown student and an unusable class now answers about the student
  // first, where it used to answer about the class. No test depends on that
  // precedence, and neither answer leaks anything about the other subject.
```

- [ ] **Step 5: Hoist the walk-in constant to module scope**

`WALK_IN_WINDOW_MS` no longer has a natural home in the request body once the derivation moves. Put it beside the error classes:

```ts
/**
 * How long before a class starts a teacher-added registration counts as a
 * walk-in — someone showing up at the door — rather than a normal booking.
 */
const WALK_IN_WINDOW_MS = 15 * 60 * 1000;
```

- [ ] **Step 6: Read the class under the lock and decide from it**

Inside `prisma.$transaction`, directly after the existing `FOR UPDATE`, insert the read and the three checks, then the walk-in derivation:

```ts
      // Serialize concurrent registrations for this class: without the row
      // lock, two simultaneous requests both count below max and both insert.
      await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${body.classId} FOR UPDATE`;

      // Read the class UNDER that lock, and decide everything from this row.
      // #107: this read used to happen before the transaction, so `status`,
      // `maxStudents` and the walk-in window were decided from a snapshot the
      // lock did not protect — a class cancelled or re-capped in the gap was
      // booked anyway. `waitlist.ts` takes this same lock in three places and
      // reads under it in all three; this is the fourth.
      //
      // `findUnique`, not `findUniqueOrThrow`: unlike the generator claims in
      // #102, the id here comes from the request body, so a missing class is
      // the ordinary 404 path rather than an impossible branch.
      const cls = await tx.class.findUnique({
        where: { id: body.classId },
        include: { teacher: { select: { defaultTimezone: true } } },
      });
      if (!cls) throw new ClassNotFoundError();

      // Teachers may only manage registrations for their own classes —
      // registering also locks the class's economic settings.
      if (actingTeacherId && cls.teacherId !== actingTeacherId) {
        throw new NotYourClassError();
      }

      // Students book open classes; the teacher can also add someone who
      // shows up while the class is in progress.
      const allowedStatuses = isTeacher ? ['open', 'in_progress'] : ['open'];
      if (!allowedStatuses.includes(cls.status)) {
        throw new ClassStatusError(cls.status);
      }

      // Walk-ins are a class-time phenomenon: someone shows up at the door and
      // the teacher lets them in — those may exceed max_students (the teacher
      // rate stays capped at target; extra students lower prices). A teacher
      // adding a student well before class is a normal registration and
      // respects capacity like everyone else.
      const classStart = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
      const isWalkIn =
        isTeacher &&
        (cls.status === 'in_progress' || Date.now() >= classStart.getTime() - WALK_IN_WINDOW_MS);
```

The rest of the transaction body is unchanged — it already refers to `cls`, which now resolves to the row read under the lock rather than the outer one. Confirm that by reading it: `cls.maxStudents` in the capacity check, `cls.settingsLocked`, `cls.teacherId` in the roster upsert, and `cls.classType`/`cls.id`/`cls.teacherId` in the two notification bodies should all still compile and now come from the fresh row.

- [ ] **Step 7: Map the three new errors**

Add to the existing `catch`, above the `ClassFullError` branch so the order reads outermost-check-first:

```ts
    if (err instanceof ClassNotFoundError) {
      return respondError('Class not found', 404);
    }
    if (err instanceof NotYourClassError) {
      return respondError('Not your class', 403);
    }
    if (err instanceof ClassStatusError) {
      return respondError(err.message, 409);
    }
```

`ClassStatusError`'s constructor builds the exact string the pre-transaction check returned, so the response body is byte-identical to today's.

- [ ] **Step 8: Run the file to verify everything passes**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: PASS, including the pre-existing `'never exceeds capacity under concurrent registrations'`, `'rejects a teacher registering students into another teacher's class'`, `'teacher adds before class respect capacity — not walk-ins'` and `'allows the owner to add a walk-in beyond capacity during class'` — those four exercise the checks that just moved, so they are the regression net for this change.

- [ ] **Step 9: Mutation-verify**

```bash
git add -A   # `git checkout --` restores from the index; docs/backlog-roadmap.md is
             # untracked and must stay that way — unstage it if it gets swept in
```

Hoist the class read back out of the transaction: move the `findUnique` and the three checks above `prisma.$transaction`, changing the throws back to `respondError` returns. Confirm by reading the lines that the read now sits outside the transaction, then:

```bash
npx vitest run --project integration tests/integration/registrations-api.test.ts
```

Expected: both new tests FAIL with `expected 201 to be 409`; every pre-existing test in the file still passes. If a pre-existing test also fails, the mutation changed more than the read's position — restore and redo.

Restore: `git checkout -- src/app/api/registrations/route.ts`

- [ ] **Step 10: Full verification and commit**

```bash
npx tsc --noEmit
npm run lint
npx vitest run --project unit
npx vitest run --project integration
```

Expected: clean. Baselines before this plan: 388 unit, 211 integration; this plan adds 2 integration tests and no unit tests.

```bash
git add src/app/api/registrations/route.ts tests/integration/registrations-api.test.ts
git commit -m "fix: decide registrations from the class row under the lock (#107)"
```

---

## Verification before opening the PR

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 388 passing
- [ ] `npx vitest run --project integration` — 213 passing (needs the app on `:3000`; do not restart it. `signup-api` 429s are the local rate limiter saturating, not this change)
- [ ] `npx playwright test` — 118 passing
- [ ] `grep -n "prisma.class.findUnique" src/app/api/registrations/route.ts` — no matches; the only class read is `tx.class.findUnique` inside the transaction
