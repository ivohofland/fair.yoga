# Attendance Spread Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Spec:** `docs/superpowers/specs/2026-07-22-attendance-spread-pricing-design.md`

### Task 1: The slice (TDD)
- Unit tests first in the tier-estimates suite: exact spread 4.50–17.50 for the canonical empty class (viewer tier 3); registered-tiers case; full-class collapse to a point; low ≤ high.
- `estimateAttendanceSpread({ ...TierEstimateInput, viewerTier })` → `{ low, high }` per the spec's floor/ceiling.

### Task 2: Surfaces
- `price-range.tsx`: add `PersonalPriceRange({ spread })` — same typography, "depending on how many join".
- Booking page: `student && student.tierSelectedAt` → `PersonalPriceRange` with `viewerTier: student.incomeTier`; else `PriceRange`.
- `booking-flow.tsx` footnote: the highest-tier sentence gated on `isFirstBooking` (inline `&&` in the shared footnote).

### Task 3: E2e + gates + PR
- Returning test: assert the new line, assert the tier-spread price line absent on that page. Full gates; push; `gh pr create` (Closes #33; note the #37 merge-order).
