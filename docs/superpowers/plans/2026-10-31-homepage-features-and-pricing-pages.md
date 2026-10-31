# Homepage features, `/sliding-scale` and `/donation-based` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the landing page's pricing band with a grouped feature section, stop `/` redirecting signed-in visitors, and add two indexable subpages: a sliding-scale explainer with an adjustable example calculator, and a donation-classes page.

**Architecture:** One pure preview function (`previewClass`) feeds the existing `PricingPreviewResult`, the homepage proof box and the calculator, so every number on every page comes from the same code. A session-aware `SiteHeader`/`SiteFooter` pair is shared by the three marketing pages. The subpages are root-level routes beside `src/app/page.tsx`.

**Tech Stack:** Next.js 16 App Router (server components; one client component for the calculator), TypeScript strict, Tailwind v4 tokens, Vitest (unit + components), Playwright (e2e, visual, a11y).

**Spec:** `docs/superpowers/specs/2026-10-31-homepage-features-and-pricing-pages-design.md`. All copy in this plan is quoted from it; where a step says "copy per spec §X", use that section verbatim.

## Global Constraints

- Every price shown is computed by `previewClass` (Task 1), never typed into copy or tests. Tests compute expected values through `previewClass`.
- EUR only. No currency picker, no inference.
- No "dana" anywhere in user-facing copy (enforced by Task 8).
- Copy states what the product does; never claims knowledge about teachers or students ("many teachers…").
- Page metadata sets `title` (absolute), `description`, `alternates.canonical`; **no `openGraph`** on the subpages. Canonical carries no query string.
- No redirect on `/`, `/sliding-scale` or `/donation-based` for any visitor.
- Signed-in header link: **Open the app** → `/start`; signed out: **Sign in** → `/login`.
- Design brief: six type styles, Georgia headings, no shadows (except sheets/modals), no motion, line icons via `Icon`, touch targets ≥44px, 375px phone without sideways scroll.
- Landing column: `mx-auto w-full max-w-[960px] px-4 sm:px-10`.
- Comment Discipline (CLAUDE.md): comments annotate their own code; cross-module policy lives in `docs/technical-architecture.md` (Search engines).
- Run commands with Node 24 on PATH: `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v24' | tail -1)/bin:$PATH"`.

## Review Focus

1. **`?example=` arrives repeated, empty, mixed-case or unknown** (`?example=a&example=b`, `?example=`, `?example=Popular`): the page renders the first valid key or `typical`, never a 500. → Task 1 `parseExampleKey` tests.
2. **Minimum below minus the room cost** (room €0, minimum −€20 gives a negative class total and negative prices; the database refuses `minRate < -roomCost`): the calculator keeps `min >= -room`, dragging the minimum up when the room drops. → Task 5 test.
3. **A signed-in student, teacher or two-hat account opens `/`**: sees the homepage with **Open the app**, not a redirect. → Task 3 tests.
4. **A push notification without a URL, or `/` opened offline**: opens `/start`; `/` offline shows the generic offline page, not a stale schedule. → Task 4.
5. **Phone width (375px) on both new pages**, calculator controls included: no sideways scroll. → Task 9 e2e.

---

### Task 1: One preview function and the shared examples

**Files:**
- Modify: `src/lib/pricing-preview.ts` (add `previewClass`)
- Modify: `src/components/class/pricing-preview-result.tsx` (compute through `previewClass`; render unchanged)
- Create: `src/lib/pricing-examples.ts`
- Test: `src/lib/pricing-preview.test.ts` (extend or create), `src/lib/pricing-examples.test.ts`

**Interfaces:**
- Produces:
  - `previewClass(inputs: Omit<PricingPreviewInputs, 'currency' | 'hideRoomCost'>, distribution: TierCounts): { teacherRate: number; totalCost: number; vatCents: number; prices: TierPrices }` in `src/lib/pricing-preview.ts`. Exactly the arithmetic `PricingPreviewResult` does today (`calculateEffectiveTeacherRate`, `withVat` rounded once to cents, `tierPrices`), except that `vatCents` is `0` when the class charges no VAT. Today's component derives a negative value there and never shows it.
  - In `src/lib/pricing-examples.ts`:
    - `type PricingExampleKey = 'typical' | 'new-class' | 'popular' | 'flat-rate' | 'vat'`
    - `interface PricingExample { label: string; story: string; students: number; roomCost: number; minRate: number; targetRate: number; minStudents: number; maxStudents: number; vatPercent: number }`
    - `PRICING_EXAMPLES: Record<PricingExampleKey, PricingExample>` (`as const satisfies`), values and copy per spec §5.3, in table order.
    - `DEFAULT_EXAMPLE_KEY: PricingExampleKey = 'typical'`
    - `parseExampleKey(raw: string | string[] | undefined): PricingExampleKey`
    - `examplePreview(key: PricingExampleKey): ReturnType<typeof previewClass>`, which is `previewClass` over the example with `normalSpread(students)`.

- [ ] **Step 1: Write the failing tests**

```ts
// pricing-preview.test.ts
it('previews the typical example the way the landing demo always has', () => {
  const p = previewClass(
    { roomCost: 20, minRate: 40, targetRate: 90, minStudents: 4, maxStudents: 12, vatPercent: 0 },
    normalSpread(7),
  );
  expect(p.teacherRate).toBe(58.75);
  expect(p.prices[1]).toBe(7.31);
  expect(p.prices[5]).toBe(15.19);
});
it('adds VAT once on the rounded total', () => {
  const p = previewClass({ roomCost: 20, minRate: 40, targetRate: 90, minStudents: 4, maxStudents: 12, vatPercent: 21 }, normalSpread(7));
  expect(p.totalCost).toBe(95.29);
  expect(p.vatCents).toBe(1654);
});

// pricing-examples.test.ts
it.each([[undefined, 'typical'], ['popular', 'popular'], [['vat', 'popular'], 'vat'], ['', 'typical'], ['Popular', 'typical'], ['nope', 'typical']])(
  'parseExampleKey(%j) is %s', (raw, key) => expect(parseExampleKey(raw)).toBe(key));
it('every example keeps its minimum at or above minus the room cost', () => {
  for (const e of Object.values(PRICING_EXAMPLES)) expect(e.minRate).toBeGreaterThanOrEqual(-e.roomCost);
});
it('the typical example is the one the homepage proof shows', () => {
  expect(examplePreview('typical')).toEqual(previewClass({ roomCost: 20, minRate: 40, targetRate: 90, minStudents: 4, maxStudents: 12, vatPercent: 0 }, normalSpread(7)));
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run src/lib/pricing-preview.test.ts src/lib/pricing-examples.test.ts`
Expected: FAIL (`previewClass` and `pricing-examples` not defined).

- [ ] **Step 3: Implement `previewClass`, point `PricingPreviewResult` at it, and write `pricing-examples.ts`**

`PricingPreviewResult` keeps its props and markup; only its arithmetic moves.

- [ ] **Step 4: Run these tests and the existing preview and class-form suites**

Run: `pnpm exec vitest run src/lib/pricing-preview.test.ts src/lib/pricing-examples.test.ts src/components/class src/components/landing`
Expected: PASS, with no snapshot or assertion changes in existing tests.

- [ ] **Step 5: Commit** — `refactor: previewClass is the one preview computation; shared pricing examples`

---

### Task 2: Session-aware site header and footer

**Files:**
- Create: `src/components/landing/site-header.tsx`, `src/components/landing/site-footer.tsx`
- Test: `src/components/landing/site-header.test.tsx`, `src/components/landing/site-footer.test.tsx`

**Interfaces:**
- Produces:
  - `SiteHeader({ signedIn, onHome }: { signedIn: boolean; onHome: boolean })`. Nav links are **What it does** (`#features` when `onHome`, else `/#features`; hidden below `sm`, as today) and **Open source** (`#open-source` / `/#open-source`). The right-hand link is **Sign in** → `/login`, or **Open the app** → `/start` when `signedIn`. The wordmark links to `/`.
  - `SiteFooter({ signedIn }: { signedIn: boolean })`. Today's footer, plus **Sliding scale** → `/sliding-scale` and **Donation-based** → `/donation-based`. The sign-in link follows the same rule as the header.
  - Both use the landing's `COLUMN` classes. Lift `REPO_URL`, `CONTACT_HREF` and the link class strings out of `page.tsx` into `src/components/landing/landing-links.ts`.

- [ ] **Step 1: Write the failing tests**: signed out shows `Sign in` → `/login` and no `Open the app`; signed in, the reverse with `/start`; `onHome` decides `#features` vs `/#features` and `#open-source` vs `/#open-source`; the footer links both subpages.
- [ ] **Step 2: Run them and see them fail** — `pnpm exec vitest run src/components/landing/site-header.test.tsx src/components/landing/site-footer.test.tsx`
- [ ] **Step 3: Implement both components**
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat: session-aware site header and footer for the marketing pages`

---

### Task 3: The homepage — no redirect, feature band, proof box

**Files:**
- Create: `src/components/landing/feature-band.tsx`, `src/components/landing/proof-box.tsx`
- Modify: `src/app/page.tsx`
- Test: `src/app/page.test.tsx`, `src/components/landing/feature-band.test.tsx`, `tests/e2e/landing.spec.ts`

**Interfaces:**
- Consumes: `SiteHeader`, `SiteFooter` (Task 2); `examplePreview`, `PRICING_EXAMPLES` (Task 1).
- Produces: `FeatureBand()` (a server component, `<section id="features" aria-labelledby=…>`) and `ProofBox()`.

Copy per spec §4.2 and §4.3. Cards: `bg-sand-soft border border-border rounded-card`, items with `Icon name="check"`. The proof caption reads "Example: {students} students, a {room} room, your target {target}", built from `PRICING_EXAMPLES.typical` with `formatMoney`. The numbers are `examplePreview('typical')`: `prices[1]`, `prices[5]`, `teacherRate`. The link is **See more examples →** → `/sliding-scale#examples`.

`page.tsx`: delete the `redirect` calls and keep `getSession()` only to compute `signedIn = session !== null`. Delete `FEATURES`, `PRICING_POINTS` and the `#pricing` band. Hero link becomes **See what it does ↓** → `#features`. Order: hero → "Look around the room" → free promise → `FeatureBand` → "Not a marketplace" → principles/open source → steps → `SiteFooter`. Update the docblock: the page is the same for everyone; the app's door is `/start`.

- [ ] **Step 1: Write the failing tests**
  - `page.test.tsx`: replace "sends a signed-in %s home" with "shows the homepage to a signed-in %s, offering Open the app → /start" for teacher, student and two-hat. Update `ALLOWED_HREFS` (`#features`, `/sliding-scale`, `/donation-based`, `/sliding-scale#examples`, `/start` is absent signed out; `#pricing` is gone). Update the h2 order: `Look around the room…`, `Everything a class needs, nothing it doesn’t`, `Your students, your income, your rules`, `Fair to everyone in the room`, `Your first class, ready in a few minutes`. Assert there's no `Students registered` slider.
  - `feature-band.test.tsx`: four card labels in order (Pricing, Classes, Students, Money); the two Pricing links; the proof numbers equal `formatMoney` of `examplePreview('typical')` values; the closing strip text.
  - `landing.spec.ts`: "See what it does" lands on `#features` and back from signup returns there; drop "the demo answers its sliders"; the column test targets `#features`.
- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run src/app/page.test.tsx src/components/landing/feature-band.test.tsx`
- [ ] **Step 3: Implement `ProofBox`, `FeatureBand` and the page changes**
- [ ] **Step 4: Run and see them pass**, plus `pnpm exec playwright test tests/e2e/landing.spec.ts` against the dev server on :3000 (warm `/` with `curl` first)
- [ ] **Step 5: Commit** — `feat: homepage feature band with engine-computed proof; / no longer redirects`

---

### Task 4: `/start`, not `/`, is the app's door in the service worker

**Files:**
- Modify: `public/sw.js` (the `pathname === '/' || pathname === '/start'` navigation rule; the `'/'` fallbacks in the notification URL helper and in the default `showNotification` data)
- Modify: `tests/e2e/offline.spec.ts` (the offline step that opens `/` and expects `/schedule`)
- Modify: `docs/technical-architecture.md` (Installed app start URL: `/` is the public homepage for everyone; `/start` is the only door)

- [ ] **Step 1: Change the offline e2e first**: `page.goto('/start')` expects `/schedule`; add `page.goto('/')` offline expects the generic offline page text ("This page wasn't saved on this device").
- [ ] **Step 2: Run it and see it fail** — `pnpm exec playwright test tests/e2e/offline.spec.ts`
- [ ] **Step 3: Edit `sw.js`**: the schedule fallback applies to `/start` only; every `'/'` default URL becomes `'/start'`.
- [ ] **Step 4: Run it and see it pass**
- [ ] **Step 5: Commit** — `fix: the service worker treats /start, not /, as the app's door`

---

### Task 5: The example calculator

**Files:**
- Create: `src/components/landing/pricing-calculator.tsx` (`'use client'`)
- Test: `src/components/landing/pricing-calculator.test.tsx`
- Delete: `src/components/landing/landing-pricing-demo.tsx` and its test (nothing imports it after Task 3)

**Interfaces:**
- Consumes: `PRICING_EXAMPLES`, `PricingExampleKey` (Task 1); `PricingPreviewResult`, `RangeTrack`, `normalSpread`.
- Produces: `PricingCalculator({ initialExample }: { initialExample: PricingExampleKey })`

Behaviour and copy per spec §5.3:
- Chips use `aria-pressed`. Choosing one loads its values and calls `history.replaceState(null, '', '?example=' + key + '#examples')`.
- Ranges: students 1–18; room €0–€80 step 5; minimum −€20–€120 step 5; target €0–€150 step 5. VAT is a three-button group, None/9%/21%.
- Ordering: moving the minimum above the target raises the target; moving the target below the minimum lowers the minimum. **The minimum never goes below `-roomCost`**: lowering the room raises the minimum if needed.
- Reset restores the example and is disabled while nothing differs.
- Below `minStudents`, show the danger-outline note (spec copy, `role="status"`) instead of the result. Above `maxStudents`, show the extra line.
- The result is `<PricingPreviewResult currency="EUR" … distribution={normalSpread(students)} showRateProgress={false} />`.

- [ ] **Step 1: Write the failing tests**
  - Renders the `initialExample` with its chip pressed, and the result's tier-1 price equals `formatMoney(examplePreview(key).prices[1], 'EUR')` for every key.
  - Choosing a chip calls `history.replaceState` with `?example=popular#examples`.
  - Reset is disabled initially; enabled after changing students; clicking it restores the value and disables it again.
  - Students set below the minimum shows the auto-cancel note and no tier prices.
  - Target dragged below the minimum lowers the minimum to match.
  - **Room set to €0 with the minimum at −€20 brings the minimum to €0** (Review Focus 2).
- [ ] **Step 2: Run them and see them fail** — `pnpm exec vitest run src/components/landing/pricing-calculator.test.tsx`
- [ ] **Step 3: Implement `PricingCalculator`; delete `LandingPricingDemo` and its test**
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat: adjustable example calculator on the preview engine`

---

### Task 6: `/sliding-scale`

**Files:**
- Create: `src/app/sliding-scale/page.tsx`
- Modify: `src/lib/reserved-slugs.ts` (add `'sliding-scale'`)
- Test: `src/app/sliding-scale/page.test.tsx`

**Interfaces:**
- Consumes: `SiteHeader`/`SiteFooter` (Task 2, `onHome={false}`), `PricingCalculator` (Task 5), `parseExampleKey` (Task 1), `TIER_INFO`, `TIER_RATIOS`.
- Produces: `metadata` and `default async function SlidingScalePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> })`

Content, copy and order per spec §5.1–5.2. The tier card has no slider, and the two columns use `items-center`. The calculator band has `id="examples"`. The three points move here from the old homepage band verbatim. The FAQ uses `<details>`, with the first one open. The call to action → `/signup`. No redirect.

- [ ] **Step 1: Write the failing tests**: metadata (absolute title, description, `canonical: '/sliding-scale'`, `openGraph` undefined, `robots` undefined); `?example=popular` renders the Popular chip pressed; an unknown example falls back to typical; the five `TIER_INFO` labels and their multipliers; the FAQ questions; the proof-of-income answer reads "…a choice that’s off by one makes only a small difference."
- [ ] **Step 2: Run and see them fail**, along with `pnpm exec vitest run src/lib/schemas.test.ts`, whose route scan fails once the directory exists
- [ ] **Step 3: Implement the page and reserve the slug**
- [ ] **Step 4: Run and see them pass**
- [ ] **Step 5: Commit** — `feat: /sliding-scale — how it works, examples, questions`

---

### Task 7: `/donation-based`, with the give page's words shared

**Files:**
- Create: `src/lib/give-page-copy.ts`
- Modify: `src/app/(student)/bookings/[classId]/give/page.tsx` (use the shared copy; output unchanged)
- Create: `src/app/donation-based/page.tsx`, `src/components/landing/give-page-phone.tsx`
- Modify: `src/lib/reserved-slugs.ts` (add `'donation-based'`)
- Test: `src/lib/give-page-copy.test.ts`, `src/app/donation-based/page.test.tsx`

**Interfaces:**
- Produces:
  - `GIVE_PAGE_HEADING = 'Thank you for coming.'`, `GIVE_PAGE_BACK = 'Your bookings'`, `giveCaption(entry: { classType: string; date: Date }, teacher: { firstName: string; lastName: string }): string` (today's `` `${classType} · ${formatDayHeader(date)} · with ${first} ${last}` ``)
  - `GivePagePhone()`: a phone-framed illustration (border, radius, no shadow) rendering `GIVE_PAGE_BACK`, `GIVE_PAGE_HEADING` and `giveCaption({ classType: 'Slow flow', date: <a Tuesday> }, { firstName: 'Anna', lastName: 'Smith' })`. Below them sits the real `MethodChooser` with `amount={{ kind: 'open' }}`, `currency="EUR"`, and sample methods: `bank_transfer` (beneficiary "Anna Smith", `{ scheme: 'sepa', iban: 'NL91ABNA0417164300', bic: null }`), `epc_qr`, `payment_link` (`https://example.com/anna`). The illustration is `aria-hidden` apart from a label, and its inputs are not focusable.

Page content, copy and order per spec §6.1–6.2.

- [ ] **Step 1: Write the failing tests**: `giveCaption` output for a fixed date; the give page still renders the same heading and caption (existing give-page tests stay green); the donation page metadata (as in Task 6, canonical `/donation-based`); the four step titles; the four promises; the Mollie answer text; `GivePagePhone` shows `GIVE_PAGE_HEADING`.
- [ ] **Step 2: Run and see them fail** (plus the `schemas.test.ts` route scan)
- [ ] **Step 3: Implement the copy module, refactor the give page, build the page and the phone, reserve the slug**
- [ ] **Step 4: Run and see them pass** — `pnpm exec vitest run src/lib/give-page-copy.test.ts src/app/donation-based "src/app/(student)/bookings"`
- [ ] **Step 5: Commit** — `feat: /donation-based; the give page's words are shared with its illustration`

---

### Task 8: Search wiring and the copy guard

**Files:**
- Modify: `src/app/sitemap.ts`, `src/app/sitemap.test.ts`
- Modify: `src/app/noindex.test.tsx` (also scan root-level page directories)
- Create: `src/app/marketing-copy.test.tsx`
- Modify: `docs/technical-architecture.md` (Search engines: the sitemap lists the platform pages `/`, `/sliding-scale`, `/donation-based`; root-level pages are classified by the census)

- [ ] **Step 1: Write the failing tests**
  - `sitemap.test.ts`: the exact list is `['https://fair.yoga/', 'https://fair.yoga/sliding-scale', 'https://fair.yoga/donation-based']`.
  - `noindex.test.tsx`: every `page.tsx` directly under a root-level, non-group directory of `src/app` is either noindex or in a new `INDEXABLE_ROOT` set (`sliding-scale`, `donation-based`), with the same unclassified/stale check as `(public)`.
  - `marketing-copy.test.tsx`: renders `/`, `/sliding-scale` and `/donation-based` and asserts `document.body.textContent` does not match `/\bdana\b/i`.
- [ ] **Step 2: Run them and see the sitemap test fail** (the census and copy tests may already pass; they guard the future)
- [ ] **Step 3: Update the sitemap and the docs**
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat: sitemap lists the subpages; census covers root pages; no-dana guard`

---

### Task 9: Visual baselines, accessibility, phone width, local check

**Files:**
- Modify: `tests/e2e/visual.spec.ts` (add `sliding-scale` and `donation-based` screenshots, full page, `freezeDates`, `hideDevOverlay`)
- Modify: `src/lib/visual-baseline-freshness.ts` (`ROUTE_BASELINES` entries: `sliding-scale` → `src/app/sliding-scale/page.tsx`, `donation-based` → `src/app/donation-based/page.tsx`)
- Modify: `tests/e2e/a11y.spec.ts` (both pages, `expectNoSeriousViolations`)
- Create: `tests/e2e/pricing-pages.spec.ts`
- Snapshots: `tests/e2e/visual.spec.ts-snapshots/{landing,sliding-scale,donation-based}-*-darwin.png`

- [ ] **Step 1: Write the e2e tests**: both pages fit 375px with zero sideways overflow (as `landing.spec.ts` measures it); `?example=new-class` opens with that chip pressed; choosing "A popular class" puts `?example=popular` in the URL; Reset returns the students slider to 7 on `typical`.
- [ ] **Step 2: Run them against the dev server** (warm each route with `curl` first) — `pnpm exec playwright test tests/e2e/pricing-pages.spec.ts tests/e2e/a11y.spec.ts`
- [ ] **Step 3: Generate the baselines** — `pnpm exec playwright test tests/e2e/visual.spec.ts -g "landing|sliding|donation" --update-snapshots`. Read every new PNG and check it against the spec before committing.
- [ ] **Step 4: Full gate** — `pnpm run verify` (typecheck, lint, all vitest projects, lockfile, migrations, visual freshness). Expected: exit 0.
- [ ] **Step 5: Local walkthrough** on the running app, signed out and signed in (a minted session per `.claude/skills/verify`): homepage links, the proof numbers, every example chip and reset, the donation page, **Open the app** → the right home, `/robots.txt` and `/sitemap.xml`.
- [ ] **Step 6: Commit** — `test: baselines, a11y and phone-width checks for the marketing pages`
