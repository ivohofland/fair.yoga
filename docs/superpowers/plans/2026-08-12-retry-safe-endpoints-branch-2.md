# #196 Branch 2 — Retry-Safe Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the nine endpoints of #196 that need no schema change survive a repeated or concurrent request, closing #196.

**Architecture:** Every fix is a compare-and-swap in a `where` clause, an advisory lock, or a catch — no migration anywhere. Where a duplicate has more than one producer, the guard goes at the point all producers share (a service function), not at the route. Where the duplicate's source is a single unguarded write, the source is scoped and the effect needs no dedupe at all.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (3 projects: `unit`, `integration`, `components`).

**Spec:** `docs/superpowers/specs/2026-08-12-retry-safe-endpoints-branch-2-design.md`. Read §3 (the corrected design) before starting; read §1 only if you want to know why §4.2 of the *branch-1* spec must not be followed.

## Global Constraints

- **No migration.** `prisma/schema.prisma` is not modified by any task. If a task seems to need a schema change, stop and surface it — that is a plan defect, not something to work around.
- **Never write a GitHub closing keyword immediately before a `#N` reference in any commit message**, in any grammatical role, including as a noun and including with a colon between: `close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved`. A commit body beginning "The studio twin of the class-template **fix: #196**'s index…" closed #196 by accident on the last branch. Write "**#N is unaffected**" or "for #N". Only the PR body may deliberately close #196.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing `[`, `]`, `(`, `)` — zsh globs them and an unquoted path silently matches nothing.
- **Never start or restart the dev server on :3000.** The user runs it; the `integration` project talks to it over HTTP.
- **The in-process scheduler is RUNNING locally** (`CRON_SCHEDULER` is unset in `.env`; CI sets it `off`). `src/lib/scheduler.ts` sweeps email-fallback every 5 min, payment-reminders and class-generation hourly, class-transitions every minute. Any integration assertion must be scoped to its own fixture rows.
- **Two date windows to avoid.** `prisma/seed.ts` builds classes at today ± 2 weeks — put fixtures at `2027-xx-xx` or `2099-06-01`. And `Class_teacher_slot_unique` (branch 1) means every class one teacher holds on one date needs its own `startTime`; use the `slotTime()` counter idiom from `tests/integration/registrations-api.test.ts:24-52` if a task creates more than one.
- **Test tiers:** `unit` = `src/**/*.test.ts` against the dedicated test database. `integration` = `tests/integration/**/*.test.ts` against the app on :3000 (shares the *dev* database). `components` = jsdom.
- **Run a single file with** `npx vitest run --project <tier> <path>`. Run everything with `npm run verify`.
- **Baseline before this branch:** `npm run verify` green at **1255 passed, 2 todo, 111 files**.
- **Surfacing a plan defect beats coding around it.** If a step's predicted output is wrong, or a file does not look as described, say so in your report rather than bending the code to match. Four of the last branch's briefs were wrong about the state of the code and every one was caught this way.
- **Commit style:** `fix:`, `test:` or `docs:` prefix, imperative, naming the endpoint. One commit per task minimum.

---

## File Structure

| File | Task | Responsibility after this branch |
|---|---|---|
| `src/app/api/invitations/[id]/route.ts` | 1 | DELETE and PUT CAS on status; PATCH deliberately unscoped |
| `src/app/api/registrations/[id]/route.ts` | 2 | Cancel is a status-scoped `updateMany`, so only one racer reaches the waitlist hook |
| `src/services/gdpr.ts` | 3 | Both erasures CAS on `deletedAt: null` and abort with a typed sentinel |
| `src/app/api/account/route.ts` | 3 | Treats the sentinel as "this half is already done", per half |
| `src/services/payments.ts` | 4 | Manual reminder CAS also gates on `reminderSentAt` |
| `src/components/class/send-reminder-button.tsx` | 4 | Docblock corrected — a cooldown now exists |
| `src/lib/auth/magic-link.ts` | 5 | Documents why reuse is impossible; consumption invalidates siblings |
| `src/app/api/auth/student-signup/route.ts` | 5 | P2002 on the create falls through to the link send |
| `src/services/notifications.ts` | 6 | `markEmailSent` is a CAS returning a count |
| `src/services/email-fallback.ts` | 6 | Claims before sending; releases the claim on failure |
| `src/lib/scheduler.ts` | 6 | Docblock no longer claims every job is idempotent |
| `src/lib/db-locks.ts` | 7 | Gains the advisory-lock helper, the dedupe window, and lists the helper as an adopter |
| `src/app/api/announcements/route.ts` | 7 | Lock + compare above the fan-out, all in one transaction; 200 + `duplicateSuppressed` when it suppresses |
| `src/components/class/send-announcement.tsx` | 7 | Tells the teacher when a send was suppressed instead of reporting a send |
| `src/components/class/send-announcement.test.tsx` | 7 | **New** — the only component test in this branch |
| `docs/lock-order.md` | 7 | Gains the advisory-lock entry |

---

## Task 1: Invitation DELETE and PUT — CAS on status

Establishes the idiom the next two tasks reuse: a status-scoped write plus a `count === 0` branch returning the pre-check's own 409.

**Files:**
- Modify: `src/app/api/invitations/[id]/route.ts:94-104` (PUT), `:143` (DELETE), `:174` (PATCH — comment only)
- Test: `tests/integration/invitations-api.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the CAS-plus-count idiom and the *uncommitted-holder* race lever, both reused by Tasks 2 and 3.

**Background you need.** Both verbs already refuse a `declined` row with a pre-check (`:55-61` for PUT, `:135-141` for DELETE) returning 409 with code `DECLINED_IS_PERMANENT`. That pre-check is a read-then-write: under Read Committed a decline can commit in the gap between it and the write. The write then destroys the tombstone, which `route.ts:130-134` says must outlive the teacher's wish to be rid of it. `declined` is the only tombstone status — `enum InvitationStatus { pending accepted declined }`.

**`PATCH` must NOT get this scope.** Archiving a declined row is the deliberate escape hatch DELETE's own message points at (`:166-172`), pinned by `invitations-api.test.ts:503`.

- [ ] **Step 1: Write the failing race test for DELETE**

The lever is a second `PrismaClient` holding an uncommitted decline, copied from `src/services/class-generator.test.ts:875-937`. The HTTP request blocks on the row lock, then re-evaluates its `where` after the holder commits — which is exactly the interleaving the pre-check cannot survive.

Add to `tests/integration/invitations-api.test.ts`, inside a new nested `describe`. Use the file's existing `makeTeacher`/`cookie`/`suffix` conventions and add a nested `afterAll` (nested ones run before their parent's):

```ts
describe('invitation writes are retry-safe against a concurrent decline (#196)', () => {
  afterAll(async () => {
    await prisma.invitation.deleteMany({ where: { teacherId: raceTeacherId } });
  });

  it('refuses to delete a row that was declined while the request was in flight', async () => {
    const email = `race-delete-${suffix}@test.local`;
    const inv = await prisma.invitation.create({
      data: { teacherId: raceTeacherId, email, firstName: 'Race', lastName: 'Delete', status: 'pending' },
    });

    // The holder declines and holds it UNCOMMITTED, so the route's own
    // pre-check still reads `pending` and its write then parks on the
    // holder's row lock — the same lever the generator race tests use.
    const holder = new PrismaClient();
    let release!: () => void;
    let declined!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const parked = new Promise<void>((r) => { declined = r; });
    const holding = holder.$transaction(async (tx) => {
      await tx.invitation.updateMany({
        where: { id: inv.id, status: 'pending' },
        data: { status: 'declined', respondedAt: new Date() },
      });
      declined();
      await released;
    }, { timeout: 20_000 });

    await parked;
    const deleting = fetch(`${BASE_URL}/api/invitations/${inv.id}`, {
      method: 'DELETE',
      headers: cookie(raceTeacherToken),
    });
    await new Promise((r) => setTimeout(r, 400));
    release();
    await holding;
    const res = await deleting;
    await holder.$disconnect();

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DECLINED_IS_PERMANENT');

    // The tombstone survived, which is the whole point of the guard.
    const still = await prisma.invitation.findUnique({ where: { id: inv.id } });
    expect(still).not.toBeNull();
    expect(still!.status).toBe('declined');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts -t 'declined while the request was in flight'`

Expected: FAIL. The unscoped `delete({ where: { id } })` succeeds after the lock is released, so `res.status` is 200 and `still` is `null`. **Record the exact failure text** — you will need it to prove the guard bites.

- [ ] **Step 3: Add the same test for PUT**

Same lever; the request edits the email off the declined row, which frees the address just as surely as a delete would (`route.ts:51-54`):

```ts
  it('refuses to edit a row that was declined while the request was in flight', async () => {
    // ... identical holder setup against a fresh `race-put-${suffix}` invitation ...
    const editing = fetch(`${BASE_URL}/api/invitations/${inv.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(raceTeacherToken) },
      body: JSON.stringify({ email: `race-put-moved-${suffix}@test.local` }),
    });
    // ... release, await ...
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DECLINED_IS_PERMANENT');
    const still = await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(still.email).toBe(email);        // the tombstone still keys on the original address
    expect(still.status).toBe('declined');
  });
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts -t 'declined while the request was in flight'`
Expected: both FAIL. Record the text.

- [ ] **Step 5: Implement DELETE's CAS**

Replace `src/app/api/invitations/[id]/route.ts:143`:

```ts
  // The pre-check above is a read-then-write, so a decline committing in the
  // gap would reach a plain `delete({ where: { id } })` and destroy the
  // tombstone anyway. The status lives in the WHERE for that reason: a count
  // of 0 means the row went declined underneath us, and the answer is the
  // same 409 the pre-check gives. Same idiom as `revivePendingInvitation`
  // (`services/invitations.ts`), which CASes on `status: 'accepted'`.
  const removed = await prisma.invitation.deleteMany({
    where: { id, status: { not: 'declined' } },
  });
  if (removed.count === 0) {
    return respondError(
      'This person declined. You can archive this contact, but it cannot be removed.',
      409,
      'DECLINED_IS_PERMANENT',
    );
  }
  return respondOk({ id });
```

- [ ] **Step 6: Implement PUT's CAS**

Replace the `prisma.invitation.update` at `:94-104` with an `updateMany` carrying the same scope. Keep the existing P2002 catch exactly as it is — `updateMany` raises P2002 the same way, and that catch is the `ALREADY_INVITED` path for a teacher retyping one contact's address as another's:

```ts
  let changed: { count: number };
  try {
    changed = await prisma.invitation.updateMany({
      // Status in the WHERE for the same reason DELETE has it: the pre-check
      // above cannot see a decline that commits in its gap.
      where: { id, status: { not: 'declined' } },
      // Nothing here lowercases `email` — it arrives already normalised
      // by `emailField` (`updateInvitationSchema`, src/lib/schemas.ts) at
      // HTTP ingress, and `Invitation_email_lowercase_check` rejects
      // anything else at rest. [...keep the rest of this comment verbatim...]
      data: { ...rest, ...(email !== undefined ? { email } : {}) },
    });
  } catch (err) {
    // ...unchanged...
  }
  if (changed.count === 0) {
    return respondError(
      'This person declined. You can archive this contact, but it cannot be removed.',
      409,
      'DECLINED_IS_PERMANENT',
    );
  }
  return respondOk({ id });
```

Note `updateMany` takes no `select`, so the `updated.id` the old code returned becomes the `id` already in scope. The response shape is unchanged.

- [ ] **Step 7: Add the PATCH exclusion comment**

Above `prisma.invitation.update` at `:174`, so the next reader does not "finish the job":

```ts
  // Deliberately NOT status-scoped, unlike DELETE and PUT above. Archiving a
  // declined row is the escape hatch those two refusals point at, so a CAS on
  // `status: { not: 'declined' }` here would remove the only thing a teacher
  // can still do with a tombstone. `invitations-api.test.ts` ('archives a
  // declined row') fails if this is ever scoped. The read-then-write gap that
  // matters there is benign: two concurrent PATCHes converge on one
  // `isArchived`.
```

- [ ] **Step 8: Run both race tests and the existing suite**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts`
Expected: PASS, including the pre-existing `:241`, `:253`, `:344` and `:503` cases. If `:503` fails you scoped PATCH.

- [ ] **Step 9: Run the three mutations and record their output**

1. Remove `status: { not: 'declined' }` from DELETE → the DELETE race test must fail. Restore.
2. Remove it from PUT → the PUT race test must fail. Restore.
3. **Add** `status: { not: 'declined' }` to PATCH → `invitations-api.test.ts` "archives a declined row" must fail. Restore. *This mutation proves an absence, and adding the guard is the only way to prove a missing one is deliberate.*

Record each exact failure message in your task report.

- [ ] **Step 10: Commit**

```bash
git add "src/app/api/invitations/[id]/route.ts" tests/integration/invitations-api.test.ts
git commit -m "fix: CAS invitation delete and edit on status so a concurrent decline cannot lose its tombstone"
```

---

## Task 2: Registration cancel — scope the source, not the broadcast

**Files:**
- Modify: `src/app/api/registrations/[id]/route.ts:160-163` and `:171-174`
- Test: `tests/integration/registrations-api.test.ts`

**Interfaces:**
- Consumes: Task 1's CAS-plus-count idiom.
- Produces: the final-hour-window fixture helper, reused conceptually by Task 3.

**Background.** The handler runs **no transaction**. Its "already cancelled" pre-check (`:143-145`) is a read-then-write, and both cancel branches write `prisma.registration.update({ where: { id } })` — unscoped. Two concurrent cancels therefore both succeed and both call `promoteAfterCancel` → `handleSpotFreed`. In the final-hour window that function broadcasts to every waiting student with no capacity check, so every waiting student gets **two** `spot_available` notifications and two emails.

There is nothing to key a broadcast guard on: `WaitlistEntry` has no `notifiedAt`, `Notification` has no unique index, and `createBulkNotifications` uses `createMany` without `skipDuplicates`. So the fix is the source.

- [ ] **Step 1: Write the failing concurrent-cancel test**

The class must sit in the `first_come_first_claimed` window, which is `[classStart − deadlineHours − 1h, classStart − deadlineHours)`. Build it from the clock so it is deterministic, and give the teacher `defaultTimezone: 'UTC'` so date + `startTime` map to a known instant:

```ts
  it('broadcasts one spot_available set when the same cancel arrives twice at once', async () => {
    // 48h + 30m out with a HOURS_48 deadline puts `now` half an hour inside
    // the final-hour window, where handleSpotFreed broadcasts instead of
    // auto-promoting. Computed from the clock rather than hard-coded: the
    // window is relative, so a fixed date would drift out of it.
    const target = new Date(Date.now() + 48 * 60 * 60 * 1000 + 30 * 60 * 1000);
    const date = target.toISOString().slice(0, 10);
    const startTime = target.toISOString().slice(11, 16);

    const cls = await prisma.class.create({
      data: {
        teacherId: raceTeacherId, teacherRoomId: raceRoomId,
        classType: 'Race Cancel', date: new Date(`${date}T00:00:00Z`), startTime,
        durationMinutes: 60, roomCost: 20, minRate: 30, targetRate: 60,
        minStudents: 1, maxStudents: 1, cancelDeadline: 'HOURS_48',
        autoCancelCheck: 'HOURS_2', status: 'open',
      },
    });
    const reg = await prisma.registration.create({
      data: { classId: cls.id, studentId: cancellerId, status: 'registered', tierAtBooking: 3 },
    });
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    const del = () => fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
      method: 'DELETE', headers: cookie(cancellerToken),
    });
    const [a, b] = await Promise.all([del(), del()]);

    // Either request can win, so the loser is identified rather than assumed.
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const notifications = await prisma.notification.findMany({
      where: { relatedClassId: cls.id, recipientId: waiterId, type: 'spot_available' },
    });
    expect(notifications).toHaveLength(1);
  });
```

The route awaits `handleSpotFreed` before responding (`:165`/`:178` then `:180`), so a plain count is sound here — no `waitFor` needed.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts -t 'same cancel arrives twice'`
Expected: FAIL on `[200, 200]` and `toHaveLength(2)`. Record the text. **If it passes before the fix, the test is not observing the race — say so rather than proceeding**; the two requests are serialising and the test needs the concurrency lever from Task 1 instead.

- [ ] **Step 3: Write the paired sequential test**

Mandatory, per `rooms-api.test.ts:465-480`: the concurrent case cannot tell "the CAS fired" from "a guard resolved it before either write ran", and a sequential duplicate can only ever reach the CAS.

```ts
  it('409s a second cancel of a registration already cancelled', async () => {
    // ...create class + registration, DELETE once expecting 200...
    const second = await fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
      method: 'DELETE', headers: cookie(cancellerToken),
    });
    expect(second.status).toBe(409);
  });
```

- [ ] **Step 4: Implement the CAS on both branches**

The late-cancel branch at `:160-163`:

```ts
      // Status in the WHERE, not just the pre-check at :143. That pre-check
      // is a read-then-write and this handler opens no transaction, so two
      // concurrent cancels both passed it and both reached `handleSpotFreed`
      // — which, inside the final hour, broadcasts to every waiting student
      // with no capacity check and no record that it already did. Scoping the
      // source means exactly one racer gets there, so the broadcast needs no
      // dedupe of its own (there is nothing on WaitlistEntry or Notification
      // to key one on).
      const updated = await prisma.registration.updateMany({
        where: { id, status: { notIn: ['cancelled', 'late_cancel'] } },
        data: { status: 'late_cancel', cancelledAt: new Date() },
      });
      if (updated.count === 0) {
        return respondError('Registration is already cancelled', 409);
      }
      await promoteAfterCancel(registration.classId);
      return respondOk({ id, status: 'late_cancel' });
```

And the same shape for the full-cancel branch at `:171-174`, with `status: 'cancelled'`.

Note both `respondOk` calls previously read fields off the `update` return value; `updateMany` returns only a count, so return the `id` already in scope and the literal status just written. The response shape is unchanged.

- [ ] **Step 5: Run both tests**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: PASS, including the pre-existing `:872` and `:887` cancel cases and `:320` capacity race.

- [ ] **Step 6: Run the mutation**

Revert both `updateMany` calls to `update({ where: { id } })` → the concurrent test must fail with two `spot_available` rows. Restore. Record the output.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/registrations/[id]/route.ts" tests/integration/registrations-api.test.ts
git commit -m "fix: scope the registration cancel by status so one freed spot broadcasts once"
```

---

## Task 3: Account erasure — CAS on `deletedAt` and abort

**Files:**
- Modify: `src/services/gdpr.ts` (the `student.update` ending `deleteStudentAccount`'s transaction, and the `teacher.update` ending `deleteTeacherAccount`'s), plus a new exported error class
- Modify: `src/app/api/account/route.ts:115-151`
- Test: `src/services/gdpr.test.ts` (unit), `tests/integration/account-api.test.ts` (integration)

**Interfaces:**
- Consumes: Task 1's CAS idiom.
- Produces: `export class AlreadyErasedError extends Error { readonly half: 'student' | 'teacher' }` from `src/services/gdpr.ts`.

**Background, and why a bare scope is not enough.** Both erasures end by setting `deletedAt` with an unscoped `update({ where: { id } })`. `deleteStudentAccount` then returns `freedClassIds` and runs `handleSpotFreed` per class **after the transaction commits**. Adding `deletedAt: null` to the `where` without aborting still lets the second transaction commit and still runs that post-commit loop a second time — so the scope alone fixes nothing user-visible. **The abort is the operative half.**

`DELETE /api/account`'s error handling is deliberately precise (`route.ts:58-93`): `erasureFailure` distinguishes transient from permanent and student-half from teacher-half, because `deleteTeacherAccount` commits a `completeClass` per in-progress class *before* its transaction opens. A generic throw would land there and tell a user "Removing your account failed" when it had in fact succeeded — hence the typed sentinel, caught **per half** so a dual-role account whose student half is already erased still erases its teacher half.

- [ ] **Step 1: Write the failing unit test**

In `src/services/gdpr.test.ts`, using that file's existing fixtures and its `$extends`/second-client conventions:

```ts
  it('erases once when the same student erasure runs twice concurrently', async () => {
    const { studentId, classId, waiterId } = await makeStudentWithFreedSpot();

    const results = await Promise.allSettled([
      deleteStudentAccount(prisma, studentId),
      deleteStudentAccount(prisma, studentId),
    ]);

    // One erases; the other finds the row already erased and aborts whole.
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyErasedError);

    // The post-commit spot-freed loop ran once, not twice.
    const notifications = await prisma.notification.findMany({
      where: { relatedClassId: classId, recipientId: waiterId, type: 'spot_available' },
    });
    expect(notifications).toHaveLength(1);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t 'same student erasure runs twice'`
Expected: FAIL — `AlreadyErasedError` is not exported yet, so this is a compile error first. That is a legitimate red. Record it.

- [ ] **Step 3: Add the sentinel and both CASes**

In `src/services/gdpr.ts`:

```ts
/**
 * Thrown when an erasure finds the profile already erased.
 *
 * Not a failure: the caller's goal is satisfied, by the request that won. It
 * exists so the transaction ABORTS rather than committing a second, redundant
 * erasure — `deleteStudentAccount` runs `handleSpotFreed` per freed class
 * AFTER its transaction commits, so a second commit would broadcast a second
 * `spot_available` set to every waiting student. Scoping the write alone does
 * not prevent that; only refusing to commit does.
 *
 * `DELETE /api/account` maps this to the same 200 a first erasure returns —
 * see that route for why it must not reach `erasureFailure`.
 */
export class AlreadyErasedError extends Error {
  constructor(readonly half: 'student' | 'teacher') {
    super(`${half} profile is already erased`);
    this.name = 'AlreadyErasedError';
  }
}
```

Replace the `tx.student.update` that ends `deleteStudentAccount`'s transaction:

```ts
    const erased = await tx.student.updateMany({
      where: { id: studentId, deletedAt: null },
      data: { /* ...every field exactly as before... */ deletedAt: new Date() },
    });
    if (erased.count === 0) throw new AlreadyErasedError('student');
```

and the `tx.teacher.update` that ends `deleteTeacherAccount`'s, with `AlreadyErasedError('teacher')`.

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`
Expected: the new test PASSES; every existing test in the file still passes.

- [ ] **Step 5: Teach the route to treat the sentinel as success**

In `src/app/api/account/route.ts`, inside each half's `catch`, ahead of the existing logging:

```ts
    } catch (err) {
      // The erasure this request wanted has already happened — a concurrent
      // duplicate, whose transaction aborted whole rather than broadcasting a
      // second time. The caller's question is "is this account gone?" and the
      // honest answer is yes, so this must NOT reach `erasureFailure`, which
      // would report a 500 for a successful outcome. Caught per half so a
      // dual-role account whose student half is already erased still goes on
      // to erase its teacher half below.
      if (err instanceof AlreadyErasedError) {
        log.info({ accountId: session.accountId, half: err.half }, 'account erasure: half already erased');
      } else {
        // ...the existing transient/log/erasureFailure block, unchanged...
      }
    }
```

- [ ] **Step 6: Write the integration test**

In `tests/integration/account-api.test.ts`:

```ts
  it('returns success and clears the session when two erasures arrive at once', async () => {
    // ...create a student account with its own session token...
    const del = () => fetch(`${BASE_URL}/api/account`, { method: 'DELETE', headers: cookie(token) });
    const [a, b] = await Promise.all([del(), del()]);

    // Both are honest: the account is gone either way.
    expect([a.status, b.status]).toEqual([200, 200]);
    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    expect(student.deletedAt).not.toBeNull();
  });
```

- [ ] **Step 7: Run both projects' relevant files**

Run: `npx vitest run --project unit src/services/gdpr.test.ts` and
`npx vitest run --project integration tests/integration/account-api.test.ts`
Expected: PASS. The existing `:351` sequential-retry case must still pass — `resolveSession` already made that a no-op and this must not change it.

- [ ] **Step 8: Run both mutations and record them**

1. Remove `deletedAt: null` from the student CAS → the concurrent unit test must fail.
2. **Keep the scope but replace the `throw` with a no-op** → the same test must *still* fail, on the doubled `spot_available` count. This is the mutation that proves the **abort** is what works and not the scope alone. Restore both.

- [ ] **Step 9: Commit**

```bash
git add src/services/gdpr.ts src/app/api/account/route.ts src/services/gdpr.test.ts tests/integration/account-api.test.ts
git commit -m "fix: abort a redundant erasure instead of broadcasting its freed spots twice"
```

---

## Task 4: Manual payment reminder — a 2-minute cooldown

**Files:**
- Modify: `src/services/payments.ts` (the `sendPaymentReminder` CAS and its docblock)
- Modify: `src/components/class/send-reminder-button.tsx:26-36` (docblock only)
- Test: `src/services/payments.test.ts`, `tests/integration/payments-api.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MANUAL_REMIND_COOLDOWN_MS` exported from `src/services/payments.ts`.

**Background.** `sendPaymentReminder` already has the `updateMany` + `count === 0` idiom — it just CASes on `status`, which a reminder does not change, so two concurrent clicks both read `pending`, both stamp and both notify. `reminderSentAt` already exists and is **already read** in six places (the cron's dedupe at `payment-reminders.ts:47` and `:78`, plus four UI sites); the branch-1 spec's claim that it is "never read" is false. The column is `Payment.reminderSentAt`, not `schema.prisma:536`.

**Decision:** 2 minutes, matching the announcement window. It kills the double-submit without becoming the anti-nagging policy the product deliberately does not have.

- [ ] **Step 1: Write the failing unit tests**

In `src/services/payments.test.ts`, following that file's fixture conventions:

```ts
  it('refuses a second manual reminder inside the cooldown, sending nothing', async () => {
    const paymentId = await makeOutstandingPayment();
    const first = await sendPaymentReminder(prisma, paymentId);
    expect(first.ok).toBe(true);

    const before = await prisma.notification.count({ where: { relatedClassId: classId, type: 'reminder' } });
    const second = await sendPaymentReminder(prisma, paymentId);

    expect(second.ok).toBe(false);
    expect(await prisma.notification.count({ where: { relatedClassId: classId, type: 'reminder' } })).toBe(before);
  });

  it('allows a manual reminder once the cooldown has lapsed', async () => {
    const paymentId = await makeOutstandingPayment();
    await sendPaymentReminder(prisma, paymentId);
    // Backdate the stamp past the window rather than sleeping.
    await prisma.payment.update({
      where: { id: paymentId },
      data: { reminderSentAt: new Date(Date.now() - MANUAL_REMIND_COOLDOWN_MS - 1000) },
    });
    expect((await sendPaymentReminder(prisma, paymentId)).ok).toBe(true);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit src/services/payments.test.ts -t 'cooldown'`
Expected: the first FAILS (a second reminder currently succeeds and notifies). The second may pass vacuously today — note that in your report; it becomes load-bearing after Step 3.

- [ ] **Step 3: Implement the cooldown**

```ts
/**
 * How long a manual reminder suppresses an identical second one.
 *
 * Two minutes: long enough to absorb a double-click and a retried request
 * from a flaky connection, short enough that it is not an anti-nagging
 * policy. That distinction is deliberate — `send-reminder-button.tsx`
 * documents the calm "Reminded …" caption as the only pressure against
 * nagging, and a longer window would replace a product stance with a
 * mechanism. The automatic sweep's own dedupe is a different quantity
 * entirely (`REMIND_EVERY_DAYS`, `payment-reminders.ts`).
 */
export const MANUAL_REMIND_COOLDOWN_MS = 2 * 60 * 1000;
```

Extend the existing CAS's `where`:

```ts
    const cooldownStart = new Date(Date.now() - MANUAL_REMIND_COOLDOWN_MS);
    const stamped = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: { in: ['pending', 'overdue'] },
        // The status CAS alone cannot stop a double-click: a reminder does
        // not change status, so both racers passed it. `reminderSentAt` is
        // the value that actually moves.
        OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: cooldownStart } }],
      },
      data: { reminderSentAt: new Date() },
    });
```

Extend the `count === 0` diagnostic branch to tell the two causes apart:

```ts
    if (stamped.count === 0) {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return { ok: false, error: `Payment not found: ${paymentId}` };
      if (payment.reminderSentAt && payment.reminderSentAt >= cooldownStart) {
        return { ok: false, error: 'A reminder for this payment was just sent. Try again in a couple of minutes.' };
      }
      return { ok: false, error: `Cannot send a reminder: current status is "${payment.status}". Must be "pending" or "overdue".` };
    }
```

- [ ] **Step 4: Correct both docblocks**

`payments.ts`'s `sendPaymentReminder` docblock currently describes the status CAS as the whole guard; add the cooldown term. `send-reminder-button.tsx:30-33` says *"the only pressure against nagging, since no cooldown is enforced"* — that sentence is now false. Rewrite it to say a 2-minute cooldown exists, that it is a retry guard rather than an anti-nagging policy, and leave the `REMIND_EVERY_DAYS` deferral paragraph intact, since that behaviour is unchanged.

- [ ] **Step 5: Add the integration test**

In `tests/integration/payments-api.test.ts`, alongside the existing `:261` and `:280` cases, a concurrent pair asserting `[200, 409].sort()` and exactly one `reminder` notification.

- [ ] **Step 6: Run everything touched**

Run: `npx vitest run --project unit src/services/payments.test.ts src/services/payment-reminders.test.ts` then
`npx vitest run --project integration tests/integration/payments-api.test.ts`
Expected: PASS. `payment-reminders.test.ts:153` ("leaves an overdue payment a recent manual send already stamped") must still pass — the cron's behaviour is unchanged.

- [ ] **Step 7: Run both mutations**

1. Remove the `OR` term from the CAS `where` → the "second reminder inside the cooldown" test must fail.
2. Freeze `cooldownStart` so the window never lapses (e.g. `new Date(0)` → change the comparison so nothing is ever old enough) → the "once the cooldown has lapsed" test must fail. This proves the second test is not vacuous. Restore both, record both.

- [ ] **Step 8: Commit**

```bash
git add src/services/payments.ts src/services/payments.test.ts src/components/class/send-reminder-button.tsx tests/integration/payments-api.test.ts
git commit -m "fix: give the manual payment reminder a 2-minute cooldown so a double-click duns once"
```

---

## Task 5: Magic link and student signup

Two endpoints, one file each, both in auth. Grouped because neither is large enough to gate separately and both were mis-specified in the same way.

**Files:**
- Modify: `src/lib/auth/magic-link.ts` (`generateMagicLinkToken` docblock; `verifyMagicLinkToken` sibling invalidation)
- Modify: `src/app/api/auth/student-signup/route.ts:40-50`
- Test: `src/lib/auth/magic-link.test.ts`, `tests/integration/signup-api.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks use.

**Background — read this before touching anything.** The branch-1 spec's §4.2 says to "reuse the live unconsumed token" and to "move the mint+send inside the existing guard". **Do neither.**

- Reuse is not expressible: `generateMagicLinkToken` stores only `sha256(raw)` and the raw token is persisted nowhere.
- Moving the mint inside `student-signup`'s guard would remove sign-in for every returning student and every unclaimed CRM contact. The comment at `route.ts:37-39` states the contract it would break, and **no test covers the non-fresh path**, so the regression would ship green.

`POST /api/auth/magic-link/send` gets **no code change**: minting a second live token while the first stays valid is the decided behaviour, and #196's acceptance permits documenting it.

- [ ] **Step 1: Write the failing sibling-invalidation tests**

In `src/lib/auth/magic-link.test.ts`:

```ts
  it('invalidates every other live token for that address on a successful sign-in', async () => {
    const email = 'siblings@example.com';
    const first = await generateMagicLinkToken(db, email);
    const second = await generateMagicLinkToken(db, email);

    expect(await verifyMagicLinkToken(db, second)).toEqual({ email, redirectTo: null });

    // The older link is dead: it has no purpose once its owner is signed in,
    // and a live one sitting in an inbox is exposure with no upside.
    expect(await verifyMagicLinkToken(db, first)).toBeNull();
    expect(await db.magicLinkToken.count({ where: { email } })).toBe(0);
  });

  it('does not let an expired token kill a live one', async () => {
    const email = 'expired-cannot-kill@example.com';
    const stale = await generateMagicLinkToken(db, email);
    await db.magicLinkToken.updateMany({
      where: { tokenHash: hashOf(stale) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const live = await generateMagicLinkToken(db, email);

    expect(await verifyMagicLinkToken(db, stale)).toBeNull();   // expired, rejected
    // If invalidation ran before the expiry check, this would be dead too —
    // which would let anyone holding an old link deny the real user theirs.
    expect(await verifyMagicLinkToken(db, live)).toEqual({ email, redirectTo: null });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit src/lib/auth/magic-link.test.ts`
Expected: the first FAILS (the older token still verifies); the second passes today and must keep passing. Record both.

- [ ] **Step 3: Implement the invalidation, after the expiry check**

In `verifyMagicLinkToken`, after the `record.expiresAt <= new Date()` guard returns and before the final `return`:

```ts
  // Every other live token for this address is now surplus: its owner is
  // signed in, so the only thing a link still sitting in their inbox can do
  // is be used by someone else — a forwarded mail, a shared mailbox, a
  // link-prefetching scanner. Rate limiting allows three per address per 15
  // minutes and the TTL is 15 minutes, so there can be two.
  //
  // Placement is load-bearing: this runs only AFTER the expiry check above.
  // Invalidating on every consumption would let anyone holding an old expired
  // link destroy the user's fresh one — a guard that creates the denial of
  // service it exists to prevent.
  //
  // Unindexed by design. `MagicLinkToken` carries `@unique` on `tokenHash`
  // only, and adding an index means a migration; `cleanupExpiredAuth` sweeps
  // daily and the rate limit caps the table, so the scan is microseconds.
  await db.magicLinkToken.deleteMany({ where: { email: record.email } });
```

- [ ] **Step 4: Document why reuse is impossible**

On `generateMagicLinkToken`:

```ts
/**
 * Mints a single-use sign-in link token, returning the RAW token for the
 * email and storing only its SHA-256 hash.
 *
 * A second call for the same address deliberately mints a second live token
 * rather than reusing or invalidating the first: a resend must work, and the
 * first link must keep working, because the user clicks whichever mail they
 * see first. That duplication is legitimate (#196) and bounded — the rate
 * limiter caps it at three per address per 15 minutes, the TTL is 15 minutes,
 * `cleanupExpiredAuth` sweeps the remains daily, and `verifyMagicLinkToken`
 * deletes every sibling the moment one of them is used.
 *
 * Reusing a live token instead is NOT possible and must not be attempted: the
 * raw value is returned here and persisted nowhere, so recovering it from a
 * row would mean inverting SHA-256. Storing it raw, or reversibly, would make
 * any database read a sign-in — which is the whole reason this column is a
 * hash. #196's original design proposed reuse; that is why this note exists.
 */
```

- [ ] **Step 5: Write the failing student-signup race test**

In `tests/integration/signup-api.test.ts` — remember `freshIp()`, since this route is IP rate-limited at 5/hour:

```ts
  it('answers both halves of a concurrent signup identically, with no enumeration', async () => {
    const email = `signup-race-${suffix}@test.local`;
    const ip = freshIp();   // one bucket, shared: two requests, limit is 5/hr
    const post = () => fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ip },
      body: JSON.stringify({ firstName: 'Race', lastName: 'Signup', email }),
    });

    const [a, b] = await Promise.all([post(), post()]);

    // The identical-response contract holds under a race too: a 409 here
    // would both fail a legitimate signup and reveal the address is taken.
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await prisma.student.count({ where: { email } })).toBe(1);
  });
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/signup-api.test.ts -t 'concurrent signup'`
Expected: FAIL with one 409. If both return 200 the race did not interleave — report that rather than proceeding; the P2002 window is narrow and the test may need more concurrent requests.

- [ ] **Step 7: Catch P2002 on the create**

```ts
  if (!existingAccount && !existingStudent) {
    try {
      await prisma.student.create({ /* ...unchanged... */ });
    } catch (err) {
      // Both pre-checks above are plain reads, so a concurrent signup for the
      // same fresh address passes both and one of them loses on
      // `Student.email`/`Account.email`. Losing means the account now exists
      // — which is precisely the state the `else` path below already handles
      // correctly, by just sending the link. Rethrowing would surface a 409
      // "Resource already exists", failing a legitimate signup AND telling an
      // anonymous caller the address is taken, which this route's identical
      // 200 exists to prevent.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }
```

Add `import { Prisma } from '@prisma/client';` if absent.

- [ ] **Step 8: Run everything touched**

Run: `npx vitest run --project unit src/lib/auth/magic-link.test.ts` then
`npx vitest run --project integration tests/integration/signup-api.test.ts tests/integration/auth.test.ts tests/integration/auth-email-case.test.ts`
Expected: PASS. `auth-email-case.test.ts:53` asserts `toHaveLength(1)` on tokens after one send — unaffected, since nothing about minting changed.

- [ ] **Step 9: Run the three mutations**

1. Remove the sibling `deleteMany` → the invalidation test must fail.
2. Move it **above** the expiry check → the "expired cannot kill a live one" test must fail.
3. Remove the P2002 catch → the concurrent signup test must fail with a 409.

Restore each, record each.

- [ ] **Step 10: Commit**

```bash
git add src/lib/auth/magic-link.ts src/lib/auth/magic-link.test.ts "src/app/api/auth/student-signup/route.ts" tests/integration/signup-api.test.ts
git commit -m "fix: retire sibling sign-in links on use, and let a raced signup answer 200"
```

---

## Task 6: Email fallback — claim before sending

**Files:**
- Modify: `src/services/notifications.ts` (`markEmailSent`)
- Modify: `src/services/email-fallback.ts` (the send branch, `markOne`, and a new release helper)
- Modify: `src/lib/scheduler.ts:9-10` (docblock only)
- Test: `src/services/email-fallback.test.ts`, `src/services/notifications.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `markEmailSent(db, ids): Promise<number>` — **signature change, was `Promise<void>`**.

**Background.** `processEmailFallback` has **two triggers**: `POST /api/cron/email-fallback` and `src/lib/scheduler.ts`, every 5 minutes in-process. Overlapping sweeps both read the same rows (`getUnreadForEmailFallback` filters on `emailSent: false` but claims nothing) and both reach `resend().emails.send`. The mark happens *after* the send, so a CAS there de-duplicates the mark and not the email.

**Decision:** claim first, release on failure. This inverts the residual risk recorded at `email-fallback.ts:41-43` from "duplicate on crash" to "drop on crash", which is accepted: overlapping sweeps are routine and a crash in the gap is rare, and a dropped *fallback* email leaves the in-app notification and inbox record intact.

**Test at the unit tier.** `email-fallback.test.ts` runs against the dedicated test database, which the dev server's scheduler does not touch. Do not write an integration test that creates fallback-eligible notifications in the dev database — the running scheduler will sweep them.

- [ ] **Step 1: Write the failing overlapping-sweep test**

In `src/services/email-fallback.test.ts`, following that file's existing send-stubbing conventions:

```ts
  it('sends once when two sweeps overlap on the same notification', async () => {
    const id = await makeUnreadNotificationOlderThan(30);

    const [a, b] = await Promise.all([
      processEmailFallback(prisma),
      processEmailFallback(prisma),
    ]);

    // Exactly one sweep owned it; the other found it claimed and skipped.
    expect(a.sent + b.sent).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves a failed send for the next sweep to retry', async () => {
    const id = await makeUnreadNotificationOlderThan(30);
    sendSpy.mockResolvedValueOnce({ error: { message: 'boom' } });

    await expect(processEmailFallback(prisma)).rejects.toThrow();

    // The claim was released, so the row is still eligible.
    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(row.emailSent).toBe(false);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --project unit src/services/email-fallback.test.ts -t 'overlap'`
Expected: FAIL — two sends. Record the text.

- [ ] **Step 3: Turn `markEmailSent` into a CAS**

```ts
/**
 * Claims notifications for email fallback, returning how many this call won.
 *
 * `emailSent: false` in the WHERE makes this a compare-and-swap, not a
 * blind mark: two overlapping sweeps read the same candidate rows (the
 * candidate query filters but does not claim), and the count is how the
 * loser learns it lost. Returns the count rather than `void` for that
 * reason — a caller that ignores it is back to the unguarded behaviour.
 */
export async function markEmailSent(
  db: PrismaClient,
  notificationIds: string[],
): Promise<number> {
  const { count } = await db.notification.updateMany({
    where: { id: { in: notificationIds }, emailSent: false },
    data: { emailSent: true },
  });
  return count;
}
```

- [ ] **Step 4: Move the claim ahead of the send, and add the release**

In `email-fallback.ts`, replace `markOne` with a claiming pair and rework the send branch:

```ts
  /**
   * Claims one notification, fail-closed. A throw here means we could not
   * record ownership, and "we could not record it" is not "we own it" — so
   * the caller must not send. Contrast the old `markOne`, which logged and
   * carried on because a lost mark then only risked a duplicate.
   */
  const claimOne = async (id: string): Promise<boolean> => {
    try {
      return (await markEmailSent(db, [id])) === 1;
    } catch (err) {
      log.error({ err, notificationId: id }, 'failed to claim notification for email fallback');
      return false;
    }
  };

  const releaseOne = async (id: string) => {
    try {
      await db.notification.updateMany({ where: { id }, data: { emailSent: false } });
    } catch (err) {
      log.error({ err, notificationId: id }, 'failed to release email-fallback claim (will not retry)');
    }
  };
```

In the send branch, claim before `resend().emails.send` and release on the `error` and `catch` paths:

```ts
    // Claim BEFORE sending. Marking after the send de-duplicated the mark and
    // not the email: two overlapping sweeps — the 5-minute in-process
    // scheduler and any route or external trigger — both passed the candidate
    // read and both sent. The trade this inverts is recorded in the spec: a
    // crash between claim and send now drops a fallback email rather than
    // duplicating one, and the in-app notification survives either way.
    if (!(await claimOne(notification.id))) continue;

    try {
      const { subject, html } = renderNotificationEmail(notification);
      const { error } = await resend().emails.send({ /* ...unchanged... */ });
      if (error) {
        log.error({ notificationId: notification.id, reason: error.message }, 'email fallback send failed');
        await releaseOne(notification.id);
        failed++;
        continue;
      }
      sent++;
    } catch (err) {
      log.error({ err, notificationId: notification.id }, 'email fallback send failed');
      await releaseOne(notification.id);
      failed++;
    }
```

The two non-send branches (the opted-out skip and the dry-run) keep marking after their decision — there is no external effect to protect there. Update the block comment at `:41-43`, which describes the old ordering.

- [ ] **Step 5: Correct the scheduler docblock**

`src/lib/scheduler.ts:9-10` says *"Every job is idempotent at the DB layer (conditional updates, unique constraints), so an overlapping external trigger is harmless."* Replace with a claim that is true: name `payment-reminders` as the job whose CAS makes that so, and say `email-fallback` claims each notification before sending for the same reason. Do not assert it of jobs you have not checked.

- [ ] **Step 6: Run everything touched**

Run: `npx vitest run --project unit src/services/email-fallback.test.ts src/services/email-fallback.consent.test.ts src/services/notifications.test.ts`
Expected: PASS. `notifications.test.ts:329` calls `markEmailSent` and may need its expectation updated for the new return type — that is a legitimate change, not a workaround.

- [ ] **Step 7: Run both mutations**

1. Move the claim back below the send → the overlapping-sweep test must fail with two sends.
2. Remove the `releaseOne` calls → the retry test must fail (`emailSent` stays `true`).

Restore each, record each.

- [ ] **Step 8: Commit**

```bash
git add src/services/notifications.ts src/services/email-fallback.ts src/lib/scheduler.ts src/services/email-fallback.test.ts src/services/notifications.test.ts
git commit -m "fix: claim a notification before sending its fallback email, so overlapping sweeps send once"
```

---

## Task 7: Announcements — lock and compare above the fan-out

The largest task and the only new idiom. Do it last.

**Files:**
- Modify: `src/lib/db-locks.ts` (new helper + the adopter list in `TransactionClientOnly`'s docblock)
- Modify: `src/app/api/announcements/route.ts:70-93`
- Modify: `src/components/class/send-announcement.tsx`
- Modify: `docs/lock-order.md`
- Create: `src/components/class/send-announcement.test.tsx`
- Test: `src/lib/db-locks.test.ts`, `tests/integration/announcements-api.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: from `src/lib/db-locks.ts` — `lockAnnouncementSlot(tx: TransactionClientOnly, key: string): Promise<void>` and `export const ANNOUNCEMENT_DEDUPE_WINDOW_MS = 2 * 60 * 1000`. The window lives beside the lock rather than in the route so the integration test can import it and backdate by exactly it; a test that hard-codes `120000` drifts silently the day the window changes. `db-locks.ts` is import-safe for tests — it pulls in only `crypto` and a Prisma type, never `@/lib/log`.
- Produces: the API response field `duplicateSuppressed: boolean` on `POST /api/announcements`, consumed by `send-announcement.tsx` in the same task.

**Background.** `route.ts:81` fans out one `Notification` per recipient (and emits SSE inside that call), and only then, at `:84`, inserts the `Announcement`. **Nothing wraps them in a transaction.** Deduplicating the insert would suppress the teacher's sent-history record and leave every student holding a second notification.

`Announcement.message` is `@db.Text`, too long for a btree key, so an index-based design must key on a hash — and a hash collision in a unique index would silently reject a legitimate announcement. With an advisory lock the hash is used only for mutual exclusion and the duplicate test compares the real text, so a collision costs a few milliseconds. A time-bucketed index leaks differently: two sends straddling a bucket edge both pass.

**There is no advisory-lock precedent in this repo.** Follow `db-locks.ts`'s conventions exactly: the helper takes `TransactionClientOnly` (that module's own rule is that a function needs the brand when it issues a statement scoped to the surrounding transaction, which `pg_advisory_xact_lock` is), and a parameterised statement uses a `$queryRaw` tagged template, not `$executeRawUnsafe`.

- [ ] **Step 1: Write the failing concurrent test**

In `tests/integration/announcements-api.test.ts`:

```ts
  it('notifies each student once when the same announcement is sent twice at once', async () => {
    const body = { classId, message: `Race announcement ${suffix}` };
    const post = () => fetch(`${BASE_URL}/api/announcements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify(body),
    });

    const [a, b] = await Promise.all([post(), post()]);
    // 201 created it, 200 suppressed it. Either request can win, so the
    // statuses are sorted rather than assigned.
    expect([a.status, b.status].sort()).toEqual([200, 201]);

    const suppressed = a.status === 200 ? a : b;
    expect((await suppressed.json()).data.duplicateSuppressed).toBe(true);

    // The student is the assertion, not the Announcement row: the fan-out is
    // what a duplicate actually costs, and it runs first.
    const notifications = await prisma.notification.findMany({
      where: { recipientType: 'student', recipientId: studentId, type: 'announcement', body: body.message },
    });
    expect(notifications).toHaveLength(1);

    const rows = await prisma.announcement.findMany({ where: { teacherId, message: body.message } });
    expect(rows).toHaveLength(1);
  });
```

- [ ] **Step 2: Write the paired sequential test**

Mandatory — the concurrent case cannot tell "the lock fired" from "a guard resolved it before either write ran":

```ts
  it('suppresses an identical announcement resent within the window, and says so', async () => {
    const body = { classId, message: `Sequential dedupe ${suffix}` };
    expect((await post(body)).status).toBe(201);

    const second = await post(body);
    expect(second.status).toBe(200);
    const json = await second.json();
    // The teacher is told, rather than shown a success for a send that did
    // not happen. `recipientCount` is the FIRST send's, which is the honest
    // number: those students did receive it.
    expect(json.data.duplicateSuppressed).toBe(true);
    expect(json.data.recipientCount).toBeGreaterThan(0);

    expect(await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'announcement', body: body.message },
    })).toBe(1);
  });

  it('sends a genuinely later identical announcement', async () => {
    const body = { classId, message: `Window lapse ${suffix}` };
    expect((await post(body)).status).toBe(201);
    // Backdate the first past the window rather than sleeping two minutes.
    await prisma.announcement.updateMany({
      where: { teacherId, message: body.message },
      data: { sentAt: new Date(Date.now() - ANNOUNCEMENT_DEDUPE_WINDOW_MS - 1000) },
    });
    expect((await post(body)).status).toBe(201);
    expect(await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'announcement', body: body.message },
    })).toBe(2);
  });

  it('does not let an all-students announcement match a class-scoped one', async () => {
    const message = `Nullable classId ${suffix}`;
    expect((await post({ classId, message })).status).toBe(201);
    expect((await post({ message })).status).toBe(201);   // no classId — a different announcement
    expect(await prisma.announcement.count({ where: { teacherId, message } })).toBe(2);
  });
```

- [ ] **Step 3: Run all four and watch them fail**

Run: `npx vitest run --project integration tests/integration/announcements-api.test.ts`
Expected: the first three FAIL (two notifications each); the fourth passes today and must keep passing. Record each.

- [ ] **Step 4: Add the lock helper to `db-locks.ts`**

```ts
/**
 * Namespace for this project's advisory locks, so a key here can never
 * collide with an unrelated advisory lock added later. Postgres's two-int
 * form exists for exactly this.
 */
const ADVISORY_NAMESPACE = { announcement: 196 } as const;

function hash32(value: string): number {
  return createHash('sha256').update(value).digest().readInt32BE(0);
}

/**
 * Serialises concurrent sends of one `(teacher, class, message)` for the rest
 * of the calling transaction.
 *
 * `pg_advisory_xact_lock`, never `pg_advisory_lock`: the transaction-scoped
 * variant releases on commit or rollback however the transaction ends, while
 * the session-scoped one would leak a lock onto a pooled connection and
 * eventually wedge an unrelated request.
 *
 * The hash is used ONLY for mutual exclusion — the caller compares the real
 * message text — so a collision costs a few milliseconds of needless
 * serialisation and nothing else. That is the whole reason this is a lock and
 * not a unique index on a hashed column: `Announcement.message` is `@db.Text`
 * and cannot be a btree key, so an index-based design would have to key on the
 * hash, where a collision silently rejects a legitimate announcement instead.
 *
 * Branded `TransactionClientOnly` per this module's rule: on a bare client the
 * lock would be taken and released by its own autocommit transaction before
 * the caller's next statement ran, protecting nothing.
 */
export async function lockAnnouncementSlot(
  tx: TransactionClientOnly,
  key: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACE.announcement}::int4, ${hash32(key)}::int4)`;
}
```

Add `import { createHash } from 'crypto';`. **Add `lockAnnouncementSlot` to the `adopt` list in `TransactionClientOnly`'s docblock** — that list is normative and is wrong the moment this lands without it.

- [ ] **Step 5: Restructure the route**

Leave `:17-69` (auth, parse, recipient set, opt-out filter) untouched — those are reads. Wrap from the notification inputs down:

```ts
  // ANNOUNCEMENT_DEDUPE_WINDOW_MS is imported from '@/lib/db-locks'.
  const classId = body.classId ?? null;

  const { announcement, deduped } = await prisma.$transaction(async (tx) => {
    // First statement in the transaction, so the compare below and the two
    // writes after it are serialised against an identical concurrent send.
    await lockAnnouncementSlot(tx, `${session.teacherId}|${classId ?? ''}|${body.message}`);

    // `classId ?? null` explicitly: a Prisma `where` given `undefined` OMITS
    // the clause, so passing `body.classId` straight through would make an
    // all-students send match every announcement this teacher ever sent.
    const recent = await tx.announcement.findFirst({
      where: {
        teacherId: session.teacherId,
        classId,
        message: body.message,
        // `sentAt`, not `createdAt` — this model has no `createdAt`.
        sentAt: { gte: new Date(Date.now() - ANNOUNCEMENT_DEDUPE_WINDOW_MS) },
      },
      orderBy: { sentAt: 'desc' },
    });
    if (recent) return { announcement: recent, deduped: true };

    // Inside the transaction and BELOW the compare, because this is the write
    // a duplicate actually costs: it creates one Notification per recipient,
    // and it used to run before the Announcement row existed to compare
    // against — so deduplicating the insert alone would have suppressed the
    // teacher's record and left every student notified twice.
    const count = await createBulkNotifications(tx, notificationInputs);
    const created = await tx.announcement.create({
      data: { teacherId: session.teacherId, classId, message: body.message, recipientCount: count },
    });
    return { announcement: created, deduped: false };
  });

  // 201 created, 200 suppressed — and `duplicateSuppressed` in the body,
  // because the status alone is not enough: a client checking only `res.ok`
  // would go on reporting a send that did not happen. Suppressing the
  // duplicate is right; hiding the suppression would be a tool telling a
  // small lie about what it just did.
  //
  // `recipientCount` on the suppressed branch is the FIRST send's, which is
  // the honest number — those students really did receive it.
  return respondOk({ ...announcement, duplicateSuppressed: deduped }, deduped ? 200 : 201);
```

- [ ] **Step 6: Run the announcement tests**

Run: `npx vitest run --project integration tests/integration/announcements-api.test.ts`
Expected: PASS, including the pre-existing `:169`, `:188`, `:207` and `:218` cases.

- [ ] **Step 7: Write the failing component test**

There is no `send-announcement.test.tsx` today, so create it. Per `vitest.config.ts`, the `components` project mocks `next/navigation` but **not** `fetch` — a test that clicks must stub `fetch` itself, or the component swallows a real relative-URL request into "Network error".

```tsx
// src/components/class/send-announcement.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SendAnnouncement } from './send-announcement';

function stubSend(status: number, data: Record<string, unknown>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => ({ data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

async function send(message: string) {
  fireEvent.click(screen.getByText('Send announcement'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: message } });
  fireEvent.click(screen.getByText('Send'));
}

describe('SendAnnouncement', () => {
  it('reports how many students a fresh announcement reached', async () => {
    stubSend(201, { recipientCount: 12, duplicateSuppressed: false });
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);
    await send('Bring a blanket.');
    await waitFor(() => expect(screen.getByText(/Sent to 12 students/)).toBeTruthy());
  });

  it('says a duplicate was not sent again, and that the first one landed', async () => {
    stubSend(200, { recipientCount: 12, duplicateSuppressed: true });
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);
    await send('Bring a blanket.');

    // The teacher must not be told a second send happened. Both halves are
    // asserted: what did NOT happen, and that the earlier one did — the
    // second is what makes the first calm rather than alarming.
    await waitFor(() => expect(screen.getByText(/Not sent again/)).toBeTruthy());
    expect(screen.getByText(/reached 12 students/)).toBeTruthy();
    expect(screen.queryByText(/^Sent to/)).toBeNull();
  });
});
```

Run: `npx vitest run --project components src/components/class/send-announcement.test.tsx`
Expected: the first PASSES (today's behaviour), the second FAILS — the component currently renders "Sent to 12 students" for both. Record the text.

- [ ] **Step 8: Make the component honest**

In `src/components/class/send-announcement.tsx`, carry the flag through `handleSend` and render the two outcomes differently:

```tsx
  const [sentCount, setSentCount] = useState<number | null>(null);
  const [suppressed, setSuppressed] = useState(false);
```

```tsx
      if (res.ok) {
        const json = (await res.json()) as {
          data: { recipientCount: number; duplicateSuppressed?: boolean };
        };
        setSentCount(json.data.recipientCount);
        setSuppressed(json.data.duplicateSuppressed === true);
        setMessage('');
        setOpen(false);
      }
```

```tsx
  if (sentCount !== null && !open) {
    return (
      <div className="flex items-center gap-3">
        {/* Not `text-teal`, and not `text-danger` either: nothing failed, and
            nothing new succeeded. The neutral caption is the honest register
            for "we deliberately did nothing". */}
        <span className={suppressed ? 'type-caption' : 'type-caption text-teal'}>
          {suppressed
            ? `Not sent again — the same message reached ${sentCount} ${sentCount === 1 ? 'student' : 'students'} moments ago.`
            : `Sent to ${sentCount} ${sentCount === 1 ? 'student' : 'students'}`}
        </span>
        <button
          type="button"
          onClick={() => { setSentCount(null); setSuppressed(false); setOpen(true); }}
          className="type-label text-teal"
        >
          Send another
        </button>
      </div>
    );
  }
```

Run: `npx vitest run --project components src/components/class/send-announcement.test.tsx`
Expected: both PASS.

- [ ] **Step 9: Update `docs/lock-order.md`**

Add the advisory lock to the enumeration, following that file's existing entry shape: what it locks, what it is ordered against (nothing — it is taken first and no other lock is taken inside this transaction), and that it cannot participate in a deadlock cycle for that reason. If that last claim turns out not to hold once you read the file's conventions, say so rather than writing it.

- [ ] **Step 10: Run the five mutations**

1. Remove the `pg_advisory_xact_lock` call → the **concurrent** test must fail, and the **sequential** test must still pass. That pairing proves the two tests measure different things.
2. Remove the `sentAt` lower bound → the "genuinely later" test must fail.
3. Pass `body.classId` through instead of `classId ?? null` → the nullable test must fail.
4. Move the compare back below `createBulkNotifications` → the **notification count** assertion must fail while the announcement-row assertion still passes. This is the mutation that proves the fan-out placement, and it is the defect §4.2 would have shipped.
5. Return `201` with `duplicateSuppressed: false` on the suppressed branch → the component test "says a duplicate was not sent again" must fail. This proves the honesty is load-bearing and not decoration.

Restore each, record each.

- [ ] **Step 11: Commit**

```bash
git add src/lib/db-locks.ts src/app/api/announcements/route.ts src/components/class/send-announcement.tsx src/components/class/send-announcement.test.tsx docs/lock-order.md tests/integration/announcements-api.test.ts src/lib/db-locks.test.ts
git commit -m "fix: serialise identical announcements, dedupe above the fan-out, and tell the teacher when a send was suppressed"
```

---

## Closing procedure (not a task — run after Task 7)

- [ ] **Reconcile the wave against the diff, not against a keyword.** `git diff main...HEAD --name-only`, and check it against the File Structure table above. A file in the table that is not in the diff is unfinished work; a file in the diff that is not in the table needs explaining.
- [ ] **Sweep the corrected claims.** §1.5 of the spec lists three false claims. Grep each phrase across source, tests, docblocks, both specs and the plan — a claim corrected in one artifact and left standing in its twin is this project's most repeated failure.
- [ ] **`npm run verify`.** Needs the app on :3000. Green `verify` runs all three vitest projects, so state the arithmetic (`N = unit + components + integration`) rather than asserting coverage. Baseline was 1255/2 todo/111 files.
- [ ] **Check every commit message for an accidental closing keyword:** `git log main..HEAD --format=%B | grep -inE '(clos|fix|resolv)[a-z]*[[:space:]:]+#[0-9]+'` — **then read what it prints.** The last branch ran this grep, it printed the offending line, and the output was misread as clean.
- [ ] **PR body** records: what was measured, that seven of §4.2's nine rows were corrected and why, the mutation output for all seventeen guards, the `verify` arithmetic, and what this branch does **not** do. `#197, #209 and #210 are unaffected` — never the phrase "does not close", which the parser reads as a close.

---

## Corrections found while executing (appended, not rewritten)

Recorded rather than silently patched, because a plan defect that is fixed
without being named teaches nobody and the same shape recurs in the next task.

**From Task 2 (registrations).**

- A plain `Promise.all([del(), del()])` **serialised**, and the test passed
  green against the bug: the second request landed after the first committed,
  so its *pre-check* — not the guard under test — returned the 409. Fixed with
  the deterministic lever: a second `PrismaClient` holding
  `SELECT … FOR UPDATE` on the registration row so both requests park at the
  write. **Assume any `Promise.all` race test needs this lever until measured
  otherwise.**
- The fixture helper needs a **required, distinct `minuteOffset` per caller**.
  `Class_teacher_slot_unique` forbids one teacher two live classes at one
  `(date, startTime)`, and `startTime` is truncated to `HH:MM`, so two fixtures
  built in the same minute collide on branch 1's own index.
- Assertions were reordered so the **notification count comes before the status
  pair**. With the statuses first, the mutation failed on `[200, 200]`, which
  says two cancels succeeded without saying what it cost anyone; with the count
  first it reads `to have a length of 1 but got 2` — the defect, named.
- An unused `raceTeacherToken` shipped past `typecheck` and a scoped vitest run
  and was caught only by `npm run lint`. **Run `npm run verify`, not a scoped
  subset, before calling a task done.**

**From Task 3 (account erasure).**

- **Step 2's predicted red is wrong.** It says a missing `AlreadyErasedError`
  export makes the test "a compile error first". It does not — vitest strips
  types, so the missing named export is `undefined` at runtime and the test
  fails on the real defect instead. Only `tsc --noEmit` sees it. **Treat every
  "expected: compile error" prediction in this plan as unreliable for the same
  reason.**
- **Step 6's integration test could not fail against the bug as written.** Two
  plain fetches asserting `[200, 200]` are green *before* the fix, and without
  a lever the two requests serialise, in which case the second returns **401**
  — `resolveSession` resolves only live profiles, so `session.studentId` is
  already `null`. Fixed with the same row-lock lever, and its bite proven by an
  extra mutation (replace the route's `instanceof AlreadyErasedError` with
  `false` → `expected [500, 200] to deeply equal [200, 200]`).
- **Step 1 calls `makeStudentWithFreedSpot()` as though it exists.** It does
  not; it had to be written. It must place the class in the
  `first_come_first_claimed` window with a UTC teacher — in `auto_promote` the
  doubling is **invisible**, because the second `promoteNext` finds the head
  already promoted and returns `none`. The plan states that requirement for
  Task 2 and omits it here.

**From Task 4 (reminder cooldown).**

- **Step 3's diagnostic-branch ordering was wrong and was deliberately
  reversed.** The plan checked `reminderSentAt` first, so a payment that was
  reminded and *then* settled would be told *"A reminder for this payment was
  just sent. Try again in a couple of minutes"* — promising a retry the status
  guard refuses forever. Status is checked first now; the cooldown is the only
  other term in the `where`, so once the payment is outstanding it is the only
  explanation left. Pinned by its own test.
- **The mutation has a direction trap.** "Freeze `cooldownStart`" must be
  `new Date(0)`. A far-*future* value makes every stamp `lt` it, i.e. the
  cooldown *always* lapses — the opposite mutation — and a max-JS-date value is
  rejected outright by Prisma (`Could not convert argument value …
  "+275760-09-13"`).
- **Third occurrence of a fixture helper referenced as though it exists**
  (`makeOutstandingPayment()`, after `makeStudentWithFreedSpot()` and
  `makeBroadcastFixture`). **Assume every `make…()` in this plan must be
  written**, and give it its own per-test rows: `payments.test.ts` shares one
  student/registration/payment across order-dependent tests, and two of them
  read `getOutstandingPayments(...)[0]` from an **unordered** query, so an extra
  outstanding payment placed earlier in the file would decide their assertions
  by luck.
- The predicted-compile-error warning was confirmed a second time: the missing
  `MANUAL_REMIND_COOLDOWN_MS` export surfaced at runtime as
  `PrismaClientValidationError … Provided Date object is invalid`
  (`new Date(NaN)`), not as a compile error.

**From Task 5 (magic link and student signup).**

- **Step 1's test calls `hashOf(stale)`, which does not exist anywhere.**
  `hashToken` is module-private in `magic-link.ts`, and exporting it to serve a
  test would widen the module's API for convenience — the raw token never
  needing to be re-derivable is the property Step 4's docblock is about. The
  stale row is captured by `id` before the live one is minted
  (`findFirstOrThrow({ where: { email }, orderBy: { createdAt: 'desc' } })`)
  and expired by that `id`, which needs no new export.
- **The daily sweep is `cleanupExpiredAuth`, not `cleanupExpiredTokens`.**
  Steps 3 and 4 both name the latter. `cleanupExpiredTokens`
  (`magic-link.ts:96`) has **no production caller at all** — only tests. The
  24-hour job is `cleanupExpiredAuth` (`services/auth-cleanup.ts`, registered
  at `scheduler.ts:114-118`), which is also what spec §2.1 names. Both comments
  were written with the correct name; a comment that cites a dead function as
  the reason an unindexed scan is safe would rot on the day someone deletes it.
- **The lever for this race is not the row lock Tasks 2-4 used**, because the
  row does not exist yet. The shape that works is an **uncommitted holder**: a
  second `PrismaClient` opens a transaction, creates the `Student` (with its
  nested `account: { create: { email } }`) for the same address, signals, and
  holds. Both requests pass their `findUnique` pre-checks — uncommitted rows
  are invisible under READ COMMITTED — both park on the pending unique-index
  entry, and the holder then commits, so **both** lose. Which also corrects
  Step 6's predicted red: it says "FAIL with one 409", and the measured red is
  `expected [ 409, 409 ] to deeply equal [ 200, 200 ]`.
- The lever leaves a proof it bit, and the test asserts it: the one surviving
  `Student` row is the **holder's** (`['Holder']`). Had the requests serialised
  instead, one of them would have created a `Race` row. The status pair is
  still asserted first, because it is the only assertion the missing catch
  changes — the row count is 1 either way.
- **Editing a route invalidates the dev server's compiled chunk, and the
  recompile blows a 5-second test timeout.** Mutation 3 first failed with
  `Test timed out in 5000ms` rather than the assertion; a throwaway `curl` at
  the route measured the recompile at **19.7 s**. After any change under
  `src/app/api/`, warm the route with one request before running a race test.
  Relevant to Tasks 6 and 7, which both edit routes.

---

## Self-Review

**Spec coverage.** §3.1 → Task 7, including its "the suppressed send says so" subsection → Task 7 steps 7-8. §3.2 → Task 4. §3.3 → Task 5 (steps 1-4). §3.4 → Task 5 (steps 5-7). §3.5 → Task 1. §3.6 → Task 2. §3.7 → Task 3. §3.8 → Task 6. §1.5's three false claims → Tasks 4 and 6 plus the closing sweep. §4's eighteen mutations → distributed across the seven tasks' mutation steps; all eighteen appear (Task 1 has 3, Task 2 has 1, Task 3 has 2, Task 4 has 2, Task 5 has 3, Task 6 has 2, Task 7 has 5). §5's acceptance items 1-7 → the closing procedure. §6's out-of-scope items are not implemented anywhere, as intended.

**Arithmetic check on the mutations:** `3 + 1 + 2 + 2 + 3 + 2 + 5 = 18` ✓ — matching the spec's §4 table after the honesty guard was added to it.

**Filed, not folded** (spec §6): `handleSpotFreed`'s missing capacity check, and device-bound magic links. Neither appears in any task. File both after the PR merges.

**Type consistency.** `markEmailSent` returns `Promise<number>` in Task 6 and is consumed as a number in the same task only. `AlreadyErasedError` is produced in Task 3's gdpr.ts change and consumed in Task 3's route change. `lockAnnouncementSlot` and `ANNOUNCEMENT_DEDUPE_WINDOW_MS` are produced and consumed inside Task 7. No task consumes a symbol another task produces, so tasks 1-7 could in principle run in any order; the order given puts the simplest idiom first and the only new one last.
