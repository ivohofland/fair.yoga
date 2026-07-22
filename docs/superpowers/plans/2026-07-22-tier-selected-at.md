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
