# Student Updates History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip rows align with their page; a top-level `/updates` page becomes the student's persistent record (issue #29).

**Spec:** `docs/superpowers/specs/2026-07-22-student-updates-history-design.md`

### Task 1: Strip restyle + entry point

- `updates-strip.tsx`: rows adopt the page's own idiom — `flex items-start justify-between gap-2 min-h-14 py-3 border-b border-border last:border-b-0` (no bleed, no tint; gold dot stays). Heading becomes a flex row: `h2` + `All updates` link (`type-label text-teal`, href `/updates`). New prop `hasHistory: boolean`; section renders when `updates.length > 0 || hasHistory`; rows only when unread exist.
- `bookings/page.tsx`: add `prisma.notification.count({ where: { recipientType: 'student', recipientId } })` to the parallel fetch; pass `hasHistory={count > 0}`.

### Task 2: `/updates` page + RESERVED_SLUGS

- `src/lib/schemas.ts`: add `'updates'` to `RESERVED_SLUGS`; extend the reserved-slug test in `schemas.test.ts` with one assertion.
- `notification-list.tsx`: optional `hrefById?: Record<string, string | null>` prop — when provided it overrides `notificationHref` per row (student pages must not link to teacher routes).
- New `src/app/(student)/updates/page.tsx`: session guard (student layout pattern), fetch `take: 50`, `orderBy [{createdAt:'desc'},{id:'desc'}]`, include `relatedClass { id, status, teacher { pageSlug } }`; build `hrefById` (public booking page while `status === 'open'`, else null); back link `← Your bookings`, `type-title` h1 `All updates`, `<NotificationList notifications hrefById>`.

### Task 3: E2e + gates + PR

- `student-journey.spec.ts`, extending the promotion-update test: assert the `All updates` link; navigate; the update row is visible; Mark read keeps the row (assert still visible after); return to `/bookings` — heading + link render, the update text does not (zero unread, history exists).
- Full playwright + vitest (exit-code gated) + tsc + lint; push; `gh pr create` (Closes #29).
