# Design Brief — Ethical Yoga App

Use this as the creative direction for all screens. Copy-paste relevant sections into Stitch as context when generating each screen.

---

## What this app is

A free toolkit for independent yoga teachers. Teachers bring their own students — this is not a marketplace or a directory. It handles scheduling, income-based pricing, simple CRM, payments, and communication. The platform's only ask is that teachers use the fair pricing system.

The app is used by two types of people: yoga teachers managing their classes, and students booking and paying. This brief focuses on the teacher experience (36 screens).

---

## Brand personality in one line

A thoughtful yoga teacher who happens to be good with numbers.

---

## Design philosophy

**Calm utility.** This is a tool that should feel like a clean, well-organized studio — not a tech product. It should feel restful to use, even when the teacher is doing admin. Every screen should breathe. No visual noise, no competing elements, no gamification.

**Warm minimalism.** Minimal doesn't mean cold. The app uses natural tones, generous whitespace, and soft typography to feel approachable. Think: a handwritten schedule on a cork board in a sunlit room — organized, human, warm.

**Trust through transparency.** Numbers are shown openly. Pricing breakdowns are clear. Nothing is hidden behind "learn more" links or collapsed sections. If the app calculates something, it shows its work.

**Mobile first.** Teachers use this at the venue (checking attendance, adding walk-ins) and at home (creating classes, reviewing payments). The primary experience is a phone held in one hand between classes.

---

## Color palette

| Role | Color | Hex | Usage |
|------|-------|-----|-------|
| Primary | Deep Teal | #1A5653 | Headers, primary buttons, active states, key labels |
| Background | Soft White | #F7F4EF | Page backgrounds — warm off-white, never pure white |
| Surface | Warm Sand | #E8DCC8 | Cards, panels, input fields, secondary surfaces |
| Text | Earth Brown | #6B5B4E | Body text, secondary labels |
| Accent | Muted Gold | #C4A96A | Highlights, progress indicators, badges, subtle accents |
| Dark text | Near Black | #2D2D2D | Headings when high contrast is needed |
| Border | Light Border | #D4C9B8 | Dividers, card borders, input outlines |
| Tint | Light Teal | #E8F0EF | Selected states, active tab backgrounds, subtle highlights |

**Key rules:**
- Background is always Soft White (#F7F4EF), never pure white (#FFFFFF)
- Cards and surfaces use Warm Sand (#E8DCC8) to create gentle depth
- Primary actions (buttons, links) use Deep Teal (#1A5653)
- Text is Earth Brown (#6B5B4E) for body, Deep Teal for headings and labels
- Muted Gold is used sparingly — for accents, not large areas
- No bright colors, no gradients, no shadows heavier than a very subtle elevation
- Error states use a muted, warm red (not bright alarming red) — something like #B85C5C
- Success states use the Deep Teal itself, not a separate green

---

## Typography

| Role | Font | Weight | Size guidance |
|------|------|--------|---------------|
| Headings | Georgia (serif) | Bold | Large, clear, grounded |
| Body text | Arial or system sans-serif | Regular | 16px base, comfortable reading |
| Labels & captions | Arial | Medium / Regular | 13-14px, Earth Brown |
| Numbers & prices | Arial | Semibold | Slightly larger than body, Deep Teal |

**Key rules:**
- Georgia for headings gives warmth and tradition — it says "this is rooted, not trendy"
- Arial/sans-serif for body keeps it clean and legible on mobile
- Price numbers should feel confident and clear — slightly larger, Deep Teal, semibold
- Never use ALL CAPS except for very small labels (and even then, sparingly)
- Line height should be generous (1.5–1.6 for body text)

---

## Component style

### Buttons
- **Primary:** Deep Teal background, Soft White text, fully rounded corners (pill shape), generous horizontal padding
- **Secondary:** Outlined in Deep Teal, transparent background, same pill shape
- **Destructive:** Outlined in muted warm red (#B85C5C), never filled red
- Button text is sentence case ("Create class", not "CREATE CLASS")
- Buttons are generous in size — easy to tap on mobile

### Cards
- Warm Sand (#E8DCC8) background with Light Border (#D4C9B8) outline
- Rounded corners (12-16px radius)
- No drop shadow — use border and background color for depth
- Comfortable internal padding (16-20px)
- Cards should never feel cramped

### Input fields
- Warm Sand background with Light Border outline
- Rounded corners matching cards
- Deep Teal focus/active border
- Labels above the field in Earth Brown, small caps or medium weight
- Placeholder text in a lighter shade of Earth Brown

### Lists and tables
- Alternating rows are NOT needed — the warm palette already creates visual rhythm
- Use generous row height and padding
- Dividers are Light Border, thin (1px)
- Headers in Deep Teal, medium weight

### Navigation
- Bottom tab bar on mobile: 5 items (Dashboard, Classes, Students, Inbox, Settings)
- Active tab: Deep Teal icon with Light Teal background pill
- Inactive tabs: Earth Brown icons
- Icons should be simple line icons, not filled — think Lucide or Feather style

### Status indicators
- Registration below minimum: Muted warm red text or dot
- Registration above minimum: Deep Teal text or dot
- Class full / waitlist active: Muted Gold indicator
- Paid: Deep Teal checkmark
- Unpaid: Earth Brown, no alarming color

---

## Spacing and layout

- **Generous whitespace everywhere.** When in doubt, add more space, not less.
- Content areas should feel like they're floating on the warm background, not crammed edge to edge
- Mobile screens use 16px side margins minimum
- Sections are separated by 24-32px vertical space
- The app should never feel "busy" on any screen

---

## Iconography

- Simple line icons (Lucide, Feather, or similar)
- Stroke width: 1.5-2px
- Color follows the element they're attached to (Deep Teal for active, Earth Brown for inactive)
- No filled icons, no emoji, no illustrations on functional screens
- Icons are functional, not decorative

---

## Imagery

- No stock photos anywhere in the app
- No illustrations or mascots
- The beauty comes from the color palette, typography, and whitespace
- If imagery is ever needed (future marketing), it should be authentic, diverse, and unstaged — real teachers in real spaces

---

## Emotional target

When a teacher opens this app, they should feel:
- **Calm** — "this isn't adding to my stress"
- **Capable** — "I understand what everything does"
- **Supported** — "this tool has my back"
- **Respected** — "this doesn't treat me like I need hand-holding"

It should NOT feel:
- Corporate or "startup-y"
- Gamified or attention-seeking
- Overly playful or whimsical
- Clinical or cold
- Cluttered or feature-heavy

---

## Reference points (mood, not copy)

These are apps/products whose visual feel (not function) is in the right territory:
- **Headspace** — for its calm, warm palette and generous spacing
- **Notion** — for its clean utility and confidence in simplicity
- **Linear** — for its clarity and respect for the user's intelligence
- **Wise (TransferWise)** — for how it makes financial information feel transparent and trustworthy

Take the warmth of Headspace, the utility of Notion, the clarity of Linear, and the transparency of Wise. Dress it in our teal-sand-gold palette with Georgia headings.

---

## Screen-by-screen notes

When generating screens in Stitch, use these guidelines per area:

### Dashboard (5.1)
The teacher's home. Should feel like a calm morning overview. Cards for each upcoming class showing registration progress (visual bar from 0 → min → max). No charts, no analytics overload — just "here's what's coming up."

### Class creation (3.1–3.5)
A stepped flow, not a long form. Each step fits on one mobile screen. The pricing preview (3.3) is the most important screen — it's where the teacher sees what students will actually pay. Make the pricing table clear and confident. Numbers in Deep Teal, generous column spacing.

### Class day view (6.1)
Designed for one-handed mobile use at the venue. Big touch targets for attendance checkboxes. Student names large and readable. The "Add Walk-In" button should be prominent but not in the way.

### Post-class summary (7.1)
This is the payoff screen — the teacher sees what they earned. Make the teacher earnings number feel important (large, Deep Teal, Georgia heading style). The breakdown below should be transparent but not overwhelming.

### Payment checklist (7.2)
Simple toggle list. Each row: student name, amount, paid/unpaid. The "Send Reminder" button is secondary — it's there when needed but doesn't dominate.

### Student list / CRM (8.1)
Clean table/list. Name, last attended, total classes. Should feel like a personal address book, not a CRM dashboard. Warm, not analytical.

### Inbox (10.1)
Chronological list with read/unread states. Warm Sand background for unread, Soft White for read. Simple, scannable, no visual hierarchy tricks.
