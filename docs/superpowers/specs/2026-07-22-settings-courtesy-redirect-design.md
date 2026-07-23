# Settings courtesy redirect

**Date:** 2026-07-22
**Status:** Approved (issue #30; autonomous run)

## Problem

A student-only session that types `/settings` is bounced by the
`(teacher)` layout to `/bookings` — their home, not their settings. The
URLs stay split (per-hat, recorded in #30); they should just be
forgiving.

## Decisions

- Mechanism: the middleware (already running on `/settings/:path*`)
  stamps `x-pathname` onto the request; the `(teacher)` layout's
  student-only branch reads it and redirects `/settings*` → `/account`,
  everything else → `/bookings` as today. No role lookups in Edge, no
  route moves, no dispatcher.
- Teacher-only sessions on `/account` keep landing on `/` (their home)
  — deliberate asymmetry, recorded in the issue.

## Testing

Two e2e pins: `account.spec.ts` — student session, `goto('/settings')`,
lands on `/account` (Settings heading visible); `account-hybrid.spec.ts` —
both wrong-profile targets pinned separately (`/inbox` → `/bookings`
generic rule, `/settings` → `/account` exception). Full suites green.
