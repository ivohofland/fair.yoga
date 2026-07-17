# Design Brief for Claude Design — Ethical Yoga App

Use this document as the **design system source** when generating screens, prototypes, and flows in Claude Design. It defines the exact palette, type, spacing, and component behavior. The earlier direction (`stitch-design-brief.md`) stands — this version makes it precise so every generated screen comes out consistent. For the eventual code handoff, `design-brief-claude-code.md` mirrors these tokens 1:1.

**Core rule: only use values defined here.** Every color, size, and spacing step in a generated design must trace back to this document. When something is missing, extend this document first.

---

## 1. What this app is

A free toolkit for independent yoga teachers — scheduling, income-based pricing, simple CRM, payments, communication. Not a marketplace. Mobile-first: the primary experience is a phone held in one hand between classes.

**Personality in one line:** a thoughtful yoga teacher who happens to be good with numbers.

**Feel:** calm utility, warm minimalism, trust through transparency. Like a clean, well-organized studio — not a tech product. Reference mood: Headspace's warmth, Notion's utility, Linear's clarity, Wise's transparency.

---

## 2. Design tokens

### Colors

| Token | Hex | Use |
|---|---|---|
| Teal (primary) | `#1A5653` | Headings, primary buttons, active states, prices, success |
| Teal hover | `#154744` | Primary button hover |
| Teal pressed | `#103A37` | Primary button pressed |
| Teal tint | `#E8F0EF` | Selected states, active tab pill, highlighted rows |
| Cream (background) | `#F7F4EF` | Page background — never pure white `#FFFFFF` anywhere |
| Sand (surface) | `#E8DCC8` | Cards, panels, input fields |
| Sand hover | `#E0D2B9` | Interactive card/row hover |
| Brown (text) | `#6B5B4E` | Body text, secondary labels, inactive icons |
| Brown light | `#9C8F84` | Placeholders, disabled text, captions |
| Ink | `#2D2D2D` | High-contrast headings, text on gold |
| Gold (accent) | `#C4A96A` | Badges, progress, accents — decorative only, never as text on cream |
| Border | `#D4C9B8` | Dividers, card borders, input outlines |
| Danger | `#B85C5C` | Errors and destructive actions — outlines/text only, never filled |
| Danger tint | `#F5E9E9` | Error field backgrounds |

Rules: success = teal (no green exists), attention = gold, error = danger. No gradients, no other colors. Text on cream/sand is always brown, teal, or ink.

### Typography

- **Headings:** Georgia (serif), bold. Warm and rooted, not trendy.
- **Body:** system sans-serif (SF/Segoe/Arial), regular.
- **Numbers & prices:** sans semibold, tabular figures, teal.

Six sizes only:

| Style | Size / line height | Face | Use |
|---|---|---|---|
| Display | 28 / 1.25 | Georgia bold, teal | Screen title, teacher earnings |
| Title | 22 / 1.3 | Georgia bold, teal | Card titles, sections |
| Subtitle | 18 / 1.4 | Georgia bold, ink | Sub-sections, modal titles |
| Body | 16 / 1.55 | Sans regular, brown | Default text |
| Label | 14 / 1.4 | Sans medium, brown | Input labels, metadata |
| Caption | 13 / 1.4 | Sans regular, brown light | Timestamps, helper text |

Sentence case everywhere ("Create class"). No ALL CAPS except tiny table headers. Georgia never appears at body sizes; sans never in heading slots.

### Spacing, radii, elevation

- **4px grid:** all spacing from `4, 8, 12, 16, 20, 24, 32, 40, 48`.
- Page margins 16 (mobile) / 24 (desktop). Card padding 20. Cards 12 apart. Sections 32 apart.
- Radii: buttons pill, cards 16, inputs/badges 12, bottom sheets 20 top.
- **No drop shadows** — depth = sand surface + 1px border on cream. Exception: sheets/modals get one soft shadow.
- When in doubt: more whitespace. Screens must breathe.

---

## 3. Components

**Buttons** — pill, 48px tall, sans semibold 16, padding 24 horizontal. Primary: teal bg / cream text. Secondary: teal 1.5px outline. Destructive: danger outline, never filled. Ghost: teal text. One primary per screen. Full-width in mobile forms.

**Cards** — sand bg, 1px border, radius 16, padding 20. Tappable cards show a chevron.

**Inputs** — 48px tall, sand bg, border outline, radius 12. Label above (8px gap). Focus: teal border + soft teal ring, visible on everything. Error: danger border + danger-tint bg + 13px message below.

**Navigation** — mobile: bottom tab bar (64px), **4 tabs: Schedule, Students, Inbox, Settings**. Active tab = teal icon + label in a teal-tint pill; inactive = brown. Desktop (≥768px): same 4 items as a slim left rail; content column max 640px centered. Icons: Lucide-style line icons, stroke 1.75, never filled.

**Status badges** — radius 12, 13px medium: registering (teal tint/teal), below minimum (danger tint/danger), full-waitlist (gold/ink), completed-paid (teal/cream), cancelled (sand/brown light).

**Registration progress bar** — the signature element on class cards: 8px tall, border-color track; fill is danger until min students, teal from min to max; small ink tick at the min mark; fraction label above right ("8 / 6–14", tabular).

**Lists** — rows ≥56px, 1px dividers, no alternating backgrounds. Pricing tables: teal caption headers, tabular numbers, prices align on the decimal, selected row teal-tint.

**Sheets & modals** — mobile bottom sheets with drag handle; desktop centered modal max 480px. Scrim ink 40%. Confirmations: two buttons, never three.

**Every list screen includes empty, loading, and error states.** Empty = one subtitle + one body line + one action (no illustrations, no emoji). Loading = sand skeletons matching layout. Error = brown text + ghost "Try again".

**Never:** emoji in UI, filled icons, illustrations on functional screens, stock photos, gradients, gamification (streaks, badges, confetti), bright alarming red, pure white.

---

## 4. Screen guidance

Structure: 4 tabs, ~19 screens total (`information-architecture.md` has the full map). Key screens:

**Schedule / week view (home).** A chronological card list of this week's classes — not a calendar grid. Each card: day/time, class type + room, registration progress bar, status badge. Studio classes appear inline but visually lighter (no progress bar). Calm morning overview; no charts.

**Class detail (the most important screen).** One adaptive screen that transforms by lifecycle stage — future (settings + pricing preview + edit/share/cancel), registering (student list + tier distribution + estimated prices), today (attendance checklist + add walk-in), completed (pricing breakdown + payment checklist), archived (read-only summary). Header always: class type, date, time, room, count.

**Create class (stepped flow).** 3 steps + confirmation, each fits one mobile screen: basics → pricing → policies. The pricing step carries a live preview table (class sizes × tier prices). Make that table clear and confident — numbers in teal, generous spacing.

**Class day view.** One-handed use at the venue: large student names, big attendance checkboxes, prominent but unobtrusive "Add walk-in" button.

**Post-class summary.** The payoff screen: teacher earnings large in Display style, transparent breakdown below (room cost, teacher rate, per-tier prices). Show the work, don't overwhelm.

**Payment checklist.** Simple rows: student, amount, paid/unpaid toggle. "Send reminder" is secondary. Unpaid is brown — never alarming.

**Students.** A warm address book, not a CRM dashboard: name, classes attended, last visit.

**Inbox.** Chronological, unread rows on sand, read on cream. No hierarchy tricks.

**Tier selection (student side).** The most philosophically important screen: warm 1–2 sentence explanation, a yogic quote, five tiers in accessible language, "Learn more" link. Inviting, never guilt-inducing.

---

## 5. Emotional check

Every generated screen should make a teacher feel calm, capable, supported, and respected — and never corporate, gamified, whimsical, or clinical. If a screen looks busy, remove elements and widen spacing until it doesn't.
