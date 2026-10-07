# Sign-in Oracles (#767) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three account-existence and code-guessing oracles: magic-link send timing, cross-token handoff-code guessing, and the 403-vs-404 split on `GET /api/students/[id]`.

**Architecture:** (1) the send route hands lookup and delivery to a new `FireAndForget` function, so its response cannot depend on registration. (2) A new `HandoffAttemptBudget` table gives every address 10 code attempts per 24 hours across all of its tokens, reserved atomically *before* the code is compared. (3) The students GET answers one 404 for "unknown" and "not yours".

**Tech Stack:** Next.js 16 route handlers, Prisma + PostgreSQL (raw SQL upsert), Vitest (unit / integration projects).

**Spec:** `docs/superpowers/specs/2026-10-07-sign-in-oracles-design.md`. Read it before any task; it argues every decision below.

## Global Constraints

- TypeScript `strict`, no `any`. Services stay framework-agnostic.
- Comment Discipline (CLAUDE.md): no counts or member rosters in comments, no history ("previously…"), and no claims about other modules. Wider prose goes in `docs/`.
- Migrations via `pnpm exec prisma migrate dev --name <name>`. In this agent shell it refuses to run non-interactively; if so, write the migration SQL by hand under `prisma/migrations/<timestamp>_<name>/migration.sql` and apply it with `pnpm exec prisma migrate deploy`. Never edit an applied migration, comments included.
- Stage exact paths; never `git add -A` / `git add .`. Quote paths containing parentheses or brackets.
- Integration tests run against this worktree's own server: `pnpm run worktree:up` (already running at the URL in `.env` as `INTEGRATION_BASE_URL`). Never touch the server on `:3000`. Node 24 is required: prefix commands with `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v24' | tail -1)/bin:$PATH:/usr/sbin";`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and reference `(#767)`.
- Every guard gets a mutation step: break it, record the exact failure text in the task report, restore it, and re-run to green. End each task with `git status` clean apart from the intended changes.

## Review Focus

1. A registered address must still receive its link after the send route stops awaiting delivery. A test that polls for the token row is the only proof, because the 200 no longer implies the row exists.
2. Concurrent wrong claims against one address: no more than 10 comparisons per window, whatever the concurrency. The test fires 20 concurrent claims.
3. A correct code after the address's budget is spent must be refused, while the same token opened from the requesting browser (`verifyWithHandoff`, matching nonce) still signs in.
4. Existing `handoff.test.ts` cases that spend more than 10 attempts on one address will now fail for a new reason. Each one is adjusted deliberately, either with a fresh address per token or with a test-local budget reset, never by raising the constant.
5. An unlinked teacher and another student reading `GET /api/students/[id]` must get a response byte-identical to the unknown-id one (status and body).

---

### Task 1: Send the magic link without awaiting it

**Files:**
- Modify: `src/lib/auth/link-delivery.ts` (add `deliverSignInLinkIfRegistered`)
- Modify: `src/lib/auth/index.ts` (export it, if `deliverSignInLink` is exported there)
- Modify: `src/app/api/auth/magic-link/send/route.ts`
- Test: `src/lib/auth/link-delivery.test.ts` (extend)
- Test: every integration test that reads a `magicLinkToken` row right after `POST /api/auth/magic-link/send`. Find them with `grep -rn "magic-link/send" tests/`. Known: `tests/integration/auth-email-case.test.ts`.

**Interfaces:**
- Produces: `export function deliverSignInLinkIfRegistered(db: PrismaClient, email: string, nonce: BrowserNonce, opts?: { redirectTo?: string }): FireAndForget`, with `FireAndForget` from `@/lib/fire-and-forget`.

- [ ] **Step 1: Write failing unit tests** in `link-delivery.test.ts` (read the file's existing mocking style first and follow it):
  - returns `undefined` synchronously while a stubbed `db.teacher.findUnique` returns a promise that never settles. This proves the lookup sits inside the detached body.
  - when the address matches neither a teacher nor a student, no token is minted and no email is sent.
  - when the lookup rejects, `log.error` is called once (spy on `log` from `@/lib/log`) and no unhandled rejection escapes. Await a flush with `await new Promise((r) => setTimeout(r, 0))` before asserting.
  - a teacher address and a student address each lead to one `sendMagicLinkEmail` call.
- [ ] **Step 2:** Run `pnpm exec vitest run src/lib/auth/link-delivery.test.ts` and expect a FAIL (function not exported).
- [ ] **Step 3: Implement** in the shape of `deliverPasskeyAddedNotice` (`src/services/passkey-notice.ts`): `void (async () => { lookup teacher, then student; if neither, return; await deliverSignInLink(db, email, nonce, { redirectTo: opts?.redirectTo }); })().catch((err: unknown) => { log.error({ err }, 'magic-link send: delivery failed'); });`. Nothing goes before the `void`. Add the compile-time pin below the function, in the shape of `services/invitations.ts`'s `_deliverInvitationReturnsVoid`: `type _deliverSignInLinkIfRegisteredReturnsVoid = Assert<Equals<ReturnType<typeof deliverSignInLinkIfRegistered>, void>>;` plus the same `void 0 as unknown as [...]` usage line. The docblock states the contract (the response must not depend on whether the address is registered) and links `docs/technical-architecture.md` (The Services Layer → Work that must not be awaited).
- [ ] **Step 4: Rewrite the route** so that after `ensureOriginNonce` it calls `deliverSignInLinkIfRegistered(prisma, email, nonce, { redirectTo: redirect });` with no `await`, and returns `response`. Delete the in-route lookup, the `try/catch` and its comment. Keep the comment about the nonce being set for every request, editing it only where it names the lookup that moved.
- [ ] **Step 5: Fix the racing tests.** Three tests are known to read a token row synchronously after `/send`. Re-run `grep -rn "magic-link/send" tests/` for any others.
  - `tests/integration/auth-email-case.test.ts` (the mixed-case token test): wrap the `findMany` in `waitFor` from `tests/helpers.ts`.
  - `tests/e2e/auth.spec.ts` (the `findFirst` after "Check your inbox"): poll with Playwright's `expect.poll`.
  - `tests/integration/magic-link-claim.test.ts`: its `email` is a registered student, so `/send` now mints a token in the background. Wait for that token with `waitFor` before the test mints its own and claims, or the late insert can land after the claim's sibling purge and break the final `toBeNull()` (or leak past `afterAll`). Apply this to every `/send` call in the file whose address is registered.

  Where a test asserts *absence* after `/send` (an unregistered address), use the control-address pattern in `waitFor`'s docblock: also send for a registered control address, `waitFor` the control's row, then assert absence.
- [ ] **Step 6: Run** `pnpm exec vitest run src/lib/auth/link-delivery.test.ts` and `pnpm exec vitest run --project integration tests/integration/auth-email-case.test.ts tests/integration/magic-link-claim.test.ts tests/integration/magic-link-origin-binding.test.ts`. Expect a PASS.
- [ ] **Step 7: Mutations.** Record each failure's text in the task report, then restore:
  - (a) change the return type to `Promise<void>`, make the body `async`, and add `await` at the route's call site → `pnpm run typecheck` must fail on the pin.
  - (b) move the teacher lookup above the `void (async` line (awaiting it would need an async function, so make the function `async` temporarily) → the synchronous-return unit test must fail.
  - (c) delete the `.catch` → the logging unit test must fail.
  - (d) make the function a no-op body → the integration poll for a registered address must time out. Curl the send route once first, so `next dev` has compiled it before you judge the result.
- [ ] **Step 8: Commit** (exact paths): `fix: magic-link send no longer waits on the lookup or the email, so its latency cannot tell a registered address from an unknown one (#767)`.

### Task 2: One handoff attempt budget per address, reserved before comparing

**Files:**
- Modify: `prisma/schema.prisma` (add `HandoffAttemptBudget`)
- Create: `prisma/migrations/<timestamp>_handoff_attempt_budget/migration.sql`
- Modify: `src/lib/auth/handoff.ts`
- Modify: `src/services/auth-cleanup.ts`
- Modify: `src/services/gdpr.ts` (both sites that run `magicLinkToken.deleteMany({ where: { email: … } })`)
- Modify: `docs/data-model.md` (new model entry, beside `MagicLinkToken`)
- No `docs/lock-order.md` node: the spec's §2.2 "Locks" decides this and says why.
- Test: `src/lib/auth/handoff.test.ts`, `src/services/auth-cleanup.test.ts`, and the gdpr erasure tests that already assert `magicLinkToken` cleanup (`grep -rln "magicLinkToken" tests/integration src/services`)

**Interfaces:**
- Produces in `handoff.ts`: `export const HANDOFF_EMAIL_MAX_ATTEMPTS = 10;`, `export const HANDOFF_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;`, and `export async function reserveHandoffComparisons(db: PrismaClient, email: string, wanted: number, now: Date = new Date()): Promise<number>`, which returns the number granted, from 0 to `wanted`.
- Consumes: nothing from Task 1. The two tasks are independent.

- [ ] **Step 1: Schema and migration.**
  ```prisma
  /// One address's handoff-code comparisons in its current window. See
  /// docs/superpowers/specs/2026-10-07-sign-in-oracles-design.md §2.2.
  model HandoffAttemptBudget {
    email          String   @id
    windowStartsAt DateTime
    attempts       Int
  }
  ```
  Create the migration (see Global Constraints). It must also add `ALTER TABLE "HandoffAttemptBudget" ADD CONSTRAINT "HandoffAttemptBudget_email_lowercase_check" CHECK (email = lower(email));`, copying the exact form from `prisma/migrations/20260807173228_email_lowercase_checks/migration.sql`. Run `pnpm exec prisma generate`. Apply the migration to the worktree's dev and test databases the same way `worktree:setup` / `pnpm test` do (read `scripts/worktree-up.ts` if unsure). In `src/services/gdpr.ts`, the comment naming "all six email columns" by roster and count is rewritten to name the convention (every email column carries an `_email_lowercase_check`) with no count or list.
- [ ] **Step 2: Failing tests in `handoff.test.ts`.** Give every new test fresh addresses. Write a helper `stamp(email, nonce)` that mints a token under `nonce` and calls `verifyWithHandoff(db, token, null)` to stamp it, returning the code.
  These tests implement spec §4's table, which is the authority on what each one asserts and which mutation must turn it red. Implement every Task-2 row of that table. In particular:
  - `reserveHandoffComparisons`: asking for 3, 3, 3, then 3 grants 3, 3, 3, then 1, and a further ask grants 0. Once the stored `windowStartsAt` is more than `HANDOFF_EMAIL_WINDOW_MS` old (set it through typed Prisma), an ask grants again and the row reads back with `attempts` equal to that grant and `windowStartsAt` equal to the `now` passed in.
  - **Spans tokens and nonces:** one address. T1 under N1 takes 4 misses, T2 under N2 takes 4, T3 under N3 takes 2, so no token reaches the per-token 5. T3's **correct** code under N3 is then `invalid`, and T3 still exists.
  - **One unit per code compared:** three stamped tokens for one address under one nonce, one wrong claim → `attempts` = 3.
  - **Partial grant, newest first:** budget at 9 (set directly), two stamped tokens under one nonce. The older token's correct code is `invalid`. In a separate setup, the newer token's correct code verifies.
  - **Only granted candidates are compared:** addresses A and B under one nonce, A's budget spent. A's correct code is `invalid`, and B's correct code verifies.
  - **The same browser is unaffected:** with the budget spent, `verifyWithHandoff(db, token, asBrowserNonce(n))` for a token minted under `n` → `verified`.
  - **Concurrency (the reserve-before-compare pin):** insert 20 stamped tokens for one address, each under its **own** nonce. Use `prisma.magicLinkToken.create` with `handoffCode` set directly, so no rate limit applies. Fire 20 concurrent wrong claims, one per nonce. Assert Σ`handoffAttempts` across the 20 rows = 10 and the budget's `attempts` = 10. To prove the calls overlap rather than run in sequence, open a second `PrismaClient`, take `SELECT … FOR UPDATE` on the budget row inside a transaction, issue all 20 claims, wait until 20 backends are waiting on it (poll `pg_stat_activity` where `wait_event_type = 'Lock'`), then release. If that harness proves unworkable, report it rather than dropping the overlap proof.
  - **Lowercase CHECK:** a raw insert of an uppercase address is refused.
- [ ] **Step 3:** Run `pnpm exec vitest run src/lib/auth/handoff.test.ts` and expect the new tests to FAIL.
- [ ] **Step 4: Implement `reserveHandoffComparisons`** as spec §2.2 describes. It is one `db.$transaction(async (tx) => …)`:
  1. `INSERT … ON CONFLICT (email) DO NOTHING` (or `tx.handoffAttemptBudget.createMany({ data: [...], skipDuplicates: true })`) with `attempts: 0, windowStartsAt: now`.
  2. ``tx.$queryRaw<{ attempts: number; windowStartsAt: Date }[]>`SELECT attempts, "windowStartsAt" FROM "HandoffAttemptBudget" WHERE email = ${email} FOR UPDATE` ``. Only the address is bound raw.
  3. Compute `used` (0 if `windowStartsAt <= now - WINDOW`) and `granted = Math.min(wanted, MAX - used)`, clamped at 0.
  4. `tx.handoffAttemptBudget.update` writes `attempts: used + granted` and, if the window restarted, `windowStartsAt: now`.

  Return `granted`. Ask for nothing when `wanted <= 0`.
- [ ] **Step 5: Wire it into `claimWithCode`.** After `live` is computed (newest first) and before `match`, group `live` by address, preserving order. For each address in turn (a sequential `for … of`, so one claim never holds two budget rows), call `granted = await reserveHandoffComparisons(db, email, group.length)` and add `group.slice(0, granted)` to `compared`. If `compared` is empty, return `{ kind: 'invalid' }`. Compute `match`, `ids` and `expectedReaps` from `compared` instead of `live`. Rewrite the docblocks so they state what is true now, linking spec §2.2 rather than restating it:
  - `HANDOFF_MAX_ATTEMPTS`: drop "this scoping is what makes it the guard". The per-address budget is now the bound that does not depend on the nonce.
  - `claimWithCode`: a miss is charged to the candidates that were *compared*, and comparisons are granted per address before the code is read.
  - The new constants and function.

  Do not change `HANDOFF_MAX_ATTEMPTS`.
- [ ] **Step 6: Re-run all of `handoff.test.ts`.** Any pre-existing test that now spends more than 10 attempts on one address fails for a new reason. Fix each one by giving its tokens separate addresses, or by deleting the budget row between phases with a comment saying why. Never change the constant. List each adjusted test in the task report.
- [ ] **Step 7: Sweep and erasure.** Add `db.handoffAttemptBudget.deleteMany({ where: { windowStartsAt: { lte: new Date(now.getTime() - HANDOFF_EMAIL_WINDOW_MS) } } })` to `cleanupExpiredAuth`'s `Promise.all`, with `handoffAttemptBudgets: count` in the result. `src/app/api/cron/daily-cleanup/route.test.ts` mocks the result shape; check that it still type-checks. Read `tests/scoped-sweep.ts` first, because sweep tests run scoped, and extend `auth-cleanup.test.ts` with a stale row (reaped) and a fresh row (kept). In both gdpr sites, add `await tx.handoffAttemptBudget.deleteMany({ where: { email: <same address expression> } });` next to the `magicLinkToken` delete, and extend whichever erasure test asserts the token delete to assert this row is gone too.
- [ ] **Step 8: Docs.** Add a `HandoffAttemptBudget` entry to `docs/data-model.md` in that document's format, beside `MagicLinkToken`: fields, why it exists, the unit (one code compared), retention (at most 48 h), erasure, and that it is not exported (spec §2.2). `cleanupExpiredAuth`'s result shape gains a key; check `src/lib/scheduler.ts` and `src/app/api/cron/daily-cleanup/route.ts` for anything that names the keys.
- [ ] **Step 9: Mutations.** Run every mutation in spec §4's Task-2 rows. Record each failure's exact text, then restore. Commit before mutating, so restoring is `git checkout -- <file>`, and check `git status` is clean at the end. At minimum:
  - (a) reserve after the miss (compare all of `live`, then reserve on a miss) → the concurrency test fails with Σ = 20.
  - (b) key the budget on the nonce instead of the address → the spans-tokens test fails.
  - (c) charge 1 per claim → the one-unit-per-code test fails.
  - (d) compare all of `live` regardless of grant → the A/B test fails.
  - (e) drop the window-ended branch → the window test fails.
  - (f) remove the sweep delete → the auth-cleanup test fails.
  - (g) remove one gdpr delete → its erasure test fails.
  - (h) drop the CHECK from a scratch copy of the migration applied to a throwaway DB, *or* argue in the report why the raw-insert test is sufficient evidence.
- [ ] **Step 10:** Run `pnpm run typecheck`, `pnpm exec vitest run src/lib/auth src/services/auth-cleanup.test.ts`, and the touched integration files. Then commit: `fix: handoff codes draw on one per-address budget of 10 comparisons a day, granted before the code is compared (#767)`.

### Task 3: `GET /api/students/[id]` answers one 404 for unknown and not-yours

**Files:**
- Modify: `src/app/api/students/[id]/route.ts` (GET only)
- Test: `tests/integration/students-api.test.ts`

- [ ] **Step 1: Failing tests.** Change `'a student-only session reading another student is denied'` to expect 404. Add: an unlinked teacher reading an existing student gets 404. Add: for both callers, the status and JSON body equal those of an unknown UUID (`crypto.randomUUID()`), so the test compares the whole response, not just the status.
- [ ] **Step 2:** Run `pnpm exec vitest run --project integration tests/integration/students-api.test.ts` and expect a FAIL.
- [ ] **Step 3: Implement.** Self-access is checked first and still reads the full row (404 if absent). A teacher's link lookup comes before any student lookup, and a missing link returns `respondError('Student not found', 404)`. Every other session returns the same 404. Update the route comment so it describes what is true now: the link check also hides whether the id is a student.
- [ ] **Step 4:** Run it and expect a PASS. **Mutation:** restore the old `403` for the unlinked teacher → the new test must fail. Record the text, then restore.
- [ ] **Step 5: Commit:** `fix: GET /api/students/[id] answers an unlinked or foreign caller with the unknown-id 404 (#767)`.
