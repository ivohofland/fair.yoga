# Integration Sweep Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tests/integration/` re-runnable so the whole suite can be run
before pushing, and add `npm run verify` as the local equivalent of CI's two jobs.

**Architecture:** Eight unauthenticated requests currently share one per-IP
rate-limit budget, and one pass spends it (5 `student-signup` call sites against
a limit of 5/hour). A `freshIp()` helper gives every one of those requests its own
`x-forwarded-for`, so no bucket ever reaches a count of 2 and the limits become
unreachable. Two guards pin that: one on the helper's distinctness, one on the
production limiter the helper now sidesteps. Then a `verify` script chains
typecheck, lint and the full suite.

**Tech Stack:** Vitest 4 (three projects: `unit`, `integration`, `components`),
Node 22, TypeScript strict, Prisma 6, Next 16.

**Spec:** `docs/superpowers/specs/2026-08-07-integration-sweep-gate-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types.
- **Never start or restart the dev server on :3000.** The user runs it; the
  integration suite needs it live. If it is down, stop and say so.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Single integration files by explicit path are the inner loop:**
  `npx vitest run --project integration tests/integration/<file>.test.ts`.
  Until Task 1 lands, do not run the whole project without a path.
- **Do not edit an applied migration.** No migrations in this plan.
- **`tests/helpers.ts` imports nothing from vitest** and takes `PrismaClient` as
  a parameter — it is shared with Playwright. Keep it that way.

## Task order is load-bearing

Task 1 must land first. Tasks 2 and 3 both call `freshIp()`, and Task 3's guard
walks a rate-limit budget from zero — before Task 1, that budget is already
partly spent by the other tests in the same file, so the test would be measuring
leftovers. Task 4's verification runs the whole suite, which is only repeatable
after Task 1.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `tests/helpers.ts` | Modify — add `freshIp()` | Mechanical fixture layer, already owns `BASE_URL`, `uniqueSuffix()`, `cookie()` |
| `tests/integration/signup-api.test.ts` | Modify — 6 call sites + 3 new tests | The file holding 6 of the 8 rate-limited call sites |
| `tests/integration/auth-email-case.test.ts` | Modify — 2 call sites | Holds the other 2 |
| `package.json` | Modify — add `verify` script | — |
| `README.md` | Modify — command table | — |
| `.claude/skills/solve-issue/SKILL.md` | Modify — replace the rate-limit hazard | — |
| `docs/test-database.md` | Modify — drop two stale counts | — |

**Which 10 fetches exist, and which 8 are in scope.** Both files were counted with
`grep -n "await fetch("`:

| file:line | endpoint | per-IP limited? |
|---|---|---|
| `auth-email-case.test.ts:54` | `/api/auth/magic-link/send` | **yes** (10 / 15 min) |
| `auth-email-case.test.ts:73` | `/api/auth/student-signup` | **yes** (5 / 1 h) |
| `auth-email-case.test.ts:88` | `/api/auth/passkey/authenticate/options` | no — **leave alone** |
| `signup-api.test.ts:65` | `/api/teachers` | **yes** (3 / 1 h) |
| `signup-api.test.ts:85` | `/api/teachers` | **yes** |
| `signup-api.test.ts:110` | `/api/auth/student-signup` | **yes** |
| `signup-api.test.ts:125` | `/api/auth/student-signup` | **yes** |
| `signup-api.test.ts:138` | `/api/auth/student-signup` | **yes** |
| `signup-api.test.ts:149` | `/api/auth/student-signup` | **yes** |
| `signup-api.test.ts:167` | `/api/auth/magic-link/verify` | no — **leave alone** |

All ten carry the byte-identical line
`      headers: { 'Content-Type': 'application/json' },`, so a blanket
find-and-replace would hit 10, not 8. Edit the eight individually.

The three limited routes are the only `checkRateLimit` callers keyed on IP —
verified with `grep -rn "checkRateLimit" src/`. `students-api.test.ts`'s three
`429` assertions key on `students:${teacherId}` with a freshly created teacher
and are **not** in scope.

---

### Task 1: `freshIp()`, and the eight call sites that need it

**Files:**
- Modify: `tests/helpers.ts` (add after `uniqueSuffix()`, around line 94)
- Modify: `tests/integration/signup-api.test.ts` — lines 65, 85, 110, 125, 138, 149
- Modify: `tests/integration/auth-email-case.test.ts` — lines 54, 73

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function freshIp(): { 'x-forwarded-for': string }` in
  `tests/helpers.ts`. Returns a one-entry object `{ 'x-forwarded-for': '10.a.b.c' }`.
  Tasks 2 and 3 both import it from `'../helpers'`.

  The return type names its key rather than being `Record<string, string>`:
  `tsconfig.json` sets `noUncheckedIndexedAccess: true`, so a `Record` index
  yields `string | undefined` and Task 2 would be asserting on a maybe-undefined.

- [ ] **Step 1: Observe the failure this task removes**

The suite's non-idempotency is directly observable. Run this file twice in a row:

```bash
npx vitest run --project integration tests/integration/signup-api.test.ts
npx vitest run --project integration tests/integration/signup-api.test.ts
```

Expected: the **second** run FAILS (and the first may also fail, if a sweep has
run within the last hour — either way the red you want is a 429). Failures look
like:

```
AssertionError: expected 429 to be 200 // Object.is equality
AssertionError: expected 429 to be 201
```

Record the output. One run spends 4 of `student-signup`'s 5/hour and 2 of
`/api/teachers`' 3/hour, so the second run crosses both ceilings.

If the second run passes, the limiter windows are wider than assumed — stop and
report that, because the whole premise of this task is wrong.

- [ ] **Step 2: Add `freshIp()` to `tests/helpers.ts`**

Insert directly after `uniqueSuffix()` (which ends at line 94):

```ts
/**
 * A unique `x-forwarded-for` per call, so a request lands in a rate-limit
 * bucket nothing else has touched.
 *
 * Three routes throttle per IP — `POST /api/auth/magic-link/send` (10/15min),
 * `POST /api/auth/student-signup` (5/hour) and `POST /api/teachers` (3/hour) —
 * and `clientIp()` reads the first comma-separated entry of this header. The
 * integration suite calls those routes 8 times, which against a limit of 5 is
 * exactly zero headroom: one pass spent the budget and the next 429'd, so the
 * suite could not be run twice in an hour and therefore was never run whole.
 *
 * A fresh address *per request* — not per file — is what fixes that. No bucket
 * ever reaches a count of 2, so the limits become unreachable rather than
 * merely roomy, and adding a sixth signup test costs nothing. Per-file
 * uniqueness would leave signup-api's four calls sharing a bucket against a
 * limit of 5: the same tripwire with a bigger number.
 *
 * The random octet keeps two overlapping runs (watch mode plus a manual one)
 * off each other's buckets; the sequence guarantees distinctness within a run
 * rather than leaving it to chance, which matters because a test pins it.
 * 10.0.0.0/8 is private, so one of these in a log is obviously synthetic.
 *
 * Callers that want several requests to share a bucket — the limiter's own
 * test — call this once and reuse the result.
 */
const ipOctet = crypto.randomInt(256);
let ipSeq = 0;

export function freshIp(): { 'x-forwarded-for': string } {
  const n = ipSeq++;
  return { 'x-forwarded-for': `10.${ipOctet}.${(n >> 8) & 0xff}.${n & 0xff}` };
}
```

The return type names its key rather than being `Record<string, string>` —
`noUncheckedIndexedAccess` is on, so a `Record` index would give
`string | undefined` and Task 2 reads the address back.

`crypto` is already imported at `tests/helpers.ts:18`. Do not add an import.

- [ ] **Step 3: Update the import in `signup-api.test.ts`**

Line 4 currently reads:

```ts
import { BASE_URL, uniqueSuffix } from '../helpers';
```

Change to:

```ts
import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';
```

- [ ] **Step 4: Update the six call sites in `signup-api.test.ts`**

At lines 65, 85, 110, 125, 138 and 149 — and **only** those six — change:

```ts
      headers: { 'Content-Type': 'application/json' },
```

to:

```ts
      headers: { 'Content-Type': 'application/json', ...freshIp() },
```

Leave line 167 (`/api/auth/magic-link/verify`) exactly as it is — that route has
no limiter, and adding the header there would imply one exists.

- [ ] **Step 5: Update `auth-email-case.test.ts`**

Line 3 currently reads:

```ts
import { BASE_URL, uniqueSuffix } from '../helpers';
```

Change to:

```ts
import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';
```

Then make the same `headers:` change at lines 54 and 73 — and **only** those two.
Leave line 88 (`/api/auth/passkey/authenticate/options`) alone.

- [ ] **Step 6: Verify the edit hit exactly 8 sites**

```bash
grep -c "\.\.\.freshIp()" tests/integration/signup-api.test.ts tests/integration/auth-email-case.test.ts
```

Expected: `6` and `2`. Then confirm the two exclusions were left alone:

```bash
grep -n -A2 "magic-link/verify" tests/integration/signup-api.test.ts
grep -n -A2 "passkey/authenticate/options" tests/integration/auth-email-case.test.ts
```

Expected: neither shows `freshIp`.

- [ ] **Step 7: Prove idempotency — run three times**

```bash
for i in 1 2 3; do
  npx vitest run --project integration tests/integration/signup-api.test.ts || echo "RUN $i FAILED"
  npx vitest run --project integration tests/integration/auth-email-case.test.ts || echo "RUN $i FAILED"
done
```

Expected: nine consecutive green runs, no `RUN n FAILED`. Before this task the
second iteration was red; that is the whole deliverable.

- [ ] **Step 8: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Expected: both silent (exit 0).

- [ ] **Step 9: Commit**

```bash
git add tests/helpers.ts tests/integration/signup-api.test.ts tests/integration/auth-email-case.test.ts
git commit -m "test: a fresh IP per request, so the suite can be run twice"
```

---

### Task 2: Pin the property Task 1 rests on

Task 1 works only because consecutive `freshIp()` calls differ. Nothing currently
asserts that, so a refactor to a constant would silently restore the tripwire and
every test would stay green until the second sweep.

**Files:**
- Modify: `tests/integration/signup-api.test.ts` — append a new `describe`

**Interfaces:**
- Consumes: `freshIp()` from Task 1.
- Produces: nothing later tasks use.

**Why it lives in an integration file.** The three vitest projects glob
`src/**/*.test.ts`, `tests/integration/**/*.test.ts` and
`['src/components/**/*.test.tsx', 'src/app/**/*.test.tsx']`. A
`tests/helpers.test.ts` matches none of them and would be collected by no
project — silently never run, which is the exact failure this issue is about.

- [ ] **Step 1: Write the test**

This one is not red-then-green: its subject already exists, from Task 1. It earns
its keep in Step 3, where the helper is broken and the test must fail. Do not
skip that step — a test that has only ever been seen passing certifies nothing.

Append to the end of `tests/integration/signup-api.test.ts`:

```ts
/**
 * `freshIp()` is what makes this suite re-runnable: a fresh bucket per request
 * means no per-IP limit is ever reached. That rests entirely on consecutive
 * calls differing, and nothing else in the repository would fail if they
 * stopped — the symptom is a 429 on the *second* full sweep, an hour of
 * confusion away from the cause. So assert it directly.
 */
describe('freshIp', () => {
  it('yields a distinct address on every call', () => {
    const seen = new Set(Array.from({ length: 100 }, () => freshIp()['x-forwarded-for']));
    expect(seen.size).toBe(100);
  });

  it('is a private-range address, so one in a log is obviously synthetic', () => {
    expect(freshIp()['x-forwarded-for']).toMatch(/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });
});
```

- [ ] **Step 2: Run it — expect PASS**

```bash
npx vitest run --project integration tests/integration/signup-api.test.ts
```

Expected: PASS. This test is written after its subject, so a green run proves
nothing on its own — Step 3 is what establishes it can fail.

- [ ] **Step 3: Prove the guard bites — break `freshIp()` and record the error**

Temporarily replace the body of `freshIp()` in `tests/helpers.ts` with a constant:

```ts
export function freshIp(): { 'x-forwarded-for': string } {
  return { 'x-forwarded-for': '203.0.113.1' };
}
```

Use an address outside `10.0.0.0/8` — `203.0.113.0/24` (RFC 5737 TEST-NET-3) —
because a constant inside `freshIp()`'s own output range can land on a real
rate-limit bucket and poison it for up to an hour, surfacing later as an
unrelated test's 429.

Run:

```bash
npx vitest run --project integration tests/integration/signup-api.test.ts
```

Expected: FAIL on `yields a distinct address on every call`, with
`AssertionError: expected 1 to be 100`. Record the exact text.

Then run the file a second time **without restoring**, and confirm the 429s come
back — this is the consequence the guard is standing in for:

```bash
npx vitest run --project integration tests/integration/signup-api.test.ts
```

Expected: FAIL with `expected 429 to be 200`. Record it.

- [ ] **Step 4: Restore and re-verify**

Restore the real `freshIp()` from Task 1 Step 2. Then:

```bash
git diff tests/helpers.ts
```

Expected: shows only Task 1's addition, no leftover constant.

```bash
npx vitest run --project integration tests/integration/signup-api.test.ts
npx vitest run --project integration tests/integration/signup-api.test.ts
```

Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/signup-api.test.ts
git commit -m "test: pin freshIp's distinctness — the property the sweep rests on"
```

---

### Task 3: Cover the per-IP limiter Task 1 now sidesteps

No test in the repository asserts a per-IP 429. Deleting the `checkRateLimit`
call from `POST /api/auth/student-signup` currently breaks nothing — the budget
was consumed entirely by tests that were not testing it.

**Files:**
- Modify: `tests/integration/signup-api.test.ts` — append a new `describe`
- Read-only reference: `src/app/api/auth/student-signup/route.ts:18-24`

**Interfaces:**
- Consumes: `freshIp()` from Task 1, `suffix` and `prisma` already in the file.
- Produces: nothing later tasks use.

**Cleanup note.** The file's existing `afterAll` (lines 52-61) deletes
`magicLinkToken`, `teacher`, `student` and `account` rows whose email
`contains: suffix`, in an order that respects the foreign keys. Every email below
embeds `${suffix}`, so it is swept already — do not add a second cleanup block.

**Why the 429 can only come from the per-IP limiter.** The route has two budgets:
per-IP (`student-signup:${ip}`, 5/hour) and per-email
(`student-signup:email:${email}`, 3/15min). The six requests below use six
*distinct* emails, so the per-email budget never reaches 2. A 429 therefore
isolates the per-IP check — which is what makes Step 3's mutation meaningful.

- [ ] **Step 1: Write the test**

As in Task 2, this is not red-then-green — the limiter it covers already exists
in production code. Step 3 is where it proves it can fail, by deleting that
limiter. That step is the task, not a formality.

Append to the end of `tests/integration/signup-api.test.ts`:

```ts
/**
 * The only test that fails if the per-IP limiter is removed from
 * `POST /api/auth/student-signup`. Every other call site in the suite now sends
 * a fresh address (see `freshIp`), which is what keeps the suite re-runnable —
 * and which would otherwise leave this limiter with no coverage at all.
 *
 * One address for all six requests, deliberately: that is the bucket under
 * test. Six DISTINCT emails, also deliberately — the route's other budget is
 * per-email (3 per 15 min), and repeating an address would let that one produce
 * the 429 instead, which would keep this test green with the IP check deleted.
 */
describe('POST /api/auth/student-signup — per-IP budget', () => {
  it('refuses the sixth signup from one address within the hour', async () => {
    const ip = freshIp();
    const statuses: number[] = [];

    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ip },
        body: JSON.stringify({
          firstName: 'Burst',
          lastName: 'Signup',
          email: `signup-ip-burst-${i}-${suffix}@test.local`,
        }),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).toEqual(Array(5).fill(200));
    expect(statuses[5]).toBe(429);
  });
});
```

- [ ] **Step 2: Run it — expect PASS**

```bash
npx vitest run --project integration tests/integration/signup-api.test.ts
```

Expected: PASS.

- [ ] **Step 3: Prove the guard bites — delete the limiter and record the error**

In `src/app/api/auth/student-signup/route.ts`, temporarily comment out the per-IP
block (lines 18-24):

```ts
  const ip = clientIp(request);
  if (ip !== 'unknown') {
    const ipCheck = checkRateLimit(`student-signup:${ip}`, 5, 60 * 60 * 1000);
    if (!ipCheck.allowed) {
      return respondError('Too many signup attempts. Try again later.', 429);
    }
  }
```

The dev server on :3000 recompiles on save — **do not restart it**. Wait for the
route to rebuild (a single `curl -s -o /dev/null -w '%{http_code}'
http://localhost:3000/api/health` round-trip is enough), then run:

```bash
npx vitest run --project integration tests/integration/signup-api.test.ts
```

Expected: FAIL on `refuses the sixth signup from one address within the hour`,
with `AssertionError: expected 200 to be 429`. Record the exact text.

This is the load-bearing step of the task. If it still passes, the test is not
measuring the limiter and must be fixed before proceeding.

- [ ] **Step 4: Restore and re-verify**

Restore `route.ts`. Confirm nothing is left behind:

```bash
git status --short src/
```

Expected: no output.

```bash
npx vitest run --project integration tests/integration/signup-api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/signup-api.test.ts
git commit -m "test: the per-IP signup budget had no coverage at all"
```

---

### Task 4: `npm run verify`

**Files:**
- Modify: `package.json` — `scripts`
- Modify: `README.md:64` region — command table

**Interfaces:**
- Consumes: a suite made re-runnable by Task 1.
- Produces: `npm run verify`, referenced by Task 5's documentation.

- [ ] **Step 1: Add the script**

In `package.json`, insert after the `"test:e2e"` line:

```json
    "verify": "npm run typecheck && npm run lint && npm test",
```

Order is deliberate and fail-fast: typecheck (~3 s) and lint (~10 s) are cheap
and catch precisely the whole-tree defects that per-diff review cannot see, so
they run before the suite rather than after it.

- [ ] **Step 2: Add the README row**

In the command table (`README.md`, currently lines 59-71), insert directly after
the `npm run lint` row:

```markdown
| `npm run verify` | Typecheck + lint + all tests — run before pushing |
```

- [ ] **Step 3: Run it — expect PASS**

```bash
npm run verify
```

Expected: exit 0, and the vitest summary reads `Test Files  104 passed (104)`
(46 `unit` + 32 `components` + 26 `integration`). If the file count differs,
recount with `find src -name '*.test.ts' | wc -l`, `find src -name '*.test.tsx'
| wc -l` and `find tests/integration -name '*.test.ts' | wc -l` and report the
discrepancy rather than adjusting the expectation.

- [ ] **Step 4: Prove idempotency at whole-suite scale**

This is the spec's headline acceptance, and the one check that cannot pass
vacuously: before Task 1 it fails, so a green pair is real evidence. Task 1
Step 7 proved it for two files; this proves it for all 104.

```bash
npm run verify && npm run verify && echo "IDEMPOTENT"
```

Expected: `IDEMPOTENT`, from two consecutive whole-suite runs. This restores the
standard `docs/test-database.md:108` has claimed since the test-database split —
*"`npm test` twice locally (second run proves idempotency)"* — which has been
false for as long as the per-IP limiters have existed.

If the second run fails on `auth-email-case` or `signup-api` with a 429, Task 1
did not cover every call site: re-run its Step 6 census.

- [ ] **Step 5: Prove the gate bites — break a fixture and record the error**

Step 4 proved the gate can pass. This proves it can fail — a gate that has only
ever been seen green certifies nothing. Reproduce the #170
defect class: a fixture that violates a CHECK constraint. In
`tests/integration/privacy-page.test.ts:31`, temporarily uppercase a character of
the email literal passed to `prisma.student.create` so it breaks
`Account_email_lowercase_check`.

```bash
npm run verify
```

Expected: **non-zero exit**, with the summary naming the file — the same shape
the issue quotes:

```
PostgresError 23514: new row for relation "Account" violates check constraint
"Account_email_lowercase_check"
 Test Files  1 failed | 103 passed (104)
```

Record the exact text. Note for the record that `Test Files … 1 failed` and a
non-zero exit are what a gate reads — the per-*test* "skipped" tally that misled
#170's reviewers is a presentation detail, not a detection gap.

- [ ] **Step 6: Restore and re-verify**

```bash
git checkout tests/integration/privacy-page.test.ts
git status --short tests/
```

Expected: no output from `git status`.

```bash
npm run verify
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json README.md
git commit -m "chore: npm run verify — the whole-tree check, one round-trip before CI"
```

---

### Task 5: Correct the record

Three documents state things this branch has now measured to be false. Per the
project rule that a wrong claim is fixed in every artifact, not just the nearest
one.

**Files:**
- Modify: `.claude/skills/solve-issue/SKILL.md:223-225`
- Modify: `docs/test-database.md:51-52`
- Modify: `docs/superpowers/specs/2026-08-07-integration-sweep-gate-design.md`

**Interfaces:**
- Consumes: `npm run verify` from Task 4.
- Produces: nothing.

- [ ] **Step 1: Replace the rate-limit hazard in `SKILL.md`**

Lines 223-225 currently read:

```markdown
- **Never run `npx vitest run --project integration` without a file path.** One file in that
  project is IP rate-limited and the whole-project run trips it. Single files by explicit path
  are fine and are often required.
```

Both halves are false. The file it points at (`students-api.test.ts`) keys its
three `429` assertions on `students:${teacherId}` with a freshly created teacher,
so it can neither poison nor be poisoned; the files that actually shared a budget
were `signup-api` and `auth-email-case`, via the per-*IP* limiters. And CI runs
the whole project on every pull request via `npm test`.

Replace with:

```markdown
- **Run `npm run verify` before pushing** — typecheck, lint, and the whole suite including
  all 26 files in `tests/integration/`. Per-diff review cannot see a defect that exists only
  in the union of several diffs, which is how #170 shipped both a dark test file and a red
  lint to a pushed branch past nine reviews. This is the same whole-tree check CI runs, one
  round-trip earlier. Single files by explicit path
  (`npx vitest run --project integration <path>`) remain the fast inner loop.
- **Do not hand-list integration files in a plan.** That habit is what left 20 of 26
  unobserved on #170. The sweep covers them; name a file only when its *order* matters.
  The suite is re-runnable — every rate-limited request carries its own `x-forwarded-for`
  via `freshIp()` in `tests/helpers.ts` — so running it costs nothing you need back.
```

**Overridden during the build, deliberately:** ship "every file in
`tests/integration/`", not "all 26 files". A hardcoded count in prose is accurate
for exactly one branch — which is the argument Step 2 immediately below makes for
*removing* the counts from `docs/test-database.md`, so prescribing one here
contradicts the next step. The second bullet's "20 of 26" stays: it reports a
measurement of a past event, which does not go stale. The whole-branch review
also corrected the "same whole-tree check CI runs" sentence — `verify` skips the
build, the migration-drift check, and Playwright — and added the :3000
prerequisite; see the shipped text in `SKILL.md`, which is authoritative over
this block.

- [ ] **Step 2: Drop the stale counts in `docs/test-database.md`**

Lines 51-52 currently read:

```markdown
| `unit` | `src/**/*.test.ts` (28 files: services + lib) | **`ethical_yoga_test`** |
| `integration` | `tests/integration/**/*.test.ts` (17 files) | dev `ethical_yoga` (unchanged — must match the running app) |
```

**Both** counts are stale — `unit` is 46, not 28; `integration` is 26, not 17.
Do not update the numbers. Remove them, following the argument `.github/workflows/ci.yml`
already makes about the type-pin list: a count written into prose is accurate for
one branch. Replace with:

```markdown
| `unit` | `src/**/*.test.ts` (services + lib) | **`ethical_yoga_test`** |
| `integration` | `tests/integration/**/*.test.ts` | dev `ethical_yoga` (unchanged — must match the running app) |
```

Leave line 108 (`Verify: npm test twice locally (second run proves idempotency)`)
exactly as it is. It was the right standard all along; Task 1 is what finally
makes it hold.

- [ ] **Step 3: Extend the spec's account of the stale counts**

The spec says only that line 52 reads "17 files". It missed that line 51 is stale
too. In `docs/superpowers/specs/2026-08-07-integration-sweep-gate-design.md`, find:

```markdown
Line 52 of the same file also still describes the `integration` project as
"(17 files)"; it is 26.
```

Replace with:

```markdown
Both counts in the project table of the same file are stale: line 51 calls `unit`
"(28 files)" when it is 46, and line 52 calls `integration` "(17 files)" when it
is 26. Neither is updated below — they are removed.
```

- [ ] **Step 4: Verify no other artifact repeats the retired rule**

```bash
grep -rn "project integration" .claude/ docs/superpowers/specs/ README.md CLAUDE.md
```

Expected: matches only in `SKILL.md`'s new text and this branch's spec/plan.
Matches inside `docs/superpowers/plans/*` from earlier issues are historical
records of what those branches did — leave them.

- [ ] **Step 5: Confirm the docs describe a real command**

```bash
npm run verify
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/solve-issue/SKILL.md docs/test-database.md docs/superpowers/specs/2026-08-07-integration-sweep-gate-design.md
git commit -m "docs: the rule that caused the blind spot named the wrong file"
```

---

## After the tasks

Not plan steps — they belong to the branch's finish, per `solve-issue`:

1. Whole-branch review on the most capable model, then one fix wave, then one
   scoped re-review.
2. Push, open the PR. The body must name which suites ran **by path**, show the
   arithmetic behind 104, and state plainly which of the issue's premises were
   falsified — including that the first reading of `clientIp()` was wrong and the
   run corrected it.
3. `/pr-review-toolkit:review-pr <N>`. Skip `type-design-analyzer`: the only new
   type is `{ 'x-forwarded-for': string }`, a single-key object literal.
4. Comment on issue #185 with the measured corrections (CI already runs all 26;
   `beforeAll` already exits 1; the rule named the wrong file; zero headroom).
5. Rebase-merge, never squash. Then update `docs/backlog-roadmap.md`, leaving it
   untracked.
6. **File the `passkey/authenticate/options` issue** (decided 2026-08-07: after
   merge, not in this PR). Everything needed is below — do not re-derive it.

## Spun out, to file after merge — not this PR's work

Found while establishing which of the 10 fetches in the two edited test files
reach a rate-limited route. Deliberately **not** fixed here: this branch's
subject is test idempotency and a local gate, and a production auth change
belongs in a PR whose reviewers are reading auth.

**Census first, because "the two endpoints in my table" was a sampling
artifact.** `find src/app/api -name route.ts` gives 56 routes; 7 have no session
guard; 3 of those are rate-limited. The 4 that are not:

| route | verdict |
|---|---|
| `health` | Public health check. Fine. |
| `auth/magic-link/verify` | Token is `crypto.randomBytes(32)` — 256 bits, stored as a hash, 15-minute TTL. Brute force infeasible. **Ruled out.** |
| `auth/passkey/authenticate/verify` | Gated on a one-time 5-minute challenge plus WebAuthn signature verification; `redirect` is `relativePath.optional()` in `passkeyAuthVerifySchema`, so the docblock's open-redirect claim holds. **Ruled out.** |
| `auth/passkey/authenticate/options` | **Two defects.** Below. |

**Defect 1 — account-enumeration oracle.**
`src/app/api/auth/passkey/authenticate/options/route.ts` looks the email up and
passes `credentialIds` to `generatePasskeyAuthenticationOptions`, which sets
`allowCredentials: allowedCredentialIds?.map((id) => ({ id }))`
(`src/lib/auth/passkey.ts:165`). The key is present when the email maps to an
account with at least one passkey and absent otherwise, so an unauthenticated
caller reads account existence off the response shape. The project designs
against this everywhere else — `student-signup`'s docblock ("The response is
identical whether the email was new, an existing student, or a teacher — no
account enumeration") and `magic-link/send`'s 200-either-way branch.

**This half is a decision, not a task.** `allowCredentials` exists so the
authenticator can pre-select a credential; omitting it forces a
discoverable-credential flow with different UX and uneven authenticator support.
File it with the options stated — uniform response vs. keep the hint — rather
than as work someone can pick up.

**Defect 2 — unbounded in-memory challenge store.** `storeChallenge`
(`src/lib/auth/passkey.ts:46`) calls `cleanupExpired()`, which evicts only
*expired* entries. Within the 5-minute TTL an unauthenticated caller adds one
entry per request with no ceiling. `src/lib/rate-limit.ts` bounds its own map at
`MAX_KEYS = 10_000`, commented "so a scanner cycling keys cannot grow memory
unbounded" — the same threat model, handled there and not here, on the 2 GB VPS
this project targets. This half is uncontroversial and needs no decision.

One issue, not two: same endpoint, same request path.
