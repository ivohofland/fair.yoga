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
  highest tier pays about twice the lowest." when the tier is settled —
  it's tier-spread information (an inline `isFirstBooking &&` gate in
  the shared footnote, not a separate branch).
- **Already-registered viewers** (review follow-up): the viewer's own
  charged row is excluded from `registeredTiers` before the call — they
  are already in the pool, so appending them again would double-count
  them and inflate the floor. A booked viewer is quoted at the tier
  stamped on their registration (what the final bill uses); a
  late_cancel viewer at their current tier (rebooking reactivates their
  row, so they re-enter as themselves, not as an extra body).

## Testing

- Unit (TDD, exact values in the tier-estimates suite): empty class,
  viewer tier 3, room 20 / rates 15–25 / 2–10 → spread 4.50–17.50;
  a with-registrations case; the full-class collapse; non-inversion
  (low ≤ high, guarded by the min/max normalization at the return);
  a viewer-tier-1 exact case (distinguishes the viewer from the tier-3
  padding); the MAX_CLASS_SIZE clamp.
- E2e: the returning-student booking page asserts the exact tier-2
  spread (€3.68 – €15.56) and the absence of the tier-spread price line
  and footnote sentence; the booked revisit asserts the same exact
  spread (the double-counted range would read €3.75 – €17.50); the
  first-booking branch pins the footnote sentence present; the
  magic-link test's existing tier-spread assertion pins the picker
  branch unchanged.

## Note

`booking.spec.ts` is also touched by PR #37 in nearby regions — merge
#37 first; this branch gets rebased if the hunks collide.
