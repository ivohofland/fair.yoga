# Updates strip matches the teacher inbox's stable row geometry

**Date:** 2026-07-21
**Status:** Approved (issue #20; autonomous run — decisions recorded here)
**Superseded (2026-07-22):** the verbatim-tint row idiom below was
revised by `2026-07-22-student-updates-history-design.md` (issue #29) —
strip rows are now untinted, matching their page; the tinted idiom
lives on `/updates`.

## Problem

Commit `008acbc` gave the teacher inbox stable row geometry: flat rows on
constant `border-b` separators, unread marked by tint only, and
`createdAt` + `id` tie-breaker ordering so batch-inserted rows stop
shuffling. The student Updates strip on `/bookings` still uses the old
idiom that commit removed — floating rounded cards
(`bg-sand-soft -mx-3 px-3 my-1 rounded-field`) — and its query orders by
`createdAt` alone (announcements are batch-created: the exact shuffling
case).

## Decisions

- **Row shape:** `flex items-start justify-between gap-2 min-h-14 py-3
  -mx-3 px-3 border-b border-border bg-sand-soft` — the inbox's unread
  row verbatim. The strip is unread-only, so every row carries the tint.
- **Ordering:** `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` on
  the `/bookings` unread query — the inbox's exact convention.
- **Mark-read keeps removing the row** (`router.refresh()`). The strip
  is deliberately unread-only ("not a tab"); rows exist only while
  unread, so read-state geometry parity doesn't apply. This resolves the
  issue's open question in favor of current behavior.
- Content anatomy (title link + arrow, body caption, timeAgo, Mark read,
  gold dot) unchanged.

## Testing

- Drive: `/bookings` as a student with unread notifications — flat
  tinted rows with separators, no rounded floating cards; screenshot
  compared against the inbox idiom.
- `student-journey.spec.ts` (asserts strip content) stays green; full
  suites, `tsc`, `eslint` green.

## Out of scope

- Any change to which notifications the strip shows (unread-only, cap 5)
  or to mark-read semantics.
