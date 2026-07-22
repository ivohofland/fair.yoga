# Public teacher page: cards show your own booked/waitlisted state

**Date:** 2026-07-22
**Status:** Approved (issue #31 + rider; autonomous run)

## Decisions

- The page stays public; it gains an optional session read. For a
  signed-in student, two id-scoped lookups across the listed classes:
  `registered` registrations and `waiting` waitlist entries.
- Card price line is replaced (Ivo's call in the issue) per state:
  `✓ Booked` for a registered class, `On the waitlist` for a waiting
  one — `type-label text-teal`, text not badge (the badge slot encodes
  class state; the checkmark matches the ✓ Paid text convention).
  Everyone else sees the price range unchanged.
- `late_cancel` shows nothing special: the seat is free and rebooking
  is real — the price range is the honest line there.
- Cards keep linking through to the booking page.
- **Rider:** the booking summary's tier link deep-links to
  `/account/tier` (the `/account` target was a build-time hedge while
  PR #22 was unmerged). Copy unchanged — it still says where you land.

## Testing

- `booking.spec.ts`: inside the accept-default test (its student books
  exactly one of two classes): the teacher page shows `✓ Booked` once
  and the price range on the other card; the signed-out public-page
  test pins the unchanged anonymous view. Returning-student test pins
  the deep-link href. `student-journey.spec.ts`: Bram waiting → the
  card says `On the waitlist`.
