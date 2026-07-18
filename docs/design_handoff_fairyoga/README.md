# fair.yoga Design System — v2

The second iteration of the fair.yoga design system, rebuilt against the updated **Design Brief for Claude Design** (`uploads/design-brief-claude-design.md`, July 2026). That brief is the single source of truth: **only values defined there appear here.** Where it conflicts with the v1 system (extracted from the live codebase), the brief wins.

fair.yoga is a **free, open-source toolkit for independent yoga teachers** — scheduling, income-based pricing, simple CRM, payments, communication. Not a marketplace. Mobile-first: the primary experience is a phone held in one hand between classes.

> **Personality in one line:** a thoughtful yoga teacher who happens to be good with numbers.
> **Feel:** calm utility, warm minimalism, trust through transparency. Reference mood: Headspace's warmth, Notion's utility, Linear's clarity, Wise's transparency.

## Sources

| Source | Location | Notes |
|---|---|---|
| Updated design brief | `uploads/design-brief-claude-design.md` | **Source of truth for this version** |
| v1 design system | Claude Design project `3fd78e52-1286-469a-add1-14c7eab035d6` | Codebase-extracted; superseded where it conflicts |
| Brand identity document | `uploads/brand-identity.pdf` (v1 project) | Voice and values carry forward |

## What changed from v1

| Concern | v1 (codebase) | v2 (this system, per brief) |
|---|---|---|
| Page background | Warm Sand `#E8DCC8` | **Cream `#F7F4EF`**; Sand becomes the surface color |
| Corners | Flat (`rounded-none`) | **Pill buttons, cards 16, inputs/badges 12, sheets 20 top** |
| Primary button | Cream fill, teal outline | **Teal fill, cream text**, with hover/pressed teal steps |
| Body font | Atkinson Hyperlegible (webfont) | **System sans** (SF/Segoe/Arial) — no webfont needed |
| Navigation | Accordion home, text-only | **Bottom tab bar (64px), 4 tabs, Lucide-style line icons** |
| Icons | None (unicode glyphs) | **Functional line icons, stroke 1.75, never filled** |
| Depth | Borders only, no shadows | Sand-on-cream + 1px border; **one soft shadow on sheets/modals only** |
| Loading | Nothing / structure-first | **Sand skeletons matching layout** |
| Signature element | — | **Registration progress bar** on class cards |

## Content fundamentals

Voice is **warm, clear, grounded**. We do not sound like a tech company, a marketplace, or a wellness subscription.

- **Sentence case everywhere** — "Create class", "Mark paid". Never ALL CAPS (exception: tiny table headers, 12–13px).
- **No emoji** in product UI. No exclamation marks. No marketing adjectives.
- **Second person** for the user ("your earnings"); third person for the system ("This class needs 6 students").
- **Money:** always currency symbol, always two decimals (`€12.50`). Ranges use en-dash (`€15.00 – €25.00`). Tabular figures, teal, semibold.
- **Transparency copy:** "Highest pays 2.1× the lowest." "Based on 7 registered students." Show the math.
- **Micro-copy patterns:** `+ Add class` · `← Schedule` · `View all →` · ` · ` middle-dot dividers · `Tier 1`–`Tier 5`.
- **Status vocabulary:** Draft / Open for registration / Full / In progress / Completed / Cancelled / Paid / Unpaid.
- **Empty states:** one subtitle + one body line + one action. No illustrations, no emoji.
- **Never:** gamification language, wellness jargon, urgency, platform-ese, "Welcome back, {name}!".

✅ "Your price is based on what you can comfortably contribute. Here's how that works."
❌ "Unlock your premium wellness journey today."

## Visual foundations

- **Colors:** Teal `#1A5653` primary (headings, primary buttons, active states, prices, **success** — no green exists). Cream `#F7F4EF` page background — never pure white. Sand `#E8DCC8` for cards, panels, inputs. Brown `#6B5B4E` body text; Brown light `#71645A` placeholders/captions. Ink `#2D2D2D` high-contrast. Gold `#C4A96A` = attention, decorative only — never as text on cream. Danger `#A24E4E` — outlines/text only, never filled; never alarming bright red. Border `#D4C9B8`. **No gradients, no other colors.**
- **Type — six styles only:** Display 28, Title 22, Subtitle 18 (Georgia bold; Display/Title teal, Subtitle ink) · Body 16, Label 14, Caption 13 (system sans; brown / brown / brown-light). Georgia never at body sizes; sans never in heading slots. Numbers: sans semibold, tabular, teal.
- **Spacing:** 4px grid (`4 8 12 16 20 24 32 40 48`). Page margins 16 mobile / 24 desktop. Card padding 20, cards 12 apart, sections 32 apart. When in doubt: more whitespace.
- **Radii:** buttons pill · cards 16 · inputs/badges 12 · sheets 20 top.
- **Depth:** sand surface + 1px border on cream. **No drop shadows** except one soft shadow on sheets/modals. No glassmorphism, no blur.
- **Backgrounds:** flat cream. No images, illustrations, stock photos, patterns, or textures on functional screens.
- **Motion:** essentially none. No confetti, no bounces, no hover lift. Hover = defined color steps (teal-hover on primary buttons, sand-hover on rows/cards). Press = teal-pressed. Focus = teal border + soft teal-tint ring, visible on everything. Disabled = 50% opacity.
- **Loading:** sand skeleton blocks matching the layout. Error: brown text + ghost "Try again".
- **Layout:** mobile-first single column; desktop ≥768px gets a slim left rail and a 640px max content column, centered. Lists over grids; rows ≥56px with 1px dividers, no alternating backgrounds.
- **No dark mode.** The warm palette is the palette.

## Iconography

v2 introduces icons, narrowly: **Lucide-style line icons, stroke 1.75, `currentColor`, never filled.** Used in the bottom tab bar (icon + label), tappable-card chevrons, and functional spots where a word would be longer. Words still come first everywhere else. No decorative icons, no emoji, no colored icons.

Icons ship as inline SVG paths in `components/core/Icon.jsx` (Lucide path data, ISC-licensed — no CDN dependency). Available names: `calendar`, `users`, `inbox`, `settings`, `chevron-right`, `arrow-left`, `plus`, `check`, `x`, `share`.

**Logo:** no logo file exists; `assets/logo.svg` is the v1 wordmark recreation (Georgia wordmark only).

## Components

All in `components/`, composed from the tokens. One primary button per screen. Every list screen designs empty, loading, and error states.

- `core/` — **Button** (primary / secondary / destructive / ghost; pill, 48px), **Input** (48px, sand bg, radius 12, label above, error state), **Card** (sand, 1px border, radius 16, padding 20, optional chevron), **Icon**
- `status/` — **StatusBadge** (registering / below-minimum / full-waitlist / completed-paid / cancelled), **RegistrationProgress** (the signature 8px bar: danger→teal fill, ink tick at minimum, "8 / 6–14" fraction), **EmptyState**, **Skeleton**
- `navigation/` — **TabBar** (64px, 4 tabs: Schedule, Students, Inbox, Settings), **ListRow** (≥56px, 1px dividers)
- `feedback/` — **Sheet** (mobile bottom sheet with drag handle / desktop modal max 480px, ink-40% scrim)

**Intentional additions** beyond the brief's component list: `Icon` (wrapper for the Lucide glyph set the brief's tab bar requires), `EmptyState` and `Skeleton` (the brief mandates empty/loading/error states on every list screen).

## File index

```
/
├─ readme.md · SKILL.md
├─ styles.css → tokens/{colors,typography,spacing}.css
├─ assets/logo.svg
├─ guidelines/            ← foundation specimen cards
├─ components/{core,status,navigation,feedback}/
└─ ui_kits/teacher-app/   ← index.html (interactive) + one JSX per screen + data.js
```

## How to use

Link `styles.css`, style against the `--*` tokens and `.type-*` classes, compose the components. Tone-check every string against Content fundamentals; if it would fit a wellness app's onboarding, rewrite it. Reach for a word before an icon.
