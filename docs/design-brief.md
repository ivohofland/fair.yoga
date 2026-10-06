# fair.yoga — Working Design Brief (v2)

The working design reference for the codebase. Source of truth: the **v2 design system** vendored in `docs/design_handoff_fairyoga/` (authored in Claude Design; see its `readme.md` and `design-brief-claude-design.md`). This document maps that system onto the app. Where they conflict, the vendored system wins.

**Core rule: only use values defined here.** Every color, size, and spacing step must trace back to the token set. When something is missing, extend the design system first.

---

## 1. Aesthetic: calm utility, warm minimalism

A thoughtful yoga teacher who happens to be good with numbers. Like a clean, well-organized studio — not a tech product. Reference mood: Headspace's warmth, Notion's utility, Linear's clarity, Wise's transparency.

- Mobile-first — a phone held in one hand between classes. Content column max 640px, centered.
- Depth = sand surface on cream + 1px border. **No shadows** except one soft shadow reserved for sheets/modals.
- **Essentially no motion.** No transitions, no hover lift, no confetti. Hover/press = defined color steps only.
- Warm palette only; **no pure white, no gradients, no dark mode.**
- No gamification, no attention-economy patterns. This is a tool.

## 2. Design tokens

Defined in `src/app/globals.css` (`@theme`, Tailwind v4 CSS-first — no tailwind.config).

### Colors

| Token / utility | Hex | Use |
|---|---|---|
| `teal` | `#1A5653` | Headings, primary buttons, active states, prices, **success** (no green exists) |
| `teal-hover` / `teal-pressed` | `#154744` / `#103A37` | Primary button interaction steps |
| `teal-tint` | `#E8F0EF` | Selected states, active tab pill, highlighted rows, earnings cards |
| `cream` | `#F7F4EF` | **Page background** — never pure white |
| `sand-soft` | `#F0E9DC` | **Card/field surface**, skeletons |
| `sand` | `#E8DCC8` | Card/row hover |
| `sand-hover` | `#E0D2B9` | Reserved deeper hover step |
| `brown` | `#6B5B4E` | Body text, inactive icons |
| `brown-light` | `#71645A` | Placeholders, captions, muted |
| `ink` | `#2D2D2D` | High-contrast text, row primaries |
| `gold` / `gold-tint` / `gold-deep` | `#C4A96A` / `#F3ECDC` / `#7A6739` | Attention (unread dot, full/waitlist badges) — decorative, never body text on cream |
| `border` | `#D4C9B8` | Dividers, card borders, progress track |
| `danger` / `danger-tint` | `#A24E4E` / `#F5E9E9` | Errors + destructive — **outlines/text only, never filled** |

### Typography — six styles only

Utilities `type-display` … `type-number` in globals.css. Headings Georgia bold; body the system sans stack (no webfont).

| Utility | Face | Size/leading | Color | Use |
|---|---|---|---|---|
| `type-display` | Georgia 700 | 28 / 1.25 | teal | Tab-page titles, earnings |
| `type-title` | Georgia 700 | 22 / 1.3 | teal | Detail-page titles |
| `type-subtitle` | Georgia 700 | 18 / 1.4 | ink | Section heads, card titles |
| `type-body` | sans 400 | 16 / 1.55 | brown | Default text |
| `type-label` | sans 500 | 14 / 1.4 | brown | Input labels, metadata, back links |
| `type-caption` | sans 400 | 13 / 1.4 | brown-light | Timestamps, helper text |
| `type-number` | sans 600 tabular | (sizeless) | teal | Prices & counts — compose with any `text-[..]` |

Sentence case everywhere. Georgia never below 18px; sans never in heading slots. Money: always the currency's symbol + two decimals (`formatMoney`, `src/lib/format.ts`), ranges with en-dash, tabular figures.

### Dates

Day-first, always: `12 Jun`, never `Jun 12`. Three formats, all in
`src/lib/format.ts`:

- `formatDayHeader` — `Friday, 12 Jun`. Lists and headers where the weekday
  earns its space: the schedule, bookings, the public pages.
- `formatDateWithYear` — `12 Jun 2026`. Detail pages, and any record that
  outlives the current month.
- `formatDateShort` — `12 Jun`. Inline in a row, where neighbouring copy
  already supplies the context.

`formatDayMonth` prints `formatDateShort`'s shape for a teacher-facing
birthday, which arrives as a day and a month with no year rather than a
`Date` — the same format for a value that has no year to drop, not a fourth.

Two grouping labels use the full month name instead, for a heading over a
*set* of dates rather than one: `formatMonthLabel` (`June 2026`, the
reporting page's month grouping) and `class-list.tsx`'s local `weekLabel`
(`Week of 4 August`, the schedule's week fallback). A new grouping label
needs a reason, same as a new per-date one would.

Never `toLocaleDateString` without an explicit `timeZone`. Class dates are
`@db.Date` columns stored at midnight UTC; a host-local read renders the
previous day west of UTC. See `src/lib/timezone.ts` for the rule in full.

### Spacing, radii, sizes

- 4px grid (`4 8 12 16 20 24 32 40 48`). Page margins 16 mobile / 24 desktop (`px-4 sm:px-6`). Card padding 20 (`p-5`), cards 12 apart (`gap-3`), sections 32 apart.
- Radii utilities: `rounded-pill` (buttons), `rounded-card` (16), `rounded-field` (12 — inputs *and* badges), `rounded-sheet` (20, reserved).
- Controls 48px (`min-h-12`), list rows ≥56px (`min-h-14`), tab bar 64px, progress bar 8px.
- Focus: `shadow-focus` (teal inset line + teal-tint halo) on every interactive element. Disabled = 50% opacity.

## 3. Navigation

**Bottom tab bar** (`src/components/layout/tab-bar.tsx`): 64px, exactly 4 tabs — Schedule (`/schedule`), Students, Inbox, Settings. Active = teal icon + label in a teal-tint pill; inactive brown; gold 8px dot on Inbox when unread. iOS safe-area padded.

- The bar renders **only on the four tab roots**. Detail views are separate pages with `PageHeader` back links (arrow-left icon + `type-label` teal).
- The Schedule tab **is** the home base ("dashboard IS the schedule") and lives at `/schedule`; `/` is the public landing page.
- `/settings` is a real index page (Recurring classes / Studio classes / Rooms / Profile rows).
- Desktop: same centered 640px column with the bottom bar. A slim left rail ≥768px is a deferred enhancement.

## 4. Iconography

Lucide-style line icons, stroke 1.75, `currentColor`, never filled — inlined in `src/components/ui/icon.tsx` (no npm dependency). Names: `calendar, users, inbox, settings, chevron-right, arrow-left, plus, check, x, share`. Used narrowly: tab bar, chevrons, back arrows, checkmarks. **Words come first everywhere else.** No decorative icons, no emoji in UI.

## 5. Components (`src/components/ui/`)

- **Button** — pill, 48px, sans semibold 16. `primary` teal fill/cream text (hover/pressed teal steps) · `secondary` teal 1.5px outline · `destructive` danger outline, never filled · `ghost` teal text. One primary per screen; full-width in mobile forms. Small inline actions (mark paid, publish) use the compact pill recipe: `h-9 px-4 rounded-pill text-[13px] font-medium`.
- **Input / Select / Textarea** — 48px, sand-soft field, `rounded-field`, `type-label` above (8px gap). Error = danger border + danger-tint bg + 13px message.
- **Card / CardLink** — sand-soft, 1px border, `rounded-card`, `p-5`; tappable cards get sand hover + chevron.
- **StatusBadge** — `rounded-field`, 13px medium. **Fill encodes time:** outline = upcoming (Draft brown-light, Open teal), tint = now (Full/Waitlist gold-tint, In progress teal-tint, Below minimum danger-tint), solid = done (Completed teal, Cancelled brown). `deriveBadgeVariant(status, reg, min, max)` maps lifecycle → variant. **Payment is never a badge:** glyph + word in text color — `✓ Paid` teal · `○ Unpaid` brown · `! Overdue` danger.
- **RegistrationProgress** — *the signature element* on class cards: 8px border-color track, fill danger until min then teal, 2px ink tick at the min mark. Label above right: live count 16px semibold (teal once min is met, brown before) + quiet 12px brown "/ 6–14" range, 5px apart — count is the datum, the range is configuration.
- **EmptyState** — one subtitle + one body line + one action. No illustrations.
- **Skeleton** — a content placeholder (a progress track, an icon slot) inside a primitive's own frame, never a stand-in for a whole card or row on its own — see Loading states below. Static sand, no shimmer, no spinners.
- **TabBar**, **PageHeader** — see Navigation.
- **Sheet** — *not yet built* (no consumer). Spec reserved: bottom sheet w/ drag handle, 20px top radius, ink-40% scrim, the system's only shadow; desktop modal max 480px; confirmations two buttons, never three. Current confirms are inline destructive/secondary button pairs.
- **Avatar** — a circle, two sizes: 40px (Schedule header, linking to `/settings/profile`) and 72px (public `/[slug]` page, profile settings). With a photo: `object-cover`, empty `alt` — decorative: on the public page it sits beside the teacher's name, and on `/schedule` and `/settings/profile` it sits inside or beside a control that already names itself (the Schedule header's "Profile" link; the profile settings' Upload/Replace buttons), so a non-empty alt would announce it a second time either way. Without: first-letter initials of first and last name, Georgia bold, teal on teal-tint, `aria-hidden`. No ring, border, shadow or hover step — a person, not a card. Not used in directory rows (text-first there). The stored photo is 400×400 (`PHOTO_EDGE_PX`, `src/services/teacher-photo.ts`) — that covers the largest avatar (72px) at 3× device density (216px) with headroom.

### List rows

Rows over card grids for directories and settings: `ListRow` (`src/components/ui/list-row.tsx`; `listRowClass` for a row `ListRow` cannot render itself), `flex items-center gap-3`, `density="regular"` and `divider="between"` for a single-line directory row; primary text `text-base text-ink`, meta `type-caption`, trailing chevron `text-brown-light`. No alternating backgrounds. `density="relaxed"` is for message-style rows instead (a title plus a body line); directory rows — one line or two — stay `regular`.

### Loading states

Static sand, no shimmer, no spinners — the motion-free option under "Essentially no motion" above. A skeleton is its primitive's frame with placeholder content: `XSkeleton` lives beside `X` and renders through the same frame `X` does, so the frame's classes are written once — `ListRowSkeleton` beside `ListRow`, `PageHeaderSkeleton` beside `PageHeader`, and so on for each primitive a loading state composes. When `X` is a `'use client'` component, its skeleton and the frame constants the two share live in a sibling server module (`x-skeleton.tsx`) that `X` imports them from: a `loading.tsx` fallback that renders a client component cannot paint until that component's JS has loaded, so it suspends and the boundary above it paints its own fallback instead — on `/students` that was the neutral header, a different header from the page's. No `loading.tsx` imports from a `'use client'` module, which `src/lib/loading-coverage.test.ts` enforces, and `tests/e2e/skeleton-geometry.spec.ts` checks that a tab-bar click to each tab root never paints the neutral fallback. `SkeletonText` takes a line's height from its type style (`type-display` … `type-caption`), so a placeholder line is the real line's height by construction rather than a copied fixed height. The raw `Skeleton` is a content placeholder only — a progress track, an icon slot — never a stand-in for a whole card or row; no `loading.tsx` may import from `@/components/ui/skeleton` at all (`Skeleton` or `SkeletonText`), which `src/lib/loading-coverage.test.ts` enforces. Bars that sit on a card surface use `surface="card"`, since the page surface's fill disappears on a card of the same colour.

Every route's loading state is a recorded choice, not an oversight: its own `loading.tsx`, the neutral header fallback (`RouteLoading`, `src/components/layout/route-loading.tsx`), or none at all — routes without a skeleton of their own are listed in `FALLBACK_ROUTES` in `src/lib/loading-coverage.test.ts`. Where the neutral `loading.tsx` files sit follows from how Next draws them (without PPR). A `loading.tsx` wraps each child of its own segment, so a navigation between two pages that share a segment (`/settings` to `/settings/profile`, `/students` to a student) shows the closest `loading.tsx` to the new page *at or below* that shared segment — and nothing at all if there is none there, leaving the old page on screen until the new one swaps in. A prefetch, though, stops at the *first* `loading.tsx` below the shared segment, and that is what paints first on a slow response. So a neutral `loading.tsx` may not sit above a page with its own skeleton: at `students/` it would be what a Schedule → Students tab click prefetches, and the neutral header would paint before the Students skeleton. A segment that holds a tab root's `(overview)` group (or `/class/new`, or a class's overview) therefore carries no `loading.tsx` of its own; each of its other children carries one instead — a leaf page its own neutral re-export, a segment with no own-skeleton page below it one neutral re-export for everything below. In route groups that use loading states at all (`(public)` and `(student)` use none), `src/lib/loading-coverage.test.ts` checks every page against both rules: a navigation from any page that shares a segment with it reaches a `loading.tsx` at or below that segment, and no neutral `loading.tsx` below the route group's own sits above a page with its own skeleton. A page whose real header differs from the neutral one (a back link above a 22px title) gets its own header-only `loading.tsx` instead — `/class/new`, whose header is a back link above a display title. A page with its own skeleton lives with it inside an `(overview)` route group (when it has child routes), so its boundary covers that page alone and never a nested child — a tab root works this way, and so does `class/[id]`, which is not one. The directory-row recipe's single owner and its split-recipe exceptions are tracked in `src/lib/list-row-recipe.test.ts`. That a skeleton and its page agree on where the header and the first item below it sit, on each of the four tab roots, is checked by `tests/e2e/skeleton-geometry.spec.ts`.

## 6. Screen patterns

- **Schedule (home).** Chronological card list of the current week plus the next four weeks (the recurring-generation horizon) — not a calendar grid. The list breaks at week boundaries with a `type-subtitle` head ("This week" · "Next week" · "Week of 4 August"), the same section idiom as "By month". Each class card: day/time label + StatusBadge, `type-subtitle` class name + chevron, room caption, RegistrationProgress. Completed cards roll payment up inline in the caption ("✓ all paid" teal · "○ 3 unpaid" brown · "! 2 overdue" danger — text, never a badge; status explorations turn 2). Studio classes inline but lighter (dashed border, no bar). Past dimmed to 70% opacity (quiet but still readable), cancelled struck through.
- **Class detail** — one adaptive page by lifecycle: badge + meta + progress always; then draft (pricing preview + publish), open (students + estimate), check-in (attendance checklist: large names, 44px teal check tiles; Finish class from 15 min before the end but not before the start, with an inline confirm), completed (attendance read-only behind "Edit attendance", earnings in a teal-tint card, Display-size tabular number, transparent breakdown + payment checklist), cancelled (quiet notice).
- **Create class** — 4 steps; caption step indicator; live pricing preview table (teal caption headers, prices align on the decimal, pill mode toggles).
- **Payments** — simple rows: name, text state, `type-number` amount, compact "Mark paid" pill. Unpaid is brown — never alarming.
- **Students** — a warm address book: name, classes attended, last visit; chevron rows.
- **Inbox** — chronological; unread rows on a sand band with a gold dot, read on cream. No hierarchy tricks.
- **Every list screen has empty, loading, and error states.** Loading = skeletons; error = brown text + ghost "Try again".

## 7. Content fundamentals

Warm, clear, grounded. Not a tech company, marketplace, or wellness subscription.

- Sentence case; no ALL CAPS except tiny table headers (12–13px).
- No emoji, no exclamation marks, no marketing adjectives, no "Welcome back, {name}!".
- Second person for the user, third person for the system. Show the math ("Highest pays 2.1× the lowest.").
- Status vocabulary: Draft / Open for registration / Full / In progress / Completed / Cancelled / Paid / Unpaid.

## 8. Never

Emoji in UI · filled icons · illustrations or stock photos on functional screens · gradients · pure white · bright alarming red · shadows outside sheets · gamification (streaks, badges-as-rewards, confetti) · motion for its own sake.
