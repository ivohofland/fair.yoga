# Updates Strip Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Student Updates strip adopts the teacher inbox's stable row geometry and ordering (issue #20).

**Spec:** `docs/superpowers/specs/2026-07-21-updates-strip-geometry-design.md`

### Task 1: Two-line change

- `src/components/student/updates-strip.tsx:44` row className →
  `flex items-start justify-between gap-2 min-h-14 py-3 -mx-3 px-3 border-b border-border bg-sand-soft`.
- `src/app/(student)/bookings/page.tsx` unread query `orderBy` →
  `[{ createdAt: 'desc' }, { id: 'desc' }]`.

### Task 2: Verify + PR

- Drive `/bookings` as a seeded student with unread rows; screenshot.
- `npx playwright test student-journey.spec.ts` green; full vitest/tsc/lint; push; `gh pr create` (Closes #20).
