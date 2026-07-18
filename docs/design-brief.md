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
| `brown-light` | `#9C8F84` | Placeholders, captions, muted |
| `ink` | `#2D2D2D` | High-contrast text, row primaries |
| `gold` / `gold-tint` / `gold-deep` | `#C4A96A` / `#F3ECDC` / `#7D6A3D` | Attention (unread dot, full/waitlist badges) — decorative, never body text on cream |
| `border` | `#D4C9B8` | Dividers, card borders, progress track |
| `danger` / `danger-tint` | `#B85C5C` / `#F5E9E9` | Errors + destructive — **outlines/text only, never filled** |

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

Sentence case everywhere. Georgia never below 18px; sans never in heading slots. Money: always `€` + two decimals, ranges with en-dash, tabular figures.

### Spacing, radii, sizes

- 4px grid (`4 8 12 16 20 24 32 40 48`). Page margins 16 mobile / 24 desktop (`px-4 sm:px-6`). Card padding 20 (`p-5`), cards 12 apart (`gap-3`), sections 32 apart.
- Radii utilities: `rounded-pill` (buttons), `rounded-card` (16), `rounded-field` (12 — inputs *and* badges), `rounded-sheet` (20, reserved).
- Controls 48px (`min-h-12`), list rows ≥56px (`min-h-14`), tab bar 64px, progress bar 8px.
- Focus: `shadow-focus` (teal inset line + teal-tint halo) on every interactive element. Disabled = 50% opacity.

## 3. Navigation

**Bottom tab bar** (`src/components/layout/tab-bar.tsx`): 64px, exactly 4 tabs — Schedule (`/`), Students, Inbox, Settings. Active = teal icon + label in a teal-tint pill; inactive brown; gold 8px dot on Inbox when unread. iOS safe-area padded.

- The bar renders **only on the four tab roots**. Detail views are separate pages with `PageHeader` back links (arrow-left icon + `type-label` teal).
- The Schedule tab **is** the home base ("dashboard IS the schedule"); `/schedule` redirects to `/`.
- `/settings` is a real index page (Recurring classes / Studio classes / Rooms / Profile rows).
- Desktop: same centered 640px column with the bottom bar. A slim left rail ≥768px is a deferred enhancement.

## 4. Iconography

Lucide-style line icons, stroke 1.75, `currentColor`, never filled — inlined in `src/components/ui/icon.tsx` (no npm dependency). Names: `calendar, users, inbox, settings, chevron-right, arrow-left, plus, check, x, share`. Used narrowly: tab bar, chevrons, back arrows, checkmarks. **Words come first everywhere else.** No decorative icons, no emoji in UI.

## 5. Components (`src/components/ui/`)

- **Button** — pill, 48px, sans semibold 16. `primary` teal fill/cream text (hover/pressed teal steps) · `secondary` teal 1.5px outline · `destructive` danger outline, never filled · `ghost` teal text. One primary per screen; full-width in mobile forms. Small inline actions (mark paid, publish) use the compact pill recipe: `h-9 px-4 rounded-pill text-[13px] font-medium`.
- **Input / Select / Textarea** — 48px, sand-soft field, `rounded-field`, `type-label` above (8px gap). Error = danger border + danger-tint bg + 13px message.
- **Card / CardLink** — sand-soft, 1px border, `rounded-card`, `p-5`; tappable cards get sand hover + chevron.
- **StatusBadge** — `rounded-field`, 13px medium. **Fill encodes time:** outline = upcoming (Draft brown-light, Open teal), tint = now (Full/Waitlist gold-tint, In progress teal-tint, Below minimum danger-tint), solid = done (Completed teal, Cancelled brown). `deriveBadgeVariant(status, reg, min, max)` maps lifecycle → variant. **Payment is never a badge:** glyph + word in text color — `✓ Paid` teal · `○ Unpaid` brown · `! Overdue` danger.
- **RegistrationProgress** — *the signature element* on class cards: 8px border-color track, fill danger until min then teal, 2px ink tick at the min mark, tabular fraction ("8 / 6–14") above right.
- **EmptyState** — one subtitle + one body line + one action. No illustrations.
- **Skeleton** — static sand blocks matching layout (used by `loading.tsx` files). No shimmer, no spinners.
- **TabBar**, **PageHeader** — see Navigation.
- **Sheet** — *not yet built* (no consumer). Spec reserved: bottom sheet w/ drag handle, 20px top radius, ink-40% scrim, the system's only shadow; desktop modal max 480px; confirmations two buttons, never three. Current confirms are inline destructive/secondary button pairs.

### List rows

Rows over card grids for directories and settings: `flex items-center gap-3 min-h-14 py-2 border-b border-border last:border-b-0`, primary text `text-base text-ink`, meta `type-caption`, trailing chevron `text-brown-light`. No alternating backgrounds.

## 6. Screen patterns

- **Schedule (home).** Chronological card list of the current week plus the next four weeks (the recurring-generation horizon) — not a calendar grid. Each class card: day/time label + StatusBadge, `type-subtitle` class name + chevron, room caption, RegistrationProgress. Studio classes inline but lighter (dashed border, no bar). Past dimmed to 70% opacity (quiet but still readable), cancelled struck through.
- **Class detail** — one adaptive page by lifecycle: badge + meta + progress always; then draft (pricing preview + publish), open (students + estimate), check-in (attendance checklist: large names, 44px teal check tiles), completed (earnings in a teal-tint card, Display-size tabular number, transparent breakdown + payment checklist), cancelled (quiet notice).
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
