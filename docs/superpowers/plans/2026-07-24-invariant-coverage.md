# Invariant Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Pin two route-level business invariants with behavioural tests, and delete a tautological test that fakes coverage of one of them (issue #67).

**Architecture:** Tests only. Extend `tests/integration/classes-api.test.ts` for the economic lock; add `tests/integration/rooms-api.test.ts` for the public-room lock; fix `tests/integration/full-flow.test.ts`'s Step 11. All on the shared fixtures in `tests/integration/helpers.ts`.

**Tech Stack:** Vitest integration project against the app on `localhost:3000`, Prisma fixtures.

## Global Constraints

- **Tests only — no `src/` changes.** Read `src/` freely to source exact status codes and error strings; change nothing.
- Use the shared helpers (`BASE_URL`, `cookie`, `uniqueSuffix`, `seedSession`); semantic fixtures stay local.
- `afterAll` cleans in FK order, with a **truthiness guard** on anything assigned in `beforeAll` — an undefined Prisma filter turns `deleteMany` into delete-all.
- Every 403/409 asserts the **DB is unchanged**, not just the status code.
- Assert the *distinct* error messages where two branches share a status (the two room 403s mean different things).
- Source all messages/statuses by reading the handler — do not guess.
- Dev server on :3000 is fresh (limiter reset). Don't run `signup-api.test.ts`.

---

### Task 1: The economic lock on `PUT /api/classes/[id]`

**Files:** Modify `tests/integration/classes-api.test.ts` (exists, from #64 — reuse its fixtures/patterns)

Read `src/app/api/classes/[id]/route.ts` first: `ECONOMIC_FIELDS` is `roomCost, minRate, targetRate, minStudents, maxStudents`; the lock rejects with **409** and a message naming the sent fields; a non-economic-only body skips the lock entirely.

- [ ] **Step 1: Add a `PUT /api/classes/[id]` describe** implementing spec §1's table:
  - **Unlocked + economic edit (owner)** → 200; re-read the class and assert the new values persisted.
  - **Locked + economic edit** → 409; assert the message names the field(s) sent; re-read and assert the economic values are **unchanged**.
  - **Locked + non-economic edit** (`description`) → 200; assert the description changed and the economic values did not.
  - **Locked + another teacher's cookie** → 403 (`Not your class`); assert unchanged.

  **Lock the class the way the app does** — create a real `Registration` through the same path `registrations-api.test.ts` uses (POST the registration, or create the row the way that suite does) so the flip comes from the app's own behaviour, not a direct `settingsLocked: true` write. If creating a registration over HTTP is impractical here, create the Registration row directly **and** note in the report that the flip itself is covered by `registrations-api.test.ts:213`. Do NOT set `settingsLocked` by hand — that is the very anti-pattern this task removes elsewhere.

  Use a **dedicated class fixture** for the lock tests so the file's existing draft-class tests (which assert `draft` state) are unaffected; extend `afterAll` to clean it up (registration → class), with truthiness guards.

- [ ] **Step 2: Run** — `npx vitest run --project integration tests/integration/classes-api.test.ts` → all pass (existing #64 cases plus the new ones).
- [ ] **Step 3: tsc + eslint** — `npx tsc --noEmit && npx eslint src tests` → exit 0.
- [ ] **Step 4: Commit** — `test: pin the settings_locked economic lock over HTTP (#67)`

---

### Task 2: The public-room lock on `PUT /api/rooms/[id]`

**Files:** Create `tests/integration/rooms-api.test.ts`

Read `src/app/api/rooms/[id]/route.ts` first. Guard order is: `requireTeacher` → 404 → **`isPublic` → 403 `Public rooms cannot be edited`** → `createdById` → 403 `Only the room creator can update this room` → `parseBody` → 400.

- [ ] **Step 1: Write the file** implementing spec §2's table:
  - **Creator edits their own private room** → 200; the change persists.
  - **The same creator edits it once public** → 403 with `Public rooms cannot be edited`; assert the DB is unchanged.
  - **A non-creator edits a private room** → 403 with `Only the room creator can update this room`; assert unchanged.

  The first two are the point — same actor, same room, only `isPublic` differs. That is what pins the ordering. Flip `isPublic` between them with a direct `prisma.room.update` (it is fixture state, not the invariant under test).

  **Assert the distinct messages**, not just `403` — a reordering would swap which branch fires while both tests still saw 403.

  Fixtures: creator teacher + session, a second teacher + session, one private `Room` (`createdById` = creator). `afterAll` deletes room → sessions → teachers → accounts in FK order, guarded.

- [ ] **Step 2: Run** — `npx vitest run --project integration tests/integration/rooms-api.test.ts` → all pass.
- [ ] **Step 3: tsc + eslint** → exit 0.
- [ ] **Step 4: Commit** — `test: pin the public-room lock's guard ordering (#67)`

---

### Task 3: Delete the tautological Step 11

**Files:** Modify `tests/integration/full-flow.test.ts`

`Step 11` writes `settingsLocked: true` with `prisma.class.update`, then asserts it is `true` — a tautology, and its own comment concedes it is simulating the route.

- [ ] **Step 1: Check whether any later step depends on the class being locked.** Read the steps after it (Step 12 onward).
  - If **nothing** depends on it → delete the whole `it(...)` block and its section comment.
  - If something **does** → keep the `prisma.class.update` as plain setup (not inside an `it`, or clearly labelled as setup), delete the fake assertion, and add a one-line comment pointing at the real coverage: `registrations-api.test.ts` asserts the flip after a genuine registration.

  Say which case applied in your report.

- [ ] **Step 2: Run** — `npx vitest run --project integration tests/integration/full-flow.test.ts` → all remaining steps pass.
- [ ] **Step 3: Commit** — `test: drop the tautological settingsLocked step (#67)`

---

### Task 4: Verify + PR

- [ ] **Step 1: Full gate** — `npx tsc --noEmit && npx eslint src tests && npx vitest run --project integration` → clean and green. (If `signup-api` 429s from repeated runs, note it; it is the local limiter, unrelated.)
- [ ] **Step 2: Push + open PR** — references #67, does **not** close it (GDPR erasure remains):

```bash
git push -u origin test/invariant-coverage
gh pr create --title "test: pin the settings_locked and public-room invariants (#67)" --body "$(cat <<'BODY'
Part of #67 (does not close it — GDPR erasure is deferred to its own PR).

## Summary
Two route-level business invariants had no behavioural coverage, and one had a test that faked it.

- **`settings_locked`** (`PUT /api/classes/[id]`) — the *flip* was covered, but the **rejection** was not: nothing exercised the 409 that stops a teacher changing `roomCost`/`minRate`/`targetRate`/`minStudents`/`maxStudents` after a student has booked at a tier. Now pinned, including that the lock is scoped to economics (a `description` edit on a locked class still succeeds).
- **The public-room lock** (`PUT /api/rooms/[id]`) — `isPublic` is checked *before* the creator check, so a public room is read-only for everyone including its creator. That is deliberate (see #52/#60), surprising, and was unpinned: a future "fix" letting the creator through would have looked like a bug fix. Same actor, same room, only `isPublic` differs — and the two 403s assert their *distinct* messages, so a reordering fails.
- **Removed a tautology** — `full-flow.test.ts`'s "Step 11" wrote `settingsLocked: true` then asserted it, while conceding in its own comment that it was simulating the route. The genuine flip is covered by `registrations-api.test.ts`.

Tests only — no `src/` changes. Every 403/409 asserts the DB is unchanged, not just the status.

## Deliberately not tested
The compare-and-swap backstop in the class PUT (`updateMany({ where: { id, settingsLocked: false } })`) — reaching `count === 0` needs a registration to land *between* the route's read and its write, which isn't producible over HTTP. It is the second layer behind the 409 these tests do cover; recorded so its absence is a decision, not an oversight.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 3: Report the PR URL. Do NOT merge.**

---

## Self-Review

**Spec coverage:** §1 economic lock → Task 1; §2 public-room lock → Task 2; §3 tautology → Task 3; verification + PR → Task 4. The spec's recorded non-goal (the CAS backstop) is carried into the PR body rather than silently dropped.

**Placeholder scan:** none — each task names the handler to read for exact strings, the fixtures to build, and the cleanup contract. The two conditional branches (how to lock the class; whether Step 11 has dependents) name both outcomes and require the choice be reported.

**Consistency:** all three tasks use the same shared-helper fixture contract and the same guarded FK-ordered teardown as the rest of the integration suite.
