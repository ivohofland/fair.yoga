# Input Bounds and Send Limits (#769) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user-authored string and number the API accepts has a bound that keeps it inside its column and its email. Announcement sends are throttled per teacher, and the forms show the limits.

**Architecture:** One client-safe module, `src/lib/input-bounds.ts`, owns every limit constant and the zod field builders. `schemas.ts` uses them, the forms import the same constants for `maxLength`/`max`, and a schema-walk test refuses any future unbounded persisted string.

**Tech Stack:** Zod 4, Next.js 16 route handlers, the in-memory rate limiter (`src/lib/rate-limit.ts`), Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-07-input-bounds-design.md`. Its §2.1 table holds every limit value, and its §4 lists each guard's test and mutation. Premise: `docs/superpowers/specs/2026-10-07-input-bounds-census.md`.

## Global Constraints

- TypeScript `strict`, no `any` (the schema-walk test may need Zod internals; type them narrowly, or use one documented `unknown` narrowing).
- Limit values come from the spec's §2.1 table **verbatim**. A value appears exactly once, in `input-bounds.ts`; everything else imports it.
- `input-bounds.ts` must stay importable from `'use client'` components: no server-only imports (no `@/lib/log`, no Prisma).
- Comment Discipline (CLAUDE.md): no prose counts or rosters, no history, and no claims about other modules in comments. Name the type or the constant.
- Stage exact paths; quote bracketed paths. Commit messages reference `(#769)` and end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Node 24: prefix commands with `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v24' | tail -1)/bin:$PATH:/usr/sbin";`. This worktree's server is on port 3121 (`INTEGRATION_BASE_URL` in `.env`). Never touch `:3000`.
- Every guard gets its §4 mutation. Record the exact failure text, restore with `git checkout -- <file>` (commit first), and end with a clean tree. Curl a route after mutating, before judging it.

## Review Focus

1. Real names in many scripts must still save: apostrophes, hyphens, `St.Clair`, `J.R.`, Devanagari with ZWJ, Arabic, CJK.
2. Edit forms resend every field, so a field newly capped on create must be capped identically on update. Otherwise a value the create path accepted becomes uneditable.
3. Existing integration tests that send many announcements must not start failing under the new per-teacher limit. The limiter is per process and shared by the whole test run.
4. Completion at the money caps must store its totals, not 500.
5. The invitation `lastName`, which had no `.trim()`, must trim like every other name.

---

### Task 1: The bounds module and every text cap

**Files:**
- Create: `src/lib/input-bounds.ts` (constants, `singleLineText`, `multiLineText`, `linkFreeText`, the TLD list), `src/lib/input-bounds.test.ts`
- Modify: `src/lib/schemas.ts`. Apply builders and caps exactly as spec §2.1's field table maps them, plus `emailField` and `pageSlugField`. Keep every field's current requiredness.
- Modify: `src/lib/schemas.test.ts` (per-family cap tests). Also add the membership test (spec §4 row 2) here, covering string and array leaves. Task 2 extends it to numbers.
- Test: an integration test that a contact, a walk-in and a CRM edit with `lastName: ''` still succeed (spec §4 "optional last name"). Find the files with `grep -rln "lastName" tests/integration | head`.

**Interfaces:**
- Produces: the constants named in spec §2.1, and `singleLineText(max: number)`, `multiLineText(max: number)`, `linkFreeText(max: number)` (zod string schemas the caller can chain `.min(1)`, `.optional()` or `.default('')` onto). Tasks 2 and 4 import the constants.

- [ ] **Step 1:** Write `input-bounds.test.ts`, covering every accept/refuse case in spec §4's "control and format characters" and "link refusal" rows, both directions. Also write the cap tests in `schemas.test.ts`. Run them and expect a FAIL.
- [ ] **Step 2:** Implement `input-bounds.ts` and wire the schemas. Read how `schemas.test.ts` already walks the module's exports (the test using `memberShapes` and skipping the field-validator exports) before writing the membership test, and reuse that export filter. The walk recurses into nested objects, arrays, unions, optional/nullable/default/pipe. An unknown def type fails. The allow-list holds only fields the census §A.2 calls never-persisted or refine-bounded, each with a one-line reason.
- [ ] **Step 3:** Run `pnpm exec vitest run src/lib` and `pnpm run typecheck`. Fix any existing test that relied on an unbounded value, and list each one in the report. Then run the integration files that POST/PUT names, classes, rooms or announcements: `grep -rln "firstName\|classType\|venueName\|message" tests/integration | head -40`. Run them all, not a sample.
- [ ] **Step 4: Mutations:** every mutation in spec §4's rows "each text cap", "membership" (string/array parts), "control and format characters", "link refusal" and "optional last name". Record each failure.
- [ ] **Step 5: Commit:** `fix: every user-authored text field has a length cap and refuses control characters; names refuse link-shaped text (#769)`.

### Task 2: Number caps

**Files:**
- Modify: `src/lib/schemas.ts` (every `durationMinutes`, money and capacity field in census §A.3), `src/lib/schemas.test.ts`
- Test: an integration test for completion at the money caps and for the 400s (spec §4 rows "completion cannot overflow" and "the API answers 400"). Put it beside the existing class-completion integration tests: `grep -rln "complete" tests/integration | head`.

**Interfaces:**
- Consumes: `DURATION_MAX_MINUTES`, `MONEY_MAX` and `CAPACITY_MAX` from Task 1's `input-bounds.ts`.

- [ ] **Step 1:** Write the failing tests named in spec §4's rows for "number caps", "completion cannot overflow", "currency tether" and "the API answers 400". Pin `minRate`'s lower bound on the *update* schemas. Extend Task 1's membership test so every number leaf must carry both bounds. Expect a FAIL.
- [ ] **Step 2:** Implement, applying the same caps on create and update for each family, with human messages on each cap.
- [ ] **Step 3:** Run the tests and typecheck, and expect a PASS. **Mutations:** every mutation in those spec §4 rows. Record each failure.
- [ ] **Step 4: Commit:** `fix: durations, money and capacities have upper bounds that keep every stored total inside its column (#769)`.

### Task 3: Announcement send limit

**Files:**
- Modify: `src/lib/rate-limit.ts` (a new `announcements` prefix and capacity; the `satisfies` tether forces both), `src/app/api/announcements/route.ts`
- Test: the announcements integration file (`grep -rln "api/announcements" tests/integration`)

- [ ] **Step 1:** Restructure `tests/integration/announcements-api.test.ts` first: one teacher per describe block, each sending at most the limit (spec §2.3 states the budget). Count each block's sends and state the arithmetic in the report. Then write the failing throttle test with its own teacher: the 11th send in an hour → 429 with the `respondRateLimited` body, and another teacher's send still → 200. Also check `invitations-api.test.ts`'s single send.
- [ ] **Step 2:** Implement the check after `requireTeacher` and before the body parse and the audience read (spec §2.3), with a named constant for the limit.
- [ ] **Step 3:** Run the whole announcements integration file, and expect a PASS. **Mutation:** remove the check → the 429 test goes red. Record it.
- [ ] **Step 4: Commit:** `fix: a teacher can send ten announcements an hour (#769)`.

### Task 4: Forms mirror the limits

**Files:**
- Modify: every form the census §E lists as missing a `maxLength`, plus the signup page-address field. Import from `@/lib/input-bounds`, and replace the literal `250` in `profile-form.tsx` only if it is the bio cap's own constant.
- Modify: the number validators spec §2.4 names (`class-edit-form`'s `numberFieldError`, `new-class-form`, `template-form`, `new-studio-class-form`, `studio-template-form`, `studio-class-edit-form`), each in its own copy style. Also `slugFromName` (`components/signup/page-address-field.tsx`) truncation.
- Test: component tests per spec §4's "forms validate" and "slug suggestion" rows. Use the existing `*.test.tsx` beside each form where one exists.

- [ ] **Step 1:** Write the failing tests. Drive cap + 1 into a representative input per validator (a class duration, a money field, a name, the announcement message) and assert the form's own error copy appears and no request is sent. Also write the slug-suggestion unit test. Expect a FAIL.
- [ ] **Step 2:** Add the `maxLength` attributes across the census §E list, the validator caps, the `max`/`min` hints, and the slug truncation.
- [ ] **Step 3:** Run `pnpm exec vitest run --project components`, the unit tests and `pnpm run typecheck`. **Mutations:** remove the cap from one validator → its test goes red; drop the slug truncation → its test goes red. Record both.
- [ ] **Step 4: Commit:** `feat: forms show the length and value limits the API enforces (#769)`.
