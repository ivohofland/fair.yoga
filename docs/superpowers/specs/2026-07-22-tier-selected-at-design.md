# tierSelectedAt — record when a student actually chose their tier

**Date:** 2026-07-22
**Status:** Approved (issue #26; autonomous run — decisions recorded here)

## Problem

PR #23 approximates "first booking" as "no registration from after the
account claim." That still lets a teacher who adds an already-claimed
student to a class consume the student's income-selection moment. The
correct model is a durable marker: has this student ever chosen a tier
themselves?

## Decisions

- **Schema:** nullable `Student.tierSelectedAt DateTime?`, added via
  `prisma migrate dev` (per CLAUDE.md — no db push).
- **Backfill (in the same migration):** claimed students get
  `tierSelectedAt = claimedAt`. Under pre-PR-#23 behavior every booking
  showed the picker, so anyone who ever signed in has had the choice.
  Unclaimed CRM students stay `NULL` — their tier is the teacher-created
  default, never a choice.
- **Stamp rule:** the students PUT route stamps `tierSelectedAt = now()`
  only in the **self-edit branch** when `incomeTier` is present in the
  update. The teacher-edit branch cannot set `incomeTier` at all
  (`createStudentSchema`), so teacher edits never stamp — by
  construction, not by check.
- **Booking flow:** `isFirstBooking` becomes
  `student.tierSelectedAt === null` (replacing the claim-aware
  registration heuristic from PR #23; that spec's residual edge is now
  closed). `handleBook` persists the tier when
  `isFirstBooking || tier !== currentTier` — accepting the default
  tier without touching the picker is still a choice and must stamp,
  else the picker would reappear forever.
- **Fixtures:** the seed's claimed students get
  `tierSelectedAt: daysAgo(30)` (same instant as their claim);
  `student-journey.spec.ts`'s `mkStudent` stamps its established
  students (they book via API without ever seeing a picker).

## Testing

- Integration (TDD, new `tests/integration/tier-selected-at.test.ts`):
  self PUT with `incomeTier` → stamped; self PUT without `incomeTier`
  (e.g. reminder change) → not stamped; teacher PUT on an unclaimed
  CRM student → not stamped (route rejects `incomeTier` for teachers —
  asserted via the field being ignored/rejected and the marker staying
  NULL).
- E2e: existing booking suites re-run — first-booking flows still show
  the picker (fresh fixtures have `tierSelectedAt: null`), the
  returning flow still shows the summary (the picker booking stamps
  via the PUT), journey's API-booked students show the summary via the
  fixture stamp.
- Full suites, `tsc`, `eslint`; dev server restarted after the
  migration (stale Prisma client).

## Out of scope

- Re-prompting existing students; any UI change beyond the persist
  condition; teacher-side tier editing (doesn't exist).
