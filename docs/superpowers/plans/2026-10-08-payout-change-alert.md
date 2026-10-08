# Payout-change alert and "This wasn't me" pause — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email the teacher on every payout-details change with a "This wasn't me" link that pauses payments and signs out everywhere; resuming requires a fresh sign-in, the right passkey, and explicit confirmation of the current details.

**Architecture:** Payout writers record a masked `PayoutChangeEvent` under the teacher lock and the route emails after commit (FireAndForget) with a single-use `PayoutPauseToken`. A public interstitial posts the token to a pause service that, in one transaction, stamps the teacher paused, freezes passkey eligibility, and signs everything out. "Paused" becomes a variant of the payment-method helper's return type, so every pay surface handles it. A resume page lists what happened in the window and resumes under recent-auth + passkey-session + details-fingerprint gates.

**Tech Stack:** Next.js 16 App Router, Prisma/PostgreSQL, Vitest (unit / components / integration projects), Playwright, Resend email.

**Spec:** `docs/superpowers/specs/2026-10-08-payout-change-alert-design.md` — read it in full before any task; this plan names files and tests, the spec carries the rules and their reasons.

## Global Constraints

- TypeScript `strict`, no `any`. Services in `src/services/` take a Prisma client/tx and typed input, no HTTP imports.
- Every 409 from `respondError` names a code registered in `src/lib/api-error-codes.ts`; tests assert the **code**, never `error.message`. New codes: `PAUSE_LINK_INVALID: 404`, `PASSKEY_REQUIRED: 403`, `PAYMENTS_PAUSED: 409`, `PAYOUT_DETAILS_CHANGED: 409`, `PASSKEY_REMOVAL_PAUSED: 409`.
- "Already done" answers `respondUnchanged`, placed after ownership and after any refusal that makes the goal moot.
- Work that must not be awaited returns `FireAndForget` (see `docs/technical-architecture.md`, "Work that must not be awaited"); copy `src/services/passkey-notice.ts`.
- Constants: `PAUSE_TOKEN_TTL_DAYS = 14`, `PAUSE_PASSKEY_LOOKBACK_DAYS = 7`, `PAUSE_PASSKEY_FALLBACK_DAYS = 14`, overdue stays `OVERDUE_AFTER_DAYS` (7).
- Masking: bank → `maskedIdentifier` (`src/lib/bank-details.ts`); link → host + `/…` + last four characters of the path (no path → host only). Never a full IBAN, account number or link in an email, log, or event row.
- Comment discipline (CLAUDE.md): no counts or member rosters in comments; claims about other modules go in `docs/`.
- Migrations: `pnpm exec prisma migrate dev --name <name>` (see memory: from an agent shell use `--create-only` then apply as the repo's recipe allows); never edit an applied migration.
- Copy: the hold-off line is exactly "Payment details are being checked — please hold off for now."
- Never `git add -A`/`.`; quote paths containing parentheses.
- Integration tests run against the worktree's own app: `pnpm run worktree:up` once, then `pnpm exec vitest run --project integration <path>`.
- Every guard gets a mutation step: break it, record the exact failing assertion text in the task report, restore, re-run green, `git status` clean.

## Review Focus

1. **Two alerts, two clicks.** A teacher clicks "This wasn't me" in two emails: the second still signs out and removes post-cutoff passkeys, but keeps the first pause's instant, window start and cutoff (Task 4 test).
2. **Bank accounts in several currencies.** The fingerprint and the resume screen cover every account the teacher holds, not just the current currency's — an attacker can write the EUR row while the teacher is on GBP (Task 6 test).
3. **A stored link that no longer parses.** Masking it must not throw; the event's `before` falls back to a fixed "an unreadable link" string (Task 2 test).
4. **Teacher erased between alert and click.** Delivery logs and returns; the pause answers `PAUSE_LINK_INVALID` (Tasks 3 and 4 tests).
5. **An old link after a resume.** A resume deletes the teacher's tokens, so a pre-resume link answers `PAUSE_LINK_INVALID` and cannot re-pause with a stale window (Task 6 test).

---

### Task 1: Schema, migration, erasure, export, cleanup

**Files:**
- Modify: `prisma/schema.prisma` (Teacher, Session; new `PayoutChangeEvent`, `PayoutPauseToken`, enum `PayoutChangeKind`)
- Create: `prisma/migrations/<timestamp>_payout_change_alert/migration.sql` (generated)
- Modify: `src/services/gdpr.ts` (erasure deletes events + tokens; export includes events)
- Modify: `src/services/auth-cleanup.ts` (delete expired pause tokens)
- Modify: `docs/data-model.md` (new models and columns)
- Test: the existing GDPR erasure/export integration tests and `auth-cleanup` tests (extend them)

**Interfaces — Produces:**
- `Teacher.paymentsPausedAt`, `paymentsResumedAt`, `pauseWindowStart`, `pausePasskeyCutoff` (all `DateTime?`)
- `Session.passkeyCredentialId String?` with relation to `PasskeyCredential`, `onDelete: SetNull`
- `enum PayoutChangeKind { bank_account_added bank_account_changed bank_account_removed payment_link_added payment_link_changed payment_link_removed }`
- `model PayoutChangeEvent { id String @id @default(cuid()); teacherId String; teacher Teacher @relation(...); kind PayoutChangeKind; accountCurrency Currency?; before String?; after String?; createdAt DateTime @default(now()); @@index([teacherId, createdAt]) }`
- `model PayoutPauseToken { id String @id @default(cuid()); tokenHash String @unique; teacherId String; teacher Teacher @relation(...); eventId String; event PayoutChangeEvent @relation(..., onDelete: Cascade); expiresAt DateTime; createdAt DateTime @default(now()); @@index([teacherId]) }`
- Follow the existing id and relation conventions in `schema.prisma` (check what `TeacherBankAccount` uses for `id` and `onDelete`).

- [ ] **Step 1:** Write failing tests: erasure of a teacher with one event and one token leaves neither; the export of a teacher with an event includes its kind, accountCurrency, before, after, createdAt; `cleanupExpiredAuth` deletes an expired token and keeps an unexpired one.
- [ ] **Step 2:** Run them; expect failures for missing models.
- [ ] **Step 3:** Edit the schema, generate the migration, apply it to the worktree's dev and test databases.
- [ ] **Step 4:** Implement erasure (inside the existing erasure transaction, beside `teacherBankAccount.deleteMany`), export, and cleanup.
- [ ] **Step 5:** Run the tests green; mutate (drop the event `deleteMany` from erasure) → record the failing assertion; restore.
- [ ] **Step 6:** Update `docs/data-model.md`; run `pnpm exec prisma validate` and `pnpm run typecheck`.
- [ ] **Step 7:** Commit.

### Task 2: Payout writers record masked events under the teacher lock

**Files:**
- Modify: `src/services/bank-accounts.ts`, `src/services/payment-link.ts`
- Modify: `src/lib/payment-link.ts` (add `maskPaymentLink`)
- Modify: `src/app/(teacher)/settings/profile/bank-account-form.tsx` (and its test) to accept the 200-unchanged answer
- Modify: `src/app/api/teachers/[id]/bank-accounts/[currency]/route.ts` (unchanged → `respondUnchanged`)
- Modify: `docs/lock-order.md` ("The `Teacher` row is the first lock"), and the route lock-order pin test (`route-lock-order.test.ts` — locate it)
- Test: the services' existing integration tests; `src/lib/payment-link.test.ts`

**Interfaces — Produces:**
```ts
// src/lib/payment-link.ts
export function maskPaymentLink(raw: string): string; // "revolut.me/…cher"; unparseable → "an unreadable link"
// src/services/bank-accounts.ts
export type SaveBankAccountOutcome =
  | { status: 'saved'; eventId: string }
  | { status: 'unchanged' }
  | { status: 'invalid'; /* existing fields */ }
  | { status: 'teacher_gone' };
export function removeBankAccount(db, teacherId, currency): Promise<{ status: 'removed'; eventId: string } | { status: 'absent' } | { status: 'teacher_gone' }>;
// src/services/payment-link.ts
savePaymentLink → { status: 'saved'; eventId } | { status: 'unchanged' } | { status: 'invalid'; ... } | { status: 'teacher_gone' }
removePaymentLink → { status: 'removed'; eventId } | { status: 'absent' } | { status: 'teacher_gone' }
```
Match the existing outcome shapes' style (read them first); if they are string literals today, widen only the success members to objects carrying `eventId` and update every caller.

- [ ] **Step 1:** Failing tests: add → one `bank_account_added` event, `before` null, `after` masked; edit → `bank_account_changed` with both masked; identical re-save → `unchanged`, no event, HTTP 200 with the unchanged answer; remove → `bank_account_removed` with `before` masked; same four for the link (`payment_link_*`), with an unparseable stored link masking to "an unreadable link"; no event row ever contains the full IBAN or full link (assert by substring); an erased teacher → `teacher_gone` and no event.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement. Each writer: one transaction; `lockTeacherForNoKeyUpdate` first (bank writers move up from `lockTeacherForShare`); null → `teacher_gone` before any write; read current; compare (bank: every stored column the upsert writes); write; insert event; return its id.
- [ ] **Step 4:** Lock pin: a hold-the-other-side test — hold `FOR SHARE` on the teacher row on a second connection, assert `savePaymentLink` parks (see memory "Untestable races usually aren't" and existing tests in the lock-order suite for the harness). Update `docs/lock-order.md` and its re-derive grep output.
- [ ] **Step 5:** Form: when the PUT answers unchanged, the form shows its normal saved state (read how other forms consume `respondUnchanged`).
- [ ] **Step 6:** Green; mutate the bank unchanged comparison (drop one column from it) → record failure; mutate the lock (back to `lockTeacherForShare`) → record failure; restore.
- [ ] **Step 7:** Commit.

### Task 3: The alert email

**Files:**
- Modify: `src/lib/email-templates.ts` (`renderPayoutChangedEmail`), `src/lib/email.ts` (`sendPayoutChangedEmail`)
- Create: `src/services/payout-notice.ts` (`deliverPayoutChangedNotice`), `src/services/payout-pause-token.ts` (mint)
- Modify: both payout routes to call delivery after commit on `saved`/`removed`
- Test: `src/lib/email-templates.test.ts`, `src/services/payout-notice.test.ts` (unit, mocked email like `passkey-notice.test.ts`), routes' tests

**Interfaces — Produces:**
```ts
export const PAUSE_TOKEN_TTL_DAYS = 14;
export function mintPayoutPauseToken(db: PrismaClient, teacherId: string, eventId: string): Promise<string>; // raw token
export function deliverPayoutChangedNotice(db: PrismaClient, eventId: string): FireAndForget;
export function renderPayoutChangedEmail(input: { kind: PayoutChangeKind; accountCurrency: Currency | null; before: string | null; after: string | null; at: Date; timezone: string; pauseUrl: string }): { subject: string; html: string };
```
`pauseUrl` = `${NEXT_PUBLIC_APP_URL}/payout-pause#t=${raw}`. Email goes to `Account.email` of the teacher's account.

- [ ] **Step 1:** Failing tests: template per kind names the change, the currency, both masked strings, the local time; equal masked before/after renders "a detail other than the account number changed"; HTML escapes input; contains the pause URL; delivery mints exactly one token whose hash (not raw) is stored and whose expiry is 14 days out; delivery returns `undefined` with a slow sender; a sender rejection is logged, not unhandled; an erased teacher logs and sends nothing; routes call delivery only on saved/removed, never on unchanged.
- [ ] **Step 2–4:** Run red, implement, run green.
- [ ] **Step 5:** Mutate: call delivery on unchanged → record failure; restore.
- [ ] **Step 6:** Commit.

### Task 4: Pausing

**Files:**
- Create: `src/services/payout-pause.ts` (`pausePayments`, window computation)
- Modify: `src/services/account-sign-out.ts` (transaction-taking form; the existing function delegates)
- Create: `src/app/api/payout-pause/route.ts`
- Create: `src/app/(public)/payout-pause/page.tsx` (+ client component reading `location.hash`, one button, POST, result states), loading/fallback per the census guards
- Modify: `src/lib/rate-limit.ts` (new IP prefix `payout-pause`, 20 per 15 minutes, in `RateLimitPrefix`, `IpRateLimitPrefix`, `PREFIX_CAPACITIES`)
- Modify: `src/lib/api-error-codes.ts` (`PAUSE_LINK_INVALID: 404`, `PASSKEY_REMOVAL_PAUSED: 409`)
- Modify: `src/app/api/auth/passkey/[id]/route.ts` (refuse while the account's teacher is paused; correct its "ungated" comment)
- Modify: `docs/lock-order.md` (pause site)
- Test: `tests/integration/...` for the pause route (match the folder conventions), unit for window computation, component test for the page

**Interfaces — Produces:**
```ts
export const PAUSE_PASSKEY_LOOKBACK_DAYS = 7;
export type PauseOutcome = { status: 'paused' } | { status: 'invalid' };
export function pausePayments(db: PrismaClient, rawToken: string, now?: Date): Promise<PauseOutcome>;
export function signOutEverywhereTx(tx: TransactionClientOnly, accountId: string): Promise<{ sessions: number; pushSubscriptions: number }>;
```
Transaction order (spec §2): resolve token row by hash (read) → `lockTeacherForNoKeyUpdate` (null → invalid) → consume (`deleteMany` where hash and `expiresAt > now`; count 0 → invalid) → window → stamp unless paused → sign-out (sessions, push subscriptions, `MagicLinkToken` by account email) → delete passkeys `createdAt >= cutoff`.

- [ ] **Step 1:** Failing tests: valid token → teacher paused with `pauseWindowStart`, `pausePasskeyCutoff` set iff a passkey older than the cutoff exists; sessions, push subscriptions, magic-link tokens gone; passkeys at/after cutoff gone, older kept; token gone; reused token → 404 `PAUSE_LINK_INVALID`; expired → same; unknown → same; erased teacher → same; second token while paused → still signs out, keeps the first instant/window/cutoff; window floor: a teacher with an event 40 days ago and one 2 days ago gets `windowStart` = 2 days ago; a token whose event predates `paymentsResumedAt` uses the floor's earliest event (or the token's event if none); a forced throw after the consume (inject via a test seam the service already exposes, or by holding a conflicting lock to provoke 55P03) leaves the token usable; GET of the page performs no pause (component: nothing posts on mount); passkey DELETE while paused → 409 `PASSKEY_REMOVAL_PAUSED`; not paused → unchanged behaviour.
- [ ] **Step 2–4:** Red, implement, green.
- [ ] **Step 5:** Mutations: consume outside the transaction; drop the cutoff filter from eligibility; drop the magic-link deletion — record each failure, restore.
- [ ] **Step 6:** Census guards (`FALLBACK_ROUTES`, loading coverage) for the new page; commit.

### Task 5: Paused on every pay surface; overdue clock

**Files:**
- Modify: `src/lib/payment-methods.ts` (return union; `paymentsPausedAt` in `teacherPaymentSelect`)
- Modify: every reader the compiler names — at `136b4d0e` they are `pay/page.tsx`, `bookings/page.tsx`, `class-lifecycle.ts`, `payments.ts`, `payment-reminders.ts`, `email-fallback.ts`, plus `teacherHasPaymentMethods` if it wraps the helper
- Modify: `src/lib/payment-request-copy.ts` (paused copy), `src/lib/email-templates.ts` (no Pay now when paused)
- Modify: `src/services/payment-reminders.ts` (`markOverduePayments` predicate; sweep skips paused)
- Modify: `src/lib/api-error-codes.ts` (`PAYMENTS_PAUSED: 409`); manual remind route/service
- Test: component tests for pay page and bookings list; unit for copy; integration for remind, sweep, overdue

**Interfaces — Produces:**
```ts
export type PaymentMethodsAnswer = { kind: 'paused' } | { kind: 'methods'; methods: PaymentMethod[] };
export function paymentMethodsForTeacher(teacher: TeacherPaymentSources, currency: Currency): PaymentMethodsAnswer;
export const PAYMENTS_PAUSED_COPY = 'Payment details are being checked — please hold off for now.';
```
`paymentMethodsFor` (the pure sources → methods function) keeps its array return.

Overdue predicate: `createdAt < cutoff` AND teacher `paymentsPausedAt: null` AND (`paymentsResumedAt: null` OR `paymentsResumedAt < cutoff`), reaching the teacher through the payment's registration → class → calendar entry (read the existing relation path).

- [ ] **Step 1:** Failing tests: pay page paused → hold-off line, no method panels, no "pay directly"; bookings list paused → hold-off caption, no Pay now; completion while paused → request created with hold-off copy; manual remind paused → 409 `PAYMENTS_PAUSED`; sweep skips a paused teacher's overdue payments but reminds another teacher's; fallback email for a paused teacher's payment request has no Pay now button; overdue: paused teacher's 8-day-old pending stays pending; resumed 2 days ago → 8-day-old pending stays pending; resumed 8 days ago → flips.
- [ ] **Step 2–4:** Red, implement, green.
- [ ] **Step 5:** Mutations: drop the paused half of the overdue predicate; drop the resume half; make the helper return `{kind:'methods', methods: []}` when paused — record each failure, restore.
- [ ] **Step 6:** Commit.

### Task 6: Resuming

**Files:**
- Modify: `src/app/api/auth/passkey/authenticate/verify/route.ts` (write `Session.passkeyCredentialId`; extend `createSession` with an optional credential id)
- Create: `src/lib/payout-fingerprint.ts` (server-only), `src/services/payout-resume.ts` (`readResumeReview`, `resumePayments`)
- Create: `src/app/api/teachers/[id]/payments-resume/route.ts`
- Create: `src/app/(teacher)/settings/resume-payments/page.tsx` (+ client confirm component), loading/fallback per census guards
- Modify: schedule home (`src/app/(teacher)/schedule/(overview)/page.tsx`) — "Payments are paused" card linking there
- Modify: `src/lib/api-error-codes.ts` (`PASSKEY_REQUIRED: 403`, `PAYOUT_DETAILS_CHANGED: 409`)
- Modify: `docs/technical-architecture.md` (Recent authentication: passkey session column, the paused passkey-DELETE refusal, this flow), `docs/lock-order.md` (resume site)
- Test: integration for the route and service; component for the page and card

**Interfaces — Consumes:** Task 4's `PAUSE_PASSKEY_LOOKBACK_DAYS`; Task 5's `PaymentMethodsAnswer`.
**Produces:**
```ts
export const PAUSE_PASSKEY_FALLBACK_DAYS = 14;
export function payoutFingerprint(t: { paymentLink: string | null; bankAccounts: readonly StoredBankAccount[] }): string; // sha256 over a canonical, currency-sorted serialisation of every stored column
export function readResumeReview(db, teacherId, sessionId, now?): Promise<ResumeReview | null>; // null when not paused
export function resumePayments(db, input: { teacherId: string; sessionId: string; fingerprint: string; now?: Date }):
  Promise<{ status: 'resumed' } | { status: 'not_paused' } | { status: 'passkey_required' } | { status: 'details_changed' } | { status: 'teacher_gone' }>;
```
`ResumeReview` carries the events since `pauseWindowStart`, outstanding payments created before `paymentsPausedAt` (student name, class title/date, amount, currency, status), payments with `paidAt` or `notChargedAt` in `[pauseWindowStart, paymentsPausedAt]`, the full current details (every account, every currency, and the link), the fingerprint, `passkeyRequired: boolean`, `sessionSatisfiesPasskey: boolean`, `fallbackOpensAt: Date | null`.

Route order (spec §4): ownership → `requireRecentAuth` → not paused → `respondUnchanged` → passkey → transaction (`lockTeacherForNoKeyUpdate`, re-check paused, fingerprint) → success: clear the pause columns, set `paymentsResumedAt`, delete the teacher's pause tokens, insert a `reminder` notification per student with an outstanding payment of this teacher (reuse the reminder copy builder with methods now live) and stamp `reminderSentAt`.

- [ ] **Step 1:** Failing tests: passkey sign-in writes `passkeyCredentialId`, magic link leaves it null; stale session → 403 `RECENT_AUTH_REQUIRED`; not paused → 200 unchanged, and a double-submit after success → 200 unchanged; cutoff set + magic-link session → 403 `PASSKEY_REQUIRED`; cutoff set + session with a passkey created after the cutoff → 403; pre-cutoff passkey session → resumed; cutoff set, 14 days after pause, magic-link session → resumed; cutoff null + magic-link session → resumed; fingerprint mismatch (another currency's account changed after viewing) → 409 `PAYOUT_DETAILS_CHANGED`; success deletes tokens (an old link then answers `PAUSE_LINK_INVALID`) and notifies each student with an outstanding payment once; review lists bounded at both ends (an event before `pauseWindowStart`, a `paidAt` after the pause, a payment created after the pause — all excluded); review shows every currency's account in full; lock: holding a bank save's lock on another connection parks the resume; page renders the card on the schedule only while paused.
- [ ] **Step 2–4:** Red, implement, green.
- [ ] **Step 5:** Mutations: drop the `createdAt < cutoff` check (expect the post-cutoff-passkey test red); drop the fallback date check (expect the 14-day test red); fingerprint over current currency only (expect the multi-currency test red) — record, restore.
- [ ] **Step 6:** Docs; census guards; commit.

### Task order

Load-bearing: 1 before everything (schema); 2 before 3 (event ids); 4 before 6 (window, constants); 5 before 6 (union type, resume notification copy). Run sequentially.

### Finish

`pnpm run verify` (worktree app up), `pnpm run build`, and the Playwright suite for any e2e touching the pay page, bookings list, schedule home, or settings profile.
