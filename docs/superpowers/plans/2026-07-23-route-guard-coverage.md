# Route Guard Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add HTTP-level integration tests for the guard/ownership/parsing 4xx branches of `payments/[id]/paid`+`/unpaid`, `classes/[id]/complete`+`/transition`, and `waitlist/claim` (issue #53, scoped slice).

**Architecture:** Tests-only. Each task adds one route group's guard tests, mirroring the established integration-test pattern (real `PrismaClient` fixtures in `beforeAll`, `fetch(BASE_URL...)` with a `Cookie` session header, `afterAll` cleanup in FK order). No `src/` changes.

**Tech Stack:** Vitest integration project (runs against the app+DB on `localhost:3000`), Prisma fixtures, `@oslojs/crypto` sha256 for session tokens.

## Global Constraints

- **No `src/` changes** — tests only. `tsc --noEmit` + `eslint src tests` clean.
- Mirror the existing patterns exactly: session = a `Session` row with `id = sha256(token)` (hex), `accountId`, `expiresAt`; `cookie(token) = { Cookie: `fair_yoga_session=${token}` }`; `uniqueSuffix` on emails/slugs; `afterAll` deletes in FK order and `$disconnect()`s.
- Reference implementations to copy from: `tests/integration/payments-api.test.ts` (fixture + cookie + guard-ladder shape, incl. the `hashToken`/`makeTeacher` helpers) and `tests/integration/registrations-api.test.ts` (waitlist + `makeClass` fixtures, teacher/student tokens).
- Assert status codes for guards; on a 403 money mutation, also assert the DB side-effect did **not** happen (mirror the remind 403 test).
- Tests run against `:3000` (health `curl` → 200 first). Known: `signup-api.test.ts` 429s are the local 3/hour rate limiter — unrelated to these files.
- The case tables in the spec (`docs/superpowers/specs/2026-07-23-route-guard-coverage-design.md`) are the authoritative list of cases per route; implement every row. Where a row says "confirm against the route", read the route handler and implement the branch it actually exposes (or note in the report why it's unreachable).

---

### Task 1: payments `/paid` + `/unpaid` guards (extend `payments-api.test.ts`)

**Files:**
- Modify: `tests/integration/payments-api.test.ts`

**Interfaces:** reuse the file's existing `teacherToken`, `otherTeacherToken`, `cookie()`, `teacherId`, `otherTeacherId`, `paymentId` (a `pending` payment), `studentId`, `BASE_URL`.

- [ ] **Step 1: Add two describe blocks** — `POST /api/payments/[id]/paid` and `POST /api/payments/[id]/unpaid` — implementing every row of spec §1's table. Key cases: 401 (no cookie), 404 (unknown id, owner cookie), 403 (`otherTeacherToken`), 400 (paid with a body missing `method` — check `markPaidSchema`), 200 success (`{method:'cash'}` → assert `status: 'paid'` in DB), then unpaid 200 (→ `pending`) and unpaid 409 (on an already-pending payment). Sequence paid-before-unpaid-success (serial file). At the end of the unpaid block, `prisma.payment.update` the fixture back to `status:'pending'` so `afterAll` is unaffected.

Copy the guard-ladder shape from the existing `POST /api/payments/[id]/remind` describe in the same file. For the 403 case, also assert the payment's `status` is unchanged in the DB.

- [ ] **Step 2: Run — expect PASS**

Run: `npx vitest run --project integration tests/integration/payments-api.test.ts`
Expected: all pass (existing remind tests + the new paid/unpaid ladders). If a case fails, read the route handler to confirm the real status for that branch, adjust the assertion to the route's actual behavior (do not change `src/`), and note it.

- [ ] **Step 3: tsc + eslint**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git commit -am "test: HTTP guard coverage for payments paid/unpaid (#53)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: classes `/complete` + `/transition` ownership guards (new `classes-api.test.ts`)

**Files:**
- Create: `tests/integration/classes-api.test.ts`

**Interfaces:** produces its own fixtures — owner teacher + session token, a second teacher + session token, one `Room` + `TeacherRoom`, one `Class` owned by the owner. Copy the `hashToken`, session-row creation, and `makeTeacher`/room/`makeClass` shapes from `registrations-api.test.ts` and `payments-api.test.ts`.

- [ ] **Step 1: Write the file** implementing spec §2's table: for both `POST /api/classes/[id]/complete` and `POST /api/classes/[id]/transition` — 401 (no cookie), 404 (unknown class id, owner cookie), 403 (second teacher's cookie on the owner's class). Read each route handler first (`src/app/api/classes/[id]/complete/route.ts`, `.../transition/route.ts`) to confirm the guard order and the exact bodies each expects; if a state-409 is reachable without a fully-priced class (e.g. completing a non-completable class), add it, else note it as requiring pricing fixtures (service-covered) and stop at the ownership guards.

`beforeAll` creates the fixtures; `afterAll` deletes class → teacherRoom → room → sessions → teachers → accounts in FK order and `$disconnect()`s. Use `uniqueSuffix`.

- [ ] **Step 2: Run — expect PASS**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts`
Expected: all pass. Adjust assertions to the route's real status per Step 1 if any differ; note any 409 deferred for pricing fixtures.

- [ ] **Step 3: tsc + eslint** — `npx tsc --noEmit && npx eslint src tests` → exit 0.

- [ ] **Step 4: Commit**

```bash
git commit -am "test: HTTP ownership guards for classes complete/transition (#53)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `waitlist/claim` guards (new `waitlist-api.test.ts`)

**Files:**
- Create: `tests/integration/waitlist-api.test.ts`

**Interfaces:** produces its own fixtures — a student + session token, a teacher + session token (to prove the non-student 403), a teacher-owned `Class`, and a `WaitlistEntry` for the student on that class. Copy waitlist fixture shapes from `registrations-api.test.ts`.

- [ ] **Step 1: Write the file** implementing spec §3's table for `POST /api/waitlist/claim`: 401 (no cookie), 403 (teacher session — the route requires `session.studentId`), 400 (body missing/blank `classId` — check `claimWaitlistSchema`), 409 (`claimSpot` rejects: outside the claim window / not waiting — the common deterministic case is a class whose window is not the final-hour broadcast, so `claimSpot` throws `WaitlistPromotionError`). Read `src/app/api/waitlist/claim/route.ts` and `claimSpot` in `src/services/waitlist.ts` to pick a class-date fixture that deterministically produces the 409 window branch. If a deterministic in-window 201 fixture is feasible, add it — `claimSpot` had zero coverage anywhere (service or HTTP) before this PR, so the 201 path is not otherwise covered.

`afterAll` cleans up waitlist entry → registration (the 201 claim creates one) → class → teacherRoom/room → student → sessions → teacher → accounts in FK order, `$disconnect()`.

- [ ] **Step 2: Run — expect PASS**

Run: `npx vitest run --project integration tests/integration/waitlist-api.test.ts`
Expected: all pass. If the 409 window fixture isn't deterministic, adjust the class date/deadline until `claimSpot` reliably rejects, and document the chosen fixture in the report.

- [ ] **Step 3: tsc + eslint** — `npx tsc --noEmit && npx eslint src tests` → exit 0.

- [ ] **Step 4: Commit**

```bash
git commit -am "test: HTTP guards for waitlist/claim window branches (#53)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full verification + PR

**Files:** none (git/gh only).

- [ ] **Step 1: Full integration + gates** (dev server on :3000):

Run: `npx tsc --noEmit && npx eslint src tests && npx vitest run --project integration`
Expected: `tsc`/`eslint` clean; the integration project green incl. the three new/extended files. (Known: `signup-api.test.ts` 429s = local rate limiter; a fresh `:3000`/CI clears it. If they appear, note it, don't treat as this PR's failure.)

- [ ] **Step 2: Push + open PR** (references #53, does not close it — this is a scoped slice)

```bash
git push -u origin test/route-guard-coverage
gh pr create --title "test: HTTP guard coverage for money/window routes (#53, scoped)" --body "$(cat <<'BODY'
Part of #53 (does not close it — a scoped, highest-value slice).

## Summary
Adds HTTP-level integration tests for the route-only guard/ownership/parsing 4xx branches that full-flow.test.ts (service layer) can't reach:
- **payments/[id]/paid + /unpaid** — 401/404/403/400 + success + state-409 (extends payments-api.test.ts).
- **classes/[id]/complete + /transition** — 401/404/403 ownership guards (new classes-api.test.ts).
- **waitlist/claim** — 401/403(non-student)/400/409(window) (new waitlist-api.test.ts).

Tests only — no src/ changes.

## Deferred (follow-up on #53)
Rooms + teacher-rooms, studio-* routes, classes create/[id]/registrations/payments, auth session/passkey/magic-link, notifications/stream, account routes, and the full success/pricing completion path (service-covered by full-flow.test.ts). Same fixture patterns extend to them.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 3: Report the PR URL. Do NOT merge — leave open for review.**

---

## Self-Review

**Spec coverage:** payments paid/unpaid (Task 1), classes complete/transition (Task 2), waitlist/claim (Task 3) map 1:1 to the spec's three sections and their case tables; verification + PR + deferral note (Task 4). Every spec §-table is assigned to a task.

**Placeholder scan:** the "confirm against the route" / "if deterministic" notes are test-authoring adaptations (the implementer reads the route and implements the real branch), not vague requirements — each names the exact route file to read and the fallback. No "TODO"/"add appropriate tests" placeholders.

**Type consistency:** all three tasks reuse the same session-fixture contract (`Session` row id = sha256(token) hex, `cookie(token)` header) and the same `BASE_URL` fetch shape as the existing integration files they mirror.
