# Every cancellation notice names the class (#200) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two `class_cancelled` notification bodies that still say only `"Hatha has been cancelled"` name the class in full — type, day, time — like the three #195 already fixed.

**Architecture:** Two one-line template-string changes. Both interpolate fields the surrounding code already reads, so no query, schema or recipient changes. The two sites need different test levels because they sit at different layers: the manual-cancel body lives inline in an HTTP route handler and is reachable only over HTTP; the teacher body lives in a service and is reachable from a unit test.

**Tech Stack:** TypeScript strict, Prisma/PostgreSQL, Vitest (`integration` project drives the app on :3000; `unit` project runs against `ethical_yoga_test`).

**Spec:** `docs/superpowers/specs/2026-08-11-cancellation-notice-names-class-design.md` — read it before Task 1, in particular the census table and why the teacher case is the worse of the two.

## Global Constraints

- **`formatDayHeader`, never `formatDateShort`.** `formatDayHeader(date)` renders `Friday, 12 Jun`; the three bodies #195 shipped use it, and #96 existed to collapse divergent date renderings after a teacher saw two of them one tap apart.
- **The exact copy, character for character.** Tests assert substrings; the reviewer checks the whole string.
  - route: `${cls.classType} class on ${formatDayHeader(cls.date)} at ${cls.startTime} has been cancelled by your teacher.`
  - teacher: `${fresh.classType} class on ${formatDayHeader(fresh.date)} at ${fresh.startTime} was cancelled — only ${activeCount} of ${fresh.minStudents} minimum students registered.`
- **Keep the "only N of M" clause** on the teacher body. It is the one piece of context that body carries and the others do not.
- **Titles are unchanged** — `'Class cancelled'` and `'Class auto-cancelled'`.
- **Bodies on the auto-cancel path are built from `fresh`, not `cls`** — pre-existing and load-bearing; a notice naming the pre-lock snapshot describes a class that no longer exists in that shape.
- **Never start or restart the dev server on :3000.** The user runs it, and it serves this checkout — which is what makes the integration test in Task 2 meaningful. If it is down, stop and ask.
- **Never `git add -A` or `git add .`** — stage exact paths, and **quote paths containing parentheses**: `"src/app/api/classes/[id]/transition/route.ts"`.
- **No `any`, no `@ts-ignore`, no casts to silence the compiler.** No new npm dependency.
- **Every guard is broken and watched to fail**, exact error recorded, restored, re-verified. Two mutations per body: revert the whole body, and drop a single field.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/services/class-transitions.ts:360` | auto-cancel's teacher notice | body names the class (Task 1) |
| `src/services/class-transitions.test.ts` | auto-cancel unit tests | extend the existing teacher-note test (Task 1) |
| `src/app/api/classes/[id]/transition/route.ts:63` | manual cancel's student notice | body names the class + one import (Task 2) |
| `tests/integration/classes-api.test.ts` | route-level tests | new fixture with a recipient + body assertion (Task 2) |
| `docs/superpowers/plans/…-mutations.md` | evidence | the four-mutation ledger (Task 3) |

**No ordering dependency between Tasks 1 and 2** — different files, different suites. Task 3 must be last.

---

### Task 1: The teacher's auto-cancel notice names the class

`class-transitions.ts` already imports `formatDayHeader` (`:14`) and already uses it in the *student* body twelve lines above the one being fixed — #195 added that import and never read down to the `notifications.push`.

**Files:**
- Modify: `src/services/class-transitions.ts:360`
- Test: `src/services/class-transitions.test.ts` (the existing test `auto-cancels below-minimum classes inside the local check window and notifies the teacher`)

**Interfaces:**
- Consumes: `formatDayHeader` from `@/lib/format`, already imported in both files.
- Produces: no signature change. `autoCancelClasses(db, now)` keeps its `Promise<number>`.

- [ ] **Step 1: Extend the existing test with body assertions**

In `src/services/class-transitions.test.ts`, find the test named `auto-cancels below-minimum classes inside the local check window and notifies the teacher`. It currently ends with `expect(teacherNote).not.toBeNull();` followed by cleanup. Replace the `findFirst` and that assertion with:

```ts
    // `findFirstOrThrow`, not `findFirst` + a null check: the three body
    // assertions below must be reported when they fail, not skipped past by a
    // conditional that TypeScript needed for narrowing.
    const teacherNote = await prisma.notification.findFirstOrThrow({
      where: { recipientType: 'teacher', recipientId: teacherId, relatedClassId: cls.id },
    });

    // #200. The teacher's row is the one that can never link: the inbox page
    // (`app/(teacher)/inbox/page.tsx`) selects no `relatedClass`, so
    // `NotificationList`'s `hrefById` arrives undefined and every teacher row
    // renders inert (filed as #201). The body is not the best channel here —
    // it is the only one. A teacher running two weekly Hatha classes cannot
    // otherwise tell which one was cancelled.
    //
    // Three separate `toContain`s rather than one whole-string equality: the
    // realistic regression is a field being dropped in an edit, and a single
    // equality assertion goes red on any rewording, which teaches the next
    // person to loosen it.
    expect(teacherNote.body).toContain('Hatha');
    expect(teacherNote.body).toContain(formatDayHeader(cls.date));
    expect(teacherNote.body).toContain('18:00');
    // The clause that makes this body worth keeping distinct from the
    // student's — it says WHY, and only this path knows.
    expect(teacherNote.body).toContain('only 0 of 4 minimum students registered');
```

`formatDayHeader` is already imported at the top of this file (added by #195). `makeClass()`'s defaults give `classType: 'Hatha'`, `startTime: '18:00'`, `minStudents: 4`, and this test registers nobody, so `activeCount` is 0.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project unit src/services/class-transitions.test.ts -t 'notifies the teacher'
```

Expected: FAIL on the *day* assertion — the current body is `Hatha was cancelled — only 0 of 4 minimum students registered.`, which contains `Hatha` and the "only 0 of 4" clause but neither the day nor `18:00`:

```
AssertionError: expected 'Hatha was cancelled — only 0 of 4 minim…' to contain 'Monday, 20 Jul'
```

If it fails on `'Hatha'` or on the "only N of M" clause instead, the fixture is wrong — stop and check `makeClass`'s defaults rather than editing the assertion.

- [ ] **Step 3: Implement**

In `src/services/class-transitions.ts`, in the `notifications.push({ recipientType: 'teacher', … })` block, replace the `body` line:

```ts
          body: `${fresh.classType} class on ${formatDayHeader(fresh.date)} at ${fresh.startTime} was cancelled — only ${activeCount} of ${fresh.minStudents} minimum students registered.`,
```

Leave `recipientType`, `recipientId`, `type`, `title` and `relatedClassId` untouched.

- [ ] **Step 4: Run the whole file**

```bash
npx vitest run --project unit src/services/class-transitions.test.ts
```

Expected: PASS, all 12 tests.

- [ ] **Step 5: Prove both guards bite**

One at a time, restoring between each:

1. **Whole body reverted.** Change it back to `` `${fresh.classType} was cancelled — only ${activeCount} of ${fresh.minStudents} minimum students registered.` `` → the test must FAIL on the day assertion. Record the exact text.
2. **One field dropped.** Keep the new shape but remove ` at ${fresh.startTime}` → the test must FAIL on `expected … to contain '18:00'`. This is the more realistic regression: an edit that trims the sentence rather than a wholesale revert.

Re-run the file clean afterwards and confirm `git diff` shows only the intended line.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-transitions.ts src/services/class-transitions.test.ts
git commit -m "fix: the teacher's auto-cancel notice never said which class"
```

---

### Task 2: The manual-cancel notice names the class

**Files:**
- Modify: `src/app/api/classes/[id]/transition/route.ts` — one import, one body line
- Test: `tests/integration/classes-api.test.ts` — a new fixture and a new test

**Interfaces:**
- Consumes: `BASE_URL`, `cookie`, `seedSession`, `uniqueSuffix` from `../helpers`; the file's own `makeClass(classType, status)` helper, which creates a class dated `2099-06-01` at `09:00` with `maxStudents: 8`.
- Produces: nothing importable. The route keeps its response shape.

**This task needs the app running on :3000**, because the transaction, the recipient fan-out and the body all live inline in the route handler — there is no service to call. Confirm it first:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://localhost:3000/
```

`307` is healthy (`/` redirects with no session cookie). A `000` or a timeout means it is down — **stop and ask**, do not start it.

- [ ] **Step 1: Add a fixture with a recipient**

The existing cancel fixture cannot carry this test: `classes-api.test.ts:100-104` says it deliberately has no registrations, so "the cancel transaction's notification fan-out has nothing to notify".

Add a module-scope declaration beside `let cancelClassId: string;`:

```ts
// #200. A second cancel fixture, this one WITH a recipient — the notice body
// is what this pins, and the sibling fixture above deliberately has nobody to
// notify.
let noticeClassId: string;
```

In `beforeAll`, immediately after the `lockRes` status check at the end, add:

```ts
  // `open`, not the file's `draft` default: `registrations/route.ts:126` sets
  // `allowedStatuses = isTeacher ? ['open','in_progress'] : ['open']`, so a
  // student booking a draft class gets a ClassStatusError. Registered over HTTP
  // by the same student the lock fixture uses — `Registration` is unique on
  // (classId, studentId), so a second class is fine, and reusing the student
  // avoids a second account/session/teardown chain.
  const noticeCls = await makeClass('Classes API Notice', 'open');
  noticeClassId = noticeCls.id;

  const noticeRes = await fetch(`${BASE_URL}/api/registrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(lockStudentToken) },
    body: JSON.stringify({ classId: noticeClassId }),
  });
  if (noticeRes.status !== 201) {
    throw new Error(
      `Fixture setup: expected the notice registration to succeed (201), got ${noticeRes.status}`,
    );
  }
```

In `afterAll`, extend the two lists that would otherwise leak it. Change:

```ts
  if (lockedClassId) {
    await prisma.registration.deleteMany({ where: { classId: lockedClassId } });
  }
  const allClassIds = [classId, cancelClassId, economicsClassId, lockedClassId].filter(Boolean);
```

to:

```ts
  for (const id of [lockedClassId, noticeClassId].filter(Boolean)) {
    await prisma.registration.deleteMany({ where: { classId: id } });
  }
  const allClassIds = [
    classId,
    cancelClassId,
    economicsClassId,
    lockedClassId,
    noticeClassId,
  ].filter(Boolean);
```

`allClassIds` already drives both the `notification.deleteMany` (by `relatedClassId`) and the `class.deleteMany`, so adding it there reaps the notice this test creates.

- [ ] **Step 2: Write the failing test**

Add `formatDayHeader` to the file's imports:

```ts
import { formatDayHeader } from '@/lib/format';
```

(The `@` alias is configured at the vitest root, so it resolves in the `integration` project.)

Add this test inside the `describe('POST /api/classes/[id]/transition', …)` block, after `cancels a class (happy path)`:

```ts
  /**
   * #200. The body is the only thing that identifies the class to the student.
   * `studentNotificationHref` (`lib/notification-links.ts`) returns a URL only
   * while the class is `open`, so a cancelled class's inbox row is inert even
   * though `relatedClassId` is set — and if the recipient had been on the
   * waitlist, this same transaction closes their entry to `removed`, dropping
   * the class off `/bookings` too.
   *
   * Reachable only over HTTP: the transaction, the recipient fan-out and the
   * body string all live inline in the route handler, so there is no service
   * to call from a unit test.
   */
  it('names the class in the cancellation notice it sends', async () => {
    const res = await transition(ownerToken, noticeClassId, { status: 'cancelled' });
    expect(res.status).toBe(200);

    const note = await prisma.notification.findFirstOrThrow({
      where: {
        recipientType: 'student',
        recipientId: lockStudentId,
        relatedClassId: noticeClassId,
        type: 'class_cancelled',
      },
    });

    // Derived from the fixture, not hard-coded: `makeClass` dates every class
    // 2099-06-01 at 09:00, and `formatDayHeader` is the renderer the other
    // three cancellation bodies use.
    expect(note.body).toContain('Classes API Notice');
    expect(note.body).toContain(formatDayHeader(new Date('2099-06-01')));
    expect(note.body).toContain('09:00');
  });
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run --project integration tests/integration/classes-api.test.ts -t 'names the class in the cancellation notice'
```

Expected: FAIL on the day assertion — the current body is `Classes API Notice has been cancelled by your teacher.`:

```
AssertionError: expected 'Classes API Notice has been cancelled b…' to contain 'Monday, 1 Jun'
```

A wall of `ECONNREFUSED` means the app on :3000 is down — stop and ask.

- [ ] **Step 4: Implement**

In `src/app/api/classes/[id]/transition/route.ts`, add the import beside the existing `createBulkNotifications` one:

```ts
import { formatDayHeader } from '@/lib/format';
```

`@/lib/format` is safe to import here — its only import is `import type { PaymentStatus }`, which erases. It is not `@/lib/log`.

Then replace the `body` line in the `notifications` map, and put the reason beside it:

```ts
      // Named in full — type, day, time — like the three service paths #112
      // fixed. `relatedClassId` below is set and still does not help: this
      // transaction has just moved the class to `cancelled`, and
      // `studentNotificationHref` (`lib/notification-links.ts`) links only an
      // `open` class, deliberately, so the inbox row is inert. A waitlisted
      // recipient has even less — their entry was closed to `removed` a few
      // lines above, which drops the class off `/bookings`.
      const notifications: CreateNotificationInput[] = [...registrations, ...waiting].map((r) => ({
        recipientType: 'student' as const,
        recipientId: r.studentId,
        type: 'class_cancelled' as const,
        title: 'Class cancelled',
        body: `${cls.classType} class on ${formatDayHeader(cls.date)} at ${cls.startTime} has been cancelled by your teacher.`,
        relatedClassId: id,
      }));
```

`cls` is the full `prisma.class.findUnique` row read at `:24`, so `date` and `startTime` need no query change.

- [ ] **Step 5: Run the whole file**

```bash
npx vitest run --project integration tests/integration/classes-api.test.ts
```

Expected: PASS, every test. The suite is re-runnable — rate-limited requests carry their own `x-forwarded-for` via `freshIp()` in `tests/helpers.ts`.

- [ ] **Step 6: Prove both guards bite**

One at a time, restoring between each. **After each mutation you must save the file and let the dev server recompile before re-running** — the integration suite tests the running app, not the source on disk.

1. **Whole body reverted** to `` `${cls.classType} has been cancelled by your teacher.` `` → the new test must FAIL on the day assertion.
2. **One field dropped** — keep the new shape but remove ` at ${cls.startTime}` → must FAIL on `expected … to contain '09:00'`.

Record both error texts. Re-run clean afterwards.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/classes/[id]/transition/route.ts" tests/integration/classes-api.test.ts
git commit -m "fix: the notice a teacher's own cancellation sends never named the class"
```

---

### Task 3: Verification and the mutation ledger

**Files:**
- Create: `docs/superpowers/plans/2026-08-11-cancellation-notice-names-class-mutations.md`

**Interfaces:**
- Consumes: the four recorded error texts from Tasks 1 and 2.
- Produces: the evidence the PR body cites.

- [ ] **Step 1: Confirm all five bodies now agree**

```bash
grep -rn "type: 'class_cancelled'" src --include="*.ts" | grep -v "\.test\.ts"
grep -rn "has been cancelled\|was cancelled\|has been withdrawn" src --include="*.ts" | grep -v "\.test\.ts" | grep "body:"
```

Expected: five sites, and every one of the five bodies contains `formatDayHeader`. That grep is the whole acceptance check for this issue — if any body lacks it, a site was missed.

- [ ] **Step 2: Write the ledger**

```markdown
# #200 mutation ledger

Four mutations, two per body: a wholesale revert, and a single dropped field.
The second is the realistic regression — an edit that trims the sentence — and
it is the one a whole-string equality assertion would have caught while a
`toContain('Hatha')` alone would not.

| # | Guard | Mutation | Test that failed | Observed |
|---|---|---|---|---|
| 1 | Teacher body names the class | revert to the pre-#200 text | auto-cancel teacher note | <exact text> |
| 2 | Teacher body carries the time | drop ` at ${fresh.startTime}` | auto-cancel teacher note | <exact text> |
| 3 | Route body names the class | revert to the pre-#200 text | cancellation notice (integration) | <exact text> |
| 4 | Route body carries the time | drop ` at ${cls.startTime}` | cancellation notice (integration) | <exact text> |

Mutations 3 and 4 run against the app on :3000, so each needs a save-and-recompile
before the re-run — a mutation "passing" without one means the old bundle answered.
```

- [ ] **Step 3: Run the full gate**

```bash
npm run verify
```

Typecheck, lint, and all three vitest projects including every file in `tests/integration/`. Record the summary lines. Green `verify` is a strong signal, not a substitute for CI — CI also runs `prisma validate`, a migration-drift check, `npm run build` and Playwright. Nothing here touches the schema, so drift should be nil; confirm rather than assume.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-11-cancellation-notice-names-class-mutations.md
git commit -m "docs: four mutations, each watched to fail"
```

---

## What this plan does not do

- **The teacher inbox's missing link** — #201. A teacher's row can never link, for any notification type, because the inbox page selects no `relatedClass`. Orthogonal: naming the class is still needed with links in place, since three cancelled Hatha classes render as three identical rows.
- **`studentNotificationHref`'s refusal to link a cancelled class.** Deliberate, with its reasoning recorded beside it. This change is what makes that survivable.
- **Titles, the "only N of M" clause, and the other three bodies**, all unchanged.
- **No schema change and no migration.**
