# Booked State On Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Spec:** `docs/superpowers/specs/2026-07-22-booked-state-on-cards-design.md`

### Task 1
- `src/app/(public)/[slug]/page.tsx`: `getSession()`; when `session?.studentId`, fetch `bookedClassIds` (`status: 'registered'`) and `waitingClassIds` (`status: 'waiting'`) across the page's class ids; card renders `✓ Booked` / `On the waitlist` (`type-label text-teal mt-2`) instead of `<PriceRange>` for those classes.
- Rider: `booking-flow.tsx` link `href="/account"` → `"/account/tier"`.

### Task 2
- E2e per spec; full gates; push; `gh pr create` (Closes #31).
