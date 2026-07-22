# tierSelectedAt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A durable marker for self-selected tiers replaces the registration heuristic (issue #26).

**Spec:** `docs/superpowers/specs/2026-07-22-tier-selected-at-design.md`

### Task 1: Schema + migration with backfill

- `prisma/schema.prisma` Student: `tierSelectedAt DateTime?` (after `claimedAt`).
- `npx prisma migrate dev --create-only --name add_tier_selected_at`, append to the generated SQL:
  `UPDATE "Student" SET "tierSelectedAt" = "claimedAt" WHERE "claimedAt" IS NOT NULL;`
- Apply with `npx prisma migrate dev`; restart the dev server (stale client).
- Commit.

### Task 2: Stamp on self-selection (TDD)

- New `tests/integration/tier-selected-at.test.ts` (house fixture pattern; student w/ session, teacher w/ session + unclaimed CRM student + link): the three cases from the spec. Run — the stamp case is red.
- `src/app/api/students/[id]/route.ts` self-edit branch: `data: { ...updateData, ...(updateData.incomeTier !== undefined ? { tierSelectedAt: new Date() } : {}) }`.
- Green; commit.

### Task 3: Consume the marker

- Booking page: student select swaps `claimedAt`/`registrations` for `tierSelectedAt`; `isFirstBooking={student.tierSelectedAt === null}` (comment updated).
- `booking-flow.tsx` handleBook: `if (isFirstBooking || tier !== currentTier)` persists `{ incomeTier: tier }` (stamps even when the default is accepted untouched).
- Seed: claimed-students create gains `tierSelectedAt: daysAgo(30)`; summary text untouched. Re-seed.
- `student-journey.spec.ts` `mkStudent`: add `tierSelectedAt: new Date()`.
- Update the PR #23 spec's residual-edge note: closed by this issue.
- Commit.

### Task 4: Verify + PR

Full e2e (booking, journey, hybrid at minimum — expect green: fresh fixtures null → picker; stamped → summary), full vitest, tsc, lint; push; `gh pr create` (Closes #26).

---

## Revision: server-side stamping (after PR #28 review)

### Task 5: Booking routes stamp (TDD)

- `tier-selected-at.test.ts` gains class/room fixtures (open class + a full class, `maxStudents: 1` with one registration) and three tests, each on a dedicated student: self registration POST → stamped (red first); teacher roster-add POST for the CRM student → registration exists, not stamped; self waitlist POST on the full class → entry created, stamped (red first). Existing three tests get dedicated students (order-independent).
- `src/app/api/registrations/route.ts`: inside the transaction after `activateRegistration`, when `!rosterStudentId`: `tx.student.updateMany({ where: { id: studentId, tierSelectedAt: null }, data: { tierSelectedAt: new Date() } })`.
- `src/app/api/waitlist/route.ts`: after `addToWaitlist` succeeds: same null-guarded `updateMany` on `session.studentId`.
- Commit.

### Task 6: Client reverts to changed-only persist

- `booking-flow.tsx` handleBook: back to `if (tier !== currentTier)`; comment explains the server owns the first-choice stamp.
- Soften the overstated backfill rationale in `prisma/seed.ts` and the spec ("assumed to have chosen") — the applied migration file stays untouched (editing it would recreate today's checksum drift).
- Commit.

### Task 7: E2e proof + gates + push

- `booking.spec.ts`: seeded-session test — claimed-but-unstamped student books with the default untouched (no radio click); DB: `tierAtBooking === 3`, `tierSelectedAt` stamped; reload → `You're in Tier 3` summary, zero radios.
- Full playwright + vitest + tsc + lint; push to the same PR; update the PR body.
