# Homepage feature section, `/sliding-scale` and `/donation-based`

One PR, three pages, tested locally before deploy. Step 2 of making the site
findable, after the technical basics in #950 (`docs/technical-architecture.md`,
Search engines).

## 1. Intent

The landing page (`src/app/page.tsx`) makes one argument well, income-based
pricing, but says nothing about donation classes, online and private classes,
recurring schedules, the waitlist or payments. It is also the only page a search
engine can rank, so someone searching "sliding scale yoga booking" or "donation
based yoga classes" lands on a page that answers neither question directly.

So:

- **The homepage stays a story.** Its narrative bands stay; the interactive
  pricing band is replaced by a grouped feature section that shows the breadth of
  the product and links to subpages.
- **Each subpage answers one search.** `/sliding-scale` explains the tiers and
  lets a teacher play with worked examples. `/donation-based` explains donation
  classes. Both link back and across.
- **The proof stays on the homepage**, smaller: three numbers inside the Pricing
  card, linking to the full calculator.

## 2. Goals, non-goals, anti-goals

**Goals**
- A visitor sees, in one band, everything fair.yoga does, grouped so it scans.
- `/sliding-scale` and `/donation-based` are indexable, listed in the sitemap,
  and linked from the homepage.
- Every number shown anywhere is computed by the pricing code, never typed into
  copy: the preview path the class form uses, the same on every page.

**Non-goals**
- Subpages for online classes, private classes, the website embed or anything
  else (their cards carry no link yet). The embed (#916,
  `docs/superpowers/specs/2026-10-30-share-your-schedule-design.md`) is a likely
  next subpage.
- A currency picker or currency inference. Examples are in EUR only (owner's
  decision; reasons in §9).
- Any change to the app's own screens or copy, including the donation give page.
- Fixing #777 (preview and billing round cents differently). The calculator
  reuses the preview, so it inherits that one-cent gap; #777 is fixed
  separately, and both marketing pages pick the fix up through the shared
  preview function (§4.3).
- Mollie for donations. The give page drops processor methods on purpose
  (`src/app/(student)/bookings/[classId]/give/page.tsx`); an open-amount Mollie
  path would be its own issue.

**Anti-goals** (would make this a failure even if it works)
- Copy that claims knowledge fair.yoga does not have ("many teachers…", "people
  choose honestly", "rarely matters"). State what the product does; suggest,
  don't assert.
- Religious or spiritual vocabulary. In particular, **never "dana"**: the owner
  does not want to open the door to misinterpretation.
- Marketing that shows students words the app never shows them.
- Motion, shadows (except sheets/modals), gradients, gamification: the design
  brief applies to these pages as to the app (`docs/design-brief.md`).

## 3. Constraints

- Tokens, type and components from `src/app/globals.css` and
  `docs/design_handoff_fairyoga/`. Six type styles only; Georgia headings; line
  icons inlined (stroke 1.75); cards are sand-soft with a 1px border, radius 16.
- The landing page's own column: `max-w-[960px] px-4 sm:px-10` (`COLUMN` in
  `src/app/page.tsx`). Subpages use the same column and the same header and
  footer as the landing page.
- Mobile first: everything stacks to one column at phone width, no horizontal
  scroll, touch targets ≥44px.
- Search rules from `docs/technical-architecture.md` (Search engines): page
  metadata sets no `openGraph` of its own (it would drop the inherited preview
  image); canonical URLs carry no query string; the sitemap lists platform
  pages.

## 4. Homepage changes (`src/app/page.tsx`)

### 4.1 What goes, what stays

**The homepage is always the homepage.** Today `LandingPage` redirects a
signed-in teacher to `/schedule` and a student to `/bookings`; that redirect is
removed, so every visitor sees the same page. The app's front door is `/start`
(`docs/technical-architecture.md`, Installed app start URL), and the header
links there for a signed-in visitor (§7).

| Band | Change |
|---|---|
| Hero | Stays. "See how the pricing works ↓" becomes **"See what it does ↓"** → `#features`. |
| Three-feature strip under the hero (Scheduling / Bookings / Payments) | **Removed**: the new band covers it. The hero leads straight into "Look around the room". |
| "Look around the room" | Stays. |
| Free promise ("Let people pay according to what they can afford") | Stays. |
| "How the pricing works" (`#pricing`: text, three points, `LandingPricingDemo`) | **Replaced** by the feature band (§4.2), same position. The three points and the demo move to `/sliding-scale`. |
| "Not a marketplace", principles, open source, five steps, footer | Stay. |
| Header nav | "How the pricing works" → **"What it does"** (`#features`). |

### 4.2 The feature band (`id="features"`)

Layout: heading block, then **four cards in a 2×2 grid** (one column below
`sm`), then one quiet line. Cards: `bg-sand-soft border border-border
rounded-card`, a small label (`text-[13px] font-medium text-brown`), a Georgia
promise line (`type-subtitle text-teal`), and check-icon items (`Icon
name="check"`, as the "Not a marketplace" band already uses).

Heading block:
- Kicker: **What it does**
- Heading: **Everything a class needs, nothing it doesn’t**
- Lead: **Pricing, scheduling, bookings and payments in one calm place, built for teachers who run their own classes.**

Cards (label · promise · items):

1. **Pricing** · *Charge what’s fair, earn what you need*
   - [Sliding scale](/sliding-scale): five income tiers, the highest pays about twice the lowest
   - [Donation-based](/donation-based): students give what they can after class
   - Or earn the same every class, with one flat rate for you
   - VAT and your own currency
   - **Proof box** (§4.3)
2. **Classes** · *Your schedule, set once*
   - Recurring classes that fill your calendar ahead
   - Your live schedule on your own website, plus a calendar feed students can subscribe to
   - Online classes: the join link reaches only booked students
   - Private classes, shared by link and kept off your page
   - Your rooms and what they cost you
   - Auto-cancel when too few sign up
3. **Students** · *Fill the room without chasing*
   - One link to share, booked in a few taps
   - A waitlist that promotes people on its own
   - Walk-ins at the door
   - Reminders and announcements
   - Each student decides what you can see
4. **Money** · *Paid directly, tracked for you*
   - Bank transfer with a QR code, your payment link, or Mollie
   - Who has paid, at a glance
   - Waive a payment when life happens
   - Income reports, studio classes included

Below the grid, centred, `text-sm text-brown`: **Works as an app on your phone · No passwords · No commission, ever**

Only the two Pricing items link. The other cards link nowhere until their
subpages exist.

### 4.3 The proof box

Inside the Pricing card: a cream box (`bg-cream border border-border
rounded-field`) holding a caption, three numbers and a link.

- Caption: **Example: 7 students, a €30 room, your target €90**
- Numbers (tabular, teal): **lowest tier pays** · **highest tier pays** · **you earn**
- Link: **See more examples →** → `/sliding-scale#examples`

The numbers are computed at render from the same example the `/sliding-scale`
"A typical class" preset uses (§5.3): room €30, minimum €40 from 4 students,
target €90 at 12, no VAT, 7 students in the normal spread (`normalSpread`,
`src/lib/pricing-preview.ts`). Today that is €8.24 / €17.12 / €58.75. The
example's values live in one module both pages import, and the proof's prices
come from the **same preview function the calculator uses** (`tierPrices` via
the `PricingPreviewResult` path), not from `calculateClassPricing`: the two
round cents differently (#777), and the proof and the calculator must never
disagree with each other.

## 5. `/sliding-scale`

### 5.1 Metadata
- Title (absolute): **Sliding-scale pricing for yoga classes · fair.yoga**
- Description: **Five income tiers, the highest paying about twice the lowest. Set your minimum and target; fair.yoga works out every price. Try the examples.**
- Canonical `/sliding-scale`, whatever the query string.

### 5.2 Content, top to bottom
1. Shared header; a trail **fair.yoga / Sliding scale** linking home.
2. H1: ***Sliding-scale pricing** for yoga classes, worked out for you* (first
   phrase teal italic, as on the landing hero).
   Lead: **Everyone books the same class. Each student picks the income tier that fits their life, and pays a little more or a little less. You set what you need to earn; fair.yoga does the sums.**
3. **How it works** band. Heading: **Five tiers, never more than about twice apart.**
   Two columns, **vertically centred on each other**:
   - Text: *Students choose a tier when they book. Nobody asks for proof: trust, not checks.* / *You enter what the room costs, the least you need to earn and what you’d like to earn. After class, the price is set from who registered: the more students, the closer you get to your target and the less each person pays.* / *A middle-tier student pays the plain share. The highest tier pays about twice what the lowest does, so nobody is priced out and nobody is squeezed.*
   - A tier card: the five tiers from `TIER_INFO` (number, label, caption) with
     each tier's multiplier from `TIER_RATIOS`. **No slider here** (tried and
     dropped).
4. **Try it** band (`id="examples"`). Heading: **What would your class look like?** — the calculator (§5.3).
5. **What it means for you** band. Heading: **Your rate, without the guesswork.** The three points moved from the homepage (*You earn your rate* / *No surprises* / *No one priced out*, today's copy), then questions:
   - **Do students have to prove their income?** No. They pick the tier that fits their life right now. The highest tier pays about twice the lowest, so a choice that’s off by one makes only a small difference.
   - **What if only a few people come?** Below your minimum number of students, the class auto-cancels at the time you choose. At or above it, you earn at least your minimum rate.
   - **Can I earn the same every class?** Yes: set your minimum equal to your target. Students still pay by income tier, and the more people come, the less each pays.
   - **What does fair.yoga take?** Nothing. It’s free and open source, and students pay you directly.
6. A teal-tint call to action: **Try it with your own room and rate** → **Set up your first class** (`/signup`).
7. Shared footer.

### 5.3 The calculator

Five **example buttons** (pill chips, the pressed one filled teal,
`aria-pressed`):

| Key (`?example=`) | Label | Story | Students | Room | Minimum | Target | Class size (min–max) | VAT |
|---|---|---|---|---|---|---|---|---|
| `typical` (default) | A typical class | Seven students on a normal week. The room is covered and you earn well above your minimum. | 7 | €30 | €40 | €90 | 4–12 | 0 |
| `new-class` | A new class | Just starting out? A low minimum and a small minimum class size keep the class running while word gets around, instead of auto-cancelling. | 3 | €30 | €10 | €70 | 2–12 | 0 |
| `popular` | A popular class | Full, plus two walk-ins. Your rate stays capped at your target, so every extra student lowers everyone’s price. | 14 | €30 | €40 | €90 | 4–12 | 0 |
| `flat-rate` | A flat rate | Prefer one simple income? Set your minimum and target to the same amount: you earn the same every class. | 8 | €30 | €60 | €60 | 4–12 | 0 |
| `vat` | With VAT | Registered for VAT? Enter rates without it. Each student’s price includes their share, and what you earn stays the same. | 7 | €30 | €40 | €90 | 4–12 | 21% |

**Every example is adjustable.** Controls (the existing `RangeTrack`,
`src/components/landing/range-track.tsx`, for sliders):
- Students registered, 1–18; its value reads `n / min–max`, with the hint *The class runs from {min}; your target is reached at {max}.*
- Room cost, €0–€80, step 5
- Your minimum, −€20–€120, step 5. Hint: *What you earn with {min} students*, or below zero *Below zero: you cover part of the room yourself.*
- Your target, €0–€150, step 5. Hint: *What you earn with {max} or more*, or when equal to the minimum *Same as your minimum: a flat rate.* Minimum and target stay ordered: moving one past the other drags the other with it.
- VAT: three segmented buttons, **None / 9% / 21%**.
- **Reset to the example**: restores the selected example's values; disabled
  until something differs from them.

Class size (min–max) is fixed per example and shown, not adjustable.

**The result** reuses `PricingPreviewResult`
(`src/components/class/pricing-preview-result.tsx`), the engine-backed table the
class form and today's landing demo already use, with
`distribution = normalSpread(students)`. It shows each tier's price (all five,
whoever came), what the teacher earns, and the class total line. Two states it
must also cover:
- **Below the minimum class size:** instead of prices, a danger-outline note: *With {n} students, this class is below your minimum of {min}. It would auto-cancel at the time you choose, and nobody pays.*
- **Above the maximum:** an extra line: *Above your target size, extra students only lower prices.*

On desktop the result sits beside the controls and stays in view while they
scroll; on a phone it follows them.

**Links.** `?example=<key>` selects an example on first render (server-side, so
there is no flash and a shared link opens on the right example); an unknown key
falls back to `typical`. Choosing an example updates the URL with
`history.replaceState`, so the address bar is always shareable. Adjusted values
are not put in the URL.

## 6. `/donation-based`

### 6.1 Metadata
- Title (absolute): **Donation-based yoga classes · fair.yoga**
- Description: **Offer classes without a price. Students book as usual, and after class everyone who came is invited once to give what they can, straight to you.**
- Canonical `/donation-based`.

### 6.2 Content, top to bottom
1. Shared header; trail **fair.yoga / Donation-based classes**.
2. H1: ***Donation-based yoga classes**, offered freely.* Lead: **Offer your teaching without a price, and let students give what they can, if they can. fair.yoga quietly takes care of the practical part.**
3. **How it works** band. Heading: **Offered freely, received with thanks.** Four step cards (numbered circles, as the landing's five steps):
   1. **Offer the class** — Choose By donation for a single class or a recurring one. Students book as they would for any other class.
   2. **Everyone is welcome** — No price appears anywhere, so nobody has to weigh whether they can afford to come.
   3. **An open hand, once** — After class, everyone who came receives one quiet invitation to give, if and as they wish.
   4. **Receive with thanks** — Note what came in for the class as a whole, for your own records.
4. **What your students see** band. Heading: **Generosity, without obligation.** Two columns, vertically centred:
   - **A phone illustration that mirrors the real give page**
     (`src/app/(student)/bookings/[classId]/give/page.tsx`): back link *Your bookings*, heading **Thank you for coming.**, caption *Slow flow · Tuesday, 3 Nov · with Anna Smith*, then the method chooser as it renders with an open amount (bank transfer, QR, payment link). Built from markup, not a screenshot; it must change when the give page's words change (see §8).
   - Four promises (check icons):
     - **No price on generosity** — No suggested amount, no default. Even the QR code leaves the amount blank.
     - **Asked once, never chased** — One invitation after class. A reminder would turn a gift into a debt.
     - **Giving stays private** — You see what came in for the class, never who gave what.
     - **From hand to hand** — Gifts go straight to your own account or payment link. Nothing passes through fair.yoga.
5. **Which fits your class?** band. Heading: **Two ways to keep the door open.** Two columns:
   - **By donation** (sand-soft): The teaching is a gift, open to anyone · What you receive follows generosity, not a formula · For community classes, or whenever you’d rather not set a price
   - **Sliding scale**: Each student pays according to their circumstances · You can count on a floor: your minimum is always covered · For classes that have to cover a room every week · **How sliding scale works →** (`/sliding-scale`)
   - Below: *You don’t have to choose one: you could offer some classes by donation and others on a sliding scale.*
   - Questions:
     - **Can I suggest an amount?** No, by design. A suggested amount quietly becomes a price, and these classes have none.
     - **Do walk-ins receive the invitation too?** Yes. Everyone who practised is invited in the same way.
     - **Can I switch a class between donation and sliding scale?** Yes, until the first student books. After that the class keeps its pricing.
     - **I take payments through Mollie. Can students give that way?** Not yet: fair.yoga’s Mollie payments are for a set amount, and a gift has none. If Mollie is all you use, students are invited to give to you directly, however suits them. Add your bank details or a payment link alongside it, and they can give online too.
     - **What does fair.yoga take?** Nothing. fair.yoga itself runs on teachers’ donations, in the same spirit.
6. Call to action: **Offer your next class by donation** → **Set up your first class**.
7. Shared footer.

Every behaviour claimed is #912's
(`docs/superpowers/specs/2026-10-25-donation-classes-design.md`); a claim that
stops being true there must be corrected here.

## 7. Shared pieces and routing

- **Routes at the app root**, beside `src/app/page.tsx`:
  `src/app/sliding-scale/page.tsx`, `src/app/donation-based/page.tsx`. Not in a
  route group: `src/app/noindex.test.tsx` requires every group except `(public)`
  to say noindex, and these pages must be indexable.
- **Header and footer** move out of `page.tsx` into shared components (e.g.
  `src/components/landing/site-header.tsx`, `site-footer.tsx`), used by all three
  pages. The footer gains links to the two subpages. On the subpages the nav
  links point at `/#features` and `/#open-source`.
- **The header reads the session.** Signed out, its right-hand link is **Sign
  in** (`/login`); signed in (either profile), it is **Open the app** (`/start`).
  The same on all three pages, header and footer alike.
- **No redirects** on any of the three pages for any visitor (§4.1).
- **`/` stops being the app's door elsewhere too.** Two places use it that way
  and move to `/start`:
  - `public/sw.js`: the fallback URL for a push notification that carries none
    (the `showNotification` default and the click handler's fallback), so a
    bare push opens the app, not the homepage.
  - `public/sw.js`: the offline rule that answers a navigation to `/` or
    `/start` with the saved schedule applies to `/start` only; `/` offline gets
    the generic offline page like any other unsaved page.
  `tests/e2e/offline.spec.ts`, which opens `/` offline and expects `/schedule`,
  opens `/start` instead. `LandingPage`'s docblock ("a bookmarked `/` still opens
  the app") and the Installed app start URL section of
  `docs/technical-architecture.md` are updated. The cost, accepted: a teacher
  who bookmarked `/` rather than installing the app taps **Open the app** once.
- **Reserved slugs:** `sliding-scale` and `donation-based` become static
  top-level routes. `schemas.test.ts` ("reserves every static top-level route
  segment") fails until both are in `RESERVED_SLUGS`, and the deploy refuses
  while a teacher holds one (`scripts/check-reserved-slugs.ts`), so check
  production for existing holders before merging.
- **Sitemap:** `src/app/sitemap.ts` lists `/`, `/sliding-scale`,
  `/donation-based`; `sitemap.test.ts` asserts the exact list.
- **noindex census:** root-level page directories are not scanned by
  `noindex.test.tsx` today (it covers route groups and `(public)`). Extend it so
  a root-level page is classified too, and list the two subpages as indexable.
- **`LandingPricingDemo`** moves to (or is rebuilt as) the `/sliding-scale`
  calculator; nothing on `/` imports it afterwards.

## 8. Tests

Test first, as everywhere (CLAUDE.md). At least:

- **No redirect, session-aware header:** `/` renders for a signed-out visitor,
  a teacher, a student and a two-hat account alike (replacing `page.test.tsx`'s
  "sends a signed-in … home" cases); the header shows **Sign in** → `/login`
  signed out and **Open the app** → `/start` signed in, on all three pages.
- **Service worker:** a push with no URL opens `/start`; offline, `/start` (not
  `/`) falls back to the saved schedule (`offline.spec.ts`).
- **Homepage:** the band's four cards and their links (`/sliding-scale`,
  `/donation-based`, `/sliding-scale#examples`); the removed strip and demo are
  gone; the hero and nav point at `#features`; the proof numbers equal the
  engine's output for the shared example (computed in the test, not typed).
  Update `page.test.tsx`'s `ALLOWED_HREFS`, heading order and copy assertions.
- **Calculator:** each `?example=` key selects its preset and an unknown one
  falls back; reset restores and disables; below-minimum and above-maximum
  states; min/target ordering; prices come from `PricingPreviewResult`. The
  homepage proof and the calculator's `typical` preset show identical prices,
  asserted by computing both through the shared preview function.
- **Donation page:** the phone illustration's heading and caption format match
  the give page's. Share the strings or assert both from one constant, so a give
  page edit fails this test rather than leaving the marketing page wrong.
- **Metadata** for both subpages (title, description, canonical, no
  `openGraph`, indexable); sitemap; reserved slugs; noindex census.
- **No forbidden vocabulary:** a test that the three pages' copy contains no
  "dana".
- **Visual baselines:** `landing` regenerates (it renders differently); add
  baselines for the two new pages to `tests/e2e/visual.spec.ts` and
  `ROUTE_BASELINES`; the a11y sweep (`tests/e2e/a11y.spec.ts`) covers them.

## 9. Decisions and their reasons

| Decision | Reason |
|---|---|
| Keep the homepage's story; replace only the pricing band | The story is the strongest part; the band was the narrowest. |
| Cards (2×2), not rows | Owner's choice between two mocked layouts. |
| Proof stays on the homepage, small | Without it the homepage asserts fairness without showing it. |
| Calculator is part of `/sliding-scale`, not its own page | One page per search; two pages would compete. |
| `?example=` presets, all adjustable, with reset | Shareable links per scenario; owner asked for every example to be playable. |
| No slider in the tier card | Tried in the mockup and dropped by the owner. |
| EUR only, no picker, no inference | Owner's decision. Inference was rejected because browser language is a poor proxy, a client-side guess flashes and crawlers always see EUR, and a wrong guess is worse than a neutral default. |
| No "dana" anywhere | Owner's decision: avoid misinterpretation and borrowing a religious term for marketing. |
| Phone mirrors the real give page; app copy unchanged | Marketing must not show students words the app doesn't. |
| Mollie FAQ says "not yet" and describes fair.yoga's flow | Mollie may offer open amounts; fair.yoga's integration does not today. |
| `/` no longer redirects signed-in visitors; the header offers **Open the app** → `/start` | Owner's decision. Otherwise the subpages' links home would bounce a signed-in teacher into the app, and the header would offer "Sign in" to someone signed in. `/start` already routes each profile home, so `/` can have one job. |
| The website embed and calendar feed go in the Classes card | They are the "set once" promise carried to the teacher's own site; a fifth card would break the 2×2 grid. |

## 10. Left to the builder

- Component boundaries, file names beyond §7, and whether the calculator wraps
  or extends `PricingPreviewResult`.
- Exact spacing within the tokens; responsive breakpoints for the 2×2 grid and
  the calculator's two columns.
- The phone illustration's construction, within §6.2 and §8.
- Whether the three moved points on `/sliding-scale` reuse the homepage's
  `PRICING_POINTS` data or become their own.
- Footer link labels for the two subpages.

Mockups the owner reviewed (local only, `.superpowers/brainstorm/…/content/`,
not committed): `feature-section.html` (option A), `sliding-scale-page-v3.html`,
`donation-page-v6.html`. This document, not the mockups, is the source of truth:
where they differ (the mockup's hand-written maths, the dashes for empty tiers),
follow this document.
