# Sweep tests assert through a scoped client

**Issue:** #251: `autoCompleteClasses` sweeps globally, and a test asserts its
count is zero, so any fixture dated in the past can redden another file
**Date:** 2026-09-22

## The problem, stated after measuring it

The issue names one assertion, `class-transitions.test.ts`'s
`expect(completed).toBe(0)`. The mechanism is real and I reproduced it in this
worktree's own test database, `ethical_yoga_test_partitioned_marinating_chipmunk`:

| State | Result of `vitest run --project unit-sweeps src/services/class-transitions.test.ts` |
|---|---|
| baseline | 16 passed |
| one planted `in_progress` class dated `2026-06-01`, belonging to a teacher the file never created | **1 failed, 15 passed**: `AssertionError: expected 1 to be +0` on 'does not complete a class rescheduled after the sweep read it' |
| immediately re-run, nothing touched | 16 passed. The sweep completed the planted row, so the debris cleaned itself up |

The part of the premise that held: the sweep is unscoped
(`class-transitions.ts`, `autoCompleteClasses`'s `class.findMany` filters on
`status` and `cancelledAt` only) and the assertion reads its global return value.

**Since the issue was filed.** #321 moved this file into `SWEEP_TESTS`
(`vitest.tiers.ts`), the serial `unit-sweeps` tier. That removed interference
from sibling files running *at the same time*. It did nothing about rows that
*earlier* runs left behind, which is this issue's mechanism. No setup file
clears them (`grep -n "TRUNCATE\|deleteMany" tests/setup/*.ts` returns nothing).

**Where the premise was incomplete: the scope.** The issue expected the pattern
to recur "unlikely to be the only place". It recurs in ten files, and in two
directions. The #453 comment on the issue measured the second direction. It
fails in four ways, not one:

1. **A global count asserted equal to 0 or N.** Stray rows make the test fail
   when it should pass.
2. **A one-shot mocked failure in an oldest-first sweep.**
   `mockResolvedValueOnce` / `mockRejectedValueOnce` lands on whichever row the
   sweep reaches first, and a stray row older than the fixture takes it.
3. **Batch caps and id ordering.** `maxClasses` caps and `00000000-…` ids that
   are supposed to sort first. Stray rows fill the batch or sort ahead of the
   fixture.
4. **`>= 1` / `> 0` counters.** Stray rows make the test pass when it should
   fail, and supply the count a mutated counter no longer produces.

## Census

Re-derive:

```sh
# 1. The sweep set: the scheduler and cron routes are authoritative; the name pattern catches the rest
grep -n "await\|import" src/lib/scheduler.ts src/app/api/cron/*/route.ts
grep -rnE "^export (async )?function (auto|reap|sweep|generate|cleanup|clean|process|send|purge|expire|prune|run|reconcile|deliver|retry|flush|delete)[A-Za-z]*" src/services src/lib | grep -v '\.test\.ts'
# 2. Test files that CALL one (then keep only real `name(` calls, not comment mentions)
grep -rlE "\b(autoTransitionToInProgress|autoCancelClasses|autoCompleteClasses|markOverduePayments|sendPaymentReminders|processPaymentReminders|cleanupExpiredAuth|cleanupExpiredTokens|processEmailFallback|getUnreadForEmailFallback|generateClassInstances|generateStudioClassInstances|reapClosedWaitlistEntries|reconcileWaitlists|runWaitlistReconciliationTick|auditTeacherTimezones)\b" src tests | grep -E '\.test\.|\.spec\.'
```

The unscoped sweeps are `autoTransitionToInProgress`, `autoCancelClasses`,
`autoCompleteClasses`, `generateStudioClassInstances`, `processEmailFallback`,
`processPaymentReminders` (with `markOverduePayments` and
`sendPaymentReminders`), `cleanupExpiredAuth`, `cleanupExpiredTokens`,
`reconcileWaitlists` / `runWaitlistReconciliationTick`,
`reapClosedWaitlistEntries` and `auditTeacherTimezones`.
`generateClassInstances` takes a `teacherId`, and its tests pass one.

Callers outside `SWEEP_TESTS`: only `timezone-audit.test.ts`. It sits in the
parallel `unit` tier because `auditTeacherTimezones` only reads, and the tier
criterion is "writes rows it was never handed".

| # | Site | Sweep | Assertion | Way |
|---|---|---|---|---|
| 1 | `class-transitions.test.ts` 'does not transition … rescheduled' | autoTransitionToInProgress | `transitioned` `toBe(0)` | 1 |
| 2 | `class-transitions.test.ts` lock-race test | autoTransitionToInProgress | `await sweeping` `toBe(0)` | 1 |
| 3 | `class-transitions.test.ts` 'closes the waitlist when it starts a class' | autoTransitionToInProgress | `transitioned` `>= 1` | 4 |
| 4 | `class-transitions.test.ts` autoCancel race | autoCancelClasses | `cancelledCount` `toBe(0)` | 1 |
| 5 | `class-transitions.test.ts` 'does not complete … rescheduled' | autoCompleteClasses | `completed` `toBe(0)` | 1 |
| 6 | `magic-link.test.ts` cleanup | cleanupExpiredTokens | `deleted` `toBe(1)` | 1 |
| 7 | `magic-link.test.ts` 'returns 0 when no tokens are expired' | cleanupExpiredTokens | `deleted` `toBe(0)` | 1 |
| 8–9 | `auth-cleanup.test.ts` | cleanupExpiredAuth | `sessions` / `magicLinkTokens` `>= 1` | 4 |
| 10 | `email-fallback.test.ts` overlapping sweeps | processEmailFallback | `outerSent` `toBe(0)`. `markOne` counts `already-claimed` as sent, so a stray row whose recipient is missing or opted out counts | 1 |
| 11–12 | `email-fallback.test.ts` send failure (resolved error / rejection) | processEmailFallback | one-shot mock, then `emailSent === false` | 2 |
| 13–14 | `email-fallback.test.ts` unreleasable / unclaimable | processEmailFallback | `/1 of 1 sends failed/`; `claimAttempts` `toBe(1)` | 1, 2 |
| 15–17 | `payment-reminders.test.ts` | sendPaymentReminders / processPaymentReminders | `first`, `markedOverdue`, `reminded` `>= 1` | 4 |
| 18–21 | `waitlist-reconciliation.test.ts` streak tests | reconcileWaitlists | `allTransientTicks` `toBe(0)` / `< 5`, `failuresByClass.size > 0` | 4 |
| 22 | `waitlist-reconciliation.test.ts` | runWaitlistReconciliationTick | `candidates` `>= 0`, which is true of every number and so checks nothing | none |
| 23 | `waitlist-retention.test.ts` two-entry reap | reapClosedWaitlistEntries | `deleted >= 2`, **made safe** by the whole-table bracket `before - after === deleted` beside it | none |
| 24 | `waitlist-retention.test.ts` held-lock test | reap | `failed` `toBe(1)` | 1 |
| 25–26 | `waitlist-retention.test.ts` `maxClasses: 50`, run twice | reap | `cappedOut false`, `failed 0`, second run `0/0/false`; `classes >= 2` | 3, 4 |
| 27 | `waitlist-retention.test.ts` `maxClasses: 1` ordering tests | reap | the `00000000-…` fixture ids must sort first | 3 |
| 28–30 | `timezone-audit.test.ts` | auditTeacherTimezones | `checked >= 1`, `teachers >= 2`; two tests expect the sweep to resolve, and any live stray teacher with a bad zone makes it throw | 4, 1 |

Lower grade. None of these asserts a count:
`studio-class-generator.test.ts`'s `await generateStudioClassInstances(...)`
calls reject when any stray template anywhere fails non-transiently, because the
sweep rethrows after the loop. Its `sweepSettled === false` after 300 ms is a
timing premise that a sweep slowed by stray rows can also satisfy.

A finding the census surfaced beside the debris: **`autoCancelClasses`'s and
`autoCompleteClasses`'s counters have no positive assertion anywhere.** Their
only return-value checks are `toBe(0)`, so deleting `cancelled++` or
`completed++` survives the file today, with or without stray rows.

Assertions already safe, and why: every reconciliation summary check except the
five above, since those checks are `toContain` on a fixture id. The retention
eligibility and cap checks that the test measures itself. All of
`notifications.test.ts`, which filters to `recipientId` first. All of
`email-fallback.consent.test.ts`, whose failure injection is routed by
recipient rather than `Once` and is the pattern hits 11–12 lacked. The
payment-reminders `void repeats`, a deliberate non-assertion. The
class-generator tests, which pass `teacherId`.

## Design

### A scoped client, not a scoped service

`tests/scoped-sweep.ts` exports one function:

```ts
const scoped = scopeSweep(prisma, {
  Class: { id: { in: [cls.id] } },
});
const completed = await autoCompleteClasses(scoped.db, NOW);
expect(scoped.rowsRead('Class')).toBeGreaterThan(0); // the fixture was a candidate
expect(completed).toBe(0);
```

- `scoped.db` is `prisma.$extends(...)` cast once to `PrismaClient`. Per named
  model, it `AND`s the given filter into the `where` of the bulk operations:
  `findMany`, `findFirst`, `count`, `groupBy`, `aggregate`, `updateMany` and
  `deleteMany`. Single-row operations (`findUnique`, `update`, `delete`) pass
  through, because they are keyed by an id the sweep already chose from a
  scoped read. Unnamed models pass through too.
- `scoped.rowsRead(model)` returns the rows the scoped `findMany`/`findFirst`/
  `groupBy` reads returned, summed (`groupBy` because `timezone-audit.ts` and
  `waitlist-retention.ts` read their candidates through it). A `toBe(0)` assertion with no presence check stays
  green when the fixture falls out of the sweep's own predicate, because the
  scope then filters an empty set. Every zero assertion therefore pairs with it.
- Measured before design: a query extension fires inside an interactive
  `$transaction`, inside a batch `$transaction` and outside both. That covers
  every sweep that claims rows inside a transaction. None of the ten sweep
  modules issues raw SQL (`grep -ln "queryRaw\|executeRaw\|Prisma.sql"` over
  them is empty), so no read escapes the extension. The per-unit helpers they
  call that do use raw SQL (`entry-generation.ts`, `waitlist.ts`) are checked
  during the build: each must be keyed by an id that came from a scoped read.
- The four existing race hooks (`racing` ×3, `overlapping`) are built on
  `scoped.db` instead of `prisma`, so scope and race compose. Those hooks key on
  the shape of the read. The scope's `AND` wraps `where`, so each hook's shape
  test must read the original args. The build verifies this per hook, because a
  hook that stops firing leaves `hookCalls === 1` red, not green.

Rejected alternatives: a `teacherId` parameter on each production sweep (the
issue's option 3) puts test-only surface in every unscoped sweep's signature.
Clearing tables per file makes counts exact, but it runs destructive deletes
against a database other main-checkout sessions share
(`docs/test-database.md` §5). Rewriting each file's own hook is ten
hand-written copies of one filter, each owing its own presence check.

### Per hit

| Hits | Fix |
|---|---|
| 1, 2, 4, 5 | scoped `class`, plus a `rowsRead` presence check; `toBe(0)` stays |
| 3 | scoped `class`; `>= 1` becomes `toBe(1)` |
| new | a positive `toBe(1)` for `autoCancelClasses` and `autoCompleteClasses` on a fixture that should be processed, which closes the counter gap |
| 6, 7 | scoped `magicLinkToken` by the fixture's email; the counts stay exact |
| 8–9 | scoped `session` and `magicLinkToken`; `>= 1` becomes `toBe(1)` |
| 10–14 | scoped `notification` by fixture id; the one-shot mocks then can only reach the fixture, and "1 of 1" / `claimAttempts === 1` become true by construction |
| 15–17 | scoped `payment`; exact counts |
| 18–21 | id membership on the summary's own fields (`failuresByClass.has(contended.id)`, `reconciledClassIds` containing the fixture) rather than scoping, because the summary already carries ids |
| 22 | replaced with an assertion that can fail, or deleted if nothing meaningful fits |
| 24–27 | scoped `class` / `waitlistEntry` for the reap's `groupBy` and delete; the cap and ordering then run over fixtures only |
| 28–30 | scoped `teacher` by fixture ids; exact counts; the "resolves" tests stop depending on every live teacher |
| studio generator | scoped `scheduleRule` / `studioClassTemplate` read, so a stray broken template cannot reject the fixture's call; the 300 ms timing premise is left as is |

Hit 23 is unchanged: its bracket is the right shape already.

### Docs

`docs/test-database.md` gets a subsection under §2's `SWEEP_TESTS` paragraph:
serialising a file protects it from files running at the same time, not from
rows earlier runs left behind, so a sweep test asserts the sweep's results
through `scopeSweep`. `AGENTS.md`'s existing `SWEEP_TESTS` line gains a clause
pointing there. There is no compiler check for the convention; the doc is its
owner.

## Proof, per file

For every file touched, recorded in the plan with exact error text:

1. **Coupling shown on the old code.** Plant a stray row that qualifies for the
   sweep, belonging to a teacher the file never created, and show the
   unmodified assertion goes red (way 1–3) or stays green under a counter
   mutation (way 4).
2. **Decoupled on the new code.** Same stray row; the new assertion is green.
3. **Still bites.** With no stray row, mutate the counter or the service's own
   predicate and show the new assertion goes red. Then drop the scope and show
   the presence check or the exact count catches it.

The planting is scratch work run against the worktree's own database and is not
committed. A committed stray-row suite was considered and rejected, because it
would plant stray rows in the serial tier on every run.

## Out of scope

- **The accumulation itself.** The #453 comment's 3127 → 3245 `Teacher` rows in
  one day, and the `gdpr-lock-order.test.ts` guard whose red depended on one
  stray row. That test is not a sweep test, and its fix is that a guard builds
  the row it needs. Filing it is decided at PR time (§7 of the solve-issue
  skill).
- **Timing premises** that a slow sweep satisfies for the wrong reason
  (studio-class-generator, 300 ms). That is a different failure mode from
  counting stray rows.
