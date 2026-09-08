# Plan — surface consumeTokenRow's discarded sibling-purge count (#506)

No separate design doc: one file, one additive log line, one reasonable
design once the premise below is corrected. Single task, so per the
`solve-issue` skill's §5 there is no whole-branch review — the task diff *is*
the branch.

## Premise verification — the issue is right about the gap and wrong about the reason

**Confirmed:** `src/lib/auth/magic-link.ts:94` discards `{count}`:

```ts
await db.magicLinkToken.deleteMany({ where: { email: row.email } });
```

The purge is the security property #506 says it is, and "not a live defect
today" is correct. Three further things are not.

### 1. The named failure mode is already held by a database CHECK constraint

#506 hypothesises "a future change to how `email` is normalized/cased". That
change cannot land silently. `prisma/migrations/20260807173228_email_lowercase_checks/migration.sql`
adds, alongside three siblings:

```sql
ALTER TABLE "MagicLinkToken" ADD CONSTRAINT "MagicLinkToken_email_lowercase_check"
  CHECK (email = lower(email));
```

A mint storing a mixed-case address fails the INSERT. Independently, `row` is
a **stored** row — `verifyMagicLinkToken` reads it with
`findUnique({ where: { tokenHash } })` and hands the record straight to
`consumeTokenRow`, and `handoff.ts` does the same at its two call sites — so
`row.email` is a constrained value being matched against a constrained
column. This is the #170 normalisation regime (`src/lib/schemas.ts:55-97`:
`emailField` at HTTP ingress, the CHECK constraints for writers that bypass
Zod, `requireNormalised` as the assertion for a ninth caller). #506 does not
mention it.

### 2. The issue's suggested shape cannot detect the defect it is written for

```ts
const siblingCount = await db.magicLinkToken.count({ where: { email: row.email } });
const purged = await db.magicLinkToken.deleteMany({ where: { email: row.email } });
if (purged.count !== siblingCount) { /* warn */ }
```

Both statements evaluate **the same predicate**. A defect in it moves both
sides identically, the comparison stays equal, and the guard stays silent
while stale tokens live — the exact outcome it was written to catch.

#506 calls this "the same technique #505 used for its `expectedReaps`".
Structurally it is the opposite: `handoff.ts:161` derives its expected count
**in JavaScript from a prior snapshot** —
`live.filter((c) => c.handoffAttempts + 1 >= HANDOFF_MAX_ATTEMPTS).length` —
against a delete whose predicate is
`{ id: { in: ids }, handoffAttempts: { gte: HANDOFF_MAX_ATTEMPTS } }`. Two
independent derivations of one quantity, which is why that one can diverge
and this one cannot.

### 3. Its only reachable divergence is a race on a supported flow

`generateMagicLinkToken`'s docblock states that a resend deliberately mints a
second live token and that the first must keep working. A resend landing
between the `count` and the `deleteMany` gives `purged.count = siblingCount + 1`
— a warning on correct behaviour. This repo has already been bitten by that
assumption once: commit `9c76c191` records a test asserted "provably inert"
that fired a real unmocked `log.warn` once the local database accumulated
rows.

### 4. A code-change regression is already caught, at CI time

`magic-link.test.ts:98-109` ("invalidates every other live token for that
address on a successful sign-in") ends on
`expect(await db.magicLinkToken.count({ where: { email } })).toBe(0)` — an
independent post-condition on the address the *test* owns, not on any value
the function derived. Narrow the purge predicate and that assertion reddens.

**Conclusion.** Completeness is held twice already, at the two levels stronger
than a runtime log. What is genuinely absent is the number itself.

## Decision: log the count as an observation, never as an assertion

The count's value is not "did the purge work" but **how many rows the purge
took**. The purge filters on `email` alone, so that is every row for the
address the daily sweep has not yet collected: expired ones included, and
`signup-ticket.ts`'s hour-long `*_profile_pending` tickets alongside sign-in
links. It is bounded by `cleanupExpiredAuth`'s daily cadence — which is what
the pre-existing docblock at `magic-link.ts:90-94` already says bounds this
table — and it is only the subset THIS call won, since concurrent consumptions
split the rows. Nothing else reports per-address accumulation in that table.

> This paragraph originally claimed the count measured *surplus live links*
> and that a large value meant "the rate limit leaked or the address is being
> bombed". Four PR reviewers found that false, and found it contradicting the
> docblock five lines above the code it described. The decision below survived
> the correction; its justification did not, so the paragraph is replaced
> rather than annotated in the code. PR #508's body carries the full
> before-and-after.

**Level: `log.info`, not `warn`.** A non-zero purge is ordinary — every
resend-then-click produces one. `warn` in this codebase means "visible without
paging anyone" for a *benign anomaly* (`waitlist-reconciliation.ts:806`, and
#505's three guards); this is not an anomaly at all. `info` matches
`waitlist-retention.ts:539` and `room-archive.ts:184`, which report what a
routine operation did.

**Gated on `> 0`.** The common path is one link, one click, zero siblings, and
an unconditional line would put a log entry on every sign-in that says
nothing. `waitlist-retention.ts:497` records this codebase correcting exactly
that mistake ("An unconditional `log.info` said 'swept' whatever happened").

**No second query.** Rejected on §§1-3 above, and separately on cost: the
docblock at `magic-link.ts:89-93` justifies the purge being an *unindexed*
scan (`MagicLinkToken` carries `@unique` on `tokenHash` only). A second scan
per sign-in doubles that on the hot path to detect nothing.

**In `consumeTokenRow`, not at its call sites.** All three consumption paths
(`verifyMagicLinkToken`, `handoff.ts:42`, `handoff.ts:197`) go through it, and
the return type stays `boolean` — no caller wants the count, and widening it
for none of them is speculative.

## Task 1 (only task) — the log line and its two guards

### Files

| Path | Change |
|---|---|
| `src/lib/auth/magic-link.ts` | Capture the purge result, log when non-zero, comment |
| `src/lib/auth/magic-link.test.ts` | Cases for the log's payload and silence, plus one pinning the purge's reach |

### Behaviour

`consumeTokenRow` binds the purge's result and, when `count > 0`, emits one
`log.info` carrying that count. Everything else — the ordering of the
single-use delete, the expiry check, the `boolean` return — is unchanged.

`@/lib/log` is server-only pino. Safe here: four files in `src/lib/auth/`
already import it (`handoff.ts`, `passkey.ts`, `signup-ticket.ts`,
`profile-authorization.ts`), all re-exported through the same `index.ts`
barrel, and no `'use client'` file imports this module — the client-side
matches on "magic-link" are `fetch('/api/auth/magic-link/…')` URL strings.

### The comment

Per CLAUDE.md *Comment Discipline*, it annotates only this code, states what
is true now, and carries no prose count or roster. It must make two things
survive a future reader:

1. the number is an **observation**, and what it counts — rows the daily sweep
   has not taken, of any purpose and any expiry state, and only those this
   call won;
2. why it is **not** a completeness check — comparing it against a same-
   predicate `count()` would compare the predicate to itself. Without this,
   #506 gets re-filed and re-implemented in the shape that cannot work.

It keeps neither the `email = lower(email)` CHECK (owned by
`docs/data-model.md`'s "Email is lowercase everywhere") nor a claim about
`row` being a stored row (untetherable — the parameter is structural). The
reflexive-predicate argument replaces both: `row.email` was read out of the
column being matched.

### Tests

Addresses are `Date.now()`-suffixed but keep the `@example.com` domain the
file's `afterEach` sweeps (line 19-24). In a whole-file run the suffix is
redundant — every test before this block sweeps every `@example.com` row on
its way out. It earns its place in a **filtered** run, where those sweeps
never happen and a leftover row sharing a fixed address would break the
negative these cases assert.

1. **Fires, with the right count.** Mint three, consume one, assert
   `{ purged: 2, purpose: 'sign_in' }`. The count assertion is load-bearing —
   `objectContaining({})` matches any object and verifies nothing (#505's own
   review, item 3).
2. **Counts un-swept rows, not live ones**, and pins the guard's near
   boundary: an expired sibling plus a live one, consume the live one, assert
   `{ purged: 1, … }`.
3. **Names the consumed row's purpose** — consume a `teacher_profile_pending`
   ticket, so the payload's `purpose` field asserts a value.
4. **Stays silent with no siblings.** Assert `log.info` was not called
   (strict, matching `handoff.test.ts:428`).

Plus, in the `verifyMagicLinkToken` block, a case pinning the purge's **reach**
against the columns below — not every column on the table (`handoffAttempts`
defaults to 0 on every row a test can mint, so a narrowing on it survives; the
motive for writing one is thin, and it is left unpinned deliberately).

`vi.spyOn(log, 'info').mockImplementation(() => undefined)` with
`afterEach(() => vi.restoreAllMocks())`, matching `handoff.test.ts`.

### Prove every guard bites (§3 — required, not optional)

Per mutation: apply, run, record the exact failure, restore, re-run green.

| Mutation | Must redden |
|---|---|
| `purged.count > 0` → `> 1` | the boundary case (2) |
| `purged.count > 0` → `>= 0` | the silence case (4) |
| `{ purged: purged.count }` → `{ purged: 0 }` | cases 1 and 2 |
| `purpose: row.purpose` → `'sign_in'` | the purpose case (3) |
| purge `where` + `purpose` / `originBrowserHash` / `handoffCode` / `redirectTo` | the reach case |
| purge `where` + `createdAt: { lte: row.createdAt }` (older rows only) | the reach case |
| purge `where` + `expiresAt: { gt: now }` | the boundary case (2) |

The count mutation is what separates "a log line fired" from "the right number
reached it".

## Verification

`magic-link.test.ts` is in `SWEEP_TESTS` (`vitest.tiers.ts:16`), so it runs in
the serial `unit-sweeps` project against `DATABASE_URL_TEST` — **not** the
`:3000` dev server. It therefore runs locally in this worktree, unlike the
`integration` tier.

```
npx vitest run --project unit-sweeps src/lib/auth/magic-link.test.ts
npm run typecheck && npm run lint
```

The `integration` and e2e tiers cannot run from a worktree (no `:3000`, no dev
database); CI is the signal for those, cited by run in the PR body. This
branch touches no file under `tests/integration/`.

## Out of scope

- **#506 is not closed by widening `consumeTokenRow`'s return type.** No
  caller wants the count.
- **No second query, no post-condition assertion** — §§1-4 above.
- **The `MagicLinkToken_email_lowercase_check` constraint is not re-pinned
  here.** It is #170's, it is live, and a test asserting it belongs beside
  that regime rather than in a logging change.
- **#504 is unaffected** — its three guards in `handoff.ts` are untouched.
