# Design Brief — fair.yoga

Working design direction for building the interface. This supersedes `stitch-design-brief.md` for implementation decisions.

---

## Aesthetic: E-reader meets dumb phone

The interface should feel like a document you interact with, not an app you navigate. Think Kindle library, Nokia menu, paper schedule pinned to a wall. Every screen should feel like it was designed for a device with no GPU.

**What this means concretely:**
- No animations, no transitions — screens just appear
- No shadows, no depth, no glassmorphism, no gradients
- No hover effects (mobile-first, there is no hover)
- No loading spinners — show content structure or nothing
- No decorative elements — every pixel serves a function
- Lists over cards — prefer simple stacked rows with dividers
- Flat and honest — the interface is the content

---

## Navigation: Accordion home

The teacher dashboard is a single page with four collapsible sections:

```
▸ Schedule
▾ Students
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  [section content]
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
▸ Inbox
▸ Settings
```

**Rules:**
- Tap a section header to expand it, others collapse
- Collapsed headers stay visible — you always see the full structure
- Section headers are text-only: Georgia, Deep Teal, no icons
- Active section has a simple indicator (underline or ▾ vs ▸)
- Scroll position within a section is preserved on collapse/reopen

**Detail pages are separate pages.** Tapping a specific class, student, or notification opens a full page. The accordion is the home base — you go to detail pages and come back. This keeps the main experience feeling like one document while giving complex screens (class detail, student profile) room to breathe.

---

## Color palette

| Role | Hex | Usage |
|------|-----|-------|
| Primary | #1A5653 (Deep Teal) | Section headers, active states, primary buttons, price numbers |
| Background | #F7F4EF (Soft White) | Page background — warm off-white, never pure white |
| Surface | #E8DCC8 (Warm Sand) | Input fields, expanded section backgrounds |
| Text | #6B5B4E (Earth Brown) | Body text, inactive nav, secondary labels |
| Accent | #C4A96A (Muted Gold) | Sparingly — waitlist indicators, progress bars |
| Dark text | #2D2D2D (Near Black) | High-contrast headings when needed |
| Border | #D4C9B8 (Light Border) | Dividers, section separators, input outlines |
| Error | #B85C5C (Warm Red) | Error states — muted, not alarming |

**Rules:**
- Background is always Soft White, never #FFFFFF
- Deep Teal does almost all the accent work — muted gold is rare
- Success states use Deep Teal, not green
- No bright colors anywhere

---

## Typography

| Role | Font | Weight | Size |
|------|------|--------|------|
| Section headers | Georgia | Bold | 20-24px |
| Page headings | Georgia | Bold | 18-20px |
| Body text | Arial / system sans | Regular | 16px, line-height 1.6 |
| Labels & captions | Arial | Regular | 13-14px |
| Prices & numbers | Arial | Semibold | 18-20px, Deep Teal |
| Nav items | Arial | Medium | 14px |

**Rules:**
- Georgia for headings only — gives warmth without being decorative
- Never ALL CAPS
- Generous line height (1.5-1.6) for body text
- Price numbers should feel confident: slightly larger, Deep Teal, semibold

---

## Components

### Buttons
- **Primary:** Deep Teal background, Soft White text, rounded corners (8px — not full pill), generous padding (12px 24px)
- **Secondary:** Deep Teal text, Light Border outline, transparent background
- **Destructive:** Warm Red text, Light Border outline
- Sentence case ("Create class", not "CREATE CLASS")
- Large touch targets — minimum 44px height

### Lists (preferred over cards)
- Simple rows with Light Border dividers (1px)
- Generous row padding (14-16px vertical)
- No alternating row colors
- Content left-aligned, status/action right-aligned

### Input fields
- Warm Sand background, Light Border outline
- 8px rounded corners
- Deep Teal focus border
- Label above in Earth Brown (13px)
- 44px minimum height

### Status indicators
- Below minimum registrations: Warm Red text
- Above minimum: Deep Teal text
- Class full / waitlist: Muted Gold
- Paid: Deep Teal checkmark (✓)
- Unpaid: Earth Brown, no alarming color

---

## Spacing

- 16px side margins on mobile
- 24-32px between sections
- Generous whitespace everywhere — when in doubt, add more space
- The screen should never feel busy

---

## Icons

- None in navigation (text-only)
- Functional icons only where text isn't sufficient (e.g., ✓ for paid status)
- When needed: simple, inline, matching the text color
- No icon library dependency — use unicode symbols or minimal inline SVG

---

## What this is NOT

- Not an app with tab bars and screen transitions
- Not a dashboard with charts and analytics
- Not a design system with dozens of component variants
- Not dark-mode-ready (warm palette only)
- Not trying to look like a tech product

---

## Screen patterns

### Home (accordion)
The four sections collapse/expand. Only one open at a time. The open section shows its full content inline. Teacher lands here after login.

### Schedule (accordion section)
Chronological list of upcoming classes. Each row: date, time, class type, registration count (e.g., "7/12"), status dot. Tap a class → opens class detail page.

### Students (accordion section)
Alphabetical list. Each row: name, last class date, total classes attended. Tap → student detail page.

### Inbox (accordion section)
Chronological, newest first. Each row: title, preview text, timestamp. Unread rows in slightly bolder text or with a dot. Tap → notification detail or navigates to related context.

### Settings (accordion section)
Simple list of setting groups: Profile, Rooms, Payment Details, Defaults. Each group expands inline or opens a sub-page depending on complexity.

### Class detail (separate page)
One page that adapts based on class lifecycle stage:
- **Draft/Open:** Class info, pricing preview, registration count, share link, edit, cancel
- **Full:** Same as open + waitlist count
- **In Progress:** Attendance checklist with big touch targets, add walk-in button
- **Completed:** Pricing breakdown (teacher earnings prominent), payment checklist per student
- **Cancelled:** Read-only summary

### Student detail (separate page)
Attendance history, payment history, shared contact info (filtered by privacy settings).
