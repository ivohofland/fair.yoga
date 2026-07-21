# Booking flow stops re-presenting the tier picker

**Date:** 2026-07-21
**Status:** Approved (issue #19; autonomous run — decisions recorded here)

## Problem

`BookingFlow` renders the full five-card tier picker on every booking.
The product concept says the tier is global and set once: returning
students shouldn't re-pick; only tiers 1–2 get a gentle confirmation at
each booking, and tiers 3–5 get no prompt at all.

## Decisions

- **"First booking" definition:** the student has zero registrations of
  any status, anywhere (tier is global, so the first booking with any
  teacher is the selection moment). Computed server-side on the booking
  page (`_count.registrations` on the existing student query) and passed
  as `isFirstBooking`.
- **First booking (and the teacher-joins-as-student flow, whose fresh
  profile always has zero registrations):** the current picker,
  unchanged.
- **Returning student:** no radiogroup. A summary block under the same
  "Your tier" heading: "You're in Tier {n} · {label}." — for tiers 1–2
  extended with the product-concept confirmation "— does this still
  reflect your situation?" — followed by a link "Change your tier in
  settings" → `/account` (works before and after PR #22; Satya quote
  copy stays deferred per CLAUDE.md open questions). The estimate
  footnote and the "Book — around €X" button (priced at their tier)
  stay.
- The tier-persist-before-booking branch in `handleBook` is unreachable
  for returning students (no way to change `tier`) and stays for the
  first-booking path.

## Testing

- E2e (`booking.spec.ts`): new test — after the existing booking test,
  the same student (now with a registration) opens a second class page:
  the summary renders, the radiogroup does not, booking still works.
  Existing picker tests keep passing (all fixtures are first bookings).
- Drive: Jan (tier 5, has registrations) sees the plain summary; Anna
  (tier 1) sees the confirmation question.
- Full suite, `tsc`, `eslint` green.

## Out of scope

- Waitlist/full-class behavior (unchanged either way).
- The tier-1/2 quote copy; per-class price-range rendering on the
  public teacher page.
