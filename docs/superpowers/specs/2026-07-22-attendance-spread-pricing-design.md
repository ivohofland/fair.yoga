# Booking price range: attendance spread once the tier is known

**Date:** 2026-07-22
**Status:** Approved (issue #33; autonomous run — decisions recorded here)

## Decisions

- **Scope: the booking page header only.** Teacher-page cards keep the
  tier-spread for anonymous-and-unbooked viewers (general per-class
  information), and #31 already replaces the line entirely for booked/
  waitlisted classes. The booking page is the personal surface — that's
  where the personal spread belongs.
- **Condition:** signed-in student with `tierSelectedAt` set (returning;
  first-bookers mid-picker keep the tier spread — their tier isn't
  committed yet).
- **Math** (`estimateAttendanceSpread` in `src/lib/tier-estimates.ts`):
  the viewer's own price at two attendances, reusing the existing honest
  padding (median tier 3): the floor `max(minStudents, registered + 1)`
  (you're joining; clamped to MAX_CLASS_SIZE) and the ceiling
  `maxStudents` (clamped ≥ floor — a walk-in-overfull class collapses to
  a single point). Low/high normalized. Walk-ins can push the real
  price below the shown low — the footnote's "final price settles after
  class" already carries that; no extra caveat.
- **Copy:** "Your price: €X – €Y depending on how many join" (new
  `PersonalPriceRange` beside `PriceRange`, same file — the two lines
  must not drift apart visually). The booking-flow footnote drops "The
  highest tier pays about twice the lowest." in the returning branch —
  it's tier-spread information.

## Testing

- Unit (TDD, exact values in the tier-estimates suite): empty class,
  viewer tier 3, room 20 / rates 15–25 / 2–10 → spread 4.50–17.50;
  a with-registrations case; the full-class collapse; monotonicity of
  low ≤ high.
- E2e: the returning-student booking page asserts "depending on how
  many join" and the absence of the tier-spread line; the first-booking
  (magic-link) test's existing tier-spread assertion pins the other
  branch unchanged.

## Note

`booking.spec.ts` is also touched by PR #37 in nearby regions — merge
#37 first; this branch gets rebased if the hunks collide.
