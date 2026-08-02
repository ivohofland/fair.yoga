# An income tier is 1–5 — in the type, and in the database

**Date:** 2026-08-02
**Status:** Approved (issue #39; design agreed with Ivo — DB CHECK constraints
alongside the TypeScript type, the boundary conversion degrades with a
`log.warn` rather than throwing, and both halves of the issue ship in one PR)

## Problem

Tiers are bare `number`/`Int` everywhere. `TIER_RATIOS` is
`Record<number, number>`, `studentTiers` is `number[]`, and the Prisma columns
are `Int` with no constraint. The only thing standing between a bad value and
the pricing engine is a runtime throw at `src/services/pricing.ts:126`:

```ts
const ratio = TIER_RATIOS[tier];
if (ratio === undefined) {
  throw new Error(`Invalid tier: ${tier}. Must be 1-5.`);
}
```

`estimateTierPrices` runs on two **public SSR pages** — a teacher's booking
page (`(public)/[slug]/page.tsx`) and a class booking page
(`(public)/[slug]/book/[classId]/page.tsx`) — and feeds them
`registrations.map(r => r.tierAtBooking)` straight from the database. One
out-of-range row takes the teacher's storefront down with a 500.

### Three inherited claims, checked

**"Caught only by the engine's runtime throw" is half right.** The API path
*is* bounded: `updateStudentSchema` (`src/lib/schemas.ts:139`) has
`z.number().int().min(1).max(5)`, and it is the only route that accepts a
client-supplied tier. `createStudentSchema` has no `incomeTier` field at all,
and every other write copies `student.incomeTier` or the constant
`DEFAULT_INCOME_TIER`. So the throw is a backstop, not the sole guard.

**But the hole is real, and it is already documented in the repo.**
`tests/integration/account-api.test.ts` writes `tierAtBooking: 0` directly
through Prisma at `:302` to force a failure, and its comment says why it can:

> `tierAtBooking` is a bare Int with no DB constraint, so an out-of-range value
> is writable today.

That comment goes on to anticipate this issue by name — "#39 is about making an
out-of-range tier unrepresentable — when that lands, this setup stops compiling
or stops throwing, and this test should be re-pointed at another failure inside
`deleteTeacherAccount` rather than deleted." Re-pointing it is part of this
work. §8 covers it.

**"The `studentPrices[i]!` pattern disappears" does not survive checking.**
Under `noUncheckedIndexedAccess`, `students[i]` is still `T | undefined`;
restructuring the result removes nothing on its own. What removes the
assertions is *iterating* the paired result instead of walking two arrays with
a shared index — see §6. The issue names the two sites in `tier-estimates.ts`,
and those are precisely the two that **survive**.

### The census

Every number below was measured, and the arithmetic is written out so a reader
can re-derive it rather than trust it.

**Assertions on the pricing result, non-test code — 6:**

| Site | Expression |
|---|---|
| `src/lib/tier-estimates.ts:43` | `pricing.studentPrices[…]!` |
| `src/lib/tier-estimates.ts:87` | `pricing.studentPrices[…]!` |
| `src/services/class-lifecycle.ts:199` | `pricing.studentPrices[i]!` |
| `src/services/class-lifecycle.ts:199` | `pricing.studentTierRatios[i]!` |
| `src/services/class-lifecycle.ts:202` | `pricing.studentPrices[i]!` |
| `src/services/class-lifecycle.ts:213` | `pricing.studentPrices[i]!` |

A seventh access, `src/components/class/pricing-preview.tsx:51`, is the careful
one — it tests for `undefined` instead of asserting.

**Everything else, measured:**

- **2** Prisma columns: `Student.incomeTier` (`schema.prisma:160`, `@default(3)`)
  and `Registration.tierAtBooking` (`schema.prisma:443`). Both bare `Int`.
- **0** rows in the dev database violate the proposed constraint; the distinct
  values are exactly `[1,2,3,4,5]` in both columns. The migration needs no
  data-cleanup step. (This also confirms the integration test cleans up after
  itself.)
- **1** out-of-range write in the whole repo: `account-api.test.ts:302`.
- **0** tests assert the throw fires. The guard this issue is built around is
  itself unverified.
- **4** non-test callers of `calculateClassPricing`: `pricing-preview.tsx:32`,
  `tier-estimates.ts:34`, `tier-estimates.ts:79`, `class-lifecycle.ts:176`.
- **2** hand-rolled `for (let tier = 1; tier <= 5; tier++)` loops:
  `pricing-preview.tsx:43`, `pricing-breakdown.tsx:21`.
- **5** `TIER_RATIOS[n]!` accesses in `pricing-preview-table.tsx:64–68`.

## Design

### 1. The type and the ratios live in `src/lib/tiers.ts`

`src/lib/tiers.ts` has **zero imports** today and is already imported by two
`'use client'` components (`tier-form.tsx`, `booking-flow.tsx`). It gains:

```ts
export type IncomeTier = 1 | 2 | 3 | 4 | 5;

/** Every tier, in order. Replaces two hand-rolled 1..5 loops. */
export const INCOME_TIERS = [1, 2, 3, 4, 5] as const satisfies readonly IncomeTier[];

/** Income tier ratios. Tier 3 is baseline (1.0). Max spread ~2.08×. */
export const TIER_RATIOS: Record<IncomeTier, number> = {
  1: 0.65, 2: 0.80, 3: 1.00, 4: 1.20, 5: 1.35,
};

export const DEFAULT_INCOME_TIER: IncomeTier = 3;

export function isIncomeTier(n: number): n is IncomeTier {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
}
```

`TIER_RATIOS` **moves here from `src/services/pricing.ts`**. That is not
cosmetic: `pricing-preview-table.tsx` is a `'use client'` component that today
imports `TIER_RATIOS` and `calculateEffectiveTeacherRate` from
`@/services/pricing`, so the whole pricing module is already in the browser
bundle. Moving the constant lets that component import from `@/lib/tiers`
instead, which is the same reasoning that put `ECONOMIC_FIELDS` in
`src/lib/class-fields.ts` during #135.

**`tiers.ts` must keep its zero-import property.** `isIncomeTier` is pure and
stays here; the *logging* conversion (§4) does not, because importing
`@/lib/log` would drag pino into the browser bundle through two client
components.

### 2. Two CHECK constraints, following the precedent in this repo

Prisma cannot express a range check declaratively, so this is a hand-written
migration — exactly like `prisma/migrations/20260721061528_student_claim_link_check/`,
which adds a CHECK to this same `Student` table with a comment naming the
invariant.

```sql
-- Invariant, DB-enforced: an income tier is one of five discrete bands.
-- TypeScript's IncomeTier stops new code from writing anything else; this
-- stops everything else — a migration, a psql session, a future route.
ALTER TABLE "Student" ADD CONSTRAINT "Student_income_tier_check"
  CHECK ("incomeTier" BETWEEN 1 AND 5);

ALTER TABLE "Registration" ADD CONSTRAINT "Registration_tier_at_booking_check"
  CHECK ("tierAtBooking" BETWEEN 1 AND 5);
```

Because `schema.prisma` itself does not change, `prisma migrate dev` will not
generate this file. Author the migration directory and `migration.sql` by hand
matching the precedent, then run `npx prisma migrate dev` to apply it, and
confirm with `npx prisma migrate status` that nothing is pending. Never edit an
applied migration.

### 3. The engine's lookup becomes total — the throw retires

With `TIER_RATIOS: Record<IncomeTier, number>` and `studentTiers: IncomeTier[]`,
`TIER_RATIOS[tier]` has no `undefined` branch. The per-student
`if (ratio === undefined) throw` at `pricing.ts:126` is deleted, not moved.
That is the issue's stated payoff, delivered literally: the check leaves the hot
path because the type makes it unreachable, and the constraint makes the type
honest.

**This was compiled, not assumed** — the whole design rests on it, and
`noUncheckedIndexedAccess` is on. Under a finite-key `Record`, indexing with a
key of that union type yields `number`; the `| undefined` that flag adds
applies to index *signatures*, not to known keys. The probe was shown able to
fail before being trusted:

```ts
declare const t: IncomeTier;
const ratio: number = TIER_RATIOS[t];   // compiles — the throw is unreachable

declare const loose: Record<number, number>;
declare const n: number;
const control: number = loose[n];       // errors: 'number | undefined'
```

One error, on the control line only. If the first line had also errored, the
throw could not be deleted and this design would need a different §3.

### 4. `toIncomeTier` converts at the read boundary, and degrades rather than throws

Prisma types both columns as `number`, so every read that feeds a computation
or a tier-indexed display needs one conversion. It lives in a server-only
module — `src/lib/tiers.server.ts` — so `tiers.ts` keeps its zero-import
property:

```ts
import { log } from '@/lib/log';
import { DEFAULT_INCOME_TIER, isIncomeTier, type IncomeTier } from '@/lib/tiers';

/**
 * Narrow a tier read from the database. Both columns carry a CHECK constraint
 * (see the income_tier_range_check migration), so the fallback is unreachable
 * — it exists so that a bypassed constraint costs one wrong price on one row
 * instead of a 500 on a teacher's public booking page. If this ever warns,
 * the constraint was circumvented and that is the bug to chase.
 */
export function toIncomeTier(n: number): IncomeTier {
  if (isIncomeTier(n)) return n;
  log.warn({ tier: n }, 'income tier outside 1-5; DB constraint bypassed');
  return DEFAULT_INCOME_TIER;
}
```

**The nine conversion sites, across six files.** All are server-side, which
falls out of the code rather than being imposed:

| File | Sites | Feeds |
|---|---|---|
| `src/app/(public)/[slug]/page.tsx` | `:113` | `estimateTierPrices` |
| `src/app/(public)/[slug]/book/[classId]/page.tsx` | `:50`, `:111`, `:115–116`, `:130` | estimates ×3, `BookingFlow` |
| `src/app/(student)/account/tier/page.tsx` | `:30` | `TierForm` |
| `src/app/(teacher)/class/[id]/page.tsx` | `:95` | `PricingBreakdown` |
| `src/components/class/pricing-preview.tsx` | `:30` | `calculateClassPricing` |
| `src/services/class-lifecycle.ts` | `:182` | `calculateClassPricing` |

1 + 4 + 1 + 1 + 1 + 1 = **9**. The two reads on `book/[classId]` at `:115–116`
and `:130` are the same `student.incomeTier`; hoist one conversion and use it
twice rather than converting the same value twice.

### 5. The Zod schema produces `IncomeTier`, and this was verified by compiling it

```ts
incomeTier: z.number().int().refine(isIncomeTier, {
  message: 'Income tier must be 1-5',
}).optional(),
```

In Zod 4, `.refine` with a type predicate narrows the inferred output. This was
**compiled, not assumed** — the same mistake pattern as #136's `Required<T>`,
where three reviewers reasoned from the intuitive reading and were wrong:

- the current shape `z.number().int().min(1).max(5)` fails the probe with
  `Type 'number' is not assignable to type 'IncomeTier'`, so the probe
  discriminates;
- the refined shape passes in **both** directions, so it infers exactly
  `IncomeTier`, not merely something assignable to it.

This types the whole client→wire→DB chain: `TierBody.incomeTier` in
`tier-form.tsx:18` becomes `IncomeTier`, and so does the form's own state. The
`.refine` form is chosen over `z.union([z.literal(1), …])` specifically to keep
the error message, which a union would replace with Zod's literal-mismatch
wording. No test asserts that message today, so this is about the API response
a client sees, not about a test.

### 6. `PricingResult` carries one array of records

```ts
export interface PricedStudent {
  tier: IncomeTier;
  ratio: number;
  price: number;
}

export interface PricingResult {
  effectiveTeacherRate: number;
  totalCost: number;
  studentCount: number;
  /** One entry per charged student, in the same order as the input tiers. */
  students: ReadonlyArray<PricedStudent>;
}
```

The win is at the call sites, and only where the caller stops indexing:

```ts
// class-lifecycle.ts today — 5 assertions, two arrays walked by a shared index
for (let i = 0; i < chargedRegistrations.length; i++) {
  const reg = chargedRegistrations[i]!;
  data: { price: pricing.studentPrices[i]!, tierRatio: pricing.studentTierRatios[i]! }
  data: { amount: pricing.studentPrices[i]! }
}

// after — 0 assertions on the pricing result
for (const [i, s] of pricing.students.entries()) {
  const reg = chargedRegistrations[i]!;          // on the caller's own array
  data: { price: s.price, tierRatio: s.ratio }   // arrive as one record
  data: { amount: s.price }
}
```

**4 of the 6 assertions go, all of them in the billing path.** That is where the
stake is: `studentPrices[i]` and `chargedRegistrations[i]` are held in
correspondence by convention alone, and a skew there bills a student another
student's price.

**The 2 in `tier-estimates.ts` remain**, as `pricing.students[n]!.price`. No
type can prove an index is in range, and the alternatives — a generic payload
threaded through the engine, or reordering the input so the viewer lands last —
either complicate the core signature for one assertion or shift which student
receives the leftover cent in the largest-remainder allocation. Both are worse
than one honest `!`. Those two sites read only a price, never a paired ratio,
so they carry no skew risk to remove.

`pricing-preview.tsx:41–56` then simplifies: its index-matching loop over
`studentTiers` becomes a group-by over `pricing.students`, and the
`TIER_RATIOS[tier]`/`price` undefined checks at `:50–52` disappear because both
values are already on the record.

### 7. What deliberately stays `number`

Six read sites keep `number` — three of each kind — and this is a decision
rather than an oversight:

- **Column-to-column copies (3)** — `api/registrations/route.ts:162`,
  `waitlist.ts:347`, `waitlist.ts:446` write `tierAtBooking` from
  `student.incomeTier`. The value never enters a computation, and both columns
  now carry the constraint, so narrowing would add a conversion and prove
  nothing.
- **JSON payloads (3)** — `api/students/[id]/route.ts:55` (response body) and
  `gdpr.ts:67`, `gdpr.ts:95` (export payloads) serialise the value; a literal
  union buys nothing across a JSON boundary.

One *parameter* stays `number` alongside them, and it is not one of the six
reads: `activateRegistration`'s `tierAtBooking: number` (`waitlist.ts:52`),
which is fed only by those column-to-column copies.

`booking-flow.tsx:185`'s `TIER_INFO[tier - 1]!` also stays. TypeScript cannot
prove `tier - 1` is `0..4` even when `tier` is `IncomeTier`, so removing that
assertion needs a second lookup structure keyed by tier — a second source of
truth for display copy, which is a worse trade than one assertion.

### 8. Re-pointing `account-api.test.ts`

Its PARTIAL_ERASURE test injects a failure by writing `tierAtBooking: 0`, so
that `deleteTeacherAccount`'s completion of in-progress classes throws inside
the pricing engine. After this change the write is rejected by the constraint
and the engine no longer throws — so the test must fail differently, not stop
failing.

Its own comment names the requirement: re-point it at another failure inside
`deleteTeacherAccount` rather than delete it. "It failing loudly is the point;
silently ceasing to cover the branch is the thing to avoid." Whichever
replacement is chosen must be shown to actually produce PARTIAL_ERASURE — by
running the test and watching it fail without the injection, not by reasoning
that it should.

**This test lives in the `integration` project, which cannot be run in full**
(one of its files is IP rate-limited). `account-api.test.ts` is runnable by
explicit path, and this change *requires* running it — a re-pointed failure
injection that was never executed is exactly the "verification that could not
have failed" pattern from #138.

## Testing

- **The throw's replacement gets the coverage the throw never had.**
  `isIncomeTier` at both boundaries and outside them: `0`, `1`, `5`, `6`, `3.5`,
  `NaN`, `-1`. `toIncomeTier` returning `DEFAULT_INCOME_TIER` **and** emitting a
  `log.warn` for an out-of-range input — assert the warn, not only the value, or
  the silent-failure half is untested.
- **An integration test proving the constraint bites**: a direct
  `prisma.student.update({ incomeTier: 0 })` must be rejected by the database.
  Without it, the migration is an assertion nobody checked. Same for
  `tierAtBooking`.
- **The engine's existing tests convert mechanically and must assert the same
  numbers.** The largest-remainder cent allocation (`pricing.ts:134–155`) is the
  part a result-shape change can silently break: the invariant is that the
  student prices sum exactly to `totalCost`, and `pricing.test.ts:145–153`
  already pins nine per-student values. Those numbers do not move. If any of
  them changes, the restructure changed behaviour and that is a defect.
- **The pins must be proved to bite.** For each of the two `satisfies`/`Record`
  constructions, temporarily add a sixth tier and record the `tsc` error naming
  it, then restore. A pin that compiles but cannot fail certifies nothing.
- **No rendered output changes.** Prices, tier labels, and the pricing preview
  and breakdown tables render identically. That is the reviewable invariant.

## Out of scope

- **Tier labels and copy** — `TIER_INFO` keeps its current wording. The
  roadmap's open question about tier naming is a UX copy decision, not this.
- **Widening the constraint to a Postgres enum or lookup table.** A CHECK on an
  `Int` matches how the column is already read and written; a domain change
  would touch every query.
- **`StudioClass`** has no tier at all — studio classes are disconnected from
  students by design (`docs/data-model.md`).

## Risks

- **The migration cannot be edited once applied.** The dev database is clean
  (0 violating rows, verified), but production or another environment may not
  be. The migration should be preceded by the same count query, and if any row
  violates, that is a data question to answer before the constraint lands — not
  something to clean up silently inside the migration.
- **A restructure that quietly changes a price.** The cent-allocation logic is
  the one place where reordering or re-deriving could shift a value without any
  test noticing, because most tests assert totals. `pricing.test.ts`'s
  per-student assertions are the guard; they must survive untouched.
- **`tiers.ts` gaining a server import.** Adding anything to `tiers.ts` that
  transitively reaches `@/lib/log` puts pino in the browser bundle through
  `tier-form.tsx` and `booking-flow.tsx`. The split into `tiers.server.ts`
  exists solely to prevent this, and it is worth checking that the built client
  bundle does not grow.
- **Nine conversion sites is nine chances to convert the wrong value.** The
  `book/[classId]` page reads three different tier sources within twenty lines
  — registered tiers, the viewer's own booking tier, and the viewer's profile
  tier — and the ternary at `:114–116` picks between two of them. Converting
  the wrong one there would be invisible to the type system, because all three
  are `number` before and `IncomeTier` after.
