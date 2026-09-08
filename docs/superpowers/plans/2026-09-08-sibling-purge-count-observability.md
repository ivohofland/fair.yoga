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

The count's value is not "did the purge work" but **how many surplus links
existed**. `generateMagicLinkToken`'s docblock puts the bound on live tokens
per address on the caller ("typically a rate limit on the minting route"), and
nothing today reports whether that bound holds. A purge of 20 is evidence the
rate limit leaked or that the address is being bombed. That signal exists
nowhere else.

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
| `src/lib/auth/magic-link.test.ts` | Two cases: fires with the right count; silent with no siblings |

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

1. the number is an **observation**, and what it signals (the minting route's
   rate limit);
2. why it is **not** a completeness check — comparing it against a same-
   predicate `count()` would compare the predicate to itself. Without this,
   #506 gets re-filed and re-implemented in the shape that cannot work.

It points at the sibling test **in this same file** for the completeness pin
rather than restating it.

### Tests

Addresses are `Date.now()`-suffixed but keep the `@example.com` domain the
file's `afterEach` sweeps (line 19-24). The suffix is not decoration: the
silence case asserts a *negative*, so a row surviving a crashed prior run
would fail it, and the `afterEach` only protects within a run.

1. **Fires, with the right count.** Mint three tokens for one address, consume
   one. The single-use delete removes that row, so the purge matches the other
   two: assert `log.info` called with `{ purged: 2 }` and this message. The
   count assertion is the load-bearing half — `objectContaining({})` matches
   any object and verifies nothing (#505's own review, item 3).
2. **Stays silent with no siblings.** Mint one token, consume it. Assert
   `log.info` was not called. Without this, `> 0` → `>= 0` passes every other
   test in the file (#505's own review, item 4: neither new guard was proven
   to stay silent).

`vi.spyOn(log, 'info').mockImplementation(() => undefined)` with
`afterEach(() => vi.restoreAllMocks())`, matching `handoff.test.ts`.

### Prove both guards bite (§3 — required, not optional)

Per mutation: apply, run, record the exact failure, restore, re-run green.

| Mutation | Must redden |
|---|---|
| `purged.count > 0` → `purged.count > 99` | case 1 (fires) |
| `purged.count > 0` → `purged.count >= 0` | case 2 (silent) |
| `{ purged: purged.count }` → `{ purged: 0 }` | case 1's count assertion |

The third is what separates "a log line fired" from "the right number
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
