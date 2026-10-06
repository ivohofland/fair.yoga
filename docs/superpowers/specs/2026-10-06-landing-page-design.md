# Landing page — design (#773)

`/` has been a deliberately plain placeholder since #385
(`src/app/(public)/page.tsx`: one sentence, two buttons). This is the
copy-and-design pass `docs/implementation-plan.md` 7.10 names.

**Source.** Claude Design project `0225e890-cfdc-48db-b174-75905b303e8e`,
`Landing Page v2.dc.html`, read as a **wireframe with content**: its sections,
order and copy are kept; its inline CSS is not. Every size and colour maps onto
the v2 tokens and the six `type-*` styles, and every repeated shape onto a
component that already exists. Where the mockup and the product disagree, the
product wins.

## Decision 1: the page leaves the `(public)` group

The `(public)` layout prints the wordmark above every page in the group — login,
signup, verify, a teacher's `[slug]` page. The landing page needs its own top
bar, so it moves to **`src/app/page.tsx`**, outside every route group. The root
layout already supplies the 640px column (`max-w-content`) and the 16px gutter;
no new layout file is needed. The URL does not change, and `(public)/page.tsx`
is deleted in the same commit — two pages resolving to `/` fail the build.

The signed-in redirects move with it unchanged: teacher → `/schedule`, student
→ `/bookings`. It stays a server component; the pricing demo is its only client
island.

**Top bar** (mobile-first, fits at 375px): the wordmark — the same markup the
`(public)` layout renders, so the site has one wordmark — and a **Sign in** text
link. The mockup's two anchor links and its "Get started" pill are dropped: the
hero already carries "See how the pricing works ↓", and the design brief allows
one primary per screen.

## Decision 2: the pricing demo shares its output with the teacher forms

The mockup's calculator re-implements the pricing maths with an invented
minimum rate ("60% of target"). The app already has the same thing:
`PricingPreviewTable` (`src/components/class/pricing-preview-table.tsx`), used
by the new-class page, the class edit form and the template form. It has **no
test file**.

Split it so logic, display and inputs are separate units:

| Unit | Kind | Holds |
|---|---|---|
| `src/lib/pricing-preview.ts` | pure functions | `normalSpread(n)` and the per-tier price calculation, moved out of the component unchanged, plus the spread ratio |
| `PricingPreviewResult` | presentational, no state | the "You earn" card, the tier table, the "Highest pays N× the lowest" line |
| `PricingPreviewTable` | client wrapper (teacher forms) | its existing class-size slider and normal/shuffle toggle — behaviour unchanged |
| `LandingPricingDemo` | client wrapper (landing page) | the two sliders below |

**Per-tier prices stay on the preview's own formula** (exact share rounded to the
cent per tier). `calculateClassPricing` allocates leftover cents per student, so
two students in one tier can be billed a cent apart — a one-row-per-tier table
cannot show that. Reconciling the two is out of scope.

**The landing demo** uses fixed example inputs, as a teacher configures them:
room €20, minimum rate €40 at 4 students, class of 4–12. A caption names them.

- **Students registered** — range 2–12, default 7, with `RegistrationProgress`
  above it (danger until the minimum, ink tick at 4 — the class-card bar).
- **Your target rate** — range €50–€130, step €5, default €90. "You earn" moves
  from the €40 floor at 4 students to the target at 12, via
  `calculateEffectiveTeacherRate`.
- **Below the minimum** the result is replaced by: "This class needs 4 students
  to go ahead. If it doesn't get there, it's cancelled and nobody pays." That is
  auto-cancel's real outcome; the mockup priced a class that would not run.
- **Normal spread only**, no shuffle toggle: deterministic, so the server render
  and the first client render agree (shuffle uses `Math.random`).
- Both sliders carry a visible `<label>` and an `aria-valuetext` ("7 students",
  "€90").

## Decision 3: tier rows read "1 · Getting by"

`PricingPreviewResult` labels each row with the tier number and its `TIER_INFO`
label — everywhere, so the three teacher forms change from "Tier 1" too. This
settles the teacher side of CLAUDE.md's open question on tier labels; that line
is updated in the same PR.

## Decision 4: copy changes only where it overpromises

Everything else in the mockup ships verbatim.

| Section | Mockup | Ships as | Why |
|---|---|---|---|
| The turn | "handles the scheduling, the pricing, the payments, and the admin…" | "…the pricing, who's paid and who hasn't, and the admin…" | No Mollie/Stripe code; Level 1 is payment requests plus the teacher marking paid |
| Value card 1 | "Set what you need to make. The app protects it." | "Set a minimum and a target. Every price is worked out to pay you between the two." | The rate scales and a below-minimum class is cancelled |
| The why | strapline "Open source · No fees · Transparent costs" | "Open source · No fees" | No running-costs page yet; the sentence about intent stays |
| The ask | "Add your profile, add your room, create your first class, and share the link" · steps Profile → Room → Class → Share | "Fill in your profile and bank details, add your room, create your first class, and share your page" · Profile → Bank details → Room → Class → Share | The real checklist, `src/lib/onboarding.ts` |
| Hero CTA | "Set up your first class" → `#start` | → `/signup` | One step closer to the action |

**Footer:** wordmark, tagline, then only links that resolve — **Open source**
(`https://github.com/ivohofland/fair.yoga`), **Contact**
(`mailto:hello@fair.yoga`, the support address `/verify` already uses), **Sign
in**. About, Running costs and Privacy have no page and are not linked.

**Style mapping:** kicker → `type-caption`; h1 → `type-display` with the italic
opening phrase in `text-teal`; h2 → `type-title`; body → `type-body`; all cards
→ `Card`; "It stays yours" → divider rows (no chevrons — they are not links);
CTAs → the pill classes the current page uses.

## Testing

1. **Characterize before moving.** `pricing-preview-table.test.tsx`, written
   against today's component: exact "You earn", room, total, rate progress,
   every tier count and price at the default size and after a slider move; the
   spread line; shuffle by invariant (counts sum to the class size). Each
   assertion group mutation-checked. After extraction its only planned edit is
   the tier label.
2. **Pure logic.** `src/lib/pricing-preview.test.ts`: `normalSpread` sums and
   exact distributions at 2, 7, 12; tier prices in exact cents; spread absent
   with fewer than two active tiers.
3. **Landing demo.** Default state shows €58.75 (40 + 50 × 3/8, hand-derived);
   the student slider changes counts and prices, and at 3 replaces the table
   with the minimum message; the rate slider changes every price; rows read
   "1 · Getting by"; `aria-valuetext` on both.
4. **The page.** Teacher → `/schedule`, student → `/bookings` (untested today);
   a visitor sees every section heading; every `href` is `/signup`, `/login`,
   the repo URL or the `mailto:`.
5. **Browser.** `/` added to `a11y.spec.ts` and to `visual.spec.ts` with a
   `ROUTE_BASELINES` entry and attestation; an e2e check for no horizontal
   scroll at 375px and the hero CTA reaching `/signup`. `FALLBACK_ROUTES` swaps
   `'(public)'` for `''`.

## Not doing

- Reconciling the preview's per-tier rounding with billing's largest-remainder
  cents — its own issue.
- Running costs, Privacy and About pages; restoring "Transparent costs" once the
  costs page exists — their own issues.
- Moving `PricingPreviewTable` onto `calculateClassPricing`.
