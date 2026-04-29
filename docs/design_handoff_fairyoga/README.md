# Handoff: fair.yoga — Design Tokens & Component Primitives

## Overview

This handoff brings the **fair.yoga** design system into a Next.js + Tailwind codebase. It contains:

- **Design tokens** — the full color, typography, spacing, radius, and elevation system, delivered as both CSS variables (`tokens.css`) and a Tailwind config (`tailwind.config.fairyoga.js`).
- **Component primitives** — buttons, inputs/selects, list rows, the payment "Mark paid / Paid" button, and the status system (activity dots + meta states).
- **Reference HTML prototypes** — the source-of-truth design files showing each component in context.

The aesthetic is deliberate: a printed-page, e-reader feel. **No drop shadows, no rounded corners by default, no pure white.** Teal is reserved for money. Earth brown carries almost every UI mark. Buttons and fields are flat — the only `8px` radius lives on the attendance and payment buttons so they read as tappable without softening the rest of the surface.

## About the Design Files

The HTML files in `reference/` are **design references, not production code to copy**. They are static prototypes that show intended look and behavior. Your task is to recreate these in the Next.js + Tailwind codebase using the project's existing patterns (App Router, server components where appropriate, your own component structure). Lift the **values** — colors, type scale, spacing, copy — into idiomatic Tailwind classes and React components. Don't ship the HTML.

## Fidelity

**High-fidelity.** All colors, typography, spacing, and radii are final. Match them pixel-perfectly using the tokens provided.

## Stack & Delivery

Target: **Next.js + Tailwind**.

Two delivery formats are included so you can choose what fits the codebase best — most projects will use **both**:

1. `tokens.css` — drop into `app/globals.css` (or import it). Provides every token as a CSS custom property and resets `html, body` to the page background, body font, and earth-brown text color.
2. `tailwind.config.fairyoga.js` — merge into your `tailwind.config.js` `theme.extend`. Exposes `bg-fy-sand`, `text-fy-teal`, `font-heading`, `text-pullquote`, `rounded-pay`, etc.

You can use them together: tokens.css owns the variables, the Tailwind config exposes utilities that resolve to those variables.

---

## Design Tokens

### Colors

The palette is small on purpose — sand, cream, earth, ink — with teal reserved for money.

| Token | Hex | Role |
|---|---|---|
| `--fy-teal` | `#1A5653` | Deep Teal — primary; **reserved for money + the wordmark** |
| `--fy-sand` | `#E8DCC8` | Warm Sand — body background (the page) |
| `--fy-cream` | `#F7F4EF` | Soft White — surface, cards, input fills |
| `--fy-brown` | `#6B5B4E` | Earth Brown — body text and almost every UI mark |
| `--fy-dark` | `#2D2D2D` | Near Black — high-contrast text, headings, hero |
| `--fy-border` | `#D4C9B8` | Light border, hairlines, dividers |
| `--fy-gold` | `#C4A96A` | Muted Gold — rare accent, not in active use |
| `--fy-error` | `#B85C5C` | Warm Red — errors only, never decorative |
| `--fy-teal-light` | `#E8F0EF` | Selected tint for list rows |

**Rules**
- **No pure white (`#FFFFFF`).** Too clinical for the page. Use `--fy-cream` for surfaces.
- **Teal is a moment, not a theme.** It appears on prices, the wordmark, and the 10% teal-tint earnings block — nowhere else.
- **Errors use warm red** as a thin border + italic Georgia label, not a fill.

### Semantic roles

```
--fg1: var(--fy-dark)            primary text
--fg2: var(--fy-brown)           secondary text, labels, almost everything
--fg-accent: var(--fy-teal)      links, prices
--fg-muted: #9A8C7E              tertiary / hints
--fg-on-teal: var(--fy-cream)    text on teal fills

--bg-page: var(--fy-sand)
--bg-surface: var(--fy-cream)
--bg-input: var(--fy-cream)
--bg-tint: var(--fy-teal-light)
--bg-teal-soft: rgba(26, 86, 83, 0.10)

--border-default: var(--fy-border)
--border-strong: var(--fy-teal)
```

### Typography

**Two families, both Google Fonts:**

```
--font-heading: Georgia, 'Times New Roman', serif;
--font-body: 'Atkinson Hyperlegible', Arial, Helvetica, sans-serif;
```

Georgia is web-safe (no import needed). Atkinson Hyperlegible loads from Google Fonts:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap" rel="stylesheet">
```

Or in Next.js (App Router) using `next/font`:

```ts
// app/fonts.ts
import { Atkinson_Hyperlegible } from 'next/font/google';
export const atkinson = Atkinson_Hyperlegible({
  weight: ['400', '700'],
  subsets: ['latin'],
  variable: '--font-body-next',
  display: 'swap',
});
```

**Type rules:**
- **Roman Georgia (bold)** carries structural work — h1, h2, section heads, stacked titles.
- **Italic Georgia (400)** is reserved for **one editorial moment per screen**: a class title, a flow opener, a sign-in heading. Never italicise a section header.
- **Atkinson Hyperlegible** is the body. 16px / 1.65 by default, in earth brown.
- **Old-style figures** (`font-feature-settings: "onum" 1`) for counts, dates, running numbers in body copy.
- **Tabular lining figures** (`"tnum" 1, "lnum" 1`) for money, so prices stack and align.

**Scale:**

```
--text-xs: 12px       hints, fine print
--text-sm: 14px       labels, captions
--text-base: 16px     body
--text-lg: 18px       price inline, h3
--text-xl: 20px       h2 / section header
--text-2xl: 24px      h1
--text-3xl: 30px      hero price
--text-4xl: 36px      pull quote / hero italic

--lh-tight: 1.2       headings
--lh-normal: 1.5      labels
--lh-loose: 1.65      body
```

**Specials:**
- **Pull quote** (hero italic): Georgia 400 italic, 36–40px, line-height 1.1, letter-spacing −0.01em, near-black.
- **Running header**: 11px earth brown, letter-spacing 0.04em, old-style figures, italic Georgia wordmark inline.
- **Colophon** (end-of-section): Georgia italic 12px, earth brown at 0.7–0.75 opacity, right-aligned.
- **Small caps** (eyebrows): `font-variant-caps: small-caps`, letter-spacing 0.08em, 12px earth brown.

### Spacing (multiples of 4)

```
--space-1: 4px       tight inset
--space-2: 8px       small gap between siblings
--space-3: 12px      inline gap, chip padding
--space-4: 16px      screen side margin (mobile)
--space-5: 20px
--space-6: 24px      section spacing
--space-8: 32px      between major sections
--space-10: 40px
--space-12: 48px
```

No in-between values. Earth-brown bars in the spec preview.

### Radii

```
--radius-none: 0     default everywhere — flat, e-reader aesthetic
--radius-sm: 4px
--radius-md: 8px     attendance + payment buttons only
--radius-lg: 12px    reserved, rarely used
```

**Flat > rounded.** Buttons, inputs, selects all sit at `--radius-none`. The 8px exceptions exist so the few interactive checkbox-style buttons feel tappable without softening the rest of the surface.

### Elevation

**No shadows.** `--shadow-none: none`. The page is paper, not glass.

Three legitimate "depth" expressions:
- **Default** — flat 1px hairline border in `--fy-border`.
- **Teal tint** — `rgba(26, 86, 83, 0.10)` background, no border. Used **once per screen**, paired with the hero earnings amount.
- **Focus** — `box-shadow: inset 0 0 0 1px var(--fy-brown)`. No outline ring.

### Touch target

```
--tap: 44px      minimum touch target — buttons, inputs
```

---

## Component Primitives

### Buttons

Five variants, all flat, sentence case, 44px min height.

| Variant | Background | Color | Border |
|---|---|---|---|
| Primary | `--fy-brown` | `--fy-cream` | none |
| Secondary | transparent | `--fy-brown` | 1px `--fy-brown` |
| Ghost | transparent | `--fy-brown` | none, hairline underline (0.5px, offset 3px) |
| Destructive | transparent | `--fy-error` | 1px `--fy-error` |
| Disabled | (any) | (any) | opacity 0.5, `cursor: not-allowed` |

Common: `font-family: var(--font-body)`, `font-weight: 500`, `font-size: 16px`, `padding: 12px 24px`, `min-height: 44px`, `border-radius: 0`.

### Payment button — the radius exception

Used on the payment checklist roster only. Two states: outline (Mark paid) and filled (Paid).

```css
.btn-pay {
  min-width: 44px;
  min-height: 44px;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  border-radius: 8px;             /* the only place 8px lives */
  border: 1px solid var(--fy-brown);
  background: transparent;
  color: var(--fy-brown);
  font-family: var(--font-body);
}
.btn-pay.paid {
  background: var(--fy-brown);
  color: var(--fy-cream);
  border-color: var(--fy-brown);
}
```

### Inputs & selects

```css
input, select {
  font-family: var(--font-body);
  font-size: 16px;                /* prevents iOS zoom */
  padding: 12px 16px;
  min-height: 44px;
  background: var(--fy-cream);
  border: 1px solid var(--fy-brown);
  color: var(--fy-dark);
  border-radius: 0;
  outline: none;
}
input:focus, select:focus {
  box-shadow: inset 0 0 0 1px var(--fy-brown);   /* no outline ring */
}
```

- **Label** above the field: italic Georgia, 13px, earth brown.
- **Hint** below: italic Georgia, 12px, earth brown, old-style figures.
- **Error** below: italic Georgia, 12px, `--fy-error`. Field gets no fill change — the error is in the label, not the chrome.
- **Select** uses an inline SVG chevron in earth brown:
  ```
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236B5B4E' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  ```

### List row

```
[ left stack          ][ right stack ]
  bold time · title     count
  studio sub            <dot> italic state
```

- Row: `padding: 14–16px 0`, hairline divider in `--fy-border`, last row no divider.
- Title: 15px near-black, lead segment bold (`<b>09:00</b>`), middle dot separator.
- Sub: 12px earth brown, old-style figures.
- Right meta: italic Georgia 13px earth brown, `count / capacity` with thin-space separator (`&thinsp;/&thinsp;`).

### Status system

**One color, three shapes.** Earth brown only — shape carries the meaning.

**Activity states** (a small dot + italic word):

| State | Marker | Meaning |
|---|---|---|
| `open` | hollow ring (1.5px brown border, transparent fill) | Below the floor — needs more registrations |
| `filling` | half-fill (linear-gradient 50% brown / 50% transparent + 1px brown border) | Between floor and ceiling |
| `full` | solid brown disc | At capacity |
| `waitlist` | solid brown disc + `full · N waiting` suffix | Same as full, with italic count appended; suffix hidden when zero |

Dot dimensions: `9×9px`, `border-radius: 50%`, `transform: translateY(-1px)` for baseline alignment.

**Meta states** (italic word, no marker):

| State | Treatment |
|---|---|
| `draft` | italic word, no decoration |
| `cancelled` | italic word; **title gets a hairline strikethrough** in earth brown (0.5px); row stays full opacity |
| `past` | italic word; **whole row dims to 40% opacity** |

No second color. No chromatic noise.

### Numbers

- **Hero price**: Georgia bold, 30–46px, deep teal, tabular lining figures, line-height 1.1, letter-spacing −0.01em. Cents at 22px, `vertical-align: top`, weight 400.
- **Inline price**: Atkinson 14–18px, weight 600, deep teal, tabular figures. Two decimals.
- **Counts** (`7 / 12`, dates, indices): old-style figures, earth brown, in body copy.

```
.fy-money         color: var(--fy-teal); font-weight: 600; font-feature-settings: "onum" 1;
.fy-price-hero    Georgia 700, 30px+, teal, tabular
```

---

## Layout patterns

### Running header (page chrome)

A "page number" at the top of every screen:

```
fair.yoga                              Class of Mon, 22 April
```

11px earth brown, letter-spacing 0.04em, old-style figures, italic Georgia for the wordmark, justified between with a 2px brown bottom border 14px below. 36–40px bottom margin before content.

### Hero block

Eyebrow (italic Georgia 13px brown) → pull quote (italic Georgia 35–40px near-black) → optional lede (italic Georgia 14px brown, max-width ~360px). 24px bottom padding, 2px brown bottom border, 28px bottom margin.

### Sub-head (within-screen section)

```
Awaiting                                 € 31.40 outstanding
```

Roman Georgia 16–22px bold near-black; meta italic Georgia 12–13px earth brown with old-style + tabular figures. 1px hairline border-bottom. 24px above, 16px below.

### Summary footer

```
Total collected so far                   € 81.00
```

2px earth-brown top border, 14px padding-top. Label italic Georgia 13px brown; value Atkinson tabular figures, near-black, weight 400. **Money does not get teal here** — the heavy line above is the moment.

---

## Files in this bundle

```
design_handoff_fairyoga/
├── README.md                          ← this file
├── tokens.css                         ← drop into app/globals.css
├── tailwind.config.fairyoga.js        ← merge into theme.extend
└── reference/
    ├── colors_and_type.css            ← original source-of-truth tokens file
    ├── flows-v1.html                  ← three flows in one (sign-in, new class, payment)
    ├── components-buttons.html
    ├── components-inputs.html
    ├── components-list-row.html
    ├── components-payment.html        ← canonical Mark paid / Paid button
    ├── components-status.html         ← full status reference
    ├── colors-primary.html
    ├── colors-neutrals.html
    ├── type-headings.html
    ├── type-body.html
    ├── type-numbers.html
    ├── spacing-scale.html
    ├── spacing-radii.html
    └── spacing-elevation.html
```

## Implementation notes

1. **Start with tokens.** Merge `tokens.css` into `app/globals.css` and `tailwind.config.fairyoga.js` into your Tailwind config first, then verify a blank page renders sand background + earth-brown body text in Atkinson Hyperlegible.
2. **Build the buttons next.** All variants share base styles — extract a `<Button variant="primary | secondary | ghost | destructive">` and a separate `<PayButton paid={boolean}>` (the radius is the only intentional exception in the system, keep it isolated).
3. **Then inputs**, then list row, then status. The status component is small but does a lot of work — keep dot rendering as CSS, not SVG, so the half-fill stays crisp at 9px.
4. **Open `reference/flows-v1.html`** alongside this README. It exercises everything together and is the most useful integration test.
5. **Accessibility:** Atkinson Hyperlegible is itself an accessibility-first typeface. Keep the 44px minimum touch target. Errors should be announced (`aria-live="polite"`), not just colored — and they aren't colored here, the field chrome doesn't change.

## What's intentionally not included

- **Brand pages** (logo lockups, iconography, voice, values) — out of scope for this handoff. Ask if you need them.
- **Flow screens** as React components — the prototype is included in `reference/` for visual reference only, since the scope was tokens + primitives.
- **Animations / motion** — none specified; the system is intentionally still.
- **Dark mode** — not part of the system. The page is sand-colored paper.
