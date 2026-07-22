# Student settings index + per-teacher privacy sub-page

**Date:** 2026-07-21
**Status:** Approved (issue #21; autonomous run — decisions recorded here)

## Problem

`/account` is a single long scroll (tier cards, notifications, dual-account
cross-link, sign-in, data & deletion), and the per-teacher privacy controls
promised by the product docs ("students control what each teacher can see,
default is maximum privacy") have model, enforcement, and API — but no UI.
Adding them inline would overload the page. The teacher side already solved
this shape: a settings index of chevron rows.

## Decisions

- **Route:** `/account` stays the index (no redirect churn). Sub-pages:
  `/account/tier`, `/account/notifications`, `/account/privacy`,
  `/account/data`. Sub-pages back-link to Settings; the index keeps its
  "Your bookings" back link.
- **Index rows** (teacher-settings row pattern, ≥56px, chevron):
  Your tier · Notifications · Privacy · Data & deletion. Below the rows:
  the existing teaching-side cross-link (dual accounts only), then the
  Sign-in section (AddPasskey + SignOutButton) — same content as today,
  relocated, nothing dropped.
- **Components:** `StudentSettingsForm` splits into `TierForm`
  (tier cards + quote, saves `incomeTier`) and `NotificationsForm`
  (email checkbox + essential-messages caption + reminder select), each
  saving via the existing `PUT /api/students/[id]`. The combined form is
  deleted.
- **Privacy sub-page:** server component loads the student's
  non-archived `TeacherStudent` links (teacher name) plus existing
  `StudentPrivacy` rows; renders one `TeacherPrivacyCard` (client) per
  teacher: five share checkboxes (`shareFullName`, `shareEmail`,
  `sharePhone`, `shareBirthday`, `shareAddress`), one
  "Receive announcements from this teacher" checkbox (`receiveComms`),
  and a per-teacher Save posting to the existing
  `PUT /api/students/[id]/privacy`. Defaults when no row exists: all
  shares off, announcements on — mirroring the API's virtual default.
  Copy states the model honestly (tightened after review fact-check):
  each teacher sees only the details switched on here; the announcements
  toggle stops that teacher's announcements (in-app and email) while
  essential booking messages still come through; the email switch on the
  Notifications page is global.
- **API fix (alongside):** the privacy GET's virtual default response
  omits `shareFullName` — add `shareFullName: false` so the no-row shape
  matches real rows.
- **No new APIs.** The privacy page reads via the server component
  (Prisma directly, house pattern), writes via the existing route.

## Testing

- Integration (TDD): new `tests/integration/privacy-api.test.ts` with a
  student session — virtual default includes `shareFullName: false`
  (red first, fixed by the API change); first PUT persists including
  `shareFullName`; a second PUT revoking a share round-trips through the
  update arm and the existing-row GET; missing `teacherId` → 400;
  another student's id → 403.
- E2e: `account.spec.ts`'s two GDPR tests navigate to `/account/data`
  instead of `/account` (CI runs Playwright — this keeps it green).
- Drive verification: index rows render; tier/notifications sub-pages
  save; privacy page lists seeded teachers (Anna sees Ivo and Sarah) and
  a toggled share persists and is visible on the teacher's student list.
- Full suite, `tsc`, `eslint` green.

## Out of scope

- Per-teacher email granularity (doesn't exist in the model).
- Reworking DataAndDeletion/AddPasskey internals — relocated only.
- Issues #19 and #20 (separate PRs; #19 will link to `/account`).
