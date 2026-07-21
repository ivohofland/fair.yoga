# "Who receives this?" disclosure in the announcement composer

**Date:** 2026-07-21
**Status:** Approved

## Problem

The announcement composer doesn't say who actually receives a message.
The Students-page variant is labeled "all your students", but the
backend sends to students with a non-cancelled registration in the
teacher's classes — CRM contacts who never booked get nothing. And the
three-layer delivery (inbox first, email fallback after 30 unread
minutes, opt-outs honored) is invisible. Teachers can't reason about
reach, and the label overpromises.

## Decisions (made with Ivo)

- **Affordance:** a tap-to-expand disclosure — small teal text button
  "Who receives this?" under the textarea — not an always-visible
  caption, not an ⓘ icon/popover (words-first design rule; hover
  tooltips don't work on touch).
- **Static copy only.** No live recipient count, no new API surface.
  The post-send confirmation already reports the exact count.
- **Honest label:** Students-page `recipientHint` changes from
  "all your students" to "your booked students". Class-detail's
  "everyone in this class" stays.
- **No behavior change.** Recipients, opt-outs, and the email sweep are
  untouched.

## Design

All in `src/components/class/send-announcement.tsx`; both call sites
inherit it. One new `useState` for the disclosure; the copy branches on
the existing `classId` prop — no new props.

- Trigger: `<button type="button">` with `aria-expanded`, classes
  `type-caption text-teal`, text `Who receives this?`, placed between
  the textarea and the Send/Close row.
- Expanded: a `type-caption` paragraph, instant show/hide (no motion).
  Copy revised after review fact-check (the per-teacher mute suppresses
  inbox delivery too; students have an Updates strip, not an inbox;
  late cancellations remain recipients):
  - Without `classId`: "Students with a booking in any of your
    classes, unless they've muted your messages — contacts who've
    never booked (or only cancelled) aren't included. They'll see it
    in the app on their next visit; anyone who hasn't read it within
    30 minutes also gets it by email, unless they've turned email
    off."
  - With `classId`: "Everyone registered for this class (late
    cancellations included), unless they've muted your messages.
    They'll see it in the app on their next visit; anyone who hasn't
    read it within 30 minutes also gets it by email, unless they've
    turned email off."
- `src/app/(teacher)/students/page.tsx`: `recipientHint="your booked
  students"`.

## Testing

No component-test infra exists and no API changes: verification is a
Playwright drive (per the convention validated in the PR #12 review) —
open the composer on the Students page and a class detail page, toggle
the disclosure, assert both copy variants render and `aria-expanded`
flips. `tsc`, `eslint`, and the full vitest suite must stay green.

## Out of scope

- Changing who receives announcements (e.g., full-CRM sends).
- Live recipient counts or any new API endpoint.
- Explaining reminder/booking notification emails — this covers the
  announcement composer only.
