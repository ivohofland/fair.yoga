# IncomeTier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an out-of-range income tier unrepresentable — in TypeScript and in PostgreSQL — and replace the pricing engine's index-correlated parallel arrays with one array of records.

**Architecture:** A literal union `IncomeTier = 1|2|3|4|5` lives in the zero-import module `src/lib/tiers.ts` alongside the tier ratios, so client components can value-import it. Two hand-written CHECK constraints make the type honest at the database. A server-only `toIncomeTier` narrows values read from Prisma, degrading with a `log.warn` rather than throwing, so no public SSR page can 500 on one bad row. `PricingResult` returns `students: ReadonlyArray<{tier, ratio, price}>` so the tier/ratio/price correspondence is inherent rather than maintained by a shared index.

**Tech Stack:** TypeScript 5 (`strict`, `noUncheckedIndexedAccess`), Next.js 16 App Router, Prisma 6 + PostgreSQL, Zod 4, Vitest.

## Global Constraints

- **No `any`. No type assertions (`as X`) to silence an error. No eslint suppressions.** These are project rules from `CLAUDE.md`, not preferences. Non-null assertions (`!`) are permitted only where this plan explicitly keeps one.
- **Never run `npx vitest run --project integration`** — one file in that project is IP rate-limited and running the whole project trips it. Individual integration files by explicit path are fine and this plan requires two of them.
- **Never restart the dev server on `:3000`.** Ivo restarts it manually.
- **Never `git add -A` or `git add .`** — stage the exact paths each step names.
- **Never edit an applied migration.** If a migration needs changing after `prisma migrate dev` has run it, create a new one.
- **Schema changes require `npx prisma migrate dev`** — never `db push`, never raw SQL applied outside a migration.
- **Every pin and every test must be proved to bite.** For a compile-time pin: break it deliberately, record the exact `tsc` error text, restore. For a test: make it fail deliberately, record the failure, restore. A pin that compiles but cannot fail certifies nothing; a test that passes against the bug proves nothing.
- **Never state a count from a command that could not have produced it.** No `head`/`tail`-limited grep reported as a census. If a claim contains a number, show the arithmetic. When correcting a claim, `grep` the corrected phrase across *every* artifact — source, tests, spec, plan, PR body, GitHub issue — because on five prior branches a correction landed in one place and stood in its twin.
- **Verified starting state (do not re-derive, but do not contradict):** the dev database has **0** rows violating the proposed constraint; distinct values are exactly `[1,2,3,4,5]` in both `Student.incomeTier` and `Registration.tierAtBooking`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/lib/tiers.server.ts` | `toIncomeTier` — the only tier module that may import `@/lib/log`. Server-only by construction. |
| `src/lib/tiers.test.ts` | Unit tests for `isIncomeTier`, `INCOME_TIERS`, `TIER_RATIOS`. |
| `src/lib/tiers.server.test.ts` | Unit tests for `toIncomeTier`, including its `log.warn`. |
| `prisma/migrations/<timestamp>_income_tier_range_check/migration.sql` | Two CHECK constraints. |
| `tests/integration/income-tier-constraint.test.ts` | Proves the constraints reject a direct out-of-range write. |

**Modified:**

| File | Change |
|---|---|
| `src/lib/tiers.ts` | Gains `IncomeTier`, `INCOME_TIERS`, `isIncomeTier`; `TIER_RATIOS` moves in; `DEFAULT_INCOME_TIER` gets an explicit type. **Must keep zero imports.** |
| `src/services/pricing.ts` | `TIER_RATIOS` moves out; `studentTiers: IncomeTier[]`; the throw is deleted; `PricingResult.students` replaces two parallel arrays. |
| `src/services/pricing.test.ts` | Converted to the new result shape; the nine per-student values must not move. |
| `src/lib/tier-estimates.ts` | `registeredTiers`/`viewerTier` become `IncomeTier[]`/`IncomeTier`; 2 assertions remain, now on `students`. |
| `src/lib/tier-estimates.test.ts` | Follows the new result shape. |
| `src/services/class-lifecycle.ts` | 4 assertions removed by iterating `pricing.students`. |
| `src/components/class/pricing-preview.tsx` | Group-by over `pricing.students`; the `1..5` loop uses `INCOME_TIERS`. |
| `src/components/class/pricing-preview-table.tsx` | 5 `TIER_RATIOS[n]!` become one `INCOME_TIERS.map`. |
| `src/components/class/pricing-breakdown.tsx` | `TierPrice.tier: IncomeTier`; the `1..5` loop uses `INCOME_TIERS`. |
| `src/components/student/tier-form.tsx` | `currentTier: IncomeTier`; `TierBody.incomeTier: IncomeTier`. |
| `src/components/booking/booking-flow.tsx` | `currentTier: IncomeTier`. |
| `src/lib/schemas.ts` | `incomeTier` uses `.refine(isIncomeTier)` so the wire type is `IncomeTier`. |
| `src/app/(public)/[slug]/page.tsx` | 1 conversion. |
| `src/app/(public)/[slug]/book/[classId]/page.tsx` | 4 conversions (one hoisted and used twice). |
| `src/app/(student)/account/tier/page.tsx` | 1 conversion. |
| `src/app/(teacher)/class/[id]/page.tsx` | 1 conversion. |
| `tests/integration/account-api.test.ts` | Failure injection re-pointed from `tierAtBooking: 0` to a duplicate `Payment`. |

**Deliberately unchanged** — these six read sites keep `number`, and a reviewer should read that as a decision:

- Column-to-column copies (3): `src/app/api/registrations/route.ts:162`, `src/services/waitlist.ts:347`, `src/services/waitlist.ts:446`. The value goes column to column, never into a computation, and both columns now carry the constraint.
- JSON payloads (3): `src/app/api/students/[id]/route.ts:55`, `src/services/gdpr.ts:67`, `src/services/gdpr.ts:95`. A literal union buys nothing across a JSON boundary.
- One parameter alongside them, not one of the six reads: `activateRegistration`'s `tierAtBooking: number` (`src/services/waitlist.ts:52`), fed only by those copies.
- `src/components/booking/booking-flow.tsx:185`'s `TIER_INFO[tier - 1]!`. TypeScript cannot prove `tier - 1` is `0..4` even when `tier` is `IncomeTier`; removing it needs a second lookup keyed by tier, i.e. a second source of truth for display copy.

**Task order is load-bearing.** Task 2 re-points the integration test *before* Task 3 adds the constraint, because the constraint makes that test's current failure injection impossible. Reversing them leaves the suite red.

---

### Task 1: The type, the guard, and the server-only narrowing

**Files:**
- Modify: `src/lib/tiers.ts`
- Create: `src/lib/tiers.server.ts`
- Create: `src/lib/tiers.test.ts`
- Create: `src/lib/tiers.server.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, and every later task depends on these exact names:
  - `type IncomeTier = 1 | 2 | 3 | 4 | 5` (from `@/lib/tiers`)
  - `const INCOME_TIERS: readonly IncomeTier[]` (from `@/lib/tiers`)
  - `function isIncomeTier(n: number): n is IncomeTier` (from `@/lib/tiers`)
  - `const DEFAULT_INCOME_TIER: IncomeTier` (from `@/lib/tiers`, value `3`)
  - `function toIncomeTier(n: number): IncomeTier` (from `@/lib/tiers.server`)
- `TIER_RATIOS` is **not** moved in this task. It moves in Task 5, together with the engine change that makes `Record<IncomeTier, number>` type-check at every use.

**Context you need:** `src/lib/tiers.ts` currently has **zero imports** and is imported by two `'use client'` components (`src/components/student/tier-form.tsx`, `src/components/booking/booking-flow.tsx`). Adding anything to it that transitively reaches `@/lib/log` puts pino in the browser bundle. Two files in this repo document that hazard: `src/lib/class-fields.ts:1-12` and `src/lib/format.ts:50-51`. That is why `toIncomeTier` gets its own file. The `.server.ts` suffix is new to this codebase — it is introduced deliberately so the constraint is visible in the filename rather than living only in a comment.

- [ ] **Step 1: Write the failing tests for the pure module**

Create `src/lib/tiers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { INCOME_TIERS, isIncomeTier, DEFAULT_INCOME_TIER } from './tiers';

describe('isIncomeTier', () => {
  it('accepts every tier in range', () => {
    expect([1, 2, 3, 4, 5].every(isIncomeTier)).toBe(true);
  });

  it('rejects both boundaries and beyond', () => {
    // 0 is the value tests/integration/account-api.test.ts used to inject a
    // failure with; 6 is the other side of the range.
    expect([0, 6, -1, 100].some(isIncomeTier)).toBe(false);
  });

  it('rejects non-integers and NaN', () => {
    expect(isIncomeTier(3.5)).toBe(false);
    expect(isIncomeTier(NaN)).toBe(false);
  });
});

describe('INCOME_TIERS', () => {
  it('is every tier, in order, and nothing else', () => {
    expect([...INCOME_TIERS]).toEqual([1, 2, 3, 4, 5]);
  });

  it('contains only values isIncomeTier accepts', () => {
    expect(INCOME_TIERS.every(isIncomeTier)).toBe(true);
  });
});

describe('DEFAULT_INCOME_TIER', () => {
  it('is the median tier and is itself a valid tier', () => {
    expect(DEFAULT_INCOME_TIER).toBe(3);
    expect(isIncomeTier(DEFAULT_INCOME_TIER)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/lib/tiers.test.ts`
Expected: FAIL — `INCOME_TIERS` and `isIncomeTier` are not exported from `./tiers`.

- [ ] **Step 3: Add the type, the list, and the guard**

Edit `src/lib/tiers.ts`. Keep `TIER_INFO` and `TIER_QUOTE` exactly as they are, and keep the file's zero imports:

```ts
/**
 * One of five discrete income bands. Ratios live in TIER_RATIOS below; the
 * database enforces the same range through two CHECK constraints (see the
 * income_tier_range_check migration), so this union and the columns agree.
 *
 * This module must stay import-free: `tier-form.tsx` and `booking-flow.tsx`
 * are `'use client'` and value-import from it, so any transitive reach to
 * `@/lib/log` (pino) would land in the browser bundle. The narrowing helper
 * that logs lives in `tiers.server.ts` for exactly that reason.
 */
export type IncomeTier = 1 | 2 | 3 | 4 | 5;

/** Every tier, in order. Use this instead of a hand-rolled 1..5 loop. */
export const INCOME_TIERS = [1, 2, 3, 4, 5] as const satisfies readonly IncomeTier[];

export function isIncomeTier(n: number): n is IncomeTier {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
}

// The middle tier: the default for new student profiles and the value
// erased profiles are reset to.
export const DEFAULT_INCOME_TIER: IncomeTier = 3;
```

Note `DEFAULT_INCOME_TIER` gains an explicit `: IncomeTier` annotation. It already inferred the literal type `3`, so this changes nothing at a call site — it documents intent and makes a future edit to `4` fail if the union ever narrows.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit src/lib/tiers.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the type pin bites**

`INCOME_TIERS` uses `satisfies` so that a typo cannot silently widen it. Prove that guard is real:

Temporarily change the line to `export const INCOME_TIERS = [1, 2, 3, 4, 6] as const satisfies readonly IncomeTier[];` and run `npx tsc --noEmit`.

Expected: an error naming the offending element, of the form `Type '6' is not assignable to type 'IncomeTier'`.

Record the exact error text in your report, then restore the line to `[1, 2, 3, 4, 5]` and re-run `npx tsc --noEmit` to confirm clean. **If no error appears, stop and report** — the `satisfies` clause is not doing what this plan claims and Task 5 depends on it.

- [ ] **Step 6: Write the failing test for the server-only narrowing**

Create `src/lib/tiers.server.test.ts`. The `vi.spyOn(log, 'warn')` shape is copied from `src/lib/timezone.test.ts:59-66`, which tests the same degrade-and-warn pattern:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toIncomeTier } from './tiers.server';
import { DEFAULT_INCOME_TIER } from './tiers';
import { log } from '@/lib/log';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toIncomeTier', () => {
  it('passes every in-range tier through unchanged', () => {
    expect([1, 2, 3, 4, 5].map(toIncomeTier)).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not warn for a value the database permits', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    toIncomeTier(4);
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades to the default rather than throwing', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    // A public SSR page renders this. Throwing here is a 500 on a teacher's
    // booking page; one wrong price is the lesser failure.
    expect(() => toIncomeTier(0)).not.toThrow();
    expect(toIncomeTier(0)).toBe(DEFAULT_INCOME_TIER);
    expect(toIncomeTier(6)).toBe(DEFAULT_INCOME_TIER);
  });

  it('warns with the offending value so a bypassed constraint is observable', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    toIncomeTier(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 0 }),
      expect.stringContaining('outside 1-5'),
    );
  });
});
```

The "does not warn" test matters as much as the warn test: a helper that warns on every call is noise that gets muted, and then the real signal is lost too.

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run --project unit src/lib/tiers.server.test.ts`
Expected: FAIL — cannot resolve `./tiers.server`.

- [ ] **Step 8: Write `toIncomeTier`**

Create `src/lib/tiers.server.ts`:

```ts
import { log } from '@/lib/log';
import { DEFAULT_INCOME_TIER, isIncomeTier, type IncomeTier } from '@/lib/tiers';

/**
 * Narrow a tier read from the database.
 *
 * `Student.incomeTier` and `Registration.tierAtBooking` both carry a CHECK
 * constraint (see the income_tier_range_check migration), so the fallback
 * below is unreachable. It exists because the alternative on a bypassed
 * constraint is a 500 on a teacher's public booking page — `estimateTierPrices`
 * runs during SSR on `(public)/[slug]` and `(public)/[slug]/book/[classId]`,
 * fed straight from `registrations.map(r => r.tierAtBooking)`. One wrong price
 * with a warning beats a dead storefront.
 *
 * If this ever warns, the constraint was circumvented. That is the bug to
 * chase, and the log line is the only thing that would tell you.
 *
 * This file is separate from `tiers.ts` solely because it imports `@/lib/log`
 * (pino, server-only) and `tiers.ts` is value-imported by two `'use client'`
 * components. Do not move it, and do not import it from a client component.
 */
export function toIncomeTier(n: number): IncomeTier {
  if (isIncomeTier(n)) return n;
  log.warn({ tier: n }, 'income tier outside 1-5; DB constraint bypassed');
  return DEFAULT_INCOME_TIER;
}
```

- [ ] **Step 9: Run the tests and watch them pass**

Run: `npx vitest run --project unit src/lib/tiers.server.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 10: Prove the warn test bites**

Temporarily delete the `log.warn(...)` line from `toIncomeTier` and re-run `npx vitest run --project unit src/lib/tiers.server.test.ts`.

Expected: the "warns with the offending value" test FAILS; the other three still pass. Record the failure, restore the line, re-run and confirm all four pass. A silent-failure test that cannot detect the silence is worse than none.

- [ ] **Step 11: Verify the client bundle is unaffected**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

Then confirm `src/lib/tiers.ts` still has zero imports:

```bash
grep -c "^import" src/lib/tiers.ts
```

Expected: `0`. If this is not 0, the file has gained an import and the client-bundle guarantee in its own docblock is now false — stop and report rather than proceeding.

- [ ] **Step 12: Commit**

```bash
git add src/lib/tiers.ts src/lib/tiers.server.ts src/lib/tiers.test.ts src/lib/tiers.server.test.ts
git commit -m "feat: an income tier is 1-5, with a server-only narrowing that degrades (#39)"
```

---

### Task 2: Re-point the account-erasure failure injection

**Files:**
- Modify: `tests/integration/account-api.test.ts:248-330` (the `reports PARTIAL_ERASURE...` test)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: nothing later tasks import. This task exists so Task 3's constraint does not turn a passing test red.

**Context you need.** This test proves that when the teacher half of an account erasure fails after the student half committed, the API reports `PARTIAL_ERASURE` and a retry finishes the job. It engineers the failure with real data rather than a mock, by writing `tierAtBooking: 0` at `:302` — `deleteTeacherAccount` completes in-progress classes first, and the pricing engine throws `Invalid tier`.

Two facts make the replacement necessary and constrain its shape:

1. Task 3 adds a CHECK constraint that rejects `tierAtBooking: 0`, so the write at `:302` will fail before the test can even get started.
2. `deleteTeacherAccount` **catches** `completeClass` returning `{ok: false}` (`src/services/gdpr.ts:318-326` — it logs and falls through). The tier-0 injection works only because the engine *throws*, propagating uncaught. So the replacement must also throw, not return a failure result.

It must additionally be **reversible**, because the test's second half clears the failure and presses Delete again.

The test's own comment already asks for this: *"this test should be re-pointed at another failure inside `deleteTeacherAccount` rather than deleted. It failing loudly is the point; silently ceasing to cover the branch is the thing to avoid."*

**The replacement:** `Payment.registrationId` is `@unique` (`prisma/schema.prisma:484`), and `completeClass` creates one `Payment` per charged registration inside its transaction with no try/catch. Pre-creating a `Payment` for the registration makes that `create` throw a P2002 unique violation — uncaught, same path as the pricing throw. Deleting that `Payment` clears it for the retry.

- [ ] **Step 1: Replace the injection and its comment**

In `tests/integration/account-api.test.ts`, replace the comment block that currently begins *"Make the teacher half throw, using real data rather than a mock"* with:

```ts
    // Make the teacher half throw, using real data rather than a mock: the
    // route's erasure of a teacher completes their in-progress classes first
    // (gdpr.ts, uncaught), and `completeClass` creates one Payment per charged
    // registration inside its transaction. `Payment.registrationId` is @unique,
    // so a Payment that already exists makes that create throw P2002.
    //
    // It has to throw rather than return a failure: deleteTeacherAccount
    // catches `{ok: false}` from completeClass and falls through (gdpr.ts:318-326),
    // so a merely-failing completion would not produce PARTIAL_ERASURE at all.
    //
    // This injection replaced `tierAtBooking: 0` when #39 added a CHECK
    // constraint making that value unwritable. Same three properties: real
    // data, uncaught, and reversible so the retry can succeed.
```

Then change the registration create at `:301-303` to use a valid tier, and add the blocking `Payment`:

```ts
    const registration = await prisma.registration.create({
      data: { classId: cls.id, studentId: attendee.id, tierAtBooking: 3 },
    });
    // The row that makes completeClass's payment.create collide.
    const blockingPayment = await prisma.payment.create({
      data: { registrationId: registration.id, amount: 1, status: 'pending' },
    });
```

- [ ] **Step 2: Replace the "clear the failure" step**

Replace:

```ts
    // Clear the failure and press Delete again, as the message instructs.
    await prisma.registration.update({
      where: { id: registration.id },
      data: { tierAtBooking: 3 },
    });
```

with:

```ts
    // Clear the failure and press Delete again, as the message instructs.
    await prisma.payment.delete({ where: { id: blockingPayment.id } });
```

- [ ] **Step 3: Run the test and watch it pass**

The dev server must already be running on `:3000` — do not start or restart it. If it is not running, stop and report rather than starting it.

Run: `npx vitest run --project integration tests/integration/account-api.test.ts`

Expected: PASS. Note this runs **one file by explicit path** — never `npx vitest run --project integration` with no path, which trips an IP rate limit in a different file.

- [ ] **Step 4: Prove the injection is what makes it fail**

This is the step that matters. A re-pointed failure injection that was never shown to cause the failure is the "verification that could not have failed" pattern that cost a full re-review on #138.

Temporarily comment out the `blockingPayment` create, and re-run the same command.

Expected: the test FAILS — `expect(first.status).toBe(500)` receives `200`, because the erasure now succeeds outright. Record the actual assertion failure text.

Restore the `blockingPayment` create and re-run; expected PASS.

**If the test still passes with the injection removed, stop and report.** It would mean the test is asserting something the injection does not cause, and the coverage this task is meant to preserve was already gone.

- [ ] **Step 5: Confirm no other test depends on an out-of-range tier**

```bash
grep -rn "incomeTier: *\(0\|6\|7\|8\|9\|-\)\|tierAtBooking: *\(0\|6\|7\|8\|9\|-\)" src/ tests/ prisma/
```

Expected: no output. Before this task there was exactly one hit, `tests/integration/account-api.test.ts:302`. If anything else appears, it must be fixed here — Task 3's constraint will reject it.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/account-api.test.ts
git commit -m "test: inject partial-erasure failure with a duplicate payment, not a bad tier (#39)"
```

---

### Task 3: The CHECK constraints

**Files:**
- Create: `prisma/migrations/<timestamp>_income_tier_range_check/migration.sql`
- Create: `tests/integration/income-tier-constraint.test.ts`

**Interfaces:**
- Consumes: Task 2's re-pointed test (this constraint would break the old one).
- Produces: a database guarantee that Task 1's `toIncomeTier` fallback is unreachable. No TypeScript symbols.

**Context you need.** Prisma cannot express a CHECK constraint declaratively, so `schema.prisma` does not change and `npx prisma migrate dev` will not generate this file for you. This repo already has exactly one hand-written CHECK migration, on this same `Student` table — read `prisma/migrations/20260721061528_student_claim_link_check/migration.sql` and match its shape, including the explanatory comment above the statement.

The dev database has been verified to contain 0 violating rows, so this will apply cleanly.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/income-tier-constraint.test.ts`. Follow the seeding and cleanup conventions of the other files in `tests/integration/` — read `tests/integration/tier-selected-at.test.ts` first for the local idiom (unique suffixes, tracked ids, `afterAll` cleanup):

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const suffix = `tier-check-${Date.now()}`;
const studentIds: string[] = [];

afterAll(async () => {
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.$disconnect();
});

/**
 * These assert the DATABASE rejects the write, not that any TypeScript
 * guard does. `toIncomeTier` degrades rather than throwing precisely
 * because it trusts these constraints; if they are absent, that fallback
 * silently becomes load-bearing and nobody finds out.
 */
describe('income tier range constraints', () => {
  it('rejects an out-of-range Student.incomeTier on create', async () => {
    await expect(
      prisma.student.create({
        data: {
          firstName: 'Out', lastName: 'OfRange',
          email: `out-of-range-${suffix}@test.local`,
          incomeTier: 0,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects an out-of-range Student.incomeTier on update', async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'In', lastName: 'Range',
        email: `in-range-${suffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);

    await expect(
      prisma.student.update({ where: { id: student.id }, data: { incomeTier: 6 } }),
    ).rejects.toThrow();

    // The row is untouched — a rejected write is not a partial write.
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.incomeTier).toBe(3);
  });

  it('accepts both boundaries', async () => {
    for (const tier of [1, 5]) {
      const student = await prisma.student.create({
        data: {
          firstName: 'Edge', lastName: `T${tier}`,
          email: `edge-${tier}-${suffix}@test.local`,
          incomeTier: tier,
        },
      });
      studentIds.push(student.id);
      expect(student.incomeTier).toBe(tier);
    }
  });
});
```

`Registration.tierAtBooking`'s constraint is not tested here — it needs a full class + teacher + room fixture, and Task 2's `account-api` test already exercises a valid `tierAtBooking` write end-to-end. Step 5 verifies that constraint directly against the database instead, which is cheaper and proves the same thing.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/income-tier-constraint.test.ts`

Expected: the two `rejects.toThrow()` tests FAIL — without the constraint, Postgres happily stores `0` and `6`. The "accepts both boundaries" test passes already.

Record the failure. This is the step that proves the migration does something.

**Clean up the rows this failing run created**, since they violate the constraint you are about to add. The migration in Step 3 will refuse to apply while any exist:

```bash
npx prisma db execute --schema prisma/schema.prisma --stdin <<'SQL'
DELETE FROM "Student" WHERE "incomeTier" < 1 OR "incomeTier" > 5;
SQL
```

Then confirm the table is clean, because `db execute` reports success without returning rows and is therefore not evidence on its own:

```bash
npx prisma db execute --schema prisma/schema.prisma --stdin <<'SQL'
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM "Student" WHERE "incomeTier" < 1 OR "incomeTier" > 5;
  IF bad > 0 THEN RAISE EXCEPTION 'STILL % violating Student rows', bad; END IF;
  SELECT count(*) INTO bad FROM "Registration" WHERE "tierAtBooking" < 1 OR "tierAtBooking" > 5;
  IF bad > 0 THEN RAISE EXCEPTION 'STILL % violating Registration rows', bad; END IF;
  RAISE NOTICE 'OK: 0 violating rows in both columns';
END $$;
SQL
```

Expected: the `OK:` notice. Anything else means the migration in Step 3 will fail, and you should find out here rather than there.

- [ ] **Step 3: Write the migration**

Create the directory `prisma/migrations/<timestamp>_income_tier_range_check/` where `<timestamp>` is `YYYYMMDDHHMMSS` and must sort **after** `20260728184625` (the latest existing migration). Use the current UTC time.

`migration.sql`:

```sql
-- Invariant, DB-enforced: an income tier is one of five discrete bands.
-- TypeScript's IncomeTier (src/lib/tiers.ts) stops new code from writing
-- anything else; this stops everything else — a psql session, a data fix,
-- a future route that forgets to validate. Without it, `toIncomeTier`'s
-- degrade-and-warn fallback silently becomes load-bearing.
ALTER TABLE "Student" ADD CONSTRAINT "Student_income_tier_check"
  CHECK ("incomeTier" BETWEEN 1 AND 5);

ALTER TABLE "Registration" ADD CONSTRAINT "Registration_tier_at_booking_check"
  CHECK ("tierAtBooking" BETWEEN 1 AND 5);
```

- [ ] **Step 4: Apply it**

Run: `npx prisma migrate dev`

Expected: Prisma detects the new unapplied migration and applies it. It should **not** prompt to reset the database. If it offers to reset, stop and report — that would destroy the dev data and means something is out of sync.

Then: `npx prisma migrate status`
Expected: no pending migrations, no drift.

- [ ] **Step 5: Run the test and watch it pass, and verify the second constraint directly**

Run: `npx vitest run --project integration tests/integration/income-tier-constraint.test.ts`
Expected: PASS, 3 tests.

Then prove `Registration_tier_at_booking_check` exists and bites, since no test covers it:

```bash
npx prisma db execute --schema prisma/schema.prisma --stdin <<'SQL'
DO $$ BEGIN
  BEGIN
    UPDATE "Registration" SET "tierAtBooking" = 0 WHERE id = (SELECT id FROM "Registration" LIMIT 1);
    RAISE EXCEPTION 'CONSTRAINT MISSING: the update was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: Registration_tier_at_booking_check rejected the write';
  END;
  ROLLBACK;
END $$;
SQL
```

Expected: the `OK:` notice. If you see `CONSTRAINT MISSING`, the second `ALTER TABLE` did not apply. The `ROLLBACK` means no row is modified either way.

- [ ] **Step 6: Confirm nothing else broke**

Run: `npx vitest run --project unit`
Expected: PASS, **460** — 450 at the branch point plus Task 1's 10. This task adds no unit tests; its own 3 are in the `integration` project.

Run: `npx vitest run --project integration tests/integration/account-api.test.ts`
Expected: PASS — Task 2's re-pointed injection is unaffected by the constraint, which is the whole reason Task 2 came first.

- [ ] **Step 7: Commit**

```bash
git add prisma/migrations tests/integration/income-tier-constraint.test.ts
git commit -m "feat: the database rejects an income tier outside 1-5 (#39)"
```

---

### Task 4: `PricingResult` returns one array of records

**Files:**
- Modify: `src/services/pricing.ts:43-51` (the `PricingResult` interface) and `:98-163` (the calculation)
- Modify: `src/services/pricing.test.ts`
- Modify: `src/lib/tier-estimates.ts:43,87`
- Modify: `src/lib/tier-estimates.test.ts`
- Modify: `src/services/class-lifecycle.ts:196-215`
- Modify: `src/components/class/pricing-preview.tsx:41-56`

**Interfaces:**
- Consumes: nothing from Tasks 1-3. The tier type is **not** introduced here — `studentTiers` stays `number[]` until Task 5, so this task is a pure result-shape change and can be reviewed as one.
- Produces:
  ```ts
  export interface PricedStudent {
    tier: number;   // becomes IncomeTier in Task 5
    ratio: number;
    price: number;
  }
  export interface PricingResult {
    effectiveTeacherRate: number;
    totalCost: number;
    studentCount: number;
    students: ReadonlyArray<PricedStudent>;
  }
  ```
  `studentPrices` and `studentTierRatios` are **removed**, not deprecated.

**Context you need.** Six non-null assertions currently index the two parallel arrays in non-test code. Measured, they are:

| Site | Expression |
|---|---|
| `src/lib/tier-estimates.ts:43` | `pricing.studentPrices[input.registeredTiers.length]!` |
| `src/lib/tier-estimates.ts:87` | `pricing.studentPrices[input.registeredTiers.length]!` |
| `src/services/class-lifecycle.ts:199` | `pricing.studentPrices[i]!` |
| `src/services/class-lifecycle.ts:199` | `pricing.studentTierRatios[i]!` |
| `src/services/class-lifecycle.ts:202` | `pricing.studentPrices[i]!` |
| `src/services/class-lifecycle.ts:213` | `pricing.studentPrices[i]!` |

**Four go — the four in `class-lifecycle.ts`. Two stay — the two in `tier-estimates.ts`.** Under `noUncheckedIndexedAccess`, `students[n]` is still `PricedStudent | undefined`, so restructuring alone removes nothing; what removes the four is *iterating* the result instead of indexing it. Do not attempt to remove the remaining two: the alternatives are a generic payload threaded through the engine, or reordering the input so the viewer lands last — which shifts which student receives the leftover cent in the largest-remainder allocation, i.e. changes prices. Both are worse than one honest `!`.

- [ ] **Step 1: Update the pricing engine's tests to the new shape**

In `src/services/pricing.test.ts`, replace every `result.studentPrices[n]` with `result.students[n]?.price` and every `result.studentTierRatios[n]` with `result.students[n]?.ratio`.

The nine per-student assertions at `:145-153` **must keep their existing expected values**:

```ts
    expect(result.students[0]?.price).toBeCloseTo(3.98, 2); // T1 (+1c remainder)
    expect(result.students[1]?.price).toBeCloseTo(3.98, 2); // T1 (+1c remainder)
    expect(result.students[2]?.price).toBeCloseTo(4.89, 2); // T2
    expect(result.students[3]?.price).toBeCloseTo(6.11, 2); // T3
    expect(result.students[4]?.price).toBeCloseTo(6.11, 2); // T3
    expect(result.students[5]?.price).toBeCloseTo(7.34, 2); // T4 (+1c remainder)
    expect(result.students[6]?.price).toBeCloseTo(7.34, 2); // T4 (+1c remainder)
    expect(result.students[7]?.price).toBeCloseTo(8.25, 2); // T5
    expect(result.students[8]?.price).toBeCloseTo(8.25, 2); // T5
```

These nine numbers are the guard against the restructure silently changing a price. If any of them has to move, the change altered behaviour and that is a defect, not a test to update.

Update the two sum-invariant reductions at `:156` and `:178`:

```ts
    const sumCents = result.students.reduce((a, s) => a + Math.round(s.price * 100), 0);
```

And the empty-list assertions at `:124-125` become one:

```ts
    expect(result.students).toEqual([]);
```

Add one new test that the old shape could not express — that each record's own three fields agree:

```ts
  it('pairs each price with the tier and ratio it was computed from', () => {
    const result = calculateClassPricing({
      roomCost: 35, minRate: 15, targetRate: 25,
      minStudents: 4, maxStudents: 12,
      studentTiers: [1, 5, 3],
    });

    // The pairing is the point of the shape: a record cannot carry tier 1's
    // price under tier 5's ratio, which two index-correlated arrays could.
    expect(result.students.map((s) => s.tier)).toEqual([1, 5, 3]);
    expect(result.students.map((s) => s.ratio)).toEqual([0.65, 1.35, 1.0]);
    expect(result.students.every((s) => s.price > 0)).toBe(true);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/pricing.test.ts`
Expected: FAIL — `students` does not exist on `PricingResult`.

- [ ] **Step 3: Change the engine**

In `src/services/pricing.ts`, replace the `PricingResult` interface:

```ts
export interface PricedStudent {
  /** The tier this student was charged at. */
  tier: number;
  /** The tier ratio applied — TIER_RATIOS[tier]. */
  ratio: number;
  /** This student's price, in whole cents after largest-remainder allocation. */
  price: number;
}

export interface PricingResult {
  effectiveTeacherRate: number;
  totalCost: number;
  studentCount: number;
  /**
   * One record per charged student, in the same order as the input tiers.
   *
   * One array of records rather than parallel `studentPrices` /
   * `studentTierRatios`: those were held in correspondence by a shared index,
   * and a skew between them in the billing loop would charge a student
   * another student's price.
   */
  students: ReadonlyArray<PricedStudent>;
}
```

Change the empty-input early return (`:98-106`):

```ts
  if (studentTiers.length === 0) {
    return {
      effectiveTeacherRate: 0,
      totalCost: 0,
      studentCount: 0,
      students: [],
    };
  }
```

And the final return (`:157-163`). Keep every line of the largest-remainder allocation between them exactly as it is — `baseUnit`, `exactCents`, `flooredCents`, `totalCents`, `leftover`, `byRemainder` and the distribution loop are untouched:

```ts
  const students: PricedStudent[] = studentTiers.map((tier, i) => ({
    tier,
    ratio: studentTierRatios[i]!,
    price: flooredCents[i]! / 100,
  }));

  return {
    effectiveTeacherRate,
    totalCost,
    studentCount,
    students,
  };
```

Delete the now-unused `const studentPrices = flooredCents.map((c) => c / 100);` line at `:155`.

The two `!` in that `map` are on arrays this function built itself, three lines earlier, with lengths it controls — they are not the index-correlation the task removes.

- [ ] **Step 4: Run the engine tests and watch them pass**

Run: `npx vitest run --project unit src/services/pricing.test.ts`
Expected: PASS. The nine per-student values must be unchanged from Step 1.

- [ ] **Step 5: Update `tier-estimates.ts` — the two assertions that stay**

At `:43` and `:87`, replace `pricing.studentPrices[input.registeredTiers.length]!` with:

```ts
    return pricing.students[input.registeredTiers.length]!.price;
```

Add this comment once, above the `:43` occurrence:

```ts
    // The joining student is at index registeredTiers.length. This assertion
    // survives the #39 restructure deliberately: no type can prove an index
    // is in range, and the alternatives (a generic payload through the engine,
    // or reordering the input so the viewer lands last) either complicate the
    // core signature or move which student gets the leftover cent. This site
    // reads only a price, never a paired ratio, so it carries no skew risk.
```

Update `src/lib/tier-estimates.test.ts` wherever it reads the old fields — it compares against `calculateClassPricing` output at `:35`, `:51`, `:68`.

- [ ] **Step 6: Update `class-lifecycle.ts` — the four that go**

Replace the loop at `:196-205` and the notification map at `:210-215`:

```ts
    // Iterating the priced records rather than indexing two arrays: price and
    // ratio arrive together, so they cannot skew apart. The one assertion left
    // is on chargedRegistrations, this function's own array.
    for (const [i, s] of pricing.students.entries()) {
      const reg = chargedRegistrations[i]!;
      await tx.registration.update({
        where: { id: reg.id },
        data: { price: s.price, tierRatio: s.ratio },
      });
      await tx.payment.create({
        data: { registrationId: reg.id, amount: s.price, status: 'pending' },
      });
    }
```

```ts
    const notifications: CreateNotificationInput[] = pricing.students.map((s, i) => {
      const reg = chargedRegistrations[i]!;
      return {
        recipientType: 'student' as const,
        recipientId: reg.studentId,
        type: 'payment_request' as const,
        title: 'Payment requested',
        body: `Your price for ${cls.classType} is €${s.price.toFixed(2)}. Pay your teacher directly.`,
        relatedClassId: cls.id,
      };
    });
```

- [ ] **Step 7: Update `pricing-preview.tsx` — the group-by**

Replace the tier-summary block at `:41-56`. The old version indexed `studentTiers` to find matching positions, then read `pricing.studentPrices[firstIndex]` and looked up `TIER_RATIOS[tier]`, guarding both for `undefined`. Both values are now on the record:

```ts
  // Build a summary by tier for preview display. Each priced record carries
  // its own tier and ratio, so there is no index to match up and no undefined
  // to guard — the two checks this replaced existed only because the price
  // and the ratio came from different places.
  const tierSummary: { tier: number; ratio: number; price: number; count: number }[] = [];
  for (const tier of INCOME_TIERS) {
    const forTier = pricing.students.filter((s) => s.tier === tier);
    const first = forTier[0];
    if (first) {
      tierSummary.push({ tier, ratio: first.ratio, price: first.price, count: forTier.length });
    }
  }
```

This file has no `@/lib/tiers` import today, so add one:

```ts
import { INCOME_TIERS } from '@/lib/tiers';
```

and narrow the existing import at `:2` to `import { calculateClassPricing } from '@/services/pricing';` — the new group-by reads `ratio` off the record, so `TIER_RATIOS` is no longer referenced in this file. (Task 5 relies on this: it moves `TIER_RATIOS` out of `services/pricing.ts`, and this file is one of the importers that must already have stopped using it.)

The `const studentTiers = activeRegistrations.map((r) => r.tierAtBooking);` line at `:30` stays as it is — Task 5 changes it.

- [ ] **Step 8: Verify the whole tree**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

Run: `npx vitest run --project unit`
Expected: PASS, **461**. The arithmetic: 450 at the branch point, plus Task 1's 10 (6 in `tiers.test.ts`, 4 in `tiers.server.test.ts`), plus the 1 pairing test added in Step 1. Task 3's tests are in the `integration` project and do not count here.

Run: `npx vitest run --project components`
Expected: PASS, **87**.

- [ ] **Step 9: Prove the four assertions are actually gone**

```bash
grep -rnoE "\.(studentPrices|studentTierRatios)\[[^]]*\]!" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

Expected: no output — the identifiers no longer exist.

```bash
grep -rnoE "pricing\.students\[[^]]*\]!" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

Expected: exactly 2 lines, both in `src/lib/tier-estimates.ts`. If you get more than 2, a site that should have been converted to iteration is still indexing — fix it rather than reporting a different number.

- [ ] **Step 10: Commit**

```bash
git add src/services/pricing.ts src/services/pricing.test.ts src/lib/tier-estimates.ts src/lib/tier-estimates.test.ts src/services/class-lifecycle.ts src/components/class/pricing-preview.tsx
git commit -m "refactor: price and ratio arrive as one record, not two arrays (#39)"
```

---

### Task 5: `IncomeTier` through the engine, and the throw retires

**Files:**
- Modify: `src/lib/tiers.ts` (receives `TIER_RATIOS`)
- Modify: `src/services/pricing.ts` (loses `TIER_RATIOS`, gains the type, loses the throw)
- Modify: `src/services/pricing.test.ts` (import moves)
- Modify: `src/lib/tier-estimates.ts` (input types)
- Modify: `src/services/class-lifecycle.ts:182`
- Modify: `src/components/class/pricing-preview.tsx:30`
- Modify: `src/components/class/pricing-preview-table.tsx:5-6,64-68`
- Modify: `src/components/class/pricing-breakdown.tsx:3-6,20-25`
- Modify: `src/components/booking/booking-flow.tsx:14`
- Modify: `src/components/student/tier-form.tsx:12`
- Modify: `src/app/(public)/[slug]/page.tsx:113`
- Modify: `src/app/(public)/[slug]/book/[classId]/page.tsx:50,111,115-116,130`
- Modify: `src/app/(student)/account/tier/page.tsx:30`
- Modify: `src/app/(teacher)/class/[id]/page.tsx:95`

**Interfaces:**
- Consumes: `IncomeTier`, `INCOME_TIERS`, `DEFAULT_INCOME_TIER` from `@/lib/tiers`; `toIncomeTier` from `@/lib/tiers.server` (Task 1). `PricedStudent`/`PricingResult` from Task 4.
- Produces:
  - `TIER_RATIOS: Record<IncomeTier, number>` now exported from `@/lib/tiers`, **no longer from `@/services/pricing`**
  - `ClassPricingInput.studentTiers: IncomeTier[]`
  - `PricedStudent.tier: IncomeTier`
  - `TierEstimateInput.registeredTiers: IncomeTier[]`, `AttendanceSpreadInput.viewerTier: IncomeTier`

**Context you need.** This task is large but atomic: changing the engine's input type forces every caller to convert, and TypeScript will not let you land half of it. Work outward from `pricing.ts` and let `npx tsc --noEmit` enumerate the sites.

Why `TIER_RATIOS` moves: `src/components/class/pricing-preview-table.tsx` is a `'use client'` component that imports it from `@/services/pricing` today, so the pricing module is already in the browser bundle. `src/lib/class-fields.ts:1-12` documents this exact hazard and even names this import as the thing its zero-import property protects. Moving the constant into `@/lib/tiers` lets that component stop importing the engine.

**The nine conversion sites**, measured, across six files:

| File | Sites | Feeds |
|---|---|---|
| `src/app/(public)/[slug]/page.tsx` | `:113` | `estimateTierPrices` |
| `src/app/(public)/[slug]/book/[classId]/page.tsx` | `:50`, `:111`, `:115-116`, `:130` | estimates ×3, `BookingFlow` |
| `src/app/(student)/account/tier/page.tsx` | `:30` | `TierForm` |
| `src/app/(teacher)/class/[id]/page.tsx` | `:95` | `PricingBreakdown` |
| `src/components/class/pricing-preview.tsx` | `:30` | `calculateClassPricing` |
| `src/services/class-lifecycle.ts` | `:182` | `calculateClassPricing` |

1 + 4 + 1 + 1 + 1 + 1 = **9**.

- [ ] **Step 1: Move `TIER_RATIOS` into `src/lib/tiers.ts`**

Add to `src/lib/tiers.ts`, below `INCOME_TIERS`:

```ts
/**
 * Income tier ratios. Tier 3 is baseline (1.0). Max spread ~2.08×.
 *
 * A `Record<IncomeTier, number>` rather than `Record<number, number>`: with a
 * finite key type, `TIER_RATIOS[tier]` is `number`, not `number | undefined`,
 * even under `noUncheckedIndexedAccess`. That is what let the engine's
 * per-student `Invalid tier` throw be deleted rather than relocated.
 *
 * Lives here rather than in `services/pricing.ts` so that
 * `pricing-preview-table.tsx` — a `'use client'` component — can import the
 * ratios without pulling the engine into the browser bundle. See
 * `src/lib/class-fields.ts` for the same reasoning applied to ECONOMIC_FIELDS.
 */
export const TIER_RATIOS: Record<IncomeTier, number> = {
  1: 0.65,
  2: 0.80,
  3: 1.00,
  4: 1.20,
  5: 1.35,
};
```

Delete the `TIER_RATIOS` declaration from `src/services/pricing.ts:12-19` and import it instead:

```ts
import { TIER_RATIOS, type IncomeTier } from '@/lib/tiers';
```

Do **not** re-export it from `pricing.ts`. **Two** importers remain to update — `src/services/pricing.test.ts:3` and `src/components/class/pricing-preview-table.tsx:6` — both switching to `@/lib/tiers`.

There were three before Task 4; `pricing-preview.tsx` stopped importing `TIER_RATIOS` when its group-by started reading the ratio off the priced record. Confirm that rather than assuming it:

```bash
grep -rn "TIER_RATIOS" src/ --include="*.ts" --include="*.tsx"
```

Expected: the declaration in `services/pricing.ts`, its use at `:124`, and exactly those two importers. If `pricing-preview.tsx` still appears, Task 4 Step 7 was left half-done.

- [ ] **Step 2: Type the engine's input and delete the throw**

In `src/services/pricing.ts`:

```ts
export interface ClassPricingInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  /** One tier per charged student. */
  studentTiers: IncomeTier[];
}
```

Change `PricedStudent.tier` from `number` to `IncomeTier`.

Replace the ratio lookup at `:123-129` with:

```ts
  // 3. Look up tier ratios for each student. Total by construction —
  // TIER_RATIOS is keyed by IncomeTier, so there is no undefined branch and
  // no runtime check. The `Invalid tier` throw that used to live here is
  // gone, not moved: the type makes it unreachable and the database's
  // income_tier_range_check makes the type honest.
  const studentTierRatios = studentTiers.map((tier) => TIER_RATIOS[tier]);
```

- [ ] **Step 3: Run `tsc` and let it enumerate the callers**

Run: `npx tsc --noEmit`

Expected: errors at the four `calculateClassPricing` call sites and downstream. This list is your worklist for Steps 4-7. Record how many distinct files it names.

- [ ] **Step 4: Convert the two service/component computation sites**

`src/services/class-lifecycle.ts:182` — add `import { toIncomeTier } from '@/lib/tiers.server';` and:

```ts
      studentTiers: chargedRegistrations.map((r) => toIncomeTier(r.tierAtBooking)),
```

`src/components/class/pricing-preview.tsx:30` — this is a server component (no `'use client'`), so it may import from `@/lib/tiers.server`:

```ts
  const studentTiers = activeRegistrations.map((r) => toIncomeTier(r.tierAtBooking));
```

- [ ] **Step 5: Type `tier-estimates.ts`**

```ts
export interface TierEstimateInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  /** Tiers of everyone currently registered (charged statuses). */
  registeredTiers: IncomeTier[];
}
```

```ts
export interface AttendanceSpreadInput extends TierEstimateInput {
  /** The signed-in student's own (already chosen) tier. */
  viewerTier: IncomeTier;
}
```

Inside `estimateTierPrices`, `priceForTier` takes an `IncomeTier`, the padding uses the named constant, and the five calls come from the shared list:

```ts
  const priceForTier = (tier: IncomeTier): number => {
    const tiers: IncomeTier[] = [...input.registeredTiers, tier];
    while (tiers.length < paddedMin) {
      tiers.push(DEFAULT_INCOME_TIER);
    }
```

```ts
  return [priceForTier(1), priceForTier(2), priceForTier(3), priceForTier(4), priceForTier(5)];
```

Leave that last line spelled out rather than mapping `INCOME_TIERS` — `TierPrices` is a fixed 5-tuple, and a `.map` returns `number[]`, which would need an assertion to satisfy the tuple. This plan forbids assertions.

In `estimateAttendanceSpread`, apply the same to the padding:

```ts
    const tiers: IncomeTier[] = [...input.registeredTiers, input.viewerTier];
    while (tiers.length < attendance) {
      tiers.push(DEFAULT_INCOME_TIER);
    }
```

Import `DEFAULT_INCOME_TIER` and `type IncomeTier` from `@/lib/tiers`.

- [ ] **Step 6: Convert the five page sites**

`src/app/(public)/[slug]/page.tsx:113`:

```ts
              registeredTiers: cls.registrations.map((r) => toIncomeTier(r.tierAtBooking)),
```

`src/app/(public)/[slug]/book/[classId]/page.tsx` — four sites. Hoist the viewer's profile tier so `:115-116` and `:130` share one conversion rather than converting the same value twice. Add near the other derived values, after `student` is resolved:

```ts
  // One conversion serves both the attendance-spread estimate and BookingFlow's
  // initial picker value — they read the same column.
  const viewerProfileTier = student ? toIncomeTier(student.incomeTier) : null;
```

Then:

```ts
    registeredTiers: cls.registrations.map((r) => toIncomeTier(r.tierAtBooking)),   // :50
```

```ts
            registeredTiers: cls.registrations
              .filter((r) => r !== ownRegistration)
              .map((r) => toIncomeTier(r.tierAtBooking)),                            // :111
            viewerTier: alreadyBooked && ownRegistration
              ? toIncomeTier(ownRegistration.tierAtBooking)
              : viewerProfileTier ?? DEFAULT_INCOME_TIER,                            // :115-116
```

```ts
          currentTier={viewerProfileTier ?? DEFAULT_INCOME_TIER}                      // :130
```

**Read the ternary at `:114-116` carefully before editing.** Three different tier sources appear within twenty lines of this file — the registered tiers, the viewer's *booking* tier (`ownRegistration.tierAtBooking`), and the viewer's *profile* tier (`student.incomeTier`). They are all `number` before this change and all `IncomeTier` after, so swapping two of them is invisible to the compiler. The comment at `:113-114` states the rule: a booked viewer is billed at the tier stamped on their registration; everyone else would join at their current profile tier.

`src/app/(student)/account/tier/page.tsx:30`:

```ts
      <TierForm studentId={student.id} currentTier={toIncomeTier(student.incomeTier)} />
```

`src/app/(teacher)/class/[id]/page.tsx:95`:

```ts
    .map((r) => ({ tier: toIncomeTier(r.tierAtBooking), price: Number(r.price) }));
```

- [ ] **Step 7: Type the four components and replace the two hand-rolled loops**

`src/components/booking/booking-flow.tsx:14` — `currentTier: IncomeTier;`, importing `type IncomeTier` from `@/lib/tiers`. `useState(currentTier)` then infers `IncomeTier`, and `setTier(t.tier)` still type-checks because `TIER_INFO` is `as const`. Leave `TIER_INFO[tier - 1]!` at `:185` alone — see "Deliberately unchanged".

`src/components/student/tier-form.tsx:12` — `currentTier: IncomeTier;`.

`src/components/class/pricing-preview-table.tsx:64-68` — replace the five assertions with one map:

```ts
const TIER_RATIO_VALUES = INCOME_TIERS.map((t) => TIER_RATIOS[t]);
```

No `!` is needed: `TIER_RATIOS` is keyed by `IncomeTier` and `INCOME_TIERS` yields exactly those keys.

`src/components/class/pricing-breakdown.tsx` — type the prop and use the shared list:

```ts
interface TierPrice {
  tier: IncomeTier;
  price: number;
}
```

```ts
  const tierSummary: { tier: IncomeTier; price: number; count: number }[] = [];
  for (const tier of INCOME_TIERS) {
    const entries = tierPrices.filter((tp) => tp.tier === tier);
    const first = entries[0];
    if (first) {
      tierSummary.push({ tier, price: first.price, count: entries.length });
    }
  }
```

`src/components/class/pricing-preview.tsx` — its `tierSummary` type from Task 4 becomes `{ tier: IncomeTier; ratio: number; price: number; count: number }[]`.

- [ ] **Step 8: Verify the whole tree**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

Run: `npx vitest run --project unit`
Expected: PASS, same count as Task 4 Step 8.

Run: `npx vitest run --project components`
Expected: PASS, **87**.

- [ ] **Step 9: Prove the throw is gone and the conversions are all present**

```bash
grep -rn "Invalid tier" src/ tests/
```

Expected: no output. Before this task there was one hit, `src/services/pricing.ts:126`. (A second historical hit lived in `tests/integration/account-api.test.ts`'s comment; Task 2 removed it. If it still appears, Task 2's comment rewrite was incomplete — fix it here.)

```bash
grep -rc "toIncomeTier" "src/app/(public)/[slug]/page.tsx" "src/app/(public)/[slug]/book/[classId]/page.tsx" "src/app/(student)/account/tier/page.tsx" "src/app/(teacher)/class/[id]/page.tsx" src/components/class/pricing-preview.tsx src/services/class-lifecycle.ts
```

Expected: every file reports at least 2 (one import plus at least one call). Quote the actual output in your report rather than summarising it as "all present".

```bash
grep -rn "TIER_RATIOS" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\." | grep "services/pricing.ts"
```

Expected: exactly one line — the `import` in `pricing.ts`. If the declaration is still there, the move did not happen.

- [ ] **Step 10: Prove the ratio lookup is total, not silently widened**

The deleted throw is only safe if `TIER_RATIOS[tier]` really is `number`. Temporarily change the `TIER_RATIOS` declaration in `src/lib/tiers.ts` to `Record<number, number>` and run `npx tsc --noEmit`.

Expected: an error at `src/services/pricing.ts` of the form `Type 'number | undefined' is not assignable to type 'number'`.

Record it, restore `Record<IncomeTier, number>`, re-run and confirm clean. **If no error appears, stop and report** — it would mean `noUncheckedIndexedAccess` is not in effect for that file and the throw's deletion is not justified.

- [ ] **Step 11: Commit**

```bash
git add src/lib/tiers.ts src/services/pricing.ts src/services/pricing.test.ts src/lib/tier-estimates.ts src/services/class-lifecycle.ts src/components/class/pricing-preview.tsx src/components/class/pricing-preview-table.tsx src/components/class/pricing-breakdown.tsx src/components/booking/booking-flow.tsx src/components/student/tier-form.tsx "src/app/(public)/[slug]/page.tsx" "src/app/(public)/[slug]/book/[classId]/page.tsx" "src/app/(student)/account/tier/page.tsx" "src/app/(teacher)/class/[id]/page.tsx"
git commit -m "feat: the pricing engine takes IncomeTier, and the Invalid tier throw is gone (#39)"
```

Note the quoted paths — `(public)`, `(student)` and `(teacher)` contain parentheses, and an unquoted path over one of these directories silently matched nothing on an earlier branch.

---

### Task 6: The wire type carries the constraint

**Files:**
- Modify: `src/lib/schemas.ts:139`
- Modify: `src/components/student/tier-form.tsx:17-19`
- Test: `src/lib/schemas.test.ts`

**Interfaces:**
- Consumes: `isIncomeTier`, `type IncomeTier` from `@/lib/tiers` (Task 1).
- Produces: `z.infer<typeof updateStudentSchema>['incomeTier']` is `IncomeTier | undefined` rather than `number | undefined`.

**Context you need.** In Zod 4, `.refine` with a type predicate narrows the inferred output type. This was verified by compiling both shapes, with a control shown to fail first:

- `z.number().int().min(1).max(5)` — assigning its inferred type to `IncomeTier` errors with `Type 'number' is not assignable to type 'IncomeTier'`, so the probe discriminates.
- `z.number().int().refine(isIncomeTier, …)` — assignable in **both** directions, so it infers exactly `IncomeTier`.

`.refine` is chosen over `z.union([z.literal(1), …])` specifically to keep the error message. A union would replace `Income tier must be 1-5` with Zod's literal-mismatch wording in the 400 response body. No test asserts that message today, so this is about what a client sees, not about a test.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/schemas.test.ts`:

```ts
describe('updateStudentSchema.incomeTier', () => {
  it('accepts every tier in range', () => {
    for (const tier of [1, 2, 3, 4, 5]) {
      expect(updateStudentSchema.safeParse({ incomeTier: tier }).success).toBe(true);
    }
  });

  it('rejects out-of-range and non-integer tiers', () => {
    for (const bad of [0, 6, -1, 3.5]) {
      expect(updateStudentSchema.safeParse({ incomeTier: bad }).success).toBe(false);
    }
  });

  it('keeps a message that names the range', () => {
    // A literal union would say "invalid literal value" instead. The wire
    // type is narrowed with .refine precisely to keep this readable.
    const result = updateStudentSchema.safeParse({ incomeTier: 9 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('1-5');
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/lib/schemas.test.ts`
Expected: the message test FAILS — the current schema emits Zod's default range wording, not a string containing `1-5`. The accept/reject tests pass already, which is correct: this change is about the *type*, and the runtime behaviour barely moves.

- [ ] **Step 3: Narrow the schema**

In `src/lib/schemas.ts`, add `import { isIncomeTier } from '@/lib/tiers';` and replace line 139:

```ts
  // `.refine` with a type predicate narrows the inferred type to IncomeTier
  // (verified by compiling both directions), so the wire type carries the
  // same constraint as the column and the engine. A literal union would
  // narrow too, but would replace this message with "invalid literal value".
  incomeTier: z.number().int().refine(isIncomeTier, {
    message: 'Income tier must be 1-5',
  }).optional(),
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run --project unit src/lib/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Narrow `TierBody` and prove the pin still holds**

In `src/components/student/tier-form.tsx`, add `type IncomeTier` to the `@/lib/tiers` import and change:

```ts
interface TierBody {
  incomeTier: IncomeTier;
}
```

The existing `#136` reverse pin at `:26` stays exactly as it is. Prove it still bites: temporarily add `foo: string;` to `TierBody` and run `npx tsc --noEmit`.

Expected: an error naming `foo`. Record it, remove the line, re-run clean.

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

Run: `npx vitest run --project unit` and `npx vitest run --project components`
Expected: PASS.

Run: `npx vitest run --project integration tests/integration/tier-selected-at.test.ts`
Expected: PASS — this file posts `{ incomeTier: 4 }` and `{ incomeTier: 5 }` through the route the schema guards, so it is the one integration file this change can break. One file by explicit path only.

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts src/components/student/tier-form.tsx
git commit -m "feat: the wire type for incomeTier is IncomeTier, not number (#39)"
```

---

## Final verification

Run before the whole-branch review, and report the actual numbers rather than "as expected":

```bash
npx tsc --noEmit
npm run lint
npx vitest run --project unit
npx vitest run --project components
npx playwright test
```

Baselines at the branch point: unit **450**, components **87**, e2e **118**. Unit gains Task 1's 10, Task 4's 1, and Task 6's 3 — so **464**, and if your number differs, say so and explain rather than adjusting the sentence.

The `integration` project (215 across 20 files) is **not** run in full. Three files were run by explicit path during this work: `account-api.test.ts` (Task 2), `income-tier-constraint.test.ts` (Task 3), `tier-selected-at.test.ts` (Task 6). Say so plainly in the PR rather than implying the project was covered.

Two final sweeps, because on five prior branches a correction landed in one artifact and stood in its twin:

```bash
grep -rn "Invalid tier" src/ tests/ docs/
grep -rn "studentPrices\|studentTierRatios" src/ tests/ docs/
```

Both should return only hits inside the spec and this plan where they describe the *former* state — and each of those must read as history, not as a description of current code. If either name still appears in `src/` or `tests/`, the migration away from it is incomplete.
