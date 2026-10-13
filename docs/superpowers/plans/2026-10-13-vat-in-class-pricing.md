# VAT in Class Pricing Implementation Plan (#819)

> Written before implementation; the code is authoritative where they differ.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A class and a class template carry a VAT %, and the pricing engine
adds VAT on top of room + teacher rate. Each student's VAT is calculated from
their own price. Completion stores it per payment and per class, and every
"you earn" figure is excl. VAT.

**Architecture:**
- First, one pure function owns "teacher earns", replacing four copies of a
  subtraction.
- Then four columns carry the percentage and the completion snapshots.
- The engine multiplies the class total by a VAT factor. At 0% that factor is
  exactly 1, so every existing result is bit-for-bit unchanged.
- Each student's VAT is extracted from their own cent-rounded price.
- Forms pre-fill from `Teacher.defaultVatPercent` (#833).
- Every display shows VAT only when the class's percentage is above 0.

**Tech Stack:** Next.js 16 App Router, Prisma + PostgreSQL, zod, vitest
(projects `unit`, `components`, `integration`), React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-13-vat-in-class-pricing-design.md`
(read it first. Its Premise check names where the issue was wrong).

## Global Constraints

- Node 24: prefix shell commands with `export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH`.
- Worktree `/Users/ivohofland/Projects/fair.yoga/.claude/worktrees/issue-819`,
  branch `feat/819-vat-in-class-pricing`. Before the first test run:
  1. `pnpm install --frozen-lockfile`
  2. `pnpm run worktree:setup`
  3. `pnpm run worktree:up`

  Integration and e2e read `INTEGRATION_BASE_URL` automatically. **Never
  touch `:3000`.**
- Column and wire key: `vatPercent` on `Class` and `ClassTemplate`. It is a
  JSON **number** on the wire, and 9 means 9%. Range 0–100, at most 3
  decimals, validated by the existing `vatPercentViolation`
  (`src/lib/vat.ts`).
- Money is integer cents in all new arithmetic. A percentage becomes integer
  thousandths (`vatThousandths`). No float percentage is multiplied into
  cents.
- **At 0%, nothing changes.** No existing money expectation in any test may be
  edited. The single allowed exception is Task 1's zero-charge
  `effectiveTeacherRate`. Membership lists such as `LOCKED_FIELDS`' `toEqual`
  are not money and do change.
- VAT lines and "excl./incl. VAT" labels render only when the relevant
  `vatPercent > 0`.
- Copy, verbatim:
  - Field label: `VAT %`
  - Field hint: `Included in student prices. Use 0 if you don't charge VAT.`
  - Room cost label when VAT > 0: `` `Room cost excl. VAT (${currencyLabel(currency)})` ``
  - Room cost hint when VAT > 0: `You reclaim the room's VAT in your own VAT return.`
  - Rate labels when VAT > 0: `` `Min rate excl. VAT (${…})` `` and `` `Target rate excl. VAT (${…})` ``
  - Rental rate hint (room settings, always shown): `If you charge VAT, enter it excl. VAT.`
  - Displays: `You earn (excl. VAT)`, `VAT (9%)`, `What students pay (incl. VAT)`,
    `Estimated earnings (excl. VAT)`, `Your earnings (excl. VAT)`,
    `Total revenue (incl. VAT)`, `VAT`
- Migrations: `pnpm exec prisma migrate dev --name <name> --create-only`, then
  hand-append, then `pnpm exec prisma migrate dev`. Never edit an applied
  migration, comments included.
- Comment discipline (CLAUDE.md): no counts or rosters in comments; a comment
  describes its own code.
- Stage exact paths. Quote paths containing parentheses. Never `git add -A`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A teacher at 0% sees exactly today's app.** Expected: every screen and
   number is unchanged. Pinned by the no-edited-expectations rule plus each
   display's "renders unchanged at 0%" test (Task 5).
2. **14.975% on a class.** Expected: the engine uses exactly 14975 thousandths
   and the total is `round(base × 1.14975)`. Pinned in Task 2 (unit) and
   Task 3 (engine).
3. **The VAT field cleared and saved.** `Number('')` is 0. Expected: saves 0,
   no error. This is the same convention #833 pinned for the profile. Pinned in
   Task 4's new-class form test.
4. **A template's VAT edited from 9 to 21.** Expected: classes already
   generated keep 9, and classes generated afterwards carry 21. Pinned in
   Task 4 (integration).
5. **A walk-in class over `maxStudents` at 9%.** Expected: Σ prices = total and
   each VAT ≤ its price, however many students. Pinned in Task 3 (engine, a
   15-student case).

---

### Task 1: One function for "teacher earns"

Behaviour-preserving, except for the zero-charge branch (spec Decision 1). This
lands before any VAT code.

**Files:**
- Create: `src/lib/teacher-earnings.ts`
- Create: `src/lib/teacher-earnings.test.ts`
- Modify: `src/lib/tier-estimates.ts` (`billAtLeastMinimum`)
- Modify: `src/components/class/pricing-breakdown.tsx`
- Modify: `src/lib/payment-breakdown.ts` (`resolvePaymentBreakdown`)
- Modify: `src/app/(teacher)/settings/reporting/page.tsx` (`classEarningsCents`)
- Modify: `src/services/class-lifecycle.ts` (`completeClass`, the
  `chargedRegistrations.length === 0` branch)
- Test: `src/services/class-lifecycle.test.ts` (`completeClass (DB)` describe)

**Interfaces:**
- Produces: `teacherEarningsCents(input: { totalCents: number; roomCents: number }): number`.
  Task 3 adds a required `vatCents`.

- [ ] **Step 1: Write the failing unit test** (`src/lib/teacher-earnings.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { teacherEarningsCents } from './teacher-earnings';

describe('teacherEarningsCents', () => {
  it('is what students paid less the room', () => {
    expect(teacherEarningsCents({ totalCents: 11000, roomCents: 3000 })).toBe(8000);
  });

  it('is negative when the room cost more than students paid', () => {
    expect(teacherEarningsCents({ totalCents: 0, roomCents: 3000 })).toBe(-3000);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run --project unit src/lib/teacher-earnings.test.ts`
Expected: FAIL, `Failed to resolve import "./teacher-earnings"`.

- [ ] **Step 3: Implement** (`src/lib/teacher-earnings.ts`, import-free so client components can use it)

```ts
/** A class's money, in whole cents, from which the teacher's share is derived. */
export interface EarningsInput {
  /** What the students were billed. */
  totalCents: number;
  roomCents: number;
}

/**
 * What the teacher keeps from a class. A subtraction rather than a stored
 * column, so the lines a screen shows always add up to its total; see
 * docs/superpowers/specs/2026-09-14-past-class-payment-breakdown-design.md.
 */
export function teacherEarningsCents({ totalCents, roomCents }: EarningsInput): number {
  return totalCents - roomCents;
}
```

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: PASS.

- [ ] **Step 5: Route the four subtraction sites through it**
  - `tier-estimates.ts`, in `billAtLeastMinimum`:
    `earningsCents: teacherEarningsCents({ totalCents: billedCents, roomCents: Math.round(input.roomCost * 100) })`.
  - `payment-breakdown.ts`:
    `teacherCents: teacherEarningsCents({ totalCents, roomCents })`.
  - `reporting/page.tsx`:
    `classEarningsCents = (c) => teacherEarningsCents({ totalCents: toCents(c.totalRevenue), roomCents: toCents(c.roomCost) })`.
  - `pricing-breakdown.tsx`: replace the float `totalRevenue - roomCost` with
    `teacherEarningsCents({ totalCents: Math.round(totalRevenue * 100), roomCents: Math.round(roomCost * 100) }) / 100`.

- [ ] **Step 6: Write the failing zero-charge test.** Add it to
  `completeClass (DB)` in `src/services/class-lifecycle.test.ts`, using the
  block's own `makeClass` helper. Create an `in_progress` class with
  `roomCost` 30 and no registrations, complete it, and read the row back:

```ts
it('stores the room as a loss when nobody was charged', async () => {
  const { id } = await makeClass({ status: 'in_progress' });
  await prisma.class.update({ where: { id }, data: { roomCost: 30 } });
  // complete it the way the block's other no-registration cases do
  const after = await prisma.class.findUniqueOrThrow({ where: { id } });
  expect(Number(after.totalRevenue)).toBe(0);
  expect(Number(after.effectiveTeacherRate)).toBe(-30);
});
```

Copy how sibling cases in that describe call `completeClass` (arguments and
clock), rather than inventing a call shape.

- [ ] **Step 7: Run it and see it fail**

Run: `pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts -t "stores the room as a loss"`
Expected: FAIL, `expected 0 to be -30`.

- [ ] **Step 8: Make the zero-charge branch call the function:**
  `effectiveTeacherRate: teacherEarningsCents({ totalCents: 0, roomCents: Math.round(Number(cls.roomCost) * 100) }) / 100`.
  Run Step 7's command again. Expected: PASS.

- [ ] **Step 9: Run every touched project.** No other expectation may change.

Run: `pnpm exec vitest run --project unit src/lib src/services/class-lifecycle.test.ts && pnpm exec vitest run --project components src/components/class src/components/student && pnpm exec vitest run --project integration tests/integration/reporting-page.test.ts tests/integration/bookings-page.test.ts tests/integration/pay-page.test.ts`
Expected: all PASS.

- [ ] **Step 10: Prove the guard bites.** In `billAtLeastMinimum`, temporarily
  restore the inline `billedCents - Math.round(input.roomCost * 100)` and
  break the function to `return totalCents;`. Run Step 9's unit command and
  record which tests fail, with their error text. Then restore. A
  zero-failure result means the function is not under test: stop and report.

- [ ] **Step 11: Commit**

```bash
git add src/lib/teacher-earnings.ts src/lib/teacher-earnings.test.ts src/lib/tier-estimates.ts src/lib/payment-breakdown.ts src/components/class/pricing-breakdown.tsx "src/app/(teacher)/settings/reporting/page.tsx" src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts
git commit -m "refactor: one function derives what a teacher earns from a class (#819)"
```

---

### Task 2: Columns, CHECKs and the VAT arithmetic

Must land before Tasks 3 and 4.

**Files:**
- Modify: `prisma/schema.prisma`
  - model `ClassTemplate`: `vatPercent` after `maxStudents`
  - model `Class`: `vatPercent` after `maxStudents`, `vatTotal` after `totalRevenue`
  - model `Payment`: `vatAmount` after `amount`
- Create: `prisma/migrations/<timestamp>_class_vat/migration.sql`
- Modify: `src/lib/vat.ts`, `src/lib/vat.test.ts`
- Create: `src/services/class-vat-constraints.test.ts`. A DB test, following
  `src/services/class-economics-constraints.test.ts`.

**Interfaces:**
- Produces:
  - `Class.vatPercent: Prisma.Decimal` (default 0)
  - `ClassTemplate.vatPercent: Prisma.Decimal` (default 0)
  - `Class.vatTotal: Prisma.Decimal | null`
  - `Payment.vatAmount: Prisma.Decimal` (default 0)
- Produces (`src/lib/vat.ts`):
  - `vatThousandths(percent: number): number`
  - `withVat(amount: number, thousandths: number): number`
  - `addedVatCents(baseCents: number, thousandths: number): number`
  - `includedVatCents(priceCents: number, thousandths: number): number`

- [ ] **Step 1: Schema.** Add these lines:
  - on `ClassTemplate` and `Class`: `vatPercent Decimal @default(0) @db.Decimal(6, 3)`
  - on `Class`: `vatTotal Decimal? @db.Decimal(10, 2)`
  - on `Payment`: `vatAmount Decimal @default(0) @db.Decimal(10, 2)`

- [ ] **Step 2: Generate, then hand-append.** Run
  `pnpm exec prisma migrate dev --name class_vat --create-only`. Then append
  the following to the generated `migration.sql`. **The backfill must come
  before the tether.** Developer and worktree databases hold completed
  classes, and without the backfill `ADD CONSTRAINT` fails on them.

```sql
-- Hand-authored: Prisma cannot express a CHECK.
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_vat_percent_range_check"
  CHECK ("vatPercent" >= 0 AND "vatPercent" <= 100);
ALTER TABLE "Class" ADD CONSTRAINT "Class_vat_percent_range_check"
  CHECK ("vatPercent" >= 0 AND "vatPercent" <= 100);

-- Every class completed before this migration was priced at 0% VAT.
UPDATE "Class" SET "vatTotal" = 0 WHERE "totalRevenue" IS NOT NULL;

ALTER TABLE "Class" ADD CONSTRAINT "Class_vat_total_nonnegative_check"
  CHECK ("vatTotal" >= 0);
ALTER TABLE "Class" ADD CONSTRAINT "Class_vat_total_snapshot_check"
  CHECK (("vatTotal" IS NULL) = ("totalRevenue" IS NULL));
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_vat_amount_range_check"
  CHECK ("vatAmount" >= 0 AND "vatAmount" <= "amount");
```

Then run `pnpm exec prisma migrate dev`. Expected: applied, client
regenerated.

- [ ] **Step 3: Make `completeClass` write `vatTotal`.** Before the tether can
  pass any test, the existing writers of `totalRevenue` must also write
  `vatTotal`:
  - Both `tx.class.update` calls in `completeClass` gain `vatTotal: 0`. Task 3
    replaces the billed one with the real sum.
  - Grep `totalRevenue:` across `src/`, `tests/` and `prisma/seed.ts`, and add
    `vatTotal` beside every **write**. Leave reads alone. In fixtures and the
    seed, write `vatTotal: 0` (or `'0'`) wherever `totalRevenue` is written
    non-null.
  - List each site in the commit body.

- [ ] **Step 4: Write the failing VAT arithmetic tests** (append to `src/lib/vat.test.ts`)

```ts
import { addedVatCents, includedVatCents, vatThousandths, withVat } from './vat';

describe('vatThousandths', () => {
  it.each([[0, 0], [9, 9000], [8.1, 8100], [14.975, 14975], [100, 100000]])(
    '%s%% is %s thousandths, exactly',
    (percent, expected) => expect(vatThousandths(percent)).toBe(expected),
  );
});

describe('withVat', () => {
  it('is the identity at 0%, bit for bit', () => {
    for (const amount of [0, 0.1, 46.666666666666664, 110, 1234.56]) {
      expect(withVat(amount, 0)).toBe(amount);
    }
  });
  it('adds 9% to the issue example', () => {
    expect(Math.round(withVat(110, 9000) * 100)).toBe(11990);
  });
  it('adds 14.975%', () => {
    expect(Math.round(withVat(100, 14975) * 100)).toBe(11498); // 114.975 → 11497.5 → half up
  });
});

describe('addedVatCents', () => {
  it('is 0 at 0%', () => expect(addedVatCents(11000, 0)).toBe(0));
  it('is 990 cents on €110 at 9%', () => expect(addedVatCents(11000, 9000)).toBe(990));
});

describe('includedVatCents', () => {
  it('is 0 at 0%', () => expect(includedVatCents(11990, 0)).toBe(0));
  it('takes the VAT back out of a VAT-inclusive price', () => {
    expect(includedVatCents(11990, 9000)).toBe(990);
  });
  it('never exceeds the price', () => {
    for (let cents = 0; cents <= 5000; cents++) {
      for (const t of [100, 9000, 14975, 21000, 100000]) {
        expect(includedVatCents(cents, t)).toBeLessThanOrEqual(cents);
      }
    }
  });
});
```

The `14.975%` case's comment claims half-up. Verify the actual value when
running Step 5. If float representation puts it on the other side of .5,
correct the expected value **and** the comment to what the code does, and say
so in the commit body.

- [ ] **Step 5: Run them and see them fail**

Run: `pnpm exec vitest run --project unit src/lib/vat.test.ts`
Expected: FAIL, `vatThousandths is not a function` (or the import error).

- [ ] **Step 6: Implement** (append to `src/lib/vat.ts`. `SCALE` is already defined there)

```ts
/** Hundred percent, in thousandths of a percent. */
const WHOLE = 100 * SCALE;

/** A percentage of at most `VAT_PERCENT_DECIMALS` decimals as whole thousandths: 14.975 → 14975. */
export function vatThousandths(percent: number): number {
  return Math.round(percent * SCALE);
}

/**
 * `amount` with VAT added. The factor is computed first so that at 0% it is
 * exactly 1 and the amount comes back unchanged, bit for bit.
 */
export function withVat(amount: number, thousandths: number): number {
  return amount * ((WHOLE + thousandths) / WHOLE);
}

/** The VAT added on top of a VAT-exclusive amount, in whole cents. */
export function addedVatCents(baseCents: number, thousandths: number): number {
  return Math.round((baseCents * thousandths) / WHOLE);
}

/** The VAT contained in a VAT-inclusive price, in whole cents. */
export function includedVatCents(priceCents: number, thousandths: number): number {
  return Math.round((priceCents * thousandths) / (WHOLE + thousandths));
}
```

- [ ] **Step 7: Run and see it pass.** Same command. Expected: PASS.

- [ ] **Step 8: Write the constraint tests** (`src/services/class-vat-constraints.test.ts`).
  Follow `class-economics-constraints.test.ts` for setup, fixtures and how it
  asserts a CHECK refusal (constraint name in the error). One case each:
  - `Class` with `vatPercent: 100.001` → refused by `Class_vat_percent_range_check`
  - `ClassTemplate` with `vatPercent: 100.001` → refused by `ClassTemplate_vat_percent_range_check`
  - `Class` updated to `totalRevenue: 10` with `vatTotal` left null → refused
    by `Class_vat_total_snapshot_check`
  - `Class` with `vatTotal: -1` beside `totalRevenue: 10` → refused by `Class_vat_total_nonnegative_check`
  - `Payment` with `amount: 5, vatAmount: 5.01` → refused by `Payment_vat_amount_range_check`
  - and the positives: `vatPercent: 100`, `vatPercent: 14.975` (reads back
    `14.975`), and a payment with `vatAmount === amount` are accepted

- [ ] **Step 9: Run them**

Run: `pnpm exec vitest run --project unit src/services/class-vat-constraints.test.ts`
Expected: PASS.

- [ ] **Step 10: Prove each CHECK bites.** For each constraint, drop it in the
  worktree database only:

  `pnpm exec prisma db execute --stdin <<< 'ALTER TABLE "Class" DROP CONSTRAINT "Class_vat_percent_range_check";'`

  Run Step 9 and record the failing case and its error text. After the last
  one, restore every constraint with `pnpm exec prisma migrate reset --force`
  (the worktree's own database), and re-run Step 9 green. No migration file is
  created or edited.

- [ ] **Step 11: Full unit run.** No money expectation may change.

Run: `pnpm exec vitest run --project unit`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/*_class_vat src/lib/vat.ts src/lib/vat.test.ts src/services/class-vat-constraints.test.ts src/services/class-lifecycle.ts
# plus every vatTotal site from Step 3, by exact path
git commit -m "feat: VAT columns on class, template and payment, and the VAT arithmetic (#819)"
```

---

### Task 3: The engine charges VAT and completion records it

**Files:**
- Modify:
  - `src/services/pricing.ts`
  - `src/lib/tier-estimates.ts`
  - `src/lib/price-line.ts`
  - `src/lib/teacher-earnings.ts`
  - `src/services/class-lifecycle.ts` (`completeClass`)
  - `src/lib/payment-breakdown.ts`
  - `src/components/class/pricing-breakdown.tsx`
  - `src/app/(teacher)/settings/reporting/page.tsx`
- Modify, wherever the compiler names them: every caller that builds a
  `ClassPricingInput`, `TierEstimateInput`, `ResolvePriceLineInput` or
  `billAtLeastMinimum` input from a class row. Each adds
  `vatPercent: Number(cls.vatPercent)` and, where the row comes from a
  `select`, `vatPercent: true`. The spec's census lists:
  - `src/app/(public)/[slug]/page.tsx`
  - `src/app/(public)/[slug]/book/[classId]/page.tsx`
  - `src/app/(student)/bookings/page.tsx`
  - `src/components/class/pricing-preview.tsx`

  Trust `pnpm exec tsc --noEmit` over this list.
- Test:
  - `src/services/pricing.test.ts`
  - `src/lib/tier-estimates.test.ts`
  - `src/lib/teacher-earnings.test.ts`
  - `src/services/class-lifecycle.test.ts`

**Interfaces:**
- Consumes: `vatThousandths`, `withVat`, `includedVatCents` (Task 2); `teacherEarningsCents` (Task 1).
- Produces:
  - `ClassPricingInput.vatPercent: number` (required)
  - `PricedStudent.vat: number` (currency units, like `price`)
  - `Billing.vatCents: number` (billed students only)
  - `TierEstimateInput.vatPercent: number`
  - `ResolvePriceLineInput.vatPercent: number`
  - `EarningsInput.vatCents: number` (required)

- [ ] **Step 1: Write the failing engine tests** (`src/services/pricing.test.ts`, new describe)

```ts
describe('calculateClassPricing with VAT', () => {
  const full = (n: number): IncomeTier[] => Array.from({ length: n }, () => 3 as IncomeTier);
  const base = { roomCost: 30, minRate: 40, targetRate: 80, minStudents: 4, maxStudents: 12 };

  it('prices the issue example: €30 room + €80 rate at 9% totals €119.90', () => {
    const r = calculateClassPricing({ ...base, vatPercent: 9, studentTiers: full(12) });
    const cents = r.students.reduce((s, p) => s + Math.round(p.price * 100), 0);
    expect(cents).toBe(11990);
  });

  it('gives each student the VAT contained in their own price', () => {
    const r = calculateClassPricing({ ...base, vatPercent: 9, studentTiers: [1, 2, 3, 4, 5] });
    for (const s of r.students) {
      expect(Math.round(s.vat * 100)).toBe(includedVatCents(Math.round(s.price * 100), 9000));
    }
  });

  it('keeps Σ prices = total and VAT ≤ price for a walk-in class over max', () => {
    const tiers: IncomeTier[] = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
    const r = calculateClassPricing({ ...base, vatPercent: 14.975, studentTiers: tiers });
    const cents = r.students.reduce((s, p) => s + Math.round(p.price * 100), 0);
    expect(cents).toBe(Math.round(r.totalCost * 100));
    for (const s of r.students) expect(s.vat).toBeLessThanOrEqual(s.price);
    const vatCents = r.students.reduce((s, p) => s + Math.round(p.vat * 100), 0);
    const exact = (r.totalCost * 100 * 14975) / 114975;
    expect(Math.abs(vatCents - exact)).toBeLessThanOrEqual(0.5 * tiers.length);
  });

  it('is unchanged at 0% and carries zero VAT', () => {
    const at0 = calculateClassPricing({ ...base, vatPercent: 0, studentTiers: [1, 3, 5] });
    expect(at0.totalCost).toBe(base.roomCost + at0.effectiveTeacherRate);
    for (const s of at0.students) expect(s.vat).toBe(0);
  });
});
```

Existing `calculateClassPricing` calls in this file and elsewhere gain
`vatPercent: 0`. That is an input addition, not an expectation change.

- [ ] **Step 2: Run and see it fail**

Run: `pnpm exec vitest run --project unit src/services/pricing.test.ts`
Expected: FAIL (a type error on `vatPercent`, or `vat` undefined).

- [ ] **Step 3: Implement in `pricing.ts`**
  - `ClassPricingInput` gains `vatPercent: number`.
  - `PricedStudent` gains `/** The VAT contained in \`price\`. */ vat: number`.
  - The empty-tiers early return is unchanged.
  - Step 2 of the function becomes
    `const t = vatThousandths(vatPercent); const totalCost = withVat(roomCost + effectiveTeacherRate, t);`
    and its comment says VAT is added on top of room + rate. The
    largest-remainder block is untouched.
  - The `students` map adds `vat: includedVatCents(a.cents, t) / 100`.
  - Update the function's docblock formula to
    `total_class_cost = (room_cost + effective_teacher_rate) × (1 + VAT)`.
  - `pricing.ts` may import `@/lib/vat`. It is import-free apart from
    constants, so client import stays safe. Check: `vat.ts` has no imports.

- [ ] **Step 4: Run Step 2's command.** Expected: PASS.

- [ ] **Step 5: Write the failing billing test** (`src/lib/tier-estimates.test.ts`)

```ts
it('charges VAT on billed students only, never on padding seats', () => {
  // 2 real students in a class whose minimum is 4: two padding seats are priced but billed to no one.
  const b = billAtLeastMinimum(
    { roomCost: 30, minRate: 40, targetRate: 80, minStudents: 4, maxStudents: 12, vatPercent: 9 },
    [3, 3],
  );
  expect(b.billed).toHaveLength(2);
  const billedVat = b.billed.reduce((s, p) => s + Math.round(p.vat * 100), 0);
  expect(b.vatCents).toBe(billedVat);
  expect(b.earningsCents).toBe(b.billedCents - 3000 - b.vatCents);
});
```

And in `teacher-earnings.test.ts`, the existing cases gain `vatCents: 0`, plus:

```ts
it('takes the VAT out as well as the room', () => {
  expect(teacherEarningsCents({ totalCents: 11990, roomCents: 3000, vatCents: 990 })).toBe(8000);
});
```

- [ ] **Step 6: Run and see them fail**

Run: `pnpm exec vitest run --project unit src/lib/tier-estimates.test.ts src/lib/teacher-earnings.test.ts`
Expected: FAIL.

- [ ] **Step 7: Implement**
  - `EarningsInput` gains required `vatCents: number`, and the function
    returns `totalCents - roomCents - vatCents`. Its docblock mentions VAT.
  - `Billing` gains `/** The VAT contained in what the billed students pay, in whole cents. */ vatCents: number`.
    `billAtLeastMinimum` computes
    `const vatCents = billed.reduce((sum, s) => sum + Math.round(s.vat * 100), 0);`
    and passes it to `teacherEarningsCents`.
  - `TierEstimateInput` and `ResolvePriceLineInput` gain `vatPercent: number`,
    passed through to every `calculateClassPricing` call.
  - Every other `teacherEarningsCents` caller from Task 1 now fails to compile.
    Pass the real VAT:
    - `payment-breakdown.ts`: its input gains `vatTotal: Prisma.Decimal | null`.
      A null `vatTotal` is part of the `snapshot_missing` check, the same as
      `totalRevenue`. `vatCents = toCents(vatTotal)`.
    - `pricing-breakdown.tsx`: `Math.round(Number(cls.vatTotal ?? 0) * 100)`.
    - Reporting: select `vatTotal`; pass `toCents(c.vatTotal)`.
    - Zero-charge branch: `vatCents: 0`, and it already writes `vatTotal: 0`.
  - Follow `pnpm exec tsc --noEmit` until clean, adding
    `vatPercent: Number(cls.vatPercent)` (and `vatPercent: true` in `select`s)
    where it points. The callers of `resolvePaymentBreakdown`
    (`(student)/bookings/page.tsx` and `bookings/[classId]/pay/page.tsx`)
    select and pass `vatTotal`.

- [ ] **Step 8: Run Step 6's command.** Expected: PASS.

- [ ] **Step 9: Write the failing completion test** (`completeClass (DB)` describe)

```ts
it('records each payment\'s VAT, the class total, and earnings excl. VAT', async () => {
  // A class at 9% with three charged registrations (tiers 1, 3, 5), built the
  // way this describe's other billed cases build theirs, with `vatPercent: 9`.
  // ... complete it ...
  const payments = await prisma.payment.findMany({ where: { registration: { classId: id } } });
  const after = await prisma.class.findUniqueOrThrow({ where: { id } });
  const vatCents = payments.reduce((s, p) => s + Math.round(Number(p.vatAmount) * 100), 0);
  expect(vatCents).toBeGreaterThan(0);
  for (const p of payments) {
    expect(Math.round(Number(p.vatAmount) * 100)).toBe(includedVatCents(Math.round(Number(p.amount) * 100), 9000));
  }
  expect(Math.round(Number(after.vatTotal) * 100)).toBe(vatCents);
  expect(Math.round(Number(after.effectiveTeacherRate) * 100)).toBe(
    Math.round(Number(after.totalRevenue) * 100) - Math.round(Number(after.roomCost) * 100) - vatCents,
  );
});
```

Build the class and registrations exactly as the nearest existing billed case
in that describe does. Do not invent fixtures.

- [ ] **Step 10: Run and see it fail**

Run: `pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts -t "records each payment"`
Expected: FAIL (`vatAmount` 0, or `vatTotal` 0).

- [ ] **Step 11: Implement in `completeClass`**
  - Pass `vatPercent: Number(cls.vatPercent)` to `billAtLeastMinimum`. Make
    sure the class read includes the column. A Prisma `include` read gets it
    automatically; a `select` needs it added.
  - Destructure `vatCents`.
  - Write `vatTotal: vatCents / 100` beside `totalRevenue`.
  - `payment.create` gains `vatAmount: s.vat`.
  - The completion notification's earnings figure already comes from
    `earningsCents`, so leave its copy alone.

- [ ] **Step 12: Run Step 10's command.** Expected: PASS.

- [ ] **Step 13: Prove the padding guard bites.** In `billAtLeastMinimum`,
  temporarily sum `vatCents` over `pricing.students` (padded) instead of
  `billed`. Run Step 6's command and record the failing test and its text,
  then restore. If nothing fails, the padding test is not padding: fix it.

- [ ] **Step 14: Whole suite, nothing re-baselined**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project unit && pnpm exec vitest run --project components && pnpm exec vitest run --project integration`
Expected: all PASS, with no existing money expectation edited. `git diff` on
test files shows only added `vatPercent: 0` / `vatTotal` inputs and new tests.

- [ ] **Step 15: Commit**, staging every file `git status` shows modified for
  this task, by exact path:

```bash
git commit -m "feat: the pricing engine adds VAT and completion records it per payment and per class (#819)"
```

---

### Task 4: The VAT field on the wire, in the forms, and stamped by templates

The wire and forms are one task. The `NoneOf` pins tie each form's values to
its zod schema in both directions, so one without the other fails typecheck.

**Files:**
- Modify:
  - `src/lib/schemas.ts` (four schemas)
  - `src/lib/class-fields.ts` (`ECONOMIC_FIELDS`)
  - `src/lib/db-locks.ts` (`lockTeacherForShare` return)
  - `src/app/api/classes/route.ts` (create)
  - `src/services/class-template-lifecycle.ts`: `createClassTemplate`, and the
    `TeacherEditableClassTemplateField` allowlist
  - `src/services/class-lifecycle.ts` (`TeacherEditableClassField`)
  - `src/services/class-generator.ts` (`createChildren`)
- Modify (forms and pages):
  - `src/app/(teacher)/class/new/page.tsx` and `new-class-form.tsx`
  - `src/app/(teacher)/class/[id]/edit/page.tsx`
  - `src/components/class/class-edit-form.tsx`
  - `src/app/(teacher)/settings/recurring/new/page.tsx`
  - `src/app/(teacher)/settings/recurring/[id]/page.tsx`
  - `src/components/settings/template-form.tsx`
- Modify (room settings hint): the three `Rental rate` inputs.
  `grep -rn "Rental rate" src` finds them; the census names `edit-room-form.tsx`,
  `edit-teacher-room-form.tsx` and `room-settings-step.tsx`.
- Create: `src/lib/teacher-vat.server.ts`, a sibling of `teacher-currency.server.ts`
- Test:
  - `src/lib/schemas.test.ts`
  - `src/services/class-lifecycle.test.ts` (the `LOCKED_FIELDS` `toEqual` pin)
  - `tests/integration/classes-api.test.ts`
  - `tests/integration/class-templates-api.test.ts`
  - `src/services/class-generator.test.ts`
  - the three form component tests (`new-class-form`, `class-edit-form.test.tsx`, `template-form.test.tsx`)

**Interfaces:**
- Consumes: `vatPercentViolation` (existing), the columns from Task 2.
- Produces:
  - `lockTeacherForShare(...): Promise<{ currency: Currency; defaultVatPercent: Prisma.Decimal } | null>`
  - `teacherDefaultVatPercent(teacherId: string): Promise<number>`
  - each form gains a `vatPercent: number` value
  - `NewClassForm` and `TemplateForm` (create mode) take a `defaultVatPercent: number` prop

- [ ] **Step 1: Write the failing schema tests** (`src/lib/schemas.test.ts`).
  For each of the four schemas:
  - `vatPercent: 9` and `vatPercent: 14.975` parse
  - `"9"`, `-1`, `100.001` and `8.1234` are refused, with
    `vatPercentViolation`'s messages where applicable (a string fails zod's
    number check)
  - for both create schemas, an omitted `vatPercent` parses, with
    `vatPercent` undefined

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run --project unit src/lib/schemas.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the field.** In `schemas.ts`, extract the teacher schema's
  inline VAT validator into one helper and reuse it:

```ts
const vatPercentField = () =>
  z.number().superRefine((v, ctx) => {
    const message = vatPercentViolation(v);
    if (message) ctx.addIssue({ code: 'custom', message });
  });
```

- `updateTeacherSchema.defaultVatPercent` becomes `vatPercentField().optional()`.
- All four class/template schemas gain `vatPercent: vatPercentField().optional()`,
  placed after `maxStudents`.

Then run `pnpm exec tsc --noEmit`. The `NoneOf` pins in the three forms and
the two allowlists now name `vatPercent`. That is expected. Steps 4–8 satisfy
them.

- [ ] **Step 4: The services and the server default**
  - `lockTeacherForShare`: `SELECT currency, "defaultVatPercent" FROM "Teacher" …`,
    with return type `{ currency: Currency; defaultVatPercent: Prisma.Decimal }`.
    Check that `$queryRaw` returns a `Prisma.Decimal` for `numeric` with a
    one-line probe in the integration test of Step 6. If it returns a string
    instead, type it as `string` and convert with `new Prisma.Decimal(...)`.
  - Create route: `vatPercent: body.vatPercent ?? teacher.defaultVatPercent`.
  - `createClassTemplate`: keep the lock's return value
    (`const teacher = await lockTeacherForShare(...)`), then
    `vatPercent: input.vatPercent ?? teacher.defaultVatPercent`.
  - `createChildren`: `vatPercent: template.vatPercent`, beside the other
    economics.
  - `ECONOMIC_FIELDS` gains `'vatPercent'` after `'maxStudents'`. Update the
    `toEqual` pin in `class-lifecycle.test.ts`. That is a membership change,
    not a money one.
  - Both editable-field allowlists gain `'vatPercent'`.

  Note: `updateChild` and `updateClass` feed `economicsViolations` from a
  hand-written select of the cross-field economics. VAT is not part of those
  rules, so those selects stay as they are. `ECONOMIC_FIELDS`' number check in
  `updateChild` covers `vatPercent` for free.

- [ ] **Step 5: Run `pnpm exec tsc --noEmit`.** Only the three forms' pins should remain.

- [ ] **Step 6: Write the failing integration tests**
  - `tests/integration/classes-api.test.ts`:
    - (a) a teacher whose `defaultVatPercent` is 9 creates a class without
      `vatPercent`, and the row reads 9
    - (b) the same teacher creates with `vatPercent: 21`, and the row reads 21
    - (c) `vatPercent: "9"` → 400
    - (d) a class with `settingsLocked: true` PUT with `vatPercent: 21` → 409
      with code `SETTINGS_LOCKED` (assert the code, not the message), and an
      unlocked one → 200 and the row reads 21
  - `tests/integration/class-templates-api.test.ts`:
    - (e) create without `vatPercent` → the teacher's default
    - (f) a template at 9 generates classes at 9; PUT `vatPercent: 21`;
      existing generated classes still read 9; classes generated after (run
      the generator the way neighbouring tests do) read 21
  - `src/services/class-generator.test.ts`:
    - (g) a template with `vatPercent: 9` stamps classes with `vatPercent` 9

  Run: `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts tests/integration/class-templates-api.test.ts && pnpm exec vitest run --project unit src/services/class-generator.test.ts`
  Expected: PASS for what Step 4 already wired. **Before Step 4's code is in
  place these fail**; the order here follows the typecheck, and the bite
  proofs are in Step 11.

- [ ] **Step 7: Pre-fill**
  - `src/lib/teacher-vat.server.ts`: `teacherDefaultVatPercent(teacherId)`
    reads `defaultVatPercent` with `findUniqueOrThrow` and returns
    `.toNumber()`. Same shape as `teacherCurrency`.
  - `class/new/page.tsx` and `settings/recurring/new/page.tsx` pass
    `defaultVatPercent={await teacherDefaultVatPercent(session.teacherId)}`.
  - The edit pages pass `vatPercent: cls.vatPercent.toNumber()` (or the
    template's) in their `initial`.

- [ ] **Step 8: The forms.** In each of the three forms:
  - The value type and initial state gain `vatPercent`. `NewClassForm` seeds
    it from the `defaultVatPercent` prop
    (`{ ...INITIAL_FORM, vatPercent: defaultVatPercent }`).
    `TemplateForm` create mode does the same; edit mode reads `initial`.
  - Add the field directly after `roomCost`, in the same row grid, following
    the profile's VAT input:

```tsx
<NumberInput
  id="vatPercent"
  label="VAT %"
  decimals={Infinity}
  value={form.vatPercent}
  onValueChange={(n) => updateField('vatPercent', n)}
  hint="Included in student prices. Use 0 if you don't charge VAT."
  error={errors.vatPercent}
/>
```

  - Client validation: wherever the form validates economics before submit,
    add `vatPercentViolation(form.vatPercent)` into `errors.vatPercent`.
  - Conditional labels, with `const chargesVat = form.vatPercent > 0;`:
    - room cost label
      `` chargesVat ? `Room cost excl. VAT (${currencyLabel(currency)})` : `Room cost (${currencyLabel(currency)})` ``,
      with hint `chargesVat ? "You reclaim the room's VAT in your own VAT return." : undefined`
    - min/target rate labels gain ` excl. VAT` the same way
  - The new-class review step ("Room cost … · Rate …") appends
    `` · VAT {form.vatPercent}% `` when `chargesVat`.
  - The three `Rental rate` inputs gain
    `hint="If you charge VAT, enter it excl. VAT."`.

  Then `pnpm exec tsc --noEmit`. Expected: clean.

- [ ] **Step 9: Write the form component tests**, one block per form test file:
  - New class (and template create): rendered with `defaultVatPercent={9}`,
    the `VAT %` input shows `9`.
  - Clearing the VAT input and submitting sends `vatPercent: 0` (Review
    Focus 3). Assert on the request body the test's fetch mock captures, as
    sibling tests do.
  - At 0, the room cost label reads `Room cost (€)` with no hint. After typing
    9, it reads `Room cost excl. VAT (€)` and shows the reclaim hint.
  - Edit forms: `initial.vatPercent: 21` shows `21`.

  Run: `pnpm exec vitest run --project components src/components/class src/components/settings "src/app/(teacher)/class/new"`
  Expected: PASS.

- [ ] **Step 10: Room settings.** Run the rooms' component tests unchanged.
  The hint is additive, so they should pass. If a test snapshots the whole
  field, update it and name it in the commit body.

- [ ] **Step 11: Prove each guard bites.** Record the failing test and its
  text for each, then restore:
  1. Drop `vatPercent: template.vatPercent` from `createChildren`, so (g) and
     (f) fail with 0 ≠ 9.
  2. Drop `'vatPercent'` from `ECONOMIC_FIELDS`, so (d) answers 200 instead
     of 409. Do this with the allowlist still listing it.
  3. Replace `body.vatPercent ?? teacher.defaultVatPercent` with
     `body.vatPercent ?? 0`, so (a) fails with 0 ≠ 9. Do the same for
     `createClassTemplate`, so (e) fails.

  Warm the touched routes with a `curl` after each mutation before judging, as
  the hazard list says.

- [ ] **Step 12: Commit**, staging exact paths, with parenthesised paths quoted:

```bash
git commit -m "feat: classes and templates carry a VAT %, pre-filled from the teacher's default (#819)"
```

---

### Task 5: The displays

**Files:**
- Modify:
  - `src/components/class/pricing-preview-result.tsx`
  - `src/components/class/pricing-preview-table.tsx`
  - `src/components/landing/landing-pricing-demo.tsx`
  - the three forms, which pass `vatPercent={form.vatPercent}` to `PricingPreviewTable`
  - `src/components/class/pricing-preview.tsx`
  - `src/components/class/pricing-breakdown.tsx`
  - `src/lib/payment-breakdown.ts`
  - `src/components/student/payment-breakdown.tsx`
- Test: each component's existing `.test.tsx`, and `src/lib/payment-breakdown.test.ts`

**Interfaces:**
- Consumes: `withVat`, `addedVatCents`, `vatThousandths` (Task 2);
  `Billing.vatCents` (Task 3); `Class.vatTotal` and `Class.vatPercent`.
- Produces:
  - `PricingPreviewInputs.vatPercent: number` (required)
  - `PaymentBreakdownLines.vatCents: number`
  - `ResolvePaymentBreakdownInput.vatPercent: number`

- [ ] **Step 1: Write the failing component tests.** For each display, add two
  cases: (a) at `vatPercent: 0` the rendered text contains no `VAT`
  (`expect(screen.queryByText(/VAT/)).toBeNull()`), and the existing numbers
  are untouched; (b) at 9% the VAT lines show. Concretely:
  - `PricingPreviewResult`, room 30, min = target 80, at 9%:
    - `You earn (excl. VAT)` is followed by `€80.00`
    - `VAT (9%)` is followed by `€9.90`
    - `Total class cost` is followed by `€119.90`
    - the heading `What students pay (incl. VAT)` is present
  - `PricingPreview` (overview) at 9%:
    - `Estimated earnings (excl. VAT)` equals `billAtLeastMinimum`'s
      `earningsCents / 100` for the same input (compute it in the test)
    - a `VAT` row equals its `vatCents / 100`
  - `PricingBreakdown` with `totalRevenue 119.90`, `roomCost 30`,
    `vatTotal 9.90`, `vatPercent 9`:
    - `Your earnings (excl. VAT)` is `€80.00`
    - the `VAT` row is `€9.90`
    - `Total revenue (incl. VAT)` is `€119.90`
  - `resolvePaymentBreakdown` (unit) with the same snapshot:
    - `lines.vatCents === 990`
    - `lines.roomCents + lines.vatCents + lines.teacherCents === lines.totalCents`
  - The student `PaymentBreakdown` component shows a `VAT` row between Room
    and Teacher at 9%, and none at 0%.
  - `PricingPreviewTable` with `vatPercent: 100.001` renders the gate, not a
    result. Follow the existing economics-gate test's assertion.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run --project components src/components/class src/components/student src/components/landing && pnpm exec vitest run --project unit src/lib/payment-breakdown.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - **`PricingPreviewResult`:**
    - `PricingPreviewInputs` gains `vatPercent: number`.
    - Compute `const t = vatThousandths(vatPercent); const chargesVat = t > 0;`
      and `const baseCents = Math.round((roomCost + teacherRate) * 100); const vatCents = addedVatCents(baseCents, t);`.
    - When `chargesVat`, `totalCost` (the displayed line) is
      `(baseCents + vatCents) / 100`. Otherwise it stays `roomCost + teacherRate`
      as today.
    - Tier prices use `tierPrices(withVat(roomCost + teacherRate, t), distribution)`,
      which is identical to today at 0%.
    - When `chargesVat`:
      - the label `You earn` becomes `You earn (excl. VAT)`
      - the caption `Room cost` becomes `Room cost (excl. VAT)`
      - a caption block `VAT (${vatPercent}%)` showing
        `formatMoney(vatCents / 100, currency)` sits between Room cost and
        Total class cost
      - the heading becomes `What students pay (incl. VAT)`
  - **`PricingPreviewTable`:** accepts and forwards `vatPercent`. Its gate
    also closes when `vatPercentViolation(vatPercent) !== null`, the same way
    it closes on `economicsViolations`. The three forms pass `vatPercent`.
  - **Landing demo:** `EXAMPLE` gains `vatPercent: 0`. No other change.
  - **`PricingPreview`:**
    - destructure `vatCents` from `billAtLeastMinimum`
    - with `const chargesVat = Number(cls.vatPercent) > 0`:
      - the heading reads `Estimated earnings (excl. VAT)`
      - a `VAT` row (`formatMoney(vatCents / 100, …)`) follows Room cost
      - the Rate row's label reads `Rate (excl. VAT)`
  - **`PricingBreakdown`:** with `chargesVat`:
    - the heading reads `Your earnings (excl. VAT)`
    - a `VAT` row from `vatTotal` follows Room cost
    - `Total revenue` reads `Total revenue (incl. VAT)`
  - **`payment-breakdown.ts`:**
    - the input gains `vatPercent: number`
    - `lines` gains `vatCents`
    - the component renders the `VAT` row when `vatPercent > 0`
    - its two page callers pass `vatPercent: Number(cls.vatPercent)` and
      select it

- [ ] **Step 4: Run Step 2's command.** Expected: PASS.

- [ ] **Step 5: Visual snapshots.** `tests/e2e/visual.spec.ts` builds its own
  fixtures rather than reading the seed, and those are at 0%. So
  `landing.png` and `class-detail-open.png` must not change. Run
  `pnpm exec playwright test tests/e2e/visual.spec.ts` against the worktree
  app. Expected: PASS with no re-baseline. A diff here is a 0% regression:
  stop and report.

- [ ] **Step 6: Whole suite**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project unit && pnpm exec vitest run --project components && pnpm exec vitest run --project integration`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: pricing displays show VAT beside room and earnings when a class charges it (#819)"
```

---

### Task 6: Export, seed, docs

**Files:**
- Modify:
  - `src/services/gdpr.ts`, `src/services/gdpr.test.ts`
  - `prisma/seed.ts`
  - `docs/product-concept.md` (Income-Based Pricing Engine)
  - `docs/data-model.md` (the `Class`, `ClassTemplate` and `Payment` tables)

- [ ] **Step 1: GDPR, test first**
  - In `gdpr.test.ts`, assert that the teacher export's class entry carries
    `vatPercent` and `vatTotal`, its template entry carries `vatPercent`, and
    the student export's payment carries `vatAmount`.
  - Run `pnpm exec vitest run --project unit src/services/gdpr.test.ts`.
    Expected: FAIL on the class and payment fields. The template field may
    already pass through the row spread; if so, say so.
  - Then add `vatPercent: c.vatPercent, vatTotal: c.vatTotal` to the classes'
    explicit list and `vatAmount: true` to the student export's payment
    select. Run again. Expected: PASS.

- [ ] **Step 2: Seed**
  - Ivo's `teacher.create` gains `defaultVatPercent: 9`. Sarah and Maya are
    unchanged (0).
  - `vinyasaTemplate` gains `vatPercent: 9`.
  - One upcoming Ivo class gains `vatPercent: 21`. Pick a draft or open one
    with no registrations, so the edit form shows a non-default value.
  - Add one completed Ivo class at 9% through `createCompletedClass`, with a
    few charged registrations across tiers. Its numbers come from the engine,
    not literals:

```ts
import { billAtLeastMinimum } from '@/lib/tier-estimates';
// …
const vatEconomics = { roomCost: 30, minRate: 40, targetRate: 80, minStudents: 4, maxStudents: 12, vatPercent: 9 };
const vatTiers: IncomeTier[] = [1, 2, 3, 3, 4, 5];
const vatBill = billAtLeastMinimum(vatEconomics, vatTiers);
// createCompletedClass(..., { effectiveTeacherRate: String(vatBill.earningsCents / 100),
//   totalStudents: vatTiers.length, totalRevenue: String(vatBill.billedCents / 100),
//   vatTotal: String(vatBill.vatCents / 100) })
// then one registration per vatBill.billed[i] with price/tierRatio from it, and a
// payment with amount: s.price, vatAmount: s.vat
```

  - `createCompletedClass`'s `totals` parameter gains `vatTotal: string`, and
    Task 2 already set it at the existing call sites.
  - Run `pnpm exec prisma migrate reset --force` in the worktree, which
    re-seeds. Expected: no error. Then
    `psql` via the worktree database, or a `prisma.class.findFirst` script:
    the 9% completed class's `totalRevenue − roomCost − vatTotal` equals its
    `effectiveTeacherRate`.

- [ ] **Step 3: Docs**
  - `docs/product-concept.md`, under Income-Based Pricing Engine:
    - the formula
      `total = (room_cost + effective_teacher_rate) × (1 + VAT%)`
    - "each student's VAT is the VAT contained in their own price, and the
      class VAT is their sum; the teacher absorbs the cent or two this
      rounding moves"
    - "room cost is entered excl. VAT when the teacher charges VAT"
    - the worked example: room €30, rate €80, 9%:
      30 + 80 = €110; VAT €9.90; total €119.90; teacher earns €80
    - Add `vatPercent` to that section's list of fields frozen by the
      settings lock.
  - `docs/data-model.md`: rows for `Class.vatPercent`, `Class.vatTotal`,
    `ClassTemplate.vatPercent` and `Payment.vatAmount`, each naming its CHECK.
    `vatTotal`'s row states the snapshot tether, and `effectiveTeacherRate`'s
    row is corrected to say it stores earnings (total − room − VAT).
  - Grep CLAUDE.md's Pricing Engine bullets for `total = room_cost +
    effective_teacher_rate`. If present, update the formula and add the VAT
    clause; it is a reference doc the next session loads.

- [ ] **Step 4: Full verify**

Run: `pnpm run verify`
Expected: green. Record the per-project counts for the PR body.

- [ ] **Step 5: Commit**

```bash
git commit -m "docs: VAT in the pricing concept, data model and seed (#819)"
```
