# Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder at `/` with the "Landing Page v2" content, fitted to the v2 design system, with a two-slider pricing demo that shares its output with the teacher forms' pricing preview.

**Architecture:** `PricingPreviewTable` is pinned by characterization tests, then split into pure logic (`src/lib/pricing-preview.ts`), a stateless display (`PricingPreviewResult`) and its existing stateful wrapper. A second wrapper, `LandingPricingDemo`, drives the same display from two sliders. The page moves from `src/app/(public)/page.tsx` to `src/app/page.tsx` so it gets only the root layout and renders its own top bar.

**Tech Stack:** Next.js 16 App Router (server component page, one client island), Tailwind v4 `@theme` tokens, Vitest + Testing Library (jsdom `components` project), Playwright (chromium + Mobile Chrome), axe-core.

**Spec:** `docs/superpowers/specs/2026-10-06-landing-page-design.md` (#773)

## Global Constraints

- Branch `feat/773-landing-page`, worktree `.claude/worktrees/issue-773`. Commit messages end with `(#773)` and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Node 24: prefix shell commands with `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"` (the agent shell defaults to Node 22; `devEngines` refuses it).
- TypeScript `strict`; no `any`; no `as` casts to silence a type.
- Typography: only `type-display`, `type-title`, `type-subtitle`, `type-body`, `type-label`, `type-caption`, `type-number`. No new font sizes for text except where an existing component already uses one.
- Colours: tokens only (`teal`, `ink`, `brown`, `brown-light`, `cream`, `sand-soft`, `border`, `teal-tint`, `danger`). `danger` for text/outline only. No shadows, no transitions, no gradients, never pure white.
- Copy uses typographic apostrophes (`’`) in JSX, as `getting-started.tsx` does.
- Tier rows read `` `${tier} · ${label}` `` from `TIER_INFO` (middle dot U+00B7), e.g. `1 · Getting by`.
- Landing demo example inputs: room €20, minimum rate €40, min 4 students, max 12. Student slider 2–12 step 1 default 7. Target-rate slider €50–€130 step €5 default €90.
- Below-minimum message, verbatim: `This class needs 4 students to go ahead. If it doesn’t get there, it’s cancelled and nobody pays.`
- Footer/nav hrefs: only `/signup`, `/login`, `#pricing`, `https://github.com/ivohofland/fair.yoga`, `mailto:hello@fair.yoga`.
- Comment discipline (CLAUDE.md): comments annotate the code they sit on; no counts or member lists in prose; no "previously…" history.
- Tests assert exact values. Expected numbers in this plan are hand-derived and cross-checked against the current code; do not regenerate them from the code under test.

## Review Focus

1. **The teacher forms after extraction** — a teacher on `/class/new`, the class edit form or a template form must see exactly the numbers they saw before; only the tier label text changes. Owned by Task 1's characterization tests, which Tasks 2–3 may edit only for the label.
2. **The minimum boundary** — at exactly 4 students the class goes ahead (prices shown, "You earn" €40.00); at 3 it does not (message, no prices). Owned by Task 4.
3. **A signed-in visitor at `/`** — must still land on their home, including a two-hat account (teacher first), and the offline e2e (`tests/e2e/offline.spec.ts:276`, `goto('/')` → `/schedule`) must stay green. Owned by Task 5 (unit) and Task 6 (full e2e run).
4. **A 375px phone** — no sideways scroll; the demo's tier table (three fixed-width columns) and the footer link row must fit or wrap. Owned by Task 6.
5. **The shared wordmark** — extracting it must not move a pixel on `/login` or a teacher's `[slug]` page. Owned by Task 6 (the full visual suite must pass against the existing `login` and `public-page` baselines without regenerating them).

---

### Task 1: Characterize `PricingPreviewTable` as it is today

**Files:**
- Create: `src/components/class/pricing-preview-table.test.tsx`

**Interfaces:**
- Consumes: `PricingPreviewTable({ roomCost, minRate, targetRate, minStudents, maxStudents }: { … all number })` from `src/components/class/pricing-preview-table.tsx` (unchanged).
- Produces: a test file later tasks may edit **only** to change tier-label strings (Task 3).

- [ ] **Step 0: Prepare the worktree**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm install --frozen-lockfile
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm run worktree:setup
```

- [ ] **Step 1: Write the characterization tests**

Expected values (room €20, min €40 at 4, target €90 at 12, tier ratios 0.65/0.80/1.00/1.20/1.35):

| Students | Counts per tier | You earn | Total | Progress | Prices | Spread |
|---|---|---|---|---|---|---|
| 8 (default: round((4+12)/2)) | 1,2,3,2,0 | €65.00 | €85.00 | 50% | 7.22, 8.89, 11.11, 13.33, 15.00 | 1.8 (tier 5 empty, excluded) |
| 12 | 1,3,4,3,1 | €90.00 | €110.00 | 100% | 5.96, 7.33, 9.17, 11.00, 12.38 | 2.1 |
| 4 | 0,1,2,1,0 | €40.00 | €60.00 | 0% | 9.75, 12.00, 15.00, 18.00, 20.25 | 1.5 (18.00 / 12.00) |

Derivation at 8: rate = 40 + 50 × (8−4)/(12−4) = 65; total 85; weighted sum = 0.65 + 2×0.80 + 3×1.00 + 2×1.20 = 7.65; unit = 85/7.65 = 11.1111; prices = unit × ratio rounded to the cent.

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PricingPreviewTable } from './pricing-preview-table';

const EXAMPLE = { roomCost: 20, minRate: 40, targetRate: 90, minStudents: 4, maxStudents: 12 };

/** [count, price] of the tier row whose label is `label`. */
function row(label: string): [string | null, string | null] {
  const cells = Array.from(screen.getByText(label).parentElement?.children ?? []);
  return [cells[1]?.textContent ?? null, cells[2]?.textContent ?? null];
}

function setStudents(n: number): void {
  fireEvent.change(screen.getByRole('slider'), { target: { value: String(n) } });
}

describe('PricingPreviewTable', () => {
  it('opens at the midpoint class size with the normal spread', () => {
    render(<PricingPreviewTable {...EXAMPLE} />);

    expect(screen.getByText('8 students')).toBeTruthy();
    expect(screen.getByText('€65.00')).toBeTruthy();
    expect(screen.getByText('€20.00')).toBeTruthy();
    expect(screen.getByText('€85.00')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(row('Tier 1')).toEqual(['1', '€7.22']);
    expect(row('Tier 2')).toEqual(['2', '€8.89']);
    expect(row('Tier 3')).toEqual(['3', '€11.11']);
    expect(row('Tier 4')).toEqual(['2', '€13.33']);
    expect(row('Tier 5')).toEqual(['0', '€15.00']);
    expect(screen.getByText('Highest pays 1.8× the lowest')).toBeTruthy();
  });

  it('reaches the target rate at a full class', () => {
    render(<PricingPreviewTable {...EXAMPLE} />);
    setStudents(12);

    expect(screen.getByText('12 students')).toBeTruthy();
    expect(screen.getByText('€90.00')).toBeTruthy();
    expect(screen.getByText('€110.00')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(row('Tier 1')).toEqual(['1', '€5.96']);
    expect(row('Tier 2')).toEqual(['3', '€7.33']);
    expect(row('Tier 3')).toEqual(['4', '€9.17']);
    expect(row('Tier 4')).toEqual(['3', '€11.00']);
    expect(row('Tier 5')).toEqual(['1', '€12.38']);
    expect(screen.getByText('Highest pays 2.1× the lowest')).toBeTruthy();
  });

  it('pays the minimum rate at the minimum class size', () => {
    render(<PricingPreviewTable {...EXAMPLE} />);
    setStudents(4);

    expect(screen.getByText('€40.00')).toBeTruthy();
    expect(screen.getByText('€60.00')).toBeTruthy();
    expect(screen.getByText('0%')).toBeTruthy();
    expect(row('Tier 1')).toEqual(['0', '€9.75']);
    expect(row('Tier 5')).toEqual(['0', '€20.25']);
    expect(screen.getByText('Highest pays 1.5× the lowest')).toBeTruthy();
  });

  it('shows full progress when the minimum and target rates are equal', () => {
    render(<PricingPreviewTable {...EXAMPLE} minRate={60} targetRate={60} />);

    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('keeps the class size when shuffling the mix', () => {
    render(<PricingPreviewTable {...EXAMPLE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Shuffle mix' }));

    const counts = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5'].map((l) => Number(row(l)[0]));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(8);
  });
});
```

- [ ] **Step 2: Run — expect PASS (it characterizes existing code)**

Run: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project components src/components/class/pricing-preview-table.test.tsx`
Expected: 5 passed. If a value differs, the plan's derivation is wrong — stop and report; do not edit the expectation to match.

- [ ] **Step 3: Commit before mutating**

```bash
git add src/components/class/pricing-preview-table.test.tsx
git commit -m "test: characterize PricingPreviewTable before extracting it (#773)"
```

- [ ] **Step 4: Prove the tests can fail — three mutations, one at a time**

In `src/components/class/pricing-preview-table.tsx`, apply each exact edit, run the Step 2 command, confirm at least one FAIL, then `git checkout -- src/components/class/pricing-preview-table.tsx`:

1. `(ratio) => Math.round(((total / weightedSum) * ratio) * 100) / 100,` → `(ratio) => Math.floor(((total / weightedSum) * ratio) * 100) / 100,`
2. `const activePrices = prices.filter((_, i) => distribution[i]! > 0);` → `const activePrices = prices;`
3. `rateRange === 0 ? 100 : Math.round(((teacherRate - minRate) / rateRange) * 100);` → `rateRange === 0 ? 0 : Math.round(((teacherRate - minRate) / rateRange) * 100);`

After the last restore: `git status --short` must print nothing.

---

### Task 2: Move the pure preview logic into `src/lib/pricing-preview.ts`

**Files:**
- Create: `src/lib/pricing-preview.ts`
- Create: `src/lib/pricing-preview.test.ts`
- Modify: `src/components/class/pricing-preview-table.tsx` (delete `NORMAL_WEIGHTS`, `normalSpread`, `TIER_RATIO_VALUES`, `calculateTierPrices` and the inline spread computation; import from the new module)

**Interfaces:**
- Produces:
  - `normalSpread(n: number): number[]` — students per tier, `INCOME_TIERS` order, summing to `n`.
  - `tierPrices(total: number, distribution: readonly number[]): number[]` — per-tier price in euros rounded to the cent; all zeros when no student is in any tier.
  - `priceSpread(prices: readonly number[], distribution: readonly number[]): string | null` — highest ÷ lowest over tiers with ≥1 student, `toFixed(1)`; `null` with fewer than two such tiers.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { normalSpread, tierPrices, priceSpread } from './pricing-preview';

describe('normalSpread', () => {
  it.each([
    [2, [0, 1, 1, 0, 0]],
    [7, [1, 1, 3, 1, 1]],
    [8, [1, 2, 3, 2, 0]],
    [12, [1, 3, 4, 3, 1]],
  ])('spreads %i students as %j', (n, expected) => {
    expect(normalSpread(n)).toEqual(expected);
  });

  it('always places exactly n students', () => {
    for (let n = 1; n <= 40; n++) {
      expect(normalSpread(n).reduce((a, b) => a + b, 0)).toBe(n);
    }
  });
});

describe('tierPrices', () => {
  it('splits the total by tier ratio, rounded to the cent', () => {
    expect(tierPrices(85, [1, 2, 3, 2, 0])).toEqual([7.22, 8.89, 11.11, 13.33, 15]);
    expect(tierPrices(78.75, [1, 1, 3, 1, 1])).toEqual([7.31, 9, 11.25, 13.5, 15.19]);
  });

  it('prices nothing when nobody is in any tier', () => {
    expect(tierPrices(85, [0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('priceSpread', () => {
  it('compares only tiers that have students', () => {
    expect(priceSpread([7.22, 8.89, 11.11, 13.33, 15], [1, 2, 3, 2, 0])).toBe('1.8');
  });

  it('has nothing to compare with a single occupied tier', () => {
    expect(priceSpread([0, 0, 20, 0, 0], [0, 0, 1, 0, 0])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project unit src/lib/pricing-preview.test.ts`
Expected: FAIL — cannot resolve `./pricing-preview`.

- [ ] **Step 3: Create the module (logic moved verbatim)**

```ts
import { INCOME_TIERS, TIER_RATIOS } from '@/lib/tiers';

/** Expected share of a class in each tier, `INCOME_TIERS` order. */
const NORMAL_WEIGHTS = [0.0895, 0.2242, 0.3726, 0.2242, 0.0895];

/** Students per tier for a class of `n`, largest-remainder rounded. */
export function normalSpread(n: number): number[] {
  const raw = NORMAL_WEIGHTS.map((w) => w * n);
  const floored = raw.map(Math.floor);
  let remaining = n - floored.reduce((a, b) => a + b, 0);

  // Distribute remainders to tiers with largest fractional parts (center-first tiebreak)
  const fractions = raw.map((v, i) => ({ i, frac: v - floored[i]! }));
  fractions.sort((a, b) => {
    if (b.frac !== a.frac) return b.frac - a.frac;
    // Center-first tiebreak: closer to index 2 wins
    return Math.abs(a.i - 2) - Math.abs(b.i - 2);
  });

  for (const { i } of fractions) {
    if (remaining <= 0) break;
    floored[i]!++;
    remaining--;
  }

  return floored;
}

const TIER_RATIO_VALUES = INCOME_TIERS.map((t) => TIER_RATIOS[t]);

/**
 * Each tier's price for a class costing `total`, rounded to the cent per
 * tier. Billing (`calculateClassPricing`) allocates cents per student instead,
 * so a billed price can differ from this by a cent.
 */
export function tierPrices(total: number, distribution: readonly number[]): number[] {
  const weightedSum = distribution.reduce(
    (sum, count, i) => sum + count * TIER_RATIO_VALUES[i]!,
    0,
  );

  if (weightedSum === 0) return TIER_RATIO_VALUES.map(() => 0);

  return TIER_RATIO_VALUES.map(
    (ratio) => Math.round(((total / weightedSum) * ratio) * 100) / 100,
  );
}

/** Highest over lowest price among occupied tiers, one decimal. */
export function priceSpread(
  prices: readonly number[],
  distribution: readonly number[],
): string | null {
  const active = prices.filter((_, i) => distribution[i]! > 0);
  return active.length >= 2 ? (Math.max(...active) / Math.min(...active)).toFixed(1) : null;
}
```

- [ ] **Step 4: Point `PricingPreviewTable` at it**

In `src/components/class/pricing-preview-table.tsx`: delete the `NORMAL_WEIGHTS` constant, `normalSpread`, `TIER_RATIO_VALUES` and `calculateTierPrices`; remove the now-unused `INCOME_TIERS, TIER_RATIOS` import; add `import { normalSpread, tierPrices, priceSpread } from '@/lib/pricing-preview';`. Replace

```tsx
  const { prices } = calculateTierPrices(totalCost, distribution);

  // Spread: ratio of highest to lowest active tier price
  const activePrices = prices.filter((_, i) => distribution[i]! > 0);
  const spread =
    activePrices.length >= 2
      ? (Math.max(...activePrices) / Math.min(...activePrices)).toFixed(1)
      : null;
```

with

```tsx
  const prices = tierPrices(totalCost, distribution);
  const spread = priceSpread(prices, distribution);
```

`shuffleMix` stays in the component.

- [ ] **Step 5: Run both test files — expect PASS, characterization unedited**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project unit src/lib/pricing-preview.test.ts
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project components src/components/class/pricing-preview-table.test.tsx
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm run typecheck
```

`git diff --stat src/components/class/pricing-preview-table.test.tsx` must be empty.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pricing-preview.ts src/lib/pricing-preview.test.ts src/components/class/pricing-preview-table.tsx
git commit -m "refactor: move the pricing preview's spread and tier-price logic into src/lib (#773)"
```

---

### Task 3: Extract `PricingPreviewResult`, labelled `1 · Getting by`

**Files:**
- Create: `src/components/class/pricing-preview-result.tsx`
- Create: `src/components/class/pricing-preview-result.test.tsx`
- Modify: `src/components/class/pricing-preview-table.tsx` (render `PricingPreviewResult`; delete its own You-earn card, tier table, spread line and `TIER_LABELS`)
- Modify: `src/components/class/pricing-preview-table.test.tsx` (tier-label strings only)
- Modify: `CLAUDE.md` (Open Questions, tier-labels line)

**Interfaces:**
- Consumes: `normalSpread`, `tierPrices`, `priceSpread` (Task 2); `calculateEffectiveTeacherRate` (`@/services/pricing`); `TIER_INFO` (`@/lib/tiers`).
- Produces:
  - `export interface PricingPreviewInputs { roomCost: number; minRate: number; targetRate: number; minStudents: number; maxStudents: number }`
  - `export function PricingPreviewResult(props: PricingPreviewInputs & { studentCount: number; distribution: readonly number[]; distributionControl?: ReactNode }): JSX.Element` — returns a fragment: the "You earn" card, then the "What students pay" block (label, `distributionControl`, tier rows, spread line). Each tier row is a `div` whose children are exactly three spans: label, count, price.

- [ ] **Step 1: Write the failing result test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PricingPreviewResult } from './pricing-preview-result';

const EXAMPLE = { roomCost: 20, minRate: 40, targetRate: 90, minStudents: 4, maxStudents: 12 };

function row(label: string): [string | null, string | null] {
  const cells = Array.from(screen.getByText(label).parentElement?.children ?? []);
  return [cells[1]?.textContent ?? null, cells[2]?.textContent ?? null];
}

describe('PricingPreviewResult', () => {
  it('labels each tier with its number and name', () => {
    render(<PricingPreviewResult {...EXAMPLE} studentCount={8} distribution={[1, 2, 3, 2, 0]} />);

    expect(row('1 · Getting by')).toEqual(['1', '€7.22']);
    expect(row('2 · Managing')).toEqual(['2', '€8.89']);
    expect(row('3 · Comfortable')).toEqual(['3', '€11.11']);
    expect(row('4 · Doing well')).toEqual(['2', '€13.33']);
    expect(row('5 · Plenty to share')).toEqual(['0', '€15.00']);
    expect(screen.getByText('€65.00')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('Highest pays 1.8× the lowest')).toBeTruthy();
  });

  it('renders the caller’s control above the tier rows', () => {
    render(
      <PricingPreviewResult
        {...EXAMPLE}
        studentCount={8}
        distribution={[1, 2, 3, 2, 0]}
        distributionControl={<button type="button">Mix control</button>}
      />,
    );
    const control = screen.getByRole('button', { name: 'Mix control' });
    const firstRow = screen.getByText('1 · Getting by');
    expect(control.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
```

- [ ] **Step 2: Update the characterization labels (only edit allowed)**

In `pricing-preview-table.test.tsx`, replace every `'Tier 1'` … `'Tier 5'` with `'1 · Getting by'`, `'2 · Managing'`, `'3 · Comfortable'`, `'4 · Doing well'`, `'5 · Plenty to share'` respectively (including the array in the shuffle test). Nothing else in the file changes.

- [ ] **Step 3: Run both — expect FAIL**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project components src/components/class/pricing-preview-result.test.tsx src/components/class/pricing-preview-table.test.tsx
```

Expected: result test fails to resolve `./pricing-preview-result`; table tests fail on `Unable to find an element with the text: 1 · Getting by`.

- [ ] **Step 4: Create `pricing-preview-result.tsx`**

```tsx
import type { ReactNode } from 'react';
import { formatEuro } from '@/lib/format';
import { TIER_INFO } from '@/lib/tiers';
import { tierPrices, priceSpread } from '@/lib/pricing-preview';
import { calculateEffectiveTeacherRate } from '@/services/pricing';

export interface PricingPreviewInputs {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
}

interface PricingPreviewResultProps extends PricingPreviewInputs {
  studentCount: number;
  /** Students per tier, `TIER_INFO` order. */
  distribution: readonly number[];
  /** Rendered between "What students pay" and the tier rows. */
  distributionControl?: ReactNode;
}

/** What a class of `studentCount` earns the teacher and costs each tier. */
export function PricingPreviewResult({
  roomCost,
  minRate,
  targetRate,
  minStudents,
  maxStudents,
  studentCount,
  distribution,
  distributionControl,
}: PricingPreviewResultProps) {
  const teacherRate = calculateEffectiveTeacherRate({
    studentCount,
    minStudents,
    maxStudents,
    minRate,
    targetRate,
  });

  const totalCost = roomCost + teacherRate;
  const rateRange = targetRate - minRate;
  const rateProgress =
    rateRange === 0 ? 100 : Math.round(((teacherRate - minRate) / rateRange) * 100);

  const prices = tierPrices(totalCost, distribution);
  const spread = priceSpread(prices, distribution);

  return (
    <>
      {/* You earn card */}
      <div className="bg-teal-tint rounded-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="type-label">You earn</p>
            <p className="type-caption">total for this class</p>
          </div>
          <p className="type-number text-[28px] leading-[1.25]">{formatEuro(teacherRate)}</p>
        </div>
        <div className="flex gap-6">
          <div>
            <p className="type-caption">Room cost</p>
            <p className="text-sm font-medium text-ink tabular-nums">{formatEuro(roomCost)}</p>
          </div>
          <div>
            <p className="type-caption">Total class cost</p>
            <p className="text-sm font-medium text-ink tabular-nums">{formatEuro(totalCost)}</p>
          </div>
          <div>
            <p className="type-caption">Rate progress</p>
            <p className="text-sm font-medium text-ink tabular-nums">{rateProgress}%</p>
          </div>
        </div>
      </div>

      {/* What students pay */}
      <div>
        <p className="type-label text-ink mb-3">What students pay</p>

        {distributionControl}

        {/* Tier table — teal caption headers, tabular prices on the decimal */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between py-2 border-b border-border text-[12px] font-medium text-teal">
            <span className="flex-1">TIER</span>
            <span className="w-20 text-right">STUDENTS</span>
            <span className="w-20 text-right">PRICE</span>
          </div>
          {TIER_INFO.map((info, i) => {
            const count = distribution[i] ?? 0;
            return (
              <div
                key={info.tier}
                className={`flex items-center justify-between min-h-12 py-2 border-b border-border last:border-b-0 ${
                  count > 0 ? '' : 'opacity-40'
                }`}
              >
                <span className="flex-1 text-base text-ink">{`${info.tier} · ${info.label}`}</span>
                <span className="w-20 text-right text-sm text-brown tabular-nums">{count}</span>
                <span className="w-20 text-right type-number text-sm">
                  {formatEuro(prices[i] ?? 0)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Spread line — show the math */}
        {spread && (
          <div className="mt-4 text-center">
            <span className="type-caption">Highest pays {spread}&times; the lowest</span>
          </div>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Make `PricingPreviewTable` a wrapper**

In `pricing-preview-table.tsx`: import `PricingPreviewResult` and `type PricingPreviewInputs` from `./pricing-preview-result`; change the props type to `PricingPreviewInputs` (delete the local `PricingPreviewTableProps`); delete `TIER_LABELS`, the `teacherRate`/`totalCost`/`rateRange`/`rateProgress`/`prices`/`spread` computations and the `calculateEffectiveTeacherRate`, `formatEuro`, `tierPrices`, `priceSpread` imports that become unused. Keep the state, handlers, the invalid-input branch and the slider block. The return becomes:

```tsx
  return (
    <div className="mt-6 flex flex-col gap-6">
      {/* Slider */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="type-label text-ink">Explore class size</span>
          <span className="type-caption tabular-nums">{studentCount} students</span>
        </div>
        <input
          type="range"
          min={effectiveMin}
          max={effectiveMax}
          value={studentCount}
          onChange={(e) => handleSliderChange(Number(e.target.value))}
          className="w-full accent-teal"
        />
        <div className="flex justify-between type-caption mt-1">
          <span>{effectiveMin} min</span>
          <span>{effectiveMax} max</span>
        </div>
      </div>

      <PricingPreviewResult
        roomCost={roomCost}
        minRate={minRate}
        targetRate={targetRate}
        minStudents={effectiveMin}
        maxStudents={effectiveMax}
        studentCount={studentCount}
        distribution={distribution}
        distributionControl={
          <div className="flex items-center gap-2 mb-4">
            <button
              type="button"
              onClick={() => handleModeChange('normal')}
              className={`h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] ${
                mode === 'normal'
                  ? 'border-teal text-teal bg-teal-tint'
                  : 'border-border text-brown'
              }`}
            >
              Normal spread
            </button>
            <button
              type="button"
              onClick={() => handleModeChange('shuffle')}
              className={`h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] ${
                mode === 'shuffle'
                  ? 'border-teal text-teal bg-teal-tint'
                  : 'border-border text-brown'
              }`}
            >
              Shuffle mix
            </button>
          </div>
        }
      />
    </div>
  );
```

The three callers (`class/new/page.tsx`, `template-form.tsx`, `class-edit-form.tsx`) pass the same five props and need no change.

- [ ] **Step 6: Update CLAUDE.md**

Replace the line `- Tier labels — currently 1-5, naming deferred to UX copy phase` with:

```
- Tier labels — teacher pricing previews show the number with its `TIER_INFO` label ("1 · Getting by") since #773; the wording of those labels is still the UX copy phase's
```

- [ ] **Step 7: Run — expect PASS**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project components src/components/class src/components/settings src/app/\(teacher\)/class
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm run typecheck
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm run lint
```

`git diff -- src/components/class/pricing-preview-table.test.tsx` must show only the label substitutions.

- [ ] **Step 8: Commit**

```bash
git add src/components/class/pricing-preview-result.tsx src/components/class/pricing-preview-result.test.tsx src/components/class/pricing-preview-table.tsx src/components/class/pricing-preview-table.test.tsx CLAUDE.md
git commit -m "refactor: the pricing preview's output becomes PricingPreviewResult, tiers labelled by name (#773)"
```

---

### Task 4: `LandingPricingDemo`

**Files:**
- Create: `src/components/landing/landing-pricing-demo.tsx`
- Create: `src/components/landing/landing-pricing-demo.test.tsx`

**Interfaces:**
- Consumes: `PricingPreviewResult` (Task 3), `normalSpread` (Task 2), `RegistrationProgress({ registered, min, max, className? })` (`@/components/ui/registration-progress`), `Card` (`@/components/ui/card`), `formatEuro` (`@/lib/format`).
- Produces: `export function LandingPricingDemo(): JSX.Element` — a `'use client'` component, no props. Sliders are labelled `Students registered` and `Your target rate`.

Expected values (room €20, min €40 at 4, max 12):

| Students | Target | You earn | Prices | Spread |
|---|---|---|---|---|
| 7 (default) | €90 (default) | €58.75 = 40 + 50 × 3/8 | 7.31, 9.00, 11.25, 13.50, 15.19 (counts 1,1,3,1,1) | 2.1 |
| 7 | €130 | €73.75 = 40 + 90 × 3/8 | 8.71, 10.71, 13.39, 16.07, 18.08 | 2.1 |
| 4 | €90 | €40.00 | — | — |
| 3 | €90 | message, no result | — | — |

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingPricingDemo } from './landing-pricing-demo';

const BELOW_MINIMUM =
  'This class needs 4 students to go ahead. If it doesn’t get there, it’s cancelled and nobody pays.';

function row(label: string): [string | null, string | null] {
  const cells = Array.from(screen.getByText(label).parentElement?.children ?? []);
  return [cells[1]?.textContent ?? null, cells[2]?.textContent ?? null];
}

const students = () => screen.getByRole('slider', { name: 'Students registered' });
const rate = () => screen.getByRole('slider', { name: 'Your target rate' });

describe('LandingPricingDemo', () => {
  it('opens on a class of 7 at a €90 target', () => {
    render(<LandingPricingDemo />);

    expect(students().getAttribute('aria-valuetext')).toBe('7 students');
    expect(rate().getAttribute('aria-valuetext')).toBe('€90.00');
    expect(screen.getByText('€58.75')).toBeTruthy();
    expect(row('1 · Getting by')).toEqual(['1', '€7.31']);
    expect(row('2 · Managing')).toEqual(['1', '€9.00']);
    expect(row('3 · Comfortable')).toEqual(['3', '€11.25']);
    expect(row('4 · Doing well')).toEqual(['1', '€13.50']);
    expect(row('5 · Plenty to share')).toEqual(['1', '€15.19']);
    expect(screen.getByText('Highest pays 2.1× the lowest')).toBeTruthy();
  });

  it('bounds its sliders to the example class', () => {
    render(<LandingPricingDemo />);

    expect([students().getAttribute('min'), students().getAttribute('max')]).toEqual(['2', '12']);
    expect([rate().getAttribute('min'), rate().getAttribute('max'), rate().getAttribute('step')]).toEqual([
      '50',
      '130',
      '5',
    ]);
  });

  it('moves every price with the target rate and keeps the spread', () => {
    render(<LandingPricingDemo />);
    fireEvent.change(rate(), { target: { value: '130' } });

    expect(rate().getAttribute('aria-valuetext')).toBe('€130.00');
    expect(screen.getByText('€73.75')).toBeTruthy();
    expect(row('1 · Getting by')).toEqual(['1', '€8.71']);
    expect(row('2 · Managing')).toEqual(['1', '€10.71']);
    expect(row('3 · Comfortable')).toEqual(['3', '€13.39']);
    expect(row('4 · Doing well')).toEqual(['1', '€16.07']);
    expect(row('5 · Plenty to share')).toEqual(['1', '€18.08']);
    expect(screen.getByText('Highest pays 2.1× the lowest')).toBeTruthy();
  });

  it('goes ahead at exactly the minimum', () => {
    render(<LandingPricingDemo />);
    fireEvent.change(students(), { target: { value: '4' } });

    expect(screen.queryByText(BELOW_MINIMUM)).toBeNull();
    expect(screen.getByText('€40.00')).toBeTruthy();
  });

  it('shows the cancellation instead of prices below the minimum', () => {
    render(<LandingPricingDemo />);
    fireEvent.change(students(), { target: { value: '3' } });

    expect(students().getAttribute('aria-valuetext')).toBe('3 students');
    expect(screen.getByText(BELOW_MINIMUM)).toBeTruthy();
    expect(screen.queryByText('You earn')).toBeNull();
  });

  it('server-renders the default state with no shuffle control', () => {
    const html = renderToStaticMarkup(<LandingPricingDemo />);

    expect(html).toContain('€58.75');
    expect(html).not.toContain('Shuffle mix');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project components src/components/landing/landing-pricing-demo.test.tsx`
Expected: FAIL — cannot resolve `./landing-pricing-demo`.

- [ ] **Step 3: Implement**

```tsx
'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { RegistrationProgress } from '@/components/ui/registration-progress';
import { PricingPreviewResult } from '@/components/class/pricing-preview-result';
import { formatEuro } from '@/lib/format';
import { normalSpread } from '@/lib/pricing-preview';

/** The example class a visitor explores, as a teacher would configure it. */
const EXAMPLE = { roomCost: 20, minRate: 40, minStudents: 4, maxStudents: 12 } as const;

const FEWEST_STUDENTS = 2;
const RATE_RANGE = { min: 50, max: 130, step: 5 } as const;

export function LandingPricingDemo() {
  const [studentCount, setStudentCount] = useState(7);
  const [targetRate, setTargetRate] = useState(90);
  const goesAhead = studentCount >= EXAMPLE.minStudents;

  return (
    <Card>
      <p className="type-caption mb-5">
        Example class: room {formatEuro(EXAMPLE.roomCost)} · minimum rate{' '}
        {formatEuro(EXAMPLE.minRate)} at {EXAMPLE.minStudents} students · your target at{' '}
        {EXAMPLE.maxStudents}
      </p>

      <div className="flex flex-col gap-6">
        <div>
          <label htmlFor="demo-students" className="type-label text-ink">
            Students registered
          </label>
          <RegistrationProgress
            registered={studentCount}
            min={EXAMPLE.minStudents}
            max={EXAMPLE.maxStudents}
          />
          <input
            id="demo-students"
            type="range"
            min={FEWEST_STUDENTS}
            max={EXAMPLE.maxStudents}
            step={1}
            value={studentCount}
            aria-valuetext={`${studentCount} students`}
            onChange={(e) => setStudentCount(Number(e.target.value))}
            className="w-full accent-teal mt-3"
          />
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="demo-rate" className="type-label text-ink">
              Your target rate
            </label>
            <span className="type-number text-base">{formatEuro(targetRate)}</span>
          </div>
          <input
            id="demo-rate"
            type="range"
            min={RATE_RANGE.min}
            max={RATE_RANGE.max}
            step={RATE_RANGE.step}
            value={targetRate}
            aria-valuetext={formatEuro(targetRate)}
            onChange={(e) => setTargetRate(Number(e.target.value))}
            className="w-full accent-teal mt-2"
          />
          <p className="type-caption mt-1">What you earn with a full class of {EXAMPLE.maxStudents}</p>
        </div>

        {goesAhead ? (
          <PricingPreviewResult
            {...EXAMPLE}
            targetRate={targetRate}
            studentCount={studentCount}
            distribution={normalSpread(studentCount)}
          />
        ) : (
          <p role="status" className="type-body text-danger">
            This class needs {EXAMPLE.minStudents} students to go ahead. If it doesn’t get there,
            it’s cancelled and nobody pays.
          </p>
        )}
      </div>
    </Card>
  );
}
```

The `<p role="status">` text must render as the single string in Global Constraints — `{EXAMPLE.minStudents}` produces `4` and JSX collapses the line break to one space; the test's exact-string match verifies it.

- [ ] **Step 4: Run — expect PASS**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project components src/components/landing/landing-pricing-demo.test.tsx
```

- [ ] **Step 5: Mutation check (commit first)**

```bash
git add src/components/landing
git commit -m "feat: a two-slider pricing demo on PricingPreviewResult (#773)"
```

Apply each, run Step 4, confirm FAIL, then `git checkout -- src/components/landing/landing-pricing-demo.tsx`:

1. `const goesAhead = studentCount >= EXAMPLE.minStudents;` → `const goesAhead = studentCount > EXAMPLE.minStudents;`
2. `targetRate={targetRate}` → `targetRate={90}`

`git status --short` must print nothing afterwards.

---

### Task 5: The page at `src/app/page.tsx`

**Files:**
- Create: `src/components/layout/wordmark.tsx`
- Modify: `src/app/(public)/layout.tsx` (use `Wordmark`)
- Create: `src/app/page.tsx`
- Delete: `src/app/(public)/page.tsx`
- Create: `src/app/page.test.tsx`
- Modify: `src/lib/loading-coverage.test.ts:18` (`'(public)': 'none',` → `'': 'none',`)

**Interfaces:**
- Consumes: `LandingPricingDemo` (Task 4), `Card`, `getSession` (`@/lib/session`), `redirect` (`next/navigation`).
- Produces: `export function Wordmark({ className }: { className?: string }): JSX.Element`; `export default async function LandingPage(): Promise<JSX.Element>`.

- [ ] **Step 1: Write the failing page test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const getSession = vi.fn();

vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

beforeEach(() => {
  getSession.mockReset();
});

const base = { sessionId: 's1', accountId: 'a1', defaultTimezone: 'Europe/Amsterdam' };

const ALLOWED_HREFS = new Set([
  '/signup',
  '/login',
  '#pricing',
  'https://github.com/ivohofland/fair.yoga',
  'mailto:hello@fair.yoga',
]);

async function renderAsVisitor(): Promise<void> {
  const { default: LandingPage } = await import('./page');
  getSession.mockResolvedValue(null);
  render(await LandingPage());
}

describe('LandingPage', () => {
  it.each([
    ['teacher', { teacherId: 't1', studentId: null }, '/schedule'],
    ['student', { teacherId: null, studentId: 'st1' }, '/bookings'],
    ['two-hat account', { teacherId: 't1', studentId: 'st1' }, '/schedule'],
  ])('sends a signed-in %s home', async (_who, hats, home) => {
    const { default: LandingPage } = await import('./page');
    getSession.mockResolvedValue({ ...base, ...hats });

    await expect(LandingPage()).rejects.toThrow(`REDIRECT:${home}`);
  });

  it('opens on the question in the room', async () => {
    await renderAsVisitor();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Look around the room. Do the people on the mats look like your neighbourhood?',
    );
  });

  it('tells the story in the wireframe’s order', async () => {
    await renderAsVisitor();

    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Somewhere along the way, teaching became a business you never signed up for',
      'A free toolkit for independent teachers',
      'Fair pricing, worked out for you',
      'It’s your practice. It stays yours.',
      'Built on yoga’s own values',
      'Set up your first class in a few minutes',
    ]);
  });

  it('links only where a page exists', async () => {
    await renderAsVisitor();

    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs.filter((h) => !ALLOWED_HREFS.has(h ?? ''))).toEqual([]);
    for (const href of ALLOWED_HREFS) expect(hrefs).toContain(href);
    expect(document.getElementById('pricing')).not.toBeNull();
  });

  it('promises only what the product does', async () => {
    await renderAsVisitor();
    const text = document.body.textContent ?? '';

    expect(text).toContain('who’s paid and who hasn’t');
    expect(text).toContain('Set a minimum and a target. Every price is worked out to pay you between the two.');
    expect(text).toContain('Fill in your profile and bank details, add your room, create your first class, and share your page.');
    expect(text).not.toContain('Transparent costs');
    expect(text).not.toContain('The app protects it');
  });

  it('carries the pricing demo', async () => {
    await renderAsVisitor();

    expect(screen.getByRole('slider', { name: 'Students registered' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Your target rate' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project components src/app/page.test.tsx`
Expected: FAIL — cannot resolve `./page`.

- [ ] **Step 3: Extract the wordmark**

`src/components/layout/wordmark.tsx`:

```tsx
/** Georgia, ink, with the period at 125% in teal. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <div className={`font-heading text-[22px] leading-none text-ink ${className}`.trim()}>
      fair<span className="text-teal text-[27px]">.</span>yoga
    </div>
  );
}
```

`src/app/(public)/layout.tsx` becomes:

```tsx
import { Wordmark } from '@/components/layout/wordmark';

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col flex-1">
      <Wordmark className="mb-14" />
      {children}
    </div>
  );
}
```

The rendered class string (`font-heading text-[22px] leading-none text-ink mb-14`) is identical to today's, which Task 6's visual run confirms.

- [ ] **Step 4: Move the page**

```bash
git rm "src/app/(public)/page.tsx"
```

Create `src/app/page.tsx`:

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSession } from '@/lib/session';
import { Card } from '@/components/ui/card';
import { Wordmark } from '@/components/layout/wordmark';
import { LandingPricingDemo } from '@/components/landing/landing-pricing-demo';

const REPO_URL = 'https://github.com/ivohofland/fair.yoga';
const CONTACT_HREF = 'mailto:hello@fair.yoga';

const PRIMARY_LINK =
  'inline-flex items-center justify-center text-center bg-teal text-cream hover:bg-teal-hover active:bg-teal-pressed rounded-pill px-6 min-h-12 font-semibold text-base no-underline';

const VALUES = [
  {
    title: 'You earn your rate',
    body: 'Set a minimum and a target. Every price is worked out to pay you between the two.',
  },
  {
    title: 'Prices you can stand behind',
    body: 'See exactly what each class size means before you publish — no surprises, no discounts to manage.',
  },
  {
    title: 'No one priced out',
    body: 'The lowest tier keeps the practice within reach for people on a tight budget.',
  },
] as const;

const PROMISES = [
  {
    lead: 'Your students are yours.',
    body: 'Your contacts and relationships stay with you — not a platform’s list to be marketed to.',
  },
  {
    lead: 'Students pay you directly.',
    body: 'The app works out the price; the money goes straight from student to you. We’re never in the middle of your income.',
  },
  {
    lead: 'Bill after class, not before.',
    body: 'Prices settle once the class has happened, based on who registered. No upfront packages, no lock-in.',
  },
  {
    lead: 'Works alongside what you already have.',
    body: 'It sits next to your website, your studio work, your existing following — it doesn’t replace them.',
  },
  {
    lead: 'Private by default.',
    body: 'We collect as little as possible, and the most private settings are the ones already switched on.',
  },
] as const;

const YAMAS = [
  { name: 'Satya', gloss: 'truthfulness', body: 'Income tiers are self-reported. We trust, we don’t verify.' },
  { name: 'Asteya', gloss: 'non-stealing', body: 'No one is priced out of practice, and no one takes a cut of your work.' },
  { name: 'Aparigraha', gloss: 'non-hoarding', body: 'We hold as little of your data as we can, and the platform stays free.' },
  { name: 'Ahimsa', gloss: 'non-harm', body: 'The math never squeezes one side to favour the other — student, teacher, or studio.' },
] as const;

const STEPS = ['Profile', 'Bank details', 'Room', 'Class', 'Share'] as const;

function Section({
  id,
  kicker,
  title,
  children,
}: {
  id?: string;
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="py-8">
      <p className="type-caption mb-1.5">{kicker}</p>
      <h2 className="type-title mb-4">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The public front door. A signed-in visitor never sees it: `/` used to be
 * the teacher home, and a bookmark of it should land on their own home.
 */
export default async function LandingPage() {
  const session = await getSession();
  if (session?.teacherId) redirect('/schedule');
  if (session?.studentId) redirect('/bookings');

  return (
    <div className="flex flex-col">
      <nav aria-label="Site" className="flex items-center justify-between gap-4 pb-6">
        <Wordmark />
        <Link href="/login" className="type-label text-teal inline-flex items-center min-h-11">
          Sign in
        </Link>
      </nav>

      <header className="pt-6 pb-10">
        <p className="type-label mb-4">Making the economics of yoga fair for everyone involved</p>
        <h1 className="type-display text-ink mb-5">
          <em className="text-teal">Look around the room.</em> Do the people on the mats look like
          your neighbourhood?
        </h1>
        <p className="type-body mb-7">
          For most of us, the honest answer is no — not because we want it that way, but because
          price quietly decides who gets to walk in. This is a free toolkit for independent teachers
          who’d rather it didn’t: everyone pays what they can, you still earn a living, and no one
          takes a cut.
        </p>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <Link href="/signup" className={PRIMARY_LINK}>
            Set up your first class
          </Link>
          <a href="#pricing" className="type-body text-center sm:text-left">
            See how the pricing works <span aria-hidden="true">↓</span>
          </a>
        </div>
        <p className="type-caption mt-4">Free forever · No commission · Bring your own students</p>
      </header>

      <Section
        kicker="The problem"
        title="Somewhere along the way, teaching became a business you never signed up for"
      >
        <p className="type-body mb-3.5">
          Rooms cost more every year. Set your price low and you can’t cover rent. Set it higher and
          you watch the people who need the practice most quietly drift away. Between room rent,
          booking fees, and platform commissions, the two people who matter — you and your students
          — are the ones left short.
        </p>
        <p className="type-body">
          It isn’t that anyone’s doing it wrong. It’s that the numbers were never built to be fair to
          both sides at once.
        </p>
      </Section>

      <Section kicker="A different starting point" title="A free toolkit for independent teachers">
        <p className="type-body mb-3.5">
          You bring your own students. It handles the scheduling, the pricing, who’s paid and who
          hasn’t, and the admin that eats your evenings. It isn’t a marketplace and isn’t a directory
          — no one browses for a cheaper teacher, and no one takes a percentage of what you earn.
        </p>
        <p className="type-body font-semibold text-ink mb-5">It’s free, and it stays free.</p>
        <p className="type-caption mb-2.5">The only thing we ask in return</p>
        <p className="type-title italic">Let people pay according to what they can afford.</p>
      </Section>

      <Section id="pricing" kicker="How it works" title="Fair pricing, worked out for you">
        <p className="type-body mb-6">
          Everyone books the same class. Behind the scenes, each student pays a little more or a
          little less depending on what they can afford — but the highest earner never pays more
          than about twice the lowest. You set the room cost and what you’d like to earn; the app
          calculates every price and shows its work. Nothing hidden, nothing to haggle over.
        </p>
        <LandingPricingDemo />
        <div className="grid gap-3 sm:grid-cols-3 mt-6">
          {VALUES.map((v) => (
            <Card key={v.title}>
              <h3 className="type-subtitle mb-1.5">{v.title}</h3>
              <p className="type-body">{v.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section kicker="Your practice, your rules" title="It’s your practice. It stays yours.">
        <ul className="flex flex-col">
          {PROMISES.map((p) => (
            <li key={p.lead} className="type-body py-4 border-b border-border last:border-b-0">
              <strong className="font-semibold text-ink">{p.lead}</strong> {p.body}
            </li>
          ))}
        </ul>
      </Section>

      <Section kicker="Why it’s built this way" title="Built on yoga’s own values">
        <div className="grid gap-3 sm:grid-cols-2">
          {YAMAS.map((y) => (
            <Card key={y.name}>
              <h3 className="flex items-baseline gap-2 mb-1.5">
                <span className="type-subtitle">{y.name}</span>
                <span className="type-caption">{y.gloss}</span>
              </h3>
              <p className="type-body">{y.body}</p>
            </Card>
          ))}
        </div>
        <p className="type-body mt-5">
          The app is open source, built by volunteers, and honest about what it costs to run —
          supported by teachers who choose to give back, never by fees.
        </p>
        <p className="type-caption mt-3">Open source · No fees</p>
      </Section>

      <section id="start" className="pt-10 pb-8">
        <Card className="px-6 py-8">
          <p className="type-caption mb-1.5">Get started</p>
          <h2 className="type-title mb-3">Set up your first class in a few minutes</h2>
          <p className="type-body mb-5">
            Fill in your profile and bank details, add your room, create your first class, and share
            your page. That’s it.
          </p>
          <ol className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-7 type-body text-ink">
            {STEPS.map((step, i) => (
              <li key={step}>
                {i > 0 && (
                  <span aria-hidden="true" className="text-brown-light mr-3">
                    →
                  </span>
                )}
                <span className="font-semibold text-teal">{i + 1}</span>&nbsp;{step}
              </li>
            ))}
          </ol>
          <Link href="/signup" className={PRIMARY_LINK}>
            Get started — it’s free
          </Link>
          <p className="type-caption mt-3.5">No fees. No commission. No catch.</p>
        </Card>
      </section>

      <footer className="border-t border-border pt-6 flex flex-col gap-2.5">
        <Wordmark />
        <p className="type-caption">Making the economics of yoga fair for everyone involved.</p>
        <p className="type-caption flex flex-wrap gap-2">
          <a href={REPO_URL}>Open source</a>
          <span aria-hidden="true">·</span>
          <a href={CONTACT_HREF}>Contact</a>
          <span aria-hidden="true">·</span>
          <Link href="/login">Sign in</Link>
        </p>
      </footer>
    </div>
  );
}
```

- [ ] **Step 5: Update the loading-coverage census**

In `src/lib/loading-coverage.test.ts`, replace the line `  '(public)': 'none',` with `  '': 'none',`.

- [ ] **Step 6: Run — expect PASS**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project components src/app/page.test.tsx
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec vitest run --project unit src/lib/loading-coverage.test.ts src/lib/list-row-recipe.test.ts
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm run typecheck
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm run lint
```

If `list-row-recipe.test.ts` names `src/app/page.tsx` as a stray (the promises list uses a divider-row shape), read that test's docblock and either use its owner recipe or add the documented `SPLIT_RECIPE_SITES` entry with its reason — do not weaken the test.

- [ ] **Step 7: Commit, then mutation-check the redirect and href guards**

```bash
git add src/app/page.tsx src/app/page.test.tsx src/components/layout/wordmark.tsx "src/app/(public)/layout.tsx" src/lib/loading-coverage.test.ts
git commit -m "feat: the landing page at /, with its own top bar and the pricing demo (#773)"
```

Apply each in `src/app/page.tsx`, run the page test, confirm FAIL, `git checkout -- src/app/page.tsx`:

1. Delete the line `  if (session?.studentId) redirect('/bookings');`
2. `<a href={CONTACT_HREF}>Contact</a>` → `<a href="#">Contact</a>`

`git status --short` must print nothing afterwards.

---

### Task 6: Browser coverage — a11y, visual baseline, phone width

**Files:**
- Modify: `tests/e2e/a11y.spec.ts` (add a `landing page` test beside `login page`, ~line 239)
- Modify: `tests/e2e/visual.spec.ts` (add a `landing` test beside `login`, ~line 355)
- Modify: `src/lib/visual-baseline-freshness.ts` (`ROUTE_BASELINES` entry)
- Create: `tests/e2e/visual.spec.ts-snapshots/landing-chromium-darwin.png`, `landing-Mobile-Chrome-darwin.png` (generated)
- Create: `tests/e2e/landing.spec.ts`

**Interfaces:**
- Consumes: the page from Task 5; `test`/`expect` from `tests/e2e/fixtures`; in `visual.spec.ts` the file-local `freezeDates` and `hideDevOverlay`; in `a11y.spec.ts` the file-local `expectNoSeriousViolations`.

- [ ] **Step 1: Start the worktree's app**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm run worktree:up
```

- [ ] **Step 2: Write the e2e spec**

`tests/e2e/landing.spec.ts`:

```ts
import { test, expect } from './fixtures';

test.describe('Landing page', () => {
  test('fits a 375px phone without sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  test('the hero sends a teacher to signup', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Set up your first class' }).click();
    await expect(page).toHaveURL(/\/signup$/);
  });

  test('the demo answers its sliders', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('slider', { name: 'Students registered' }).fill('3');
    await expect(page.getByRole('status')).toHaveText(
      'This class needs 4 students to go ahead. If it doesn’t get there, it’s cancelled and nobody pays.',
    );
  });
});
```

- [ ] **Step 3: Add the a11y and visual cases**

`tests/e2e/a11y.spec.ts`, after the `login page` test:

```ts
  test('landing page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoSeriousViolations(page);
  });
```

`tests/e2e/visual.spec.ts`, after the `login` test:

```ts
  test('landing', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await freezeDates(page);
    await expect(page).toHaveScreenshot('landing.png', { fullPage: true, stylePath: hideDevOverlay });
  });
```

`src/lib/visual-baseline-freshness.ts`, in `ROUTE_BASELINES` after the `login` entry:

```ts
  {
    name: 'landing',
    sourceFiles: ['src/app/page.tsx'],
    baselineFiles: baselineFiles('landing'),
  },
```

- [ ] **Step 4: Run the new e2e and a11y cases — expect PASS**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec playwright test landing a11y
```

Mutation check for the overflow assertion: temporarily add `min-w-[500px]` to the `<nav>` className, rerun `pnpm exec playwright test landing -g "375px"`, confirm FAIL, then `git checkout -- src/app/page.tsx`.

- [ ] **Step 5: Generate the landing baseline only, then look at it**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec playwright test visual -g landing --update-snapshots
```

Open both PNGs with the Read tool at actual size and check against the spec: wordmark + Sign in bar, ink h1 with teal italic opening, sand cards with 1px border and no shadow, tier rows reading `1 · Getting by`, nothing clipped on Mobile Chrome. Report what you saw.

- [ ] **Step 6: Run the whole visual suite without updating — the shared wordmark must not move a pixel**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec playwright test visual
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm run check-visual-baseline-freshness
```

Expected: all pass with `login` and `public-page` baselines untouched (`git status --short tests/e2e/visual.spec.ts-snapshots` lists only the two new landing PNGs).

- [ ] **Step 7: Full e2e run — the offline spec's `goto('/')` must still redirect**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm exec playwright test
```

- [ ] **Step 8: Full verify and commit**

```bash
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm run verify
git add tests/e2e/landing.spec.ts tests/e2e/a11y.spec.ts tests/e2e/visual.spec.ts src/lib/visual-baseline-freshness.ts tests/e2e/visual.spec.ts-snapshots/landing-chromium-darwin.png tests/e2e/visual.spec.ts-snapshots/landing-Mobile-Chrome-darwin.png
git commit -m "test: landing page a11y, visual baseline and phone-width checks (#773)"
```

---

### Task 7 (controller): follow-up issues

Not for a subagent — GitHub writes stay with the controller, after the user confirms.

- [ ] File: "Pricing preview rounds per tier; billing allocates cents per student" — `src/lib/pricing-preview.ts` `tierPrices` vs `calculateClassPricing`'s largest-remainder loop; a billed price can differ from the previewed one by a cent.
- [ ] File: "Running costs, Privacy and About pages" — the landing footer links only what exists (#773); restore the "Transparent costs" strapline when the costs page ships.
