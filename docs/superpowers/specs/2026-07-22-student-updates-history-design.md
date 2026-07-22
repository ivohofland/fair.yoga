# Updates strip alignment + all-updates history page

**Date:** 2026-07-22
**Status:** Approved (issue #29; autonomous run — decisions recorded here)

## Problem

Two connected gaps. (1) PR #24 copied the teacher inbox row verbatim
onto `/bookings`, full-bleed included — next to the rounded booking
cards the tinted rows overhang the cards' outer edges and the text
lines don't match. (2) Announcements have no durable student-readable
home: once marked read they vanish, despite the docs' layer-2
"persistent record" promise.

## Decisions

- **Route:** top-level `/updates` (Ivo's call, and the right one: the
  student side is flat — `/bookings` and `/account` are siblings, so a
  third sibling beats introducing the side's first nested route; if
  tabs ever arrive the root already exists). `updates` joins
  `RESERVED_SLUGS` so no teacher page slug can claim it, with the
  reserved-slug test extended to pin it.
- **Strip restyle — match the page, not the inbox.** `/bookings`
  already has its own row idiom (Waitlist and Past classes sections:
  column-aligned, untinted, `border-b` separators). The strip adopts
  it: no bleed, no tint. The tint carried no information here — the
  strip is all-unread and the gold dot already marks that. The full
  inbox idiom (tint distinguishing read/unread) lives on the history
  page, where it means something. This deliberately revises #24's
  "verbatim" goal to behavioral parity in context.
- **Entry point:** the strip section renders whenever there is
  anything to show — unread rows with a quiet `All updates` link
  beside the heading; when there are zero unread but history exists,
  the heading + link alone (one calm line); nothing at all for a
  student with no notifications ever.
- **History page** (`/bookings/updates`): all of the student's
  notifications, read and unread, `createdAt desc` + `id` tie-breaker,
  `take: 50` (the inbox's bound). Reuses `NotificationList` — true
  parity by sharing code: tint on unread, stable geometry, Mark-read
  rendered invisible when read, rows stay in place. One addition to
  the component: an optional `hrefById` map (computed server-side)
  because its built-in href targets the teacher class route; the
  student page maps to the public booking page while the class is
  open, like the strip does. Back link "Your bookings",
  `type-title` heading.
- The strip keeps disappear-on-read (unread-only preview); the page is
  the record.

## Testing

- E2e (`student-journey.spec.ts`, riding the existing promotion
  fixtures): the strip shows the `All updates` link; the history page
  lists the update; Mark read there keeps the row in place (restyled);
  back on `/bookings` the strip shows heading + link only (zero unread,
  history exists).
- Full suites, `tsc`, `eslint`.

## Out of scope

- Tab bar (rejected — recorded in issue #29); pagination beyond the
  50-row bound; teacher inbox changes.
