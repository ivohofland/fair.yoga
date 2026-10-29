# Prisma 7 Follow-ups (#927) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the live follow-ups from #927: match unique violations by name, record where the pg 9 deprecation actually comes from, and make `db:reset` seed again.

**Architecture:** Three independent edits. (1) Four `P2002` catches that test only the code switch to `isUniqueConflictOn` with the index each one means (`admin-grants.ts` re-reads the grant instead), and rethrow anything else. (2) A docs subsection records the measured source of the pg deprecation. (3) `db:reset` chains `prisma db seed`.

**Tech Stack:** TypeScript strict, Prisma 7.10.1 + `@prisma/adapter-pg`, pg 8.23.1, Vitest.

**Spec:** none (gated out: three single-approach edits, no invariant change). The decisions are in #927 and its comment, and were agreed at the brainstorming gate.

## Premise record (measured 2026-10-29, against 7.10.1)

- **Item 1 (23503 `{fields}`) is already pinned, so there is nothing to build.** `src/lib/pg-error.test.ts:42` asserts a fields-only cause names no constraint. The real-DB cases at `:380` (restrict delete) and `:394` (dangling insert) fail if the adapter ever emits `{fields}` for them. `docs/technical-architecture.md:1852` states that Postgres never sets `column` on an FK violation. No migration raises `23503` itself (`grep -rln "foreign_key_violation\|'23503'" prisma/migrations` finds nothing).
- **Item 2 holds.** `prisma migrate reset --help` on 7.10.1 lists only `--config`, `--schema` and `--force`; there is no seed option. `README.md:74` and `:113` promise a re-seed.
- **Item 3 holds, with 4 sites, not 3.** `src/lib/auth/account.ts:71`, `src/app/api/invitations/[id]/route.ts:261`, `src/services/admin-grants.ts:48`, and `src/services/processor-refunds.ts:199`, which neither the issue nor its comment names. Re-derive: `git grep -n "err.code === 'P2002'" -- src ':!*.test.ts'`, then drop the hits that already follow an `isUniqueConflictOn` (student-profile, teacher-profile, teacher-rooms, invitations.ts:414 and api-errors.ts's fallback).
- **Item 4's mechanism is wrong.** A static census found one `Promise.all` on a transaction client: `liveWorkOf` (`src/services/processor-connection.ts:42`), called by `disconnect` with its `tx` (`:416`). Non-test hits (`git grep -n "Promise.all" -- src prisma ':!*.test.ts'`): 27 = 0 direct on a `tx` + 1 through a parameter given a `tx` + 9 through a parameter given only the plain client + 17 plain client, no DB, or a comment. Probing during Task 2 showed that call never warns. pg warns only with three statements in flight, and three app statements on a `tx` stayed quiet. What does warn is one read with three or more relation `include`s inside an interactive transaction. The measurements are in `docs/technical-architecture.md` (Overlapping statements on one transaction, and pg 9).
- **Item 5 is let go.** The issue comment names the cost: an exactly pinned devDependency that has to move in lockstep with `@prisma/adapter-pg`.

## Global Constraints

- `strict: true`, no `any`. Comments state what is true now, with no counts or rosters (CLAUDE.md, *Comment Discipline*).
- Stage exact paths; never `git add -A`. Quote paths containing `[id]`.
- Never run `prisma migrate reset` against the dev database on :3000, and never restart the dev server.

## Review Focus

- A `P2002` on an index the catch did not name must now propagate, not be answered as "already done", a re-resolve, or `CONTACT_EMAIL_TAKEN`. Each task-1 site gets a test of that where the call can be intercepted.
- The lost race each catch exists for must still answer exactly as before. The existing race tests cover this (`admin-grants.test.ts:80`, `processor-refunds.test.ts:325`, `tests/integration/invitations-api.test.ts:612`); they must stay green.
- `UNIQUE_CONSTRAINTS` gains one partial index. `pg-error.test.ts:196` holds every member to `pg_indexes`, so a misspelt name fails there.

---

### Task 1: Match the four code-only P2002 catches by index name

**Files:**
- Modify: `src/lib/unique-conflict.ts` (add `'ProcessorRefund_one_live_per_attempt'` to `UNIQUE_CONSTRAINTS`, keeping alphabetical order)
- Modify: `src/lib/auth/account.ts:71` → `isUniqueConflictOn(err, ['Account_email_key'])`
- Modify: `src/app/api/invitations/[id]/route.ts:261` → `isUniqueConflictOn(err, ['Invitation_teacherId_email_key'])`
- Modify: `src/services/admin-grants.ts:48` → on a P2002, re-read the active grant and answer `unchanged` only if one exists (the migrate image carries only `prisma-client.ts`, so this module cannot import `unique-conflict.ts`; `admin-grants.test.ts` pins that)
- Modify: `src/services/processor-refunds.ts:199` → `isUniqueConflictOn(err, ['ProcessorRefund_one_live_per_attempt'])`
- Test: `src/services/admin-grants.test.ts`, `src/lib/auth/account.test.ts`, `src/app/api/invitations/[id]/cas-scope.test.ts` (or a sibling test in that directory using its `vi.mock('@/lib/db')` setup), `src/services/processor-refunds.test.ts`

**Interfaces:**
- Consumes: `isUniqueConflictOn(err: unknown, names: readonly UniqueConstraintName[]): boolean` from `@/lib/unique-conflict`; fixtures `typedCallError(pgCause('23505', message, { constraint: { index } }), modelName)` from `tests/adapter-errors.ts`.
- Produces: nothing other tasks use.

A non-matching error falls to the catch's existing `throw err`. Drop each file's `Prisma` import if nothing else in the file uses it. Where a comment above a catch names the race, keep it; it may now name the index.

- [ ] **Step 1: Write the failing tests.** One per site. Each makes the guarded create or update reject with a P2002 on an index the catch did not name, and asserts the call rejects with that same error:
  - `admin-grants.test.ts`: `'rethrows a unique violation that left no active grant'`. With no grant in the database, spy on `db.adminGrant.create` to reject once with `typedCallError(pgCause('23505', 'duplicate key value violates unique constraint "AdminGrant_other_key"', { constraint: { index: 'AdminGrant_other_key' } }), 'AdminGrant')`, then `await expect(grantAdmin(...)).rejects.toBe(thatError)`.
  - `account.test.ts`: `'rethrows a unique violation on an index other than Account_email_key'`. The unclaimed-student path, with `db.account.create` spied to reject the same way (`'Account_other_key'`), asserting `rejects.toBe(thatError)`.
  - invitation route, new `put-unique-conflict.test.ts` (mocks as in `cas-scope.test.ts`): `'answers CONTACT_EMAIL_TAKEN for the (teacher, email) key'` and `'leaves a violation on any other index to the generic fallback, not CONTACT_EMAIL_TAKEN'`, which asserts 409 `UNIQUE_CONFLICT` from `classifyApiError`.
  - `processor-refunds.test.ts`: `'a unique violation on the one-live-refund key with REFUND_ALREADY_REQUESTED'` and `'rethrows a unique violation on an index other than the one-live-refund key'`. The create runs on the transaction client, so a helper wraps `prisma.$transaction` and proxies that client's `processorRefund.create`.
- [ ] **Step 2: Run them and see them fail.** `pnpm exec vitest run --project integration src/services/admin-grants.test.ts src/lib/auth/account.test.ts src/services/processor-refunds.test.ts`, plus the invitation route test under its own project (check `vitest.config` for which project owns `src/app/api/**`). Expected: each new test FAILS because the code-only catch swallows the error (unchanged / re-resolve recursion / `CONTACT_EMAIL_TAKEN` / `REFUND_ALREADY_REQUESTED`).
- [ ] **Step 3: Implement** the five file edits listed above.
- [ ] **Step 4: Run the same tests plus `src/lib/pg-error.test.ts` and `tests/integration/invitations-api.test.ts`.** Expected: all PASS, including the `UNIQUE_CONSTRAINTS` ↔ `pg_indexes` check and the existing race tests.
- [ ] **Step 5: Prove the name match bites.** For each site, change the listed name to another `UNIQUE_CONSTRAINTS` member, run that site's existing race test, record the failure text, restore, re-run green. Record all four in the task report.
- [ ] **Step 6: Commit**
  ```bash
  git add src/lib/unique-conflict.ts src/lib/auth/account.ts 'src/app/api/invitations/[id]/route.ts' src/services/admin-grants.ts src/services/processor-refunds.ts <the test files touched>
  git commit -m "fix: the four code-only P2002 catches match their index by name (#927)"
  ```

### Task 2: Record where the pg deprecation actually comes from

The task originally planned was to make `liveWorkOf` sequential. Its first step falsified that: three `Promise.all` counts on a `tx` raise no warning, so Prisma keeps fewer than three of the app's statements in flight there, and `liveWorkOf` issues two. The change was dropped and the measurements were recorded instead.

**Files:**
- Modify: `docs/technical-architecture.md`: a new subsection before *Database errors*, holding the measured trigger table and the condition for a pg 9 bump.

- [ ] **Step 1: Commit**
  ```bash
  git add docs/technical-architecture.md docs/superpowers/plans/2026-10-29-prisma-7-follow-ups.md
  git commit -m "docs: the pg 9 deprecation comes from Prisma's relation fetches in a transaction, not the repo's Promise.all (#927)"
  ```

### Task 3: `db:reset` seeds again

**Files:**
- Modify: `package.json` (`"db:reset": "prisma migrate reset && prisma db seed"`)
- Check: `README.md:74` and `:113`. Its description ("Drop all tables, re-migrate, re-seed") becomes true again. Correct it only if it still differs.

**Interfaces:** none.

- [ ] **Step 1: Edit the script.**
- [ ] **Step 2: Verify without touching the dev DB.** `pnpm run db:reset --help` is not meaningful, so check the script resolves: `node -e "console.log(require('./package.json').scripts['db:reset'])"`. Leave running it to the user. Prisma's agent guard refuses `migrate reset` from an agent anyway, and :3000's database is the user's. State this in the task report.
- [ ] **Step 3: Commit**
  ```bash
  git add package.json
  git commit -m "fix: db:reset runs the seed that prisma migrate reset no longer runs (#927)"
  ```
