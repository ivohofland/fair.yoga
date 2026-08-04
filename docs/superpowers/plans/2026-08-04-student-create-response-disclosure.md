# Student create/update response disclosure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `POST /api/students` and the teacher branch of `PUT /api/students/[id]` from returning raw `Student` rows, and meter both routes — they share one budget, see Task 2's correction — so neither is an unlimited probe for whether a `Student` row exists for an address.

**Architecture:** Narrow at the Prisma query with `select: { id: true }`, not at the response. The row never enters the handler's scope, so `existing` is typed `{ id: string }` and reading any field beyond `.id` off it becomes a compile error rather than something review has to catch — reading, not returning: widening the `select` itself still compiles cleanly, because `respondOk` is generically typed over whatever it is handed. Query-level narrowing is still the better fix over projecting at the response; the exhaustive `Object.keys(...)` key-set assertions in the integration tests are what actually catches a widened `select`. Add an in-process fixed-window rate limit keyed on the teacher, shared across both write routes.

**Tech Stack:** Next.js 14 App Router route handlers, Prisma, Vitest integration tests over HTTP against the dev server on `:3000`.

**Spec:** `docs/superpowers/specs/2026-08-04-student-create-response-disclosure-design.md`

## Global Constraints

- TypeScript `strict: true`. No `any`, no implicit types.
- **Never run `npx vitest run --project integration` without a file path.** One file in that project is IP rate-limited and a whole-project run trips it. **Never run `npm test`** — it is bare `vitest run` and would sweep all three projects, integration included. Safe forms: `npx vitest run --project integration tests/integration/students-api.test.ts`, `npx vitest run --project unit`, `npx vitest run --project components`.
- **Never start or restart the dev server on `:3000`.** The user runs it; the integration suite needs it live and serving this checkout.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Quote every path containing `[` or `(`.** `src/app/api/students/[id]/route.ts` is a zsh glob: unquoted, `[id]` means "one character from {i,d}", matches nothing, and the command either errors or silently stages nothing. Always `git add "src/app/api/students/[id]/route.ts"`.
- Every guard is broken before it is trusted: remove or invert it, record the exact failure text, restore, re-run. This is a step in each task, not a nicety.
- The response body for both changed branches is exactly `{ id }` — one key, no more.

---

### Task 1: `POST /api/students` returns only the id

**Files:**
- Modify: `src/app/api/students/route.ts:111-136`
- Test: `tests/integration/students-api.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `POST /api/students` responds `{ data: { id: string } }` on both the 200 (already existed) and 201 (created) branches. Task 2 adds a rate limit to the same handler and relies on this shape being settled.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block at the end of `tests/integration/students-api.test.ts`. It needs its own fixtures — a **claimed** student with personal data and no `StudentPrivacy` row, and a teacher with no link to them. This isn't about dodging a gate: `POST /api/students` never reads `claimedAt` at all, so any existing fixture would exercise the bug just as well. It's about the fields. The file's top-level fixtures (the 25-student loop and `unlinked`) are all unclaimed, but that's incidental — what actually rules them out is that none of them has `phone`, `birthday` or `address` set, so a test built on them could not demonstrate what this route actually leaks.

```ts
describe('POST /api/students — response disclosure (#162)', () => {
  let strangerId: string;
  let strangerAccountId: string;
  let strangerToken: string;
  let victimId: string;
  let victimAccountId: string;
  const victimEmail = `crm-victim-${suffix}@test.local`;

  beforeAll(async () => {
    // Account created first so `accountId` is a plain string here — the
    // Student_claim_link_check constraint needs claimedAt and accountId set
    // together, and this avoids a non-null assertion on victim.accountId.
    const victimAccount = await prisma.account.create({ data: { email: victimEmail } });
    victimAccountId = victimAccount.id;
    const victim = await prisma.student.create({
      data: {
        firstName: 'Victim',
        lastName: 'Surname',
        email: victimEmail,
        incomeTier: 5,
        phone: '+31 6 12345678',
        birthday: new Date('1988-03-14'),
        address: 'Kerkstraat 1, 1017 GA Amsterdam',
        claimedAt: new Date(),
        accountId: victimAccount.id,
      },
    });
    victimId = victim.id;

    const stranger = await prisma.teacher.create({
      data: {
        firstName: 'Stranger',
        lastName: 'Teacher',
        email: `crm-stranger-${suffix}@test.local`,
        account: { create: { email: `crm-stranger-${suffix}@test.local` } },
        bio: 'No relationship with the victim',
        pageSlug: `crm-stranger-${suffix}`,
      },
    });
    strangerId = stranger.id;
    strangerAccountId = stranger.accountId;
    strangerToken = await seedSession(prisma, strangerAccountId);
  });

  afterAll(async () => {
    await prisma.teacherStudent.deleteMany({ where: { teacherId: strangerId } });
    await prisma.session.deleteMany({ where: { accountId: strangerAccountId } });
    await prisma.teacher.delete({ where: { id: strangerId } });
    await prisma.student.delete({ where: { id: victimId } });
    await prisma.account.deleteMany({
      where: { id: { in: [victimAccountId, strangerAccountId] } },
    });
  });

  it('gives a teacher who knows only the email nothing but the id', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(strangerToken) },
      body: JSON.stringify({
        firstName: 'Anything',
        lastName: 'AtAll',
        email: victimEmail,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Exhaustive on keys, not field-by-field absence: a test that asserts
    // `phone === undefined` and three siblings cannot fail when someone later
    // adds a new sensitive column to Student. This one can.
    expect(Object.keys(json.data)).toEqual(['id']);
    expect(json.data.id).toBe(victimId);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts -t 'nothing but the id'`

Expected: FAIL. The diff must show the received key array containing all 16 fields — `id, accountId, firstName, lastName, email, incomeTier, phone, birthday, address, reminderPref, emailNotifications, claimedAt, tierSelectedAt, deletedAt, createdAt, updatedAt`. A failure for any other reason (404, 401, 403, a fixture error) means the test is not exercising the branch — fix that before continuing.

- [ ] **Step 3: Narrow both queries**

In `src/app/api/students/route.ts`, replace the body of the `POST` handler from the `existing` lookup through the final return:

```ts
  // #162: select the id and nothing else. Narrowing here rather than at the
  // response is deliberate — `existing` is typed `{ id: string }`, so reading
  // any field beyond `.id` off it is a compile error, not something review
  // has to catch. (Returning more still compiles if a later edit also widens
  // the `select` — `respondOk` is generically typed, so nothing pins response
  // shape to query shape. The exhaustive key-set assertions in the
  // integration tests are the backstop for that case.) This route answered
  // any teacher who knew an email with the student's phone, birthday, home
  // address and income tier.
  const existing = await prisma.student.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: session.teacherId, studentId: existing.id } },
    });
    if (link) {
      return respondError('Student already in your contacts', 409, 'ALREADY_LINKED');
    }
    await prisma.teacherStudent.create({
      data: { teacherId: session.teacherId, studentId: existing.id },
    });
    return respondOk({ id: existing.id }, 200);
  }

  const student = await prisma.$transaction(async (tx) => {
    const created = await tx.student.create({
      data: { firstName, lastName, email },
      select: { id: true },
    });
    await tx.teacherStudent.create({
      data: { teacherId: session.teacherId, studentId: created.id },
    });
    return created;
  });

  return respondOk({ id: student.id }, 201);
```

- [ ] **Step 4: Update the one existing assertion this breaks**

`tests/integration/students-api.test.ts:147` currently reads `expect(json.data.firstName).toBe('New');`. Replace that single line with:

```ts
    expect(Object.keys(json.data)).toEqual(['id']);
```

Leave `expect(res.status).toBe(201);` at `:145` and `createdStudentId = json.data.id;` at `:148` exactly as they are. Leave `expect(json.data.id).toBe(createdStudentId);` at `:201` alone — it already asserts only the id.

- [ ] **Step 5: Run the whole file**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts`

Expected: PASS, all tests in the file.

- [ ] **Step 6: Break the guard and confirm the test catches it**

Delete `select: { id: true },` from the `findUnique` and change the return to `respondOk(existing, 200)`. Re-run the single test from Step 2. Record the exact failure text in the commit or task report. Restore both lines and re-run to confirm green again.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/app/api/students/route.ts tests/integration/students-api.test.ts
git commit -m "fix: POST /api/students returned a stranger's full row (#162)"
```

---

### Task 2: Rate-limit `POST /api/students` and the teacher `PUT` — one shared budget

**Correction — as originally scoped, this task left the sibling route unbounded.**
This task was first written as "rate-limit `POST /api/students` per teacher," 30/hour,
alone. A PR review found, and it was confirmed by running it, that the teacher
branch of `PUT /api/students/[id]` (Task 3) is an **unmetered** twin of the
same oracle: `createStudentSchema` requires `email`, so that branch always
writes a client-supplied email into the same `@unique` column with no
pre-check, and the `P2002` collision surfaces as a plain `409` — 409 means
taken, 200 means free, exactly like the `POST`'s 200-vs-201. Metering only the
`POST` leaves that door wide open: 40 consecutive probes against the `PUT`
alone returned 20×409 / 20×200 and zero 429s. Full writeup in the spec's
Design §2. The steps below build the corrected, shared design directly rather
than the `POST`-only version and a later patch.

**Files:**
- Modify: `src/lib/rate-limit.ts` (new `checkStudentWriteLimit` helper)
- Modify: `src/app/api/students/route.ts` (imports, and the top of the `POST` handler)
- Modify: `src/app/api/students/[id]/route.ts` (imports, and the top of the teacher branch of `PUT`, ahead of Task 3's response-narrowing change)
- Test: `tests/integration/students-api.test.ts`

**Interfaces:**
- Consumes: `checkRateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number }` from `@/lib/rate-limit`, wrapped by the new `checkStudentWriteLimit(teacherId: string): RateLimitResult`. Do **not** import `clientIp` — this route keys on the teacher.
- Produces: a 51st write within an hour from one teacher — `POST /api/students` or the teacher branch of `PUT /api/students/[id]`, since they share a bucket — returns 429.

- [ ] **Step 1: Write the failing test**

Append this test inside the `describe('POST /api/students — response disclosure (#162)')` block from Task 1.

It POSTs the **same** email 51 times on purpose. The first creates the student, the next 49 return `409 ALREADY_LINKED` — and a 409 still counts a hit, because the limiter runs before the body is even parsed — so the whole burst leaves exactly one row to clean up instead of fifty.

```ts
  it('refuses a 51st addition within the hour', async () => {
    const burst = await prisma.teacher.create({
      data: {
        firstName: 'Burst',
        lastName: 'Teacher',
        email: `crm-burst-${suffix}@test.local`,
        account: { create: { email: `crm-burst-${suffix}@test.local` } },
        bio: 'Fresh limiter bucket',
        pageSlug: `crm-burst-${suffix}`,
      },
    });
    const burstToken = await seedSession(prisma, burst.accountId);
    const targetEmail = `crm-burst-target-${suffix}@test.local`;

    const statuses: number[] = [];
    for (let i = 0; i < 51; i++) {
      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(burstToken) },
        body: JSON.stringify({ firstName: 'Burst', lastName: 'Target', email: targetEmail }),
      });
      statuses.push(res.status);
    }

    expect(statuses[0]).toBe(201);
    expect(statuses.slice(1, 50)).toEqual(Array(49).fill(409));
    expect(statuses[50]).toBe(429);

    const created = await prisma.student.findUnique({ where: { email: targetEmail } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: burst.id } });
    await prisma.session.deleteMany({ where: { accountId: burst.accountId } });
    await prisma.teacher.delete({ where: { id: burst.id } });
    if (created) await prisma.student.delete({ where: { id: created.id } });
    await prisma.account.deleteMany({ where: { id: burst.accountId } });
  });
```

The fresh teacher is load-bearing: the limiter is an in-memory map inside the dev-server process, so an integration test cannot reset it over HTTP. A teacher created in this test has a brand-new uuid and therefore a brand-new bucket, every run.

Add two more tests alongside it, both required by the shared-budget correction above — without them, giving the `PUT` its own separate bucket would pass every other test in this task unnoticed: one that spends the 50-hit budget as 1 `POST` plus 49 `PUT`s against the same contact (each `PUT` moving that contact's email to a fresh candidate) and confirms the 51st write of either kind is refused; and one that repeats the invalid-body case 50 times to confirm a hit is spent even when the body 400s, then confirms a flawless 51st request is refused anyway.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts -t '51st addition'`

Expected: FAIL on `expect(statuses[50]).toBe(429)` — received `409`, because nothing throttles the route yet.

- [ ] **Step 3: Add the shared limiter**

In `src/lib/rate-limit.ts`, add the helper both routes will call:

```ts
/**
 * Shared hourly budget for teacher-initiated student writes that carry a
 * client-supplied email: POST /api/students and the teacher branch of
 * PUT /api/students/[id]. Both write `email` to a `@unique` column, so both
 * answer "is this address taken?" — the POST through 200-vs-201, the PUT
 * through 200-vs-409 on the P2002 fallback. Metering only one leaves the pair
 * unbounded, so they share a bucket.
 */
export function checkStudentWriteLimit(teacherId: string): RateLimitResult {
  return checkRateLimit(`students:${teacherId}`, 50, 60 * 60 * 1000);
}
```

Then, in `src/app/api/students/route.ts`, add the import and call it in the `POST` handler, immediately after the `requireTeacher` guard and **before** `parseBody`:

```ts
import { checkStudentWriteLimit } from '@/lib/rate-limit';
```

```ts
  // Keyed on the teacher, not the IP. The caller is authenticated, so an IP key
  // is both evadable by rotation and unfair to teachers behind one NAT — and it
  // would need the `ip === 'unknown'` fallback its siblings carry, which drops
  // the IP limit entirely when no proxy header is present. `magic-link/send`
  // and `student-signup` survive that because each also keeps an unconditional
  // per-email limit; `teachers/route.ts` has no second limit and is genuinely
  // unthrottled in that case. A teacher key needs no fallback at all.
  //
  // The ceiling — and the bucket this route shares with the teacher branch of
  // PUT /api/students/[id] — lives in `checkStudentWriteLimit`. See that
  // helper and the spec's Design §2 correction for why they share one budget.
  //
  // Issue #51 (bulk/CSV student import) will exceed it by design — raise the
  // ceiling or exempt the import path when that lands; do not assume this
  // number still fits.
  //
  // What it buys: this route still tells a caller whether a Student row exists
  // for an address — 200 if one does, 201 if it did not. "Student row", not
  // "account": an unclaimed contact sitting in another teacher's CRM answers
  // 200 with no Account behind it, so the bit leaks CRM membership as well as
  // self-registration. A follow-up GET recovers the same bit through the
  // returned name, since this branch ignores the names the caller submitted.
  //
  // The limit meters bulk probing rather than stopping it: 50/hour is ~8.3 days
  // per 10,000 addresses. Treat that as an order of magnitude, not a guarantee
  // — the limiter is in-process, so a deploy or restart hands back a fresh
  // budget, and its shared 10,000-key map can evict a live bucket under
  // pressure. The wall is requiring the student's acceptance before a link
  // exists at all; this holds until that lands.
  const limit = checkStudentWriteLimit(session.teacherId);
  if (!limit.allowed) {
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return respondError(
      `Too many student requests. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      429,
    );
  }
```

Add the matching call to the teacher branch of `PUT /api/students/[id]` at the same time — see Task 3, which narrows that branch's response and now also carries this limiter check at its top, ahead of the claimed-student pre-check.

- [ ] **Step 4: Run the whole file**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts`

Expected: PASS. The pre-existing `POST` tests consume only 3 hits on their shared teacher — `:136` (create), `:158` (409) and `:210` (invalid body) — plus 2 more spent by the `PUT` describes later in the file, well inside 50. `:187` uses a second teacher, and `:219` sends no session so neither reaches the limiter. Note that `:210` counts even though it 400s, because the limiter runs before `parseBody`; if that surprises a later reader, it is intentional.

- [ ] **Step 5: Break the guard**

Comment out the `if (!limit.allowed)` block in the `POST` handler and re-run the Step 2 test. Expected: FAIL with received `409` at `statuses[50]`. Record the text, restore, re-run green. Repeat the same break/restore against the `PUT` branch's copy of the check once Task 3 has added it, to confirm the shared-budget test (Step 1) catches that side too.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/rate-limit.ts src/app/api/students/route.ts tests/integration/students-api.test.ts
git commit -m "fix: POST /api/students was an unmetered account-existence oracle (#162)"
```

This commit message is what the branch's history actually carries for the
first, `POST`-only pass (commit `cfdd118`) — it predates the correction above
and repeats the same "account-existence" imprecision the spec corrects. It
cannot be fixed without rewriting history. The shared-budget change this task
now describes needs a follow-up commit once Task 3 adds the `PUT` side; give
it a subject that does not repeat the error, e.g. "fix: meter the teacher PUT
— it was an unmetered twin of the POST oracle (#162)".

---

### Task 3: Teacher `PUT /api/students/[id]` returns only the id, and shares Task 2's rate limit

**Files:**
- Modify: `src/app/api/students/[id]/route.ts:106-131` (response narrowing) and the top of the same branch (the shared limiter added below)
- Test: `tests/integration/students-api.test.ts`

**Interfaces:**
- Consumes: `checkStudentWriteLimit` from `@/lib/rate-limit`, added by Task 2 — this branch is the second of the two call sites that budget shares.
- Produces: the teacher branch of `PUT /api/students/[id]` responds `{ data: { id: string } }`, and — per Task 2's correction — refuses with 429 once the teacher's shared budget with `POST /api/students` is spent.

**Do not touch the self-edit branch at `:81-103`.** It returns the caller's own row to the caller, which is not a disclosure at any boundary. It is left alone deliberately.

- [ ] **Step 1: Write the failing test**

Add a new `describe` at the end of `tests/integration/students-api.test.ts`, using the file's top-level `teacherId` / `teacherToken` fixtures.

**Fixture trap — read before writing.** Do not reach for the existing `GET/PUT /api/students/[id] — profile-presence authorization` block at `:240`. Its `rosterStudent` is created with `claimedAt: new Date()`, and the teacher branch 403s at `:109` on any claimed student — so the response is never built and the test would pass against the bug. This branch needs an **unclaimed** student that the teacher is linked to. Do not reuse `studentIds[0]` either; the `GET` search tests assert on its name.

```ts
describe('PUT /api/students/[id] — teacher response shape (#162)', () => {
  it('returns only the id when a teacher edits an unclaimed contact', async () => {
    const target = await prisma.student.create({
      data: {
        firstName: 'Editable',
        lastName: 'Contact',
        email: `crm-put-${suffix}@test.local`,
      },
    });
    studentIds.push(target.id); // cleaned up by the file's top-level afterAll
    await prisma.teacherStudent.create({
      data: { teacherId, studentId: target.id },
    });

    const res = await fetch(`${BASE_URL}/api/students/${target.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({
        firstName: 'Renamed',
        lastName: 'Contact',
        email: `crm-put-renamed-${suffix}@test.local`,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json.data)).toEqual(['id']);
    expect(json.data.id).toBe(target.id);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails, and that it fails for the right reason**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts -t 'unclaimed contact'`

Expected: FAIL showing the full 16-key array. This test has **two** ways to pass vacuously — a claimed fixture 403s at `:109`, an unlinked one 403s at `:116` — so a `403` here means the fixture is wrong, not that the guard works. Confirm the received value is the wide key set before going on.

- [ ] **Step 3: Add the shared rate limit**

Per Task 2's correction, this branch writes a client-supplied `email` to the
same `@unique` column as `POST /api/students`, with no pre-check — a `P2002`
here surfaces as a `409` exactly like the `POST`'s 200-vs-201, which is what
makes it an unmetered twin of that oracle if left unguarded. In
`src/app/api/students/[id]/route.ts`, add the import and, at the very top of
the teacher branch of `PUT` — before the pre-check load, so a probe that never
gets past the 403s below still spends a hit:

```ts
import { checkStudentWriteLimit } from '@/lib/rate-limit';
```

```ts
    // Shares one bucket with POST /api/students — see `checkStudentWriteLimit`.
    // This branch writes a client-supplied `email` to a `@unique` column with
    // no pre-check, so a 409 from the P2002 fallback answers "is this address
    // taken?" exactly as the POST's 200-vs-201 does. Metered at the very top so
    // the 403 and 404 refusals below cost a hit too: probing that never gets
    // past them still probes.
    const limit = checkStudentWriteLimit(session.teacherId);
    if (!limit.allowed) {
      const minutes = Math.ceil(limit.retryAfterSeconds / 60);
      return respondError(
        `Too many student requests. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        429,
      );
    }
```

- [ ] **Step 4: Narrow both queries in the teacher branch**

In `src/app/api/students/[id]/route.ts`, the teacher branch of `PUT`. Change the pre-check load to select only what it reads:

```ts
    const student = await prisma.student.findUnique({
      where: { id },
      select: { id: true, claimedAt: true },
    });
```

and the update to return only the id:

```ts
    // #162: same treatment as POST /api/students. Lower stakes here — this
    // branch only fires for an unclaimed student already in the teacher's
    // contacts, and Student_claim_link_check makes accountId provably null on
    // that path — so what leaked was shape, not secrets. Narrowed anyway: the
    // raw row standing here is what tells the next reader the pattern is fine.
    const updated = await prisma.student.update({
      where: { id },
      data: updateData,
      select: { id: true },
    });

    return respondOk({ id: updated.id });
```

- [ ] **Step 5: Run the two files that exercise this handler**

```bash
npx vitest run --project integration tests/integration/students-api.test.ts
npx vitest run --project integration tests/integration/tier-selected-at.test.ts
```

Expected: both PASS. `tier-selected-at.test.ts:187-199` drives this exact branch but asserts only `res.status` and then reads the row back from the database — it never touches the response body, so it should be unaffected. If it fails, that assumption was wrong; report it rather than editing that test to fit. This run also exercises Step 3's limiter for the first time against the file's real fixtures — if it trips a stray 429, that is the shared-budget accounting from Task 2 Step 4 being wrong, not this task's response narrowing.

- [ ] **Step 6: Break both guards**

Remove `select: { id: true },` from the `update` and change the return to `respondOk(updated)`. Re-run the Task 3 Step 2 test, record the exact failure, restore, re-run green. Then comment out Step 3's `if (!limit.allowed)` block and re-run Task 2's shared-budget test (that task's Step 1); record the exact failure, restore, re-run green — this is the other half of confirming that test actually exercises the `PUT` side of the shared bucket.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add "src/app/api/students/[id]/route.ts" tests/integration/students-api.test.ts
git commit -m "fix: the teacher PUT returned a raw student row too (#162)"
```

As with Task 2's commit, this is the message the branch's history actually
carries (commit `c1ef272`) for the response-narrowing half alone — it
predates the shared-budget correction, which landed in a later commit. If
Steps 3 and 6 are done as part of the same pass rather than a follow-up, fold
the rate-limit change into this commit and say so in the message instead;
don't silently attribute the limiter to a commit subject that doesn't mention
it.

---

### Task 4: Whole-branch verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```

Expected: both clean.

- [ ] **Step 2: Run the component and unit projects**

```bash
npx vitest run --project components
npx vitest run --project unit
```

Expected: PASS. `create-student-form.test.tsx:23` already mocks `{ data: { id: 'student-1' } }`, so the UI contract was `{ id }` before this branch and nothing there should move. `edit-student-form` ignores the response body entirely (`router.refresh()`).

- [ ] **Step 3: Run every integration file that touches these routes, by explicit path**

```bash
npx vitest run --project integration tests/integration/students-api.test.ts
npx vitest run --project integration tests/integration/tier-selected-at.test.ts
npx vitest run --project integration tests/integration/privacy-api.test.ts
```

Never the whole `integration` project. Record which files ran, by path, for the PR body.

- [ ] **Step 4: Confirm the fix in the running app, not only in tests**

Re-run the reproduction that opened this issue — a claimed student with `phone`, `birthday`, `address` and `incomeTier` set, and a teacher with no link POSTing that email:

```bash
npx tsx "/private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga/41c8c478-fdbd-4e29-9a2d-3223810a4a08/scratchpad/repro-162.ts"
```

If that script is gone, rewrite it from the spec's "What was measured" section; it needs a `node_modules` symlink beside it to resolve `@prisma/client`:

```bash
ln -sfn /Users/ivohofland/Projects/fair.yoga/node_modules "<scratchpad>/node_modules"
```

Expected: the `POST` prints `{"data":{"id":"…"}}` and nothing else, where before the branch it printed 16 fields. The `GET` it prints afterwards will still show `firstName`, a last initial, `incomeTier` and `claimedAt` — that is the documented residual, not a failure.

- [ ] **Step 5: File the two issues the spec spun out**

Both carry a decision already made, so file them as work with the decision stated — not as open questions.

1. **Linking a student requires that student's acceptance.** Copy the six open design questions verbatim from the spec's "Filed, not folded" §1. Note that it is what actually closes the existence oracle and the `incomeTier` residual, and that it needs its own brainstorm rather than a plan.
2. **Honour `StudentPrivacy` in the payment and registration routes.** Record the decision: flags are honoured even when payment is owed, because reminders go through the app and blocking a non-paying student is the escalation. Name the sites — `services/payments.ts:202-206` and `:239-242`, the four route files that consume them, and `students/[id]/route.ts:51-66`'s (as of `c12e388`) sibling concerns — that is the `GET` handler's own inline, field-by-field privacy projection (`isUnclaimed` / `shareEmail` / `sharePhone` / `shareBirthday` / `shareAddress`), which is itself one of the copies the shared helper would replace, not a separate concern — and that the shape is one shared `projectStudentForTeacher` helper, not a fourth inline copy. Note that it subsumes the `incomeTier` question.

Then update `docs/backlog-roadmap.md` with 1 closed / 2 opened and re-check the open count against `gh issue list --limit 200`. Leave that file untracked.

- [ ] **Step 6: Report what was measured**

For the PR body: the exact key sets before and after, the three commands above with their results, the exact failure text recorded from each break-the-guard step across Tasks 1-3 (query-narrowing on the `POST`, the shared limiter on the `POST`, query-narrowing on the `PUT`, and the shared limiter on the `PUT`), and what this branch does **not** do — the existence oracle is metered rather than closed, and `incomeTier` stays readable by any linked teacher.
