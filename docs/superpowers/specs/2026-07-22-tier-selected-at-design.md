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
  `tierSelectedAt = claimedAt` — a one-time heuristic: anyone who
  claimed is *assumed* to have chosen (a claimed-but-never-booked
  student never saw a picker, but the neutral default plus the settings
  link make this an acceptable approximation for pre-existing rows;
  going forward such students correctly stay unstamped). Unclaimed CRM
  students stay `NULL` — their tier is the teacher-created default,
  never a choice. The applied migration file itself keeps its original
  comment: editing an applied migration recreates checksum drift.
- **Stamp rule:** the students PUT route stamps `tierSelectedAt = now()`
  only in the **self-edit branch** when `incomeTier` is present in the
  update. The teacher-edit branch cannot set `incomeTier` at all
  (`createStudentSchema`), so teacher edits never stamp — by
  construction, not by check.
- **Booking flow:** `isFirstBooking` becomes
  `student.tierSelectedAt === null` (replacing the claim-aware
  registration heuristic from PR #23; that spec's residual edge is now
  closed).
- **Server-side stamping (revised after review):** "booking implies
  choice" is an invariant, so it is enforced where bookings happen, not
  in a client component only e2e can reach:
  - `POST /api/registrations` stamps inside the booking transaction —
    **self-bookings only** (`body.studentId` absent; roster adds and
    walk-ins never stamp), null-guarded
    (`updateMany where tierSelectedAt: null`) so the timestamp records
    the first choice and repeat bookings are no-ops.
  - `POST /api/waitlist` stamps the same way (the route is self-only by
    construction). Waitlist promotion and claim create registrations
    through the service, bypassing the route — transitively covered:
    nobody is promoted or claims without having joined, and joining
    stamps.
  - The client persist reverts to its original condition
    (`tier !== currentTier`): accepting the default needs no client
    cooperation, and any future booking surface inherits the invariant
    for free. The PUT-route stamp remains for explicit tier saves
    (settings page, changed tier at booking).
- **Fixtures:** the seed's claimed students get
  `tierSelectedAt: daysAgo(30)` (same instant as their claim);
  `student-journey.spec.ts`'s `mkStudent` stamps its established
  students (they book via API without ever seeing a picker).

## Testing

- Integration (TDD, `tests/integration/tier-selected-at.test.ts`, one
  dedicated student per case — order-independent): self PUT with
  `incomeTier` → stamped; self PUT without `incomeTier` → not stamped;
  teacher PUT on an unclaimed CRM student → neither sets tier nor
  stamps; self booking POST → stamped (red first); teacher roster-add
  POST → not stamped; self waitlist join on a full class → stamped
  (red first).
- One thin e2e as user-facing proof: first booking with the default
  tier untouched → books, reload shows the returning summary.
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
