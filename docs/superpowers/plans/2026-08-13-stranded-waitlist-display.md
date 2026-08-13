# Stranded waitlist display (#199) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop two display queries from rendering waitlist entries whose class is no longer `open`, and stop the teacher's class detail from counting waitlist entries that are no longer `waiting`.

**Architecture:** Two one-line predicate additions to server-component Prisma queries, each pinned by an integration test that fetches the rendered page over HTTP and asserts on its HTML. No service, schema, or migration changes. The predicates are not new policy — `src/services/waitlist.ts` already refuses a non-`open` class in all four paths that grant or offer a spot; these two reads were the only places that bypassed it.

**Tech Stack:** Next.js 14 App Router server components, Prisma, Vitest (`integration` project), the dev server on `http://localhost:3000`.

**Spec:** `docs/superpowers/specs/2026-08-13-stranded-waitlist-display-design.md`

## Global Constraints

- **TypeScript `strict: true`** — no `any`, no implicit types.
- **Never start, restart, or stop the dev server on :3000.** The user runs it and it serves this checkout; the `integration` vitest project talks to it over HTTP. Without it every test in this plan fails with `ECONNREFUSED`. After editing a page, the running dev server recompiles it on the next request — no restart needed.
- **`Class` carries a partial unique index Prisma cannot express:** `Class_teacher_slot_unique` on `(teacherId, date, startTime) WHERE status <> 'cancelled'` (#196, documented at `prisma/schema.prisma:378-382`). Fixture classes for one teacher on one date need **distinct `startTime`s**, except `cancelled` ones which the predicate excludes. Give all four distinct times anyway — it costs nothing and survives a later status change.
- **The dev server runs the job scheduler** (`src/instrumentation.ts` → `startScheduler`). Two sweeps would rewrite fixture statuses: `autoTransitionToInProgress` takes `open` classes with `date: { lte: now + 24h }`, and `autoCompleteClasses` takes **every** `in_progress` class and completes those whose computed end instant has passed. **All fixture classes must be dated `2099-06-01`**, which keeps both sweeps away — the first by its date ceiling, the second by `currentTime >= endTime`.
- **Fixtures must write `WaitlistEntry` rows directly, never through `addToWaitlist`** — that service throws `WaitlistJoinError` on a non-`open` class (`waitlist.ts:178`), which is the invariant these tests exist to check the *reads* against. Direct `prisma.waitlistEntry.create` is the only way to build a stranded row.
- **Stage exact paths, and quote any containing parentheses** — `"src/app/(student)/bookings/page.tsx"`. An unquoted path with `(` matches nothing in zsh. Never `git add -A` or `git add .`.
- **Run a single file with** `npx vitest run --project integration tests/integration/waitlist-display.test.ts`.

## File Structure

| File | Responsibility |
|---|---|
| `tests/integration/waitlist-display.test.ts` | **Create.** Both surfaces' pins. One file because both share the same fixture graph (teacher → room → teacherRoom → classes → waitlist entries) and the same defect; splitting them would duplicate ~60 lines of setup to no end. |
| `src/app/(student)/bookings/page.tsx` | **Modify line 41.** Add the class-status predicate to the waitlist query. |
| `src/app/(teacher)/class/[id]/page.tsx` | **Modify line 45.** Filter the `waitlistEntries` relation count. |

---

### Task 1: The student's `/bookings` waitlist strip

**Files:**
- Create: `tests/integration/waitlist-display.test.ts`
- Modify: `src/app/(student)/bookings/page.tsx:41`

**Interfaces:**
- Consumes: `BASE_URL`, `cookie`, `uniqueSuffix`, `seedSession` from `tests/helpers.ts`. `seedSession(db, accountId)` creates a `Session` row and returns the raw token; `cookie(token)` returns `{ Cookie: 'session=<token>' }` for `fetch`.
- Produces: the module-scope fixture ids and the `suffix`/`slot` helpers that Task 2 extends — `prisma`, `suffix`, `teacherId`, `teacherRoomId`, `teacherToken`, `classIds: string[]`, `accountIds: string[]`, `studentIds: string[]`, and `slot(n: number): string`. Task 2 adds a second `describe` block to this same file and reuses all of them.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/waitlist-display.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * #199. Two display reads qualified one side of the `WaitlistEntry`
 * relationship and forgot the other: `/bookings` filtered the entry's status
 * and not its class's, and the teacher's class detail counted every entry
 * status. `src/services/waitlist.ts` already refuses a non-`open` class in
 * `addToWaitlist:178`, `promoteNext:391`, `claimSpot:523` and
 * `handleSpotFreed:635` — these tests pin the same rule on the reads.
 *
 * Every fixture class is dated 2099 deliberately. The dev server serving these
 * requests runs the scheduler (`src/instrumentation.ts`), and
 * `autoCompleteClasses` sweeps EVERY `in_progress` class with no date filter —
 * a present-dated `in_progress` fixture would be completed underneath the
 * assertion, turning a real failure into a passing one for the wrong reason.
 */

// Distinct `startTime` per class: `Class_teacher_slot_unique` is
// (teacherId, date, startTime) WHERE status <> 'cancelled', so three of the
// four classes below would collide on a shared literal time.
function slot(n: number): string {
  const minute = String(n).padStart(2, '0');
  return `09:${minute}`;
}

const CLASS_DATE = new Date('2099-06-01');

let teacherId = '';
let teacherRoomId = '';
let teacherToken = '';
let studentToken = '';
const classIds: string[] = [];
const accountIds: string[] = [];
const studentIds: string[] = [];

// The four statuses a `waiting` row can be stranded on, plus the one it is
// legitimately on. `draft` is excluded: a draft class cannot hold a
// registration, so it cannot reach `maxStudents` and cannot form a queue.
const openType = `w199-open-${suffix}`;
const inProgressType = `w199-inprogress-${suffix}`;
const completedType = `w199-completed-${suffix}`;
const cancelledType = `w199-cancelled-${suffix}`;

async function makeClass(
  classType: string,
  status: 'open' | 'in_progress' | 'completed' | 'cancelled',
  slotIndex: number,
): Promise<string> {
  const cls = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      classType,
      date: CLASS_DATE,
      startTime: slot(slotIndex),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 2,
      status,
    },
  });
  classIds.push(cls.id);
  return cls.id;
}

// Returns both ids rather than pushing and letting the caller dig the account
// id back out of `accountIds` — `noUncheckedIndexedAccess` makes that an
// index access needing a `!`, and it would silently break if the push order
// ever changed.
async function makeStudent(tag: string): Promise<{ id: string; accountId: string }> {
  const email = `w199-${tag}-${suffix}@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'W199',
      lastName: tag,
      email,
      claimedAt: new Date(),
      account: { create: { email } },
    },
    select: { id: true, accountId: true },
  });
  studentIds.push(student.id);
  accountIds.push(student.accountId);
  return { id: student.id, accountId: student.accountId };
}

beforeAll(async () => {
  await prisma.$connect();

  const teacherEmail = `w199-teacher-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'W199',
      lastName: 'Teacher',
      email: teacherEmail,
      account: { create: { email: teacherEmail } },
      pageSlug: `w199-${suffix}`,
    },
    select: { id: true, accountId: true },
  });
  teacherId = teacher.id;
  accountIds.push(teacher.accountId);
  teacherToken = await seedSession(prisma, teacher.accountId);

  const room = await prisma.room.create({
    data: {
      venueName: 'W199 Studio',
      address: `${suffix} Waitlist St`,
      city: 'Testville',
      postcode: '1234CA',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 10,
      createdById: teacherId,
    },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
  });
  teacherRoomId = teacherRoom.id;

  // A student-only account: `getSession` resolves `teacherId` first when an
  // account carries both profiles (`lib/auth/session.ts:100-106`), so a hybrid
  // fixture would still reach `/bookings` but would muddy what is being tested.
  const strip = await makeStudent('strip');
  studentToken = await seedSession(prisma, strip.accountId);

  const statuses: Array<[string, 'open' | 'in_progress' | 'completed' | 'cancelled']> = [
    [openType, 'open'],
    [inProgressType, 'in_progress'],
    [completedType, 'completed'],
    [cancelledType, 'cancelled'],
  ];

  for (const [i, [classType, status]] of statuses.entries()) {
    const classId = await makeClass(classType, status, i);
    // Written directly, not via `addToWaitlist`: that service throws on a
    // non-`open` class, which is the invariant under test one layer down.
    await prisma.waitlistEntry.create({
      data: { classId, studentId: strip.id, position: 1, status: 'waiting' },
    });
  }
});

afterAll(async () => {
  await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.deleteMany({ where: { createdById: teacherId } });
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('GET /bookings (page) — the waitlist strip', () => {
  it('shows a waiting entry on an open class and hides every entry whose class has left open', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();

    // Proves the fetch reached `/bookings` with a live session rather than a
    // redirect to `/login`, which would satisfy all three absences for free.
    expect(html).toContain(openType);

    // `cancelled` is the case #199 was filed about. `in_progress` and
    // `completed` are the cases that make this test discriminate: the
    // predicate the issue proposed, `not: 'cancelled'`, passes a test whose
    // only dead fixture is a cancelled class.
    expect(html).not.toContain(inProgressType);
    expect(html).not.toContain(completedType);
    expect(html).not.toContain(cancelledType);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx vitest run --project integration tests/integration/waitlist-display.test.ts
```

Expected: FAIL. Three assertions fail — the first one reported will be
`expect(html).not.toContain(inProgressType)`, because all four `waiting` rows
render today. Record the failure output; it is the baseline the mutations in
Steps 5 and 6 must reproduce.

- [ ] **Step 3: Add the predicate**

In `src/app/(student)/bookings/page.tsx`, line 41, change:

```ts
      where: { studentId: session.studentId, status: 'waiting' },
```

to:

```ts
      // #199. The entry's own status is not enough: nothing closes the queue
      // when a class leaves `open` by starting (#216), so a `waiting` row
      // outlives its class and renders as "position 2" on a class that will
      // never take another student. Positive, not `not: 'cancelled'` — `open`
      // is the predicate `addToWaitlist`, `promoteNext`, `claimSpot` and
      // `handleSpotFreed` all already require, and a negative predicate would
      // need extending for every terminal state added later.
      where: { studentId: session.studentId, status: 'waiting', class: { status: 'open' } },
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run --project integration tests/integration/waitlist-display.test.ts
```

Expected: PASS, 1 test. The dev server recompiles the page on the request — do not restart it.

- [ ] **Step 5: Prove the guard bites — mutation A, the predicate deleted**

Remove `, class: { status: 'open' }` from the query, leaving the comment. Re-run.

Expected: FAIL on `not.toContain(inProgressType)`. Paste the exact assertion output into the commit message in Step 7. Restore the predicate and re-run to confirm PASS before continuing.

- [ ] **Step 6: Prove the guard bites — mutation B, the predicate weakened**

This is the mutation that matters: it is not hypothetical, it is what #199 asked for. Change the predicate to the issue's proposal:

```ts
      where: { studentId: session.studentId, status: 'waiting', class: { status: { not: 'cancelled' } } },
```

Re-run. Expected: FAIL on `not.toContain(inProgressType)` and `not.toContain(completedType)`, while `not.toContain(cancelledType)` still passes — which is precisely why a cancelled-only fixture would have certified the wrong predicate. Record both failures. Restore `class: { status: 'open' }` and re-run to confirm PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/waitlist-display.test.ts "src/app/(student)/bookings/page.tsx"
git commit -F - <<'EOF'
fix: hide a waitlist row whose class has left open, not just a cancelled one

#199 asked for `not: 'cancelled'`. That leaves the `in_progress` and
`completed` rows rendering — the larger half, and the half still growing,
because nothing closes the queue when a class starts (#216).

`status: 'open'` is not a defensive invention: `addToWaitlist:178`,
`promoteNext:391`, `claimSpot:523` and `handleSpotFreed:635` all already
refuse a non-`open` class, while `removeFromWaitlist` deliberately does not.
The reads were the only paths bypassing it.

Both mutations proved to fail:

  <paste the Step 5 output — predicate deleted>

  <paste the Step 6 output — weakened to `not: 'cancelled'`, which fails on
  in_progress and completed while cancelled still passes>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: The teacher's "N on waitlist" count

**Files:**
- Modify: `tests/integration/waitlist-display.test.ts` (append one `describe` block and extend `beforeAll`)
- Modify: `src/app/(teacher)/class/[id]/page.tsx:45`

**Interfaces:**
- Consumes: everything Task 1 produced in that file — `prisma`, `suffix`, `slot`, `CLASS_DATE`, `makeClass`, `makeStudent`, `teacherId`, `teacherRoomId`, `teacherToken`, `classIds`, `accountIds`, `studentIds`.
- Produces: nothing consumed later.

- [ ] **Step 1: Write the failing test**

Add to the end of `beforeAll` in `tests/integration/waitlist-display.test.ts`, after the four-class loop:

```ts
  // Task 2's fixture: one class carrying 1 `waiting` and 2 `removed` entries.
  // The 2/1 split is load-bearing. One entry of each status renders `1`
  // before the fix and `2` after, so several wrong predicates reproduce it —
  // the shape that let #39 ship three guards that could not fail. Two
  // `removed` against one `waiting` makes filtered and unfiltered differ by
  // two, which no off-by-one predicate produces.
  countClassId = await makeClass(`w199-count-${suffix}`, 'open', 4);
  const waiting = await makeStudent('count-waiting');
  const goneA = await makeStudent('count-gone-a');
  const goneB = await makeStudent('count-gone-b');
  await prisma.waitlistEntry.createMany({
    data: [
      { classId: countClassId, studentId: waiting.id, position: 1, status: 'waiting' },
      { classId: countClassId, studentId: goneA.id, position: 2, status: 'removed' },
      { classId: countClassId, studentId: goneB.id, position: 3, status: 'removed' },
    ],
  });
```

Add the declaration beside the other module-scope `let`s:

```ts
let countClassId = '';
```

Append this `describe` block at the end of the file:

```ts
describe('GET /class/[id] (page) — the waitlist count', () => {
  it('counts waiting entries only, so a closed queue does not inflate it', async () => {
    const res = await fetch(`${BASE_URL}/class/${countClassId}`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);

    // React's SSR splices `<!-- -->` around a dynamic text node that sits
    // beside a static one, and `class-info.tsx:35` is exactly that shape:
    // `{waitlistCount} on waitlist`. The raw HTML therefore reads
    // `1<!-- --> on waitlist`, and a plain `toContain('1 on waitlist')` fails
    // against correct output. Stripping the markers asserts on what a reader
    // sees. (`privacy-page.test.ts` needs no such step because the page it
    // checks builds its name as one template string.)
    const html = (await res.text()).replaceAll('<!-- -->', '');

    expect(html).toContain('1 on waitlist');
    expect(html).not.toContain('3 on waitlist');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx vitest run --project integration tests/integration/waitlist-display.test.ts
```

Expected: FAIL on `expect(html).toContain('1 on waitlist')`, because the page renders `3 on waitlist` today. Task 1's test must still pass. Record the output.

- [ ] **Step 3: Filter the count**

In `src/app/(teacher)/class/[id]/page.tsx`, line 45, change:

```ts
      _count: { select: { waitlistEntries: true } },
```

to:

```ts
      // #199. Unfiltered, this counted all five `WaitlistStatus` values.
      // `promoted` and `claimed` rows have a `Registration` created in the
      // same transaction (`promoteNext:480`, `claimSpot:588`,
      // `registrations/route.ts:185`), so those students are already in the
      // registrations list on this page — counted twice — and `removed` keeps
      // counting everyone who left, including every queue #195 closed.
      _count: { select: { waitlistEntries: { where: { status: 'waiting' } } } },
```

- [ ] **Step 4: Run the tests and watch both pass**

```bash
npx vitest run --project integration tests/integration/waitlist-display.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Prove the guard bites**

Remove the `where` clause, leaving the comment: `_count: { select: { waitlistEntries: true } }`. Re-run.

Expected: FAIL on `toContain('1 on waitlist')`, and the `not.toContain('3 on waitlist')` assertion fails too — the page renders `3`. Record both. Restore and re-run to confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/waitlist-display.test.ts "src/app/(teacher)/class/[id]/page.tsx"
git commit -F - <<'EOF'
fix: count only waiting entries in the teacher's "N on waitlist"

The count filtered none of the five `WaitlistStatus` values. `promoted` and
`claimed` rows carry a `Registration` created in the same transaction, so
those students were counted here AND in the registrations list on the same
page; `removed` kept counting everyone who left, including every queue #195
closed on a cancelled class. A teacher read a wrong number on current data,
with no stranded row required — this issue's own defect, one altitude up.

Mutation proved to fail:

  <paste the Step 5 output>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Whole-branch verification

**Files:** none — this task only runs commands and reports.

**Interfaces:**
- Consumes: a green working tree from Tasks 1 and 2.
- Produces: the arithmetic the PR body must quote.

**Do not touch `docs/backlog-roadmap.md`.** It is untracked, local to the
owner's checkout, and the owner updates it themselves in the closing stage of
`solve-issue`. Its stale claim at `:2176-2179` — #199's *"the population is now
bounded and no longer growing"* — is still on the branch's acceptance list
(spec §8); it is simply not yours to fix. Do not `git add` it, do not edit it,
and do not treat its wording as a source of truth about this branch.

- [ ] **Step 1: Run the full gate**

```bash
npm run verify
```

This is typecheck + lint + all three vitest projects. It needs the dev server on :3000 — if you see a wall of `ECONNREFUSED`, the server is down; **ask the user to start it, do not start it yourself.**

Expected: green. Record the per-project test counts from the output (e.g. `unit N + components M + integration K = total`), because the PR body must show that arithmetic rather than claiming "the suite passed".

- [ ] **Step 2: Confirm no other read surface was missed**

```bash
grep -rn "waitlistEntry\.\|waitlistEntries" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

Expected: the two fixed reads, plus `src/app/(public)/[slug]/page.tsx:71` (safe by containment — its outer `class.findMany` is already scoped to `status: 'open', date: { gte: today }`), `src/services/gdpr.ts:50` (the Article 15 export, #216's business), and service write paths. If anything else appears, stop and report it — the spec's §4 census claimed this list is complete.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/199-stranded-waitlist-display
```

Write the PR body to a file and pass it with `--body-file`, **never** `--body "…"` — backticks inside a double-quoted shell string reach zsh as command substitution even when escaped, and it fails *silently*: a previous round published a sentence with two file paths eaten and returned a success URL.

The body must record, per spec §8 and the handover's §8:

- The `verify` arithmetic, before and after (`113 = 48 + 37 + 28` files).
- All three mutations with their exact recorded failure text.
- `tests/integration/waitlist-display.test.ts` named by path as the integration file this branch touches, and the fact that a green `verify` runs the whole integration project rather than a named subset.
- Which inherited claims were checked: two of #199's were false (the proposed predicate, and "the population is bounded"), one held (`/bookings` filters entry status and not class status).
- What the PR does not do: no queue closing when a class starts, no notification-layer change, no migration. Write "**#216 is unaffected**" — **never** "does not close #216", because GitHub's parser matches `close #N` and ignores the negation in front of it. A previous PR's scope section closed #113 exactly this way.

`Closes #199` is correct and deliberate in this body — that is the one closing keyword that belongs here.

- [ ] **Step 4: Report and stop**

Report the `verify` arithmetic, the three mutation transcripts, the PR URL, and anything in this plan that turned out to be wrong. Then **stop**: the whole-branch review, the roadmap update, and the rebase-merge are the owner's, in the closing stage of `solve-issue`. Do not run a review yourself and do not merge.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3.1 `/bookings` predicate | Task 1 Step 3 |
| §3.2 teacher `_count` predicate | Task 2 Step 3 |
| §6.1 student test, 4 fixtures, both mutations | Task 1 Steps 1, 5, 6 |
| §6.2 teacher test, 1 waiting / 2 removed, mutation | Task 2 Steps 1, 5 |
| §4 read-surface census still complete | Task 3 Step 2 |
| §8 acceptance: guards broken and restored | Task 1 Steps 5-6, Task 2 Step 5 |
| §8 acceptance: #199's inherited claim corrected everywhere | Comment posted on #199 (done); the PR body in Task 3 Step 3; `docs/backlog-roadmap.md` is the owner's, in the closing stage |
| §7 / #216 | Filed before this plan; no task |

**Not covered by design:** §5's ruled-out alternatives are decisions, not work. §7 is #216.

**Placeholder scan:** the only `<paste …>` markers are in commit-message bodies, where the actual mutation output cannot be known before the step runs. Every code step carries complete code.

**Type consistency:** `slot`, `makeClass`, `makeStudent`, `CLASS_DATE`, `classIds`, `accountIds`, `studentIds`, `teacherId`, `teacherRoomId`, `teacherToken`, `countClassId` are declared in Task 1 and used with the same names and types in Task 2. `makeClass(classType, status, slotIndex)` and `makeStudent(tag)` keep their Task 1 signatures. `makeStudent` returns the student id and pushes the account id onto `accountIds`, which is how Task 1's `stripAccountId` and Task 2's three students both reach a session or cleanup.
