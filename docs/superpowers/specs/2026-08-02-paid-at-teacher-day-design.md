# paidAt renders the teacher's day, not UTC's

**Date:** 2026-08-02
**Status:** Approved (issue #140; design agreed with Ivo — extract
`ReceivedPaymentRow` to mirror its already-tested sibling, and pass `paidAt`
raw rather than pre-formatted so the timezone conversion lands inside the
tested unit)

## Problem

`src/app/(teacher)/settings/payments/page.tsx:125` renders:

```tsx
{p.paidAt && <> · ✓ paid {formatDateShort(p.paidAt)}</>}
```

`Payment.paidAt` is `DateTime?` — a true **instant**, the moment the teacher
tapped "Mark paid". `formatDateShort` reads with `getUTC*` accessors, which is
correct for a `@db.Date` calendar value and wrong for an instant.

A payment marked paid at 18:00 Pacific on 12 June is stored as
`2026-06-13T01:00:00Z` and renders as **13 Jun**. A teacher who settled up on
Friday evening sees it dated Saturday.

This breaks the rule `src/lib/timezone.ts` states:

> A `@db.Date` column is a *calendar date*, stored at midnight UTC — read it
> with UTC accessors. A `new Date()` is an *instant* — convert it with
> `startOfLocalDay` before comparing or rendering it as a day.

### The census: one site, and the "one line" claim holds

Every call of a UTC-accessor formatter (`formatDayHeader`, `formatDateWithYear`,
`formatDateShort`) outside `format.ts` — **22 sites**, classified:

| Kind | Count | Correct? |
|---|---|---|
| `@db.Date` column (`cls.date`, `sc.date`, `student.birthday`) | 18 | ✅ |
| Instant already run through `startOfLocalDay` | 2 | ✅ |
| `new Date(form.date)` from a date-only ISO string → UTC midnight | 1 | ✅ |
| **Raw instant** — `payments/page.tsx:125` | **1** | ❌ |

Checked the other routes an instant could leak into a day render:

- **Direct `getUTC*` outside the formatters** — 14 hits, all date *arithmetic*
  on calendar values (`monthKey`, `weekLabel`/`mondayOf`, `class-generator`,
  `template-sync`, the schedule window). None renders an instant.
- **`toLocaleDateString`** — none left in `src/`; #96 removed the last.
- **`timeAgo`** — reads elapsed milliseconds, never a calendar field. Correct by
  construction for instants, which is what it takes.

`#140`'s claim that the fix is one line survived the check intact — worth noting
because most inherited claims this week did not.

### Why it was not fixed sooner

#96 consolidated eight date formats and deliberately preserved this bug rather
than half-fixing it inside a formatting refactor; the call site has carried a
comment naming #140 since. The fix needs the teacher's timezone, which #138
(PR #144) put on the session — `session.defaultTimezone` is available after
`requireTeacherSession()`, and this page already calls it at line 14. No new
query.

## Design

### 1. The fix

```ts
formatDateShort(startOfLocalDay(p.paidAt, session.defaultTimezone))
```

### 2. Extract `ReceivedPaymentRow`, because nothing can test the page

The render sits inline in an async server component. RTL cannot render one, and
#136's glob widening does not help — that unlocked `'use client'` page forms,
which this is not.

The **Outstanding** section already has an extracted, tested
`src/components/class/outstanding-payment-row.tsx`. The Received rows are the
half that never got extracted. Adding `received-payment-row.tsx` beside it
mirrors a pattern the codebase already has, and creates the seam this fix needs.

It takes over the row's markup and its `MarkUnpaidButton`.

### 3. `paidAt` is passed raw — a deliberate divergence from the sibling

`OutstandingPaymentRow` receives `classContext` as a **pre-formatted string**,
and that is correct for it: #59 requires that string byte-identical across the
visible caption and three button labels, so a separate aria value could drift
from what is on screen.

`paidAt` has no such constraint, and pre-formatting it would defeat the
extraction:

```ts
interface ReceivedPaymentRowProps {
  paymentId: string;
  studentName: string;
  classContext: string;      // pre-formatted, same as the sibling, same #59 reason
  paidAt: Date | null;       // raw instant
  timeZone: string;          // session.defaultTimezone
  amount: number;
}
```

If the page formatted `paidAt` and passed a string, the component would be dumb
and the timezone conversion would remain untestable — the extraction would buy
nothing. Passing the instant puts the conversion **inside** the tested unit.

`classContext` keeps its pre-formatted `@db.Date` rendering, which is correct
and unchanged.

## Testing

`src/components/class/received-payment-row.test.tsx`, mirroring
`outstanding-payment-row.test.tsx`'s conventions:

- **The regression test.** `paidAt = 2026-06-13T01:00:00.000Z`,
  `timeZone = 'America/Los_Angeles'` → the caption reads **`12 Jun`**. Under the
  unfixed code this renders `13 Jun`, so the test fails against the bug and
  passes against the fix. Verify that by reverting the fix, not by assuming it.
- **A second zone, with its own instant, shifting the opposite way.**
  `Asia/Kolkata` (UTC+5:30) with `paidAt = 2026-06-12T20:00:00.000Z` → the
  caption reads **`13 Jun`** while UTC reads 12 Jun. Reusing the Los Angeles
  instant here would **not** discriminate — `2026-06-13T01:00:00Z` is 06:30 on
  13 June in Kolkata, the same calendar day as UTC, so the test would pass
  whether or not the timezone were applied at all. Two zones shifting in
  opposite directions also rules out an implementation that always subtracts.
- **`paidAt: null`** renders no "✓ paid" caption at all.

The suite's `TZ` pin (`vitest.config.ts`, `America/New_York`) means a
regression to host-local time is visible rather than theoretical.

## Out of scope

- **#143** — the general absence of a test seam on async server components. This
  creates one seam for one row; it does not solve the class.
- **#128** — `MarkUnpaidButton`'s accessible name is the bare "Mark unpaid" for
  every row. It moves into the new component unchanged.
- **The 45 other instant columns.** None is rendered through a calendar-date
  formatter today (verified above). This fixes the one that is.

## Risks

- **Moving markup is where a "no visual change" claim goes wrong.** Every
  class name, element order and separator must survive the extraction
  unchanged. The visible caption changes in exactly one respect — the date —
  and any other diff is a defect.
- **A test that passes for the wrong reason.** Both fixtures are chosen so the
  target zone and UTC fall on *different* calendar days; that is the whole
  property. An earlier draft of this spec specified `Asia/Kolkata` against the
  Los Angeles instant, which shares UTC's day and would have made that case
  pass whether or not the code applied a timezone. If either instant is ever
  changed, re-check that property rather than assuming it.
- **`startOfLocalDay` returns midnight UTC of the teacher's day**, which
  `formatDateShort` then reads with UTC accessors — correct, and the same
  composition `archived-record.tsx` and the schedule home already use. It reads
  odd on first encounter, which is why the call-site comment stays.
