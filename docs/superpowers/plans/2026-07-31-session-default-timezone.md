# defaultTimezone on the Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the session teacher's `defaultTimezone` on `SessionUser` so three teacher pages stop re-querying the teacher row for it (#138).

**Architecture:** `validateSession` already loads the teacher row on every authenticated request to check GDPR liveness. Adding one column to that existing select, and one field to the teacher branch of the `SessionUser` union, collapses three page-level lookups to `session.defaultTimezone`.

**Tech Stack:** TypeScript strict, Next.js App Router server components, Prisma, Vitest (`unit` project runs against a real database).

## Global Constraints

- **TypeScript `strict: true`, `noUncheckedIndexedAccess` on.** No `any`, **no type assertions to silence a type error**, no eslint suppressions.
- **The field is REQUIRED on the teacher branch of the union, never optional.** An optional field lets a construction site omit it and a consumer read `undefined` into a timezone argument. Required means the compiler enumerates every site.
- **The name stays `defaultTimezone`**, matching the Prisma column. A second name for one value is how the drift in #96 started.
- **The 25 row-teacher joins must NOT change.** `include: { teacher: { select: { defaultTimezone: true } } }` hanging off a class, template or registration row needs *that row's* teacher, which is not necessarily the session user — and the cron routes have no session at all. **Session-teacher lookups are duplication; row-teacher joins are not.**
- **Zero rendered output changes.** This is the reviewable invariant for the whole PR. Any diff in a rendered string is a defect, not an improvement.
- **#140 is out of scope.** This change makes `p.paidAt` on the payments page a one-line fix and deliberately does not make it.
- **Never restart the dev server on `:3000`.**
- **Never `git add -A` or `git add .`** — `docs/backlog-roadmap.md` is deliberately untracked. Stage by explicit path.

---

## File Structure

| File | Change | Task |
|---|---|---|
| `src/lib/types.ts` | `defaultTimezone: string` on the union's teacher branch, plus the docblock rule | 1 |
| `src/lib/auth/session.ts` | one column on the existing select; carry it into the teacher return | 1 |
| `src/lib/auth/session.test.ts` | non-default timezones on two fixtures; three assertions | 1 |
| `src/lib/api-utils.test.ts` | two teacher-branch session fakes gain the field | 1 |
| `src/app/(teacher)/schedule/past/page.tsx` | delete the query entirely | 2 |
| `src/app/(teacher)/settings/reporting/page.tsx` | delete the query entirely | 2 |
| `src/app/(teacher)/page.tsx` | keep the query (needs `bankIban`), drop the field | 2 |

**Why two tasks.** Task 1 is atomic — the type, the query and the return do not compile independently of each other — and ends with the field existing and tested. Task 2 consumes it. A reviewer can approve Task 1 while rejecting Task 2, which is the case worth separating: an over-eager query deletion is invisible in a diff.

---

### Task 1: The session carries the teacher's timezone

**Files:**
- Modify: `src/lib/types.ts:5-11`
- Modify: `src/lib/auth/session.ts:60-66` and `:88-91`
- Modify: `src/lib/auth/session.test.ts` (fixtures in `beforeAll`, plus the `validateSession` describe block)
- Modify: `src/lib/api-utils.test.ts:139-143` and `:184-188`

**Interfaces:**
- Produces, consumed by Task 2: `TeacherSession` (and the teacher branch of `SessionUser`) gains `defaultTimezone: string`. Read it as `session.defaultTimezone` after `requireTeacherSession()` or `requireTeacher()` — both already narrow to the teacher branch, so no null check is needed or possible.
- Consumes: nothing.

- [ ] **Step 1: Give two fixtures non-default timezones**

`src/lib/auth/session.test.ts`'s `beforeAll` creates three account shapes. Two of them have a teacher, and neither sets `defaultTimezone` — so both currently take the schema default `Europe/Amsterdam`. A test written against the default would pass against an implementation that hard-codes it.

Add a distinct non-default zone to each teacher, so reading the wrong row also fails:

In the teacher-only fixture's `db.teacher.create`, add to `data`:

```ts
      defaultTimezone: 'America/Los_Angeles',
```

In the dual account's `dualTeacher` `db.teacher.create`, add to `data`:

```ts
      defaultTimezone: 'Asia/Kolkata',
```

Leave every other field alone. Both zones are deliberately non-default and on opposite sides of UTC.

- [ ] **Step 2: Write the failing assertions**

In `src/lib/auth/session.test.ts`, inside the existing `describe('validateSession', ...)`, extend the three existing account-shape tests. Add to the teacher-only test's assertions:

```ts
    expect(result!.defaultTimezone).toBe('America/Los_Angeles');
```

Add to the dual-account test's assertions:

```ts
    expect(result!.defaultTimezone).toBe('Asia/Kolkata');
```

Then add a new test immediately after the student-only test:

```ts
  /**
   * The union puts `defaultTimezone` on the teacher branch, so a student-only
   * session must not carry the key at all. Assert its *absence*, not that it is
   * `undefined` — the latter passes whether the key is missing or present and
   * empty, and the guarantee here is about the key.
   */
  it('omits defaultTimezone entirely for a student-only account', async () => {
    const token = await createSession(db, studentAccountId);

    const result = await validateSession(db, token);

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('defaultTimezone');
  });
```

Note on types: `result!.defaultTimezone` will not type-check until Step 4 widens the union, and TypeScript will also refuse it on an un-narrowed `SessionUser`. If the compiler objects after Step 4 because the union is not narrowed at that point, narrow with the existing `result!.teacherId` check rather than reaching for a type assertion — assertions are forbidden by the Global Constraints.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run --project unit src/lib/auth/session.test.ts`

Expected: FAIL. The two `toBe(...)` assertions fail because `defaultTimezone` is not on the returned object; `tsc` would also reject the property access. The new absence test passes already — it is a guard against a later regression, not a driver, and it should be the only one green of the three.

- [ ] **Step 4: Widen the union**

`src/lib/types.ts`, replacing the existing `SessionUser`:

```ts
// A session identifies an account; authorization is profile presence:
// teacher surfaces require teacherId, student surfaces studentId. Dual
// accounts carry both — there is no "active role" state. The union makes
// "neither profile" unrepresentable: at least one id is always a string.
//
// `defaultTimezone` sits on the teacher branch, not at the top level, so
// reading it requires having narrowed to a teacher — which every guard
// (`requireTeacherSession`, `requireTeacher`) already does. It rides along
// because `validateSession` already loads the teacher row for its GDPR
// liveness check, so this costs one column on a query that runs anyway, and
// nothing at all for student-only accounts, whose teacher relation is null.
//
// The bar for adding a field here: it must be needed to *compute* something
// on many surfaces. `defaultTimezone` decides which calendar day a teacher is
// in — a correctness input, not *only* a display value. `firstName` is read
// by several session-scoped lookups, but each either shows it or copies it —
// none computes with it — so it stayed where it was (#138). Deliberately not
// enumerated here: an inventory in a docblock is wrong the moment someone
// adds a call site, which is how the sentence this replaced went stale.
export type SessionUser = { sessionId: string; accountId: string } & (
  | { teacherId: string; defaultTimezone: string; studentId: string | null }
  | { teacherId: null; studentId: string }
);
```

Leave `TeacherSession` and `StudentSession` exactly as they are — `TeacherSession` intersects with `{ teacherId: string }`, which selects the teacher branch and therefore already carries the new field.

- [ ] **Step 5: Load the column and carry it into the return**

`src/lib/auth/session.ts`. In the `db.account.findUnique` select, add the column to the teacher relation only:

```ts
      teacher: { select: { id: true, deletedAt: true, defaultTimezone: true } },
```

Leave the `student` select untouched.

Then in the teacher return branch, carry it through:

```ts
  if (liveTeacher) {
    return {
      ...base,
      teacherId: liveTeacher.id,
      defaultTimezone: liveTeacher.defaultTimezone,
      studentId: liveStudent?.id ?? null,
    };
  }
```

Leave the student return branch (`teacherId: null`) exactly as it is — adding the field there would not compile, which is the union doing its job.

- [ ] **Step 6: Run the tests and watch them pass**

```bash
npx vitest run --project unit src/lib/auth/session.test.ts
npx tsc --noEmit
```

Expected: the session tests pass. `tsc` **fails** at this point, on `src/lib/api-utils.test.ts` — four teacher-branch session fakes now lack a required field. That failure is expected and is fixed in Step 7.

The signal to stop and report is a **file** the plan did not name, not a count within `api-utils.test.ts`. Report the count if it differs from four, but keep going: a differing count means this plan miscounted that file, whereas an error in a *different* file means something else constructs a session and the plan's model is wrong.

- [ ] **Step 7: Fix the two session fakes the compiler found**

`src/lib/api-utils.test.ts` has **six** hand-built session objects, spread across four `describe` blocks — `isErrorResponse`, `requireSession`, `requireTeacher` and `requireStudent`. The last two hold **two each**, which is what makes a quick scan of the file undercount.

The **four** with `teacherId: 'teacher-1'` each need the field. The **two** with `teacherId: null` must **not** get it — adding it there would not compile, which is the union doing its job.

Do not trust these line numbers over the file: find them by their `teacherId` value.

Add to both teacher-branch objects:

```ts
      defaultTimezone: 'Europe/Amsterdam',
```

The default zone is right here — these fakes are about guard behaviour, not timezone behaviour, and a distinctive value would imply the test cares about it.

- [ ] **Step 8: Verify the whole thing compiles and passes**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
npx vitest run --project components
```

Expected: all clean and green. Unit count rises by exactly 1 (the new absence test).

- [ ] **Step 9: Commit**

```bash
git add src/lib/types.ts src/lib/auth/session.ts src/lib/auth/session.test.ts src/lib/api-utils.test.ts
git commit -m "feat: carry the teacher's defaultTimezone on the session (#138)"
```

---

### Task 2: The three pages stop re-querying

**Files:**
- Modify: `src/app/(teacher)/schedule/past/page.tsx:9-12`
- Modify: `src/app/(teacher)/settings/reporting/page.tsx:19-22`
- Modify: `src/app/(teacher)/page.tsx:28-32`

**Interfaces:**
- Consumes from Task 1: `session.defaultTimezone`, a `string`, available after `await requireTeacherSession()` with no null check.
- Produces: nothing.

- [ ] **Step 1: `schedule/past/page.tsx` — delete the query**

Delete these four lines entirely:

```ts
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    select: { defaultTimezone: true },
  });
```

Then replace **both** reads of `teacher.defaultTimezone` with `session.defaultTimezone` — `:17` (`startOfLocalDay(new Date(), ...)`) and `:42` (`<ClassList ... timeZone={...}>`). Confirm with `grep -n "teacher\.defaultTimezone" "src/app/(teacher)/schedule/past/page.tsx"`, which must return nothing afterwards.

**Keep the `prisma` import.** The page still queries inside its `Promise.all`. Confirm that by reading the file rather than assuming; if lint reports an unused import, that is a signal you deleted too much.

- [ ] **Step 2: `settings/reporting/page.tsx` — delete the query**

Same four-line deletion:

```ts
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    select: { defaultTimezone: true },
  });
```

Then replace the **single** read, at `:30` (`startOfLocalDay(new Date(), teacher.defaultTimezone)`), with `session.defaultTimezone`. This page has exactly one, unlike the other two. Confirm with `grep -n "teacher\.defaultTimezone" "src/app/(teacher)/settings/reporting/page.tsx"`, which must return nothing afterwards.

The `prisma` import stays here too — the page's `Promise.all` uses it.

- [ ] **Step 3: `(teacher)/page.tsx` — keep the query, drop the field**

This one is different: the query also selects `bankIban`, which nothing else provides. **Do not delete it.** Narrow the select:

```ts
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    select: { bankIban: true },
  });
```

Then repoint **all three** reads of `teacher.defaultTimezone` — there are exactly three, and missing one is the likeliest error in this task because the first is fifty lines from the other two:

| Line | Currently | Becomes |
|---|---|---|
| `:32` | `getScheduleWindow(teacher.defaultTimezone)` | `getScheduleWindow(session.defaultTimezone)` |
| `:74` | `formatDayHeader(startOfLocalDay(now, teacher.defaultTimezone))` | `...startOfLocalDay(now, session.defaultTimezone))` |
| `:92` | `timeZone={teacher.defaultTimezone}` | `timeZone={session.defaultTimezone}` |

Leave `teacher.bankIban` at `:83` alone — that is why the query survives.

Confirm you got all three: `grep -n "teacher\.defaultTimezone" "src/app/(teacher)/page.tsx"` must return nothing afterwards.

- [ ] **Step 4: Confirm nothing else reads a session-teacher timezone**

```bash
grep -rn "defaultTimezone" src/app/ | grep -v "teacher: { select"
```

Expected: no session-teacher `select: { defaultTimezone: true }` remains anywhere under `src/app/`. Any hit that *is* a row-teacher join (`include: { teacher: { select: { defaultTimezone: true } } }` on a class, template or registration) is correct and must stay — see the Global Constraints.

Then confirm the total is unchanged where it should be:

```bash
grep -rn "defaultTimezone: true" src/ | grep -v "\.test\." | wc -l
```

Expected: **28** — 30 on `main`, +1 from Task 1's session-select column, −3 from these three deletions — with every row-teacher join surviving. If the number is below 28 you have deleted a join that was doing real work.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
npx vitest run --project components
npx playwright test
```

Expected: all clean and green, e2e 118 passing.

Do NOT run `npx vitest run --project integration` — its `signup-api` tests are rate-limited per IP (3/hour and 5/hour) and routinely exhausted. If you run it by accident and see `expected 429 to be 201`, that is the limiter, not this change.

- [ ] **Step 6: Check the three pages in the running app**

**This step cannot be skipped or inferred from the diff.** Two of these pages lost a query entirely. If a deletion was over-eager, nothing renders differently until the missing field is read — so the "zero rendered output changes" invariant has to be observed, not reasoned about.

The dev server is already running on `:3000` — **do not restart it.** Sign in as the seeded Portland teacher (`America/Los_Angeles`, added by PR #139), because west-of-UTC is the only place a timezone regression is visible at all: east of the meridian a broken timezone renders identically to a working one.

Visit and confirm each renders without error and shows the same dates as before:

- `/` — the schedule home. Check the "today" caption and that the week grouping is right.
- `/schedule/past` — past classes. Check that the completed class from yesterday appears and today's 19:00 class does **not**.
- `/settings/reporting` — the month rows.

If you cannot obtain a session (the sandbox has blocked credential-adjacent flows before), **say so plainly in your report and do not claim the check passed.** An unperformed check reported as done is worse than a stated gap.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(teacher)/schedule/past/page.tsx" "src/app/(teacher)/settings/reporting/page.tsx" "src/app/(teacher)/page.tsx"
git commit -m "refactor: read the timezone off the session, not a repeat query (#138)"
```

---

## Pre-PR checklist

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 448 passing (447 + 1)
- [ ] `npx vitest run --project components` — 61 passing, unchanged
- [ ] `npx playwright test` — 118 passing
- [ ] `grep -rn "defaultTimezone: true" src/ | grep -v "\.test\." | wc -l` — **28** (30 on `main`, +1 from Task 1's session column, −3 from Task 2's deletions)
- [ ] No `select: { defaultTimezone: true }` keyed on `session.teacherId` remains
- [ ] `src/lib/types.ts` — the field is on the teacher branch, required, and the docblock states the bar for future additions
- [ ] All six `teacher.defaultTimezone` reads repointed — 2 in `schedule/past`, 1 in
      `settings/reporting`, 3 in `(teacher)/page.tsx`; `grep -rn "teacher\.defaultTimezone" src/app/`
      returns nothing
- [ ] The student return branch of `validateSession` is untouched
- [ ] `(teacher)/page.tsx` still queries for `bankIban`
- [ ] Three pages checked in the running app as a west-of-UTC teacher, or the gap stated plainly
- [ ] `git status --short` — only `docs/backlog-roadmap.md` untracked
- [ ] `p.paidAt` on the payments page is **unchanged** — #140 stays open
