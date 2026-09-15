# Signed Euro Formatter (#599) Implementation Plan

**Goal:** One signed-euro formatter in `src/lib/format.ts` (`formatCents`, `formatEuro`), formatting negative amounts as `−€X.XX` (U+2212 before the currency symbol) and zero as `€0.00` (never `−€0.00` or `€-0.00`). Accumulate reporting earnings in whole cents to eliminate float drift.

**Architecture:**
- `formatCents(cents: number): string` in `src/lib/format.ts` (pure function, zero dependencies, client-safe).
- `formatEuro(euros: number): string` in `src/lib/format.ts` (convenience helper wrapping `formatCents(Math.round(euros * 100))`).
- Replace local `formatCents` in `src/components/student/payment-breakdown.tsx`.
- Replace inline/local euro formatting in `pricing-breakdown.tsx`, `pricing-preview-table.tsx`, `pricing-preview.tsx`, `class/new/page.tsx`, and `class-lifecycle.ts`.
- Refactor `src/app/(teacher)/settings/reporting/page.tsx` to accumulate class and studio earnings in whole cents.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Vitest (unit, components, integration).

---

## File Structure

- Modify: `src/lib/format.ts` — add `formatCents` and `formatEuro`.
- Modify: `src/lib/format.test.ts` — unit tests for both formatters.
- Modify: `src/components/student/payment-breakdown.tsx` — replace local `formatCents` with import from `@/lib/format`.
- Modify: `src/components/class/pricing-breakdown.tsx` — use `formatEuro`.
- Create: `src/components/class/pricing-breakdown.test.tsx` — component tests for pricing breakdown.
- Modify: `src/components/class/pricing-preview-table.tsx` — use `formatEuro` from `@/lib/format`.
- Modify: `src/components/class/pricing-preview.tsx` — use `formatEuro`.
- Create: `src/components/class/pricing-preview.test.tsx` — component tests for pricing preview.
- Modify: `src/app/(teacher)/class/new/page.tsx` — use `formatEuro` for rate range.
- Modify: `src/services/class-lifecycle.ts` — use `formatEuro` for completion notification.
- Modify: `src/services/class-lifecycle.test.ts` — test completion notification with negative earnings.
- Modify: `src/app/(teacher)/settings/reporting/page.tsx` — accumulate in whole cents and format via `formatCents`.
- Modify: `tests/integration/reporting-page.test.ts` — add tests for zero float cancellation and negative earnings month.

---

### Task 1: Add `formatCents` and `formatEuro` to `src/lib/format.ts`

**Files:**
- Modify: `src/lib/format.ts`
- Modify: `src/lib/format.test.ts`

- [ ] **Step 1: Write failing unit tests in `src/lib/format.test.ts`**

Add tests covering:
- Positive whole cents: `formatCents(4000) === '€40.00'`
- Padded single-digit cents: `formatCents(5) === '€0.05'`
- Negative whole cents: `formatCents(-400) === '−€4.00'` (U+2212)
- Zero cents: `formatCents(0) === '€0.00'`
- Negative zero cents: `formatCents(-0) === '€0.00'`
- Near-zero float: `formatCents(-7.1054e-15) === '€0.00'`
- Sub-cent rounding: `formatCents(399.6) === '€4.00'`
- `formatEuro`: positive `formatEuro(16.25) === '€16.25'`, negative `formatEuro(-4) === '−€4.00'`, zero `formatEuro(0) === '€0.00'`, negative zero `formatEuro(-0) === '€0.00'`, float cancel `formatEuro((56.30 - 40.10) + (24.00 - 40.20)) === '€0.00'`

Run tests to watch them fail:
```bash
pnpm exec vitest run --project unit src/lib/format.test.ts
```

- [x] **Step 2: Implement `formatCents` and `formatEuro` in `src/lib/format.ts`**

```ts
/**
 * Euros from whole cents, without float drift.
 *
 * Formats positive amounts as `€X.XX`, negative amounts as `−€X.XX` (using U+2212
 * before the euro sign), and zero as `€0.00` (never `−€0.00` or `€-0.00`).
 */
export function formatCents(cents: number): string {
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  const euros = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${rounded < 0 ? '−' : ''}€${euros}.${rest}`;
}

/**
 * Euros from a decimal/float euro amount, rounding to nearest whole cent.
 *
 * Convenience helper wrapping `formatCents(Math.round(euros * 100))`.
 */
export function formatEuro(euros: number): string {
  return formatCents(Math.round(euros * 100));
}
```

- [x] **Step 3: Run unit tests and verify pass**

```bash
pnpm exec vitest run --project unit src/lib/format.test.ts
```

- [x] **Step 4: Prove guards bite (mutation testing)**
- Mutate `−` to `-` in `formatCents`, run vitest, observe failure expecting `\u2212`, restore.
- Mutate `rounded < 0` to `rounded <= 0` in `formatCents`, run vitest, observe zero test failing with `−€0.00`, restore.

---

### Task 2: Replace local `formatCents` in `src/components/student/payment-breakdown.tsx`

**Files:**
- Modify: `src/components/student/payment-breakdown.tsx`

- [x] **Step 1: Replace local `formatCents` with import from `@/lib/format`**

Remove local `formatCents` definition and import `{ formatCents } from '@/lib/format'`.

- [x] **Step 2: Run component tests to verify unchanged behavior**

```bash
pnpm exec vitest run --project components src/components/student/payment-breakdown.test.tsx
```

---

### Task 3: Teacher Completed Class Breakdown (`pricing-breakdown.tsx`)

**Files:**
- Modify: `src/components/class/pricing-breakdown.tsx`
- Create: `src/components/class/pricing-breakdown.test.tsx`

- [x] **Step 1: Write failing component test in `src/components/class/pricing-breakdown.test.tsx`**

Test rendering:
- Positive teacher earnings: `€50.00`
- Negative teacher earnings: `−€4.00`
- Negative minRate: `−€20.00`

Run component tests to watch it fail against current code:
```bash
pnpm exec vitest run --project components src/components/class/pricing-breakdown.test.tsx
```

- [x] **Step 2: Update `pricing-breakdown.tsx` to use `formatEuro`**

Import `formatEuro` from `@/lib/format`.
Use `formatEuro(teacherEarnings)` on line 38.
Use `formatEuro(roomCost)` on line 45.
Use `formatEuro(Number(cls.minRate))` and `formatEuro(Number(cls.targetRate))` on line 54.
Use `formatEuro(totalRevenue)` on line 59.
Use `formatEuro(row.price)` on line 73.

- [x] **Step 3: Run component tests and verify pass**

```bash
pnpm exec vitest run --project components src/components/class/pricing-breakdown.test.tsx
```

- [x] **Step 4: Prove guard bites**
Mutate line 38 back to `&euro;{teacherEarnings.toFixed(2)}`, run test, watch fail on `−€4.00`, restore.

---

### Task 4: Teacher Pricing Preview Components (`pricing-preview-table.tsx`, `pricing-preview.tsx`, `class/new/page.tsx`)

**Files:**
- Modify: `src/components/class/pricing-preview-table.tsx`
- Modify: `src/components/class/pricing-preview.tsx`
- Create: `src/components/class/pricing-preview.test.tsx`
- Modify: `src/app/(teacher)/class/new/page.tsx`

- [x] **Step 1: Write failing component tests in `src/components/class/pricing-preview.test.tsx`**

Test that `PricingPreview` renders:
- Negative estimated earnings: `−€4.00`
- Negative minRate: `−€20.00`

Run component tests:
```bash
pnpm exec vitest run --project components src/components/class/pricing-preview.test.tsx
```

- [x] **Step 2: Update `pricing-preview-table.tsx`**

Remove local `formatEuro` and import `formatEuro` from `@/lib/format`.

- [x] **Step 3: Update `pricing-preview.tsx`**

Import `formatEuro` from `@/lib/format`.
Use `formatEuro(estimatedEarnings)` on line 84.
Use `formatEuro(Number(cls.roomCost))` on line 91.
Use `formatEuro(Number(cls.minRate))` and `formatEuro(Number(cls.targetRate))` on line 99.
Use `formatEuro(row.price)` on line 112.

- [x] **Step 4: Update `src/app/(teacher)/class/new/page.tsx`**

Import `formatEuro` from `@/lib/format`.
On line 643-644:
Change to `Room cost: {formatEuro(form.roomCost)} · Rate: {formatEuro(form.minRate)} – {formatEuro(form.targetRate)}`.

- [x] **Step 5: Run component tests and verify pass**

```bash
pnpm exec vitest run --project components src/components/class/pricing-preview.test.tsx
```

- [x] **Step 6: Prove guard bites**
Mutate line 84 in `pricing-preview.tsx` back to `&euro;{estimatedEarnings.toFixed(2)}`, watch test fail, restore.

---

### Task 5: Notification Service (`class-lifecycle.ts`)

**Files:**
- Modify: `src/services/class-lifecycle.ts`
- Modify: `src/services/class-lifecycle.test.ts`

- [x] **Step 1: Write failing unit test in `src/services/class-lifecycle.test.ts`**

Add a test case under `completeClass` where `cls.roomCost` exceeds `pricing.totalCost` (e.g. roomCost 40, totalCost 36 $\to$ earnings -4.00).
Assert that `teacherNote.body` contains `completed — −€4.00 earnings`.

Run test to watch it fail:
```bash
pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts
```

- [x] **Step 2: Update `completeClass` in `src/services/class-lifecycle.ts`**

Import `formatEuro` from `@/lib/format`.
On line 840:
```ts
body: `${cls.calendarEntry.classType} class on ${formatDayHeader(cls.calendarEntry.date)} at ${timeToHHmm(cls.calendarEntry.startTime)} completed — ${formatEuro(pricing.totalCost - Number(cls.roomCost))} earnings, ${chargedRegistrations.length} payment ${chargedRegistrations.length === 1 ? 'request' : 'requests'} sent.`,
```

- [x] **Step 3: Run unit test and verify pass**

```bash
pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts
```

- [x] **Step 4: Prove guard bites**
Mutate line 840 back to `` `€${(pricing.totalCost - Number(cls.roomCost)).toFixed(2)}` ``, watch test fail with `AssertionError: expected '... completed — €-4.00 earnings ...' to contain 'completed — −€4.00 earnings'`, restore.

---

### Task 6: Reporting Page Whole-Cents Accumulation (`reporting/page.tsx`)

**Files:**
- Modify: `src/app/(teacher)/settings/reporting/page.tsx`
- Modify: `tests/integration/reporting-page.test.ts`

- [x] **Step 1: Write integration tests in `tests/integration/reporting-page.test.ts`**

Add test cases for:
1. Float cancellation month:
   - Class 1: total revenue €56.30, room cost €40.10 (earnings +€16.20)
   - Class 2: total revenue €24.00, room cost €40.20 (earnings -€16.20)
   - Assert HTML contains `€0.00` and does NOT contain `€-0.00` or `−€0.00`.
2. Negative month:
   - Class with total revenue €20.00, room cost €40.00 (earnings -€20.00)
   - Assert HTML contains `−€20.00` (and does NOT contain `€-20.00`).

Run integration test (warm route first):
```bash
curl -s http://localhost:3000/settings/reporting > /dev/null
pnpm exec vitest run --project integration tests/integration/reporting-page.test.ts
```

- [x] **Step 2: Refactor `src/app/(teacher)/settings/reporting/page.tsx` to integer cents**

Import `formatCents` from `@/lib/format`.

Convert calculations to integer cents:
```ts
const toCents = (val: Prisma.Decimal | number | null | undefined): number =>
  Math.round(Number(val ?? 0) * 100);

const classEarningsCents = (c: (typeof completedClasses)[number]) =>
  toCents(c.totalRevenue) - toCents(c.roomCost);

const studioEarningsCents = (s: (typeof completedStudioClasses)[number]) =>
  Math.round((Number(s.hourlyRate) * 100 * s.calendarEntry.durationMinutes) / 60);

const totalClassEarningsCents = completedClasses.reduce((sum, c) => sum + classEarningsCents(c), 0);
const totalStudioEarningsCents = completedStudioClasses.reduce((sum, s) => sum + studioEarningsCents(s), 0);
const totalRoomCostsCents = completedClasses.reduce((sum, c) => sum + toCents(c.roomCost), 0);
```

In monthly rollup:
```ts
const byMonth = new Map<string, { classes: number; students: number; earningsCents: number }>();
// ...
entry.earningsCents += classEarningsCents(c);
// ...
entry.earningsCents += studioEarningsCents(s);
```

Render with `formatCents`:
- Banner: `{formatCents(totalClassEarningsCents + totalStudioEarningsCents)}`
- Your classes: `{formatCents(totalClassEarningsCents)}`
- Studio classes: `{formatCents(totalStudioEarningsCents)}`
- Room costs paid: `{formatCents(totalRoomCostsCents)}`
- By month row: `{formatCents(m.earningsCents)}`

- [x] **Step 3: Run integration test and verify pass**

```bash
pnpm exec vitest run --project integration tests/integration/reporting-page.test.ts
```

- [x] **Step 4: Prove guard bites**
Mutate reporting back to float accumulation, run integration test, watch float cancellation test fail with `€-0.00`, restore.

---

### Task 7: Full Verification Gate

- [x] **Step 1: Run typecheck**
```bash
pnpm run typecheck
```

- [x] **Step 2: Run lint**
```bash
pnpm run lint
```

- [x] **Step 3: Run full verify**
```bash
pnpm run verify
```
