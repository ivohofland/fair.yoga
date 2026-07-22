# Integration coverage for POST /api/announcements

**Date:** 2026-07-22
**Status:** Approved (issue #25; autonomous run — decisions recorded here)

## Problem

`POST /api/announcements` has zero integration tests. Recipient
selection (non-cancelled registrations, distinct students), the
`receiveComms` mute filter, ownership, and the empty-recipients branch
are all unpinned — and PR #22 shipped the first UI that can set
`receiveComms: false`, so the mute path is now user-reachable.

## Decisions

- Test-only PR: pin the route's *existing* behavior through real HTTP;
  any failure is a found bug, not a spec change.
- One fixture graph, five tests (`tests/integration/announcements-api.test.ts`):
  teacher A (announcer, session) with class 1, class 2, and class 3;
  teacher B with a foreign class. Students: S1 registered in classes
  1+2 (the dedup case), S2 registered in classes 1+3 but muted
  (`StudentPrivacy.receiveComms: false` for teacher A), S3 with only a
  cancelled registration in class 1.
- Tests:
  1. Class-scoped send to class 1 → 201; `recipientCount` 1 (S1 only —
     S2 muted, S3 cancelled); exactly one `announcement`-type
     notification for S1 with `relatedClassId`; none for S2/S3.
  2. All-students send → `recipientCount` 1 (S1 deduplicated across
     classes 1+2; S2 muted; S3 excluded); exactly one new notification
     for S1.
  3. Foreign classId (teacher B's) → 403, no notifications created.
  4. Class 3 (only the muted S2 registered) → 400 "No students to
     notify", no Announcement row created.
  5. Unknown classId → 404.
- Cleanup scoped by created ids; the standard undefined-guard pattern.

## Out of scope

- Any route behavior change; announcement UI; email-fallback
  interaction (covered by the notification-policy suites).
