# Plan: template-edit propagation & student-side updates

Status: **planned, not implemented** · Two independent features; either
can ship alone.

---

## Part 1 — Recurring-template edits vs already-generated instances

### Current behavior (verified in code)

`generateClassInstances` copies the template's fields into each new
`Class` row at generation time. Editing a template afterwards changes
*future generations only*: the up-to-four already-generated instances
keep the old time, rates, and sizes. Nothing in the UI says so — a
teacher who moves "Monday 09:00" to "Monday 10:00" sees the change
apparently ignored for the next month.

### Decision: sync safe instances, say so for the rest

Propagating edits is the least-surprise behavior, but only where the
economics are still mutable. The class lifecycle already has the exact
boundary: `settingsLocked` flips on first registration and freezes
economic fields.

**Rule:** on template update, propagate to generated instances that are
`draft` or `open` **and** have `settingsLocked: false` **and** are in
the future. Instances with registrations, started, cancelled, or past
are never touched.

| Template field | Propagates to unlocked future instances? |
|---|---|
| startTime, durationMinutes | yes |
| roomCost, minRate, targetRate, minStudents, maxStudents | yes |
| classType, description | yes |
| dayOfWeek | **no** — a different day is a different class; see below |
| cancelDeadline, autoCancelCheck | yes |

**dayOfWeek changes:** rather than moving existing instances (surprising
— "my Monday class vanished"), delete unlocked future instances and let
the next generation run recreate them on the new day. Same outcome,
simpler invariants (the `@@unique(templateId, date)` constraint keeps
protecting against duplicates).

### Implementation sketch

1. `src/services/class-generator.ts` (or a new
   `src/services/template-sync.ts`):
   `syncTemplateInstances(db, templateId)` — one transaction:
   - `updateMany` on `Class` where `templateId`, `settingsLocked: false`,
     `status in (draft, open)`, `date >= today`, setting the propagable
     fields from the template.
   - If `dayOfWeek` changed: `deleteMany` the same selection instead,
     then call the generator for this template to refill the window.
   - Return `{ synced, skipped }` counts (skipped = locked/started
     future instances).
2. `PUT /api/class-templates/[id]` calls it after the template update
   and returns the counts.
3. UI (`template-form.tsx`, edit mode): after save, show the honest
   result line — "Applied to 3 upcoming classes; 1 class with bookings
   keeps its current settings." When every future instance is locked,
   say "Existing classes keep their settings — changes apply to newly
   generated classes."
4. Tests: unit (sync respects the lock boundary, day-change
   delete+regenerate, idempotency) + one e2e assertion appended to
   `recurring.spec.ts` (edit time → unlocked instances move).

Effort: ~half a day. Risk: low — the lock boundary already exists and
the unique constraint guards regeneration.

---

## Part 2 — Student-side updates on /bookings

### Current behavior

Students receive notifications (waitlist promotion, class cancelled,
payment requests) only as rows in the `Notification` table that feed the
email fallback. There is no student-facing surface: someone who misses
the email never learns their waitlist spot came through. Teachers have
the Inbox tab; students have nothing.

### Decision: a "Recent updates" strip on /bookings, not a student inbox

A full inbox tab would violate the student side's deliberate lightness
(one page, no tab bar). The bookings page is the student's single home —
put the last few unread notifications at the top of it.

**Design (fits the existing system):**

- Section at the top of `/bookings`, only rendered when unread student
  notifications exist: `type-subtitle` "Updates", then up to 5 rows in
  the inbox row idiom (sand-soft card per unread row, gold dot, title +
  body caption, timeAgo).
- Each row: "Mark read" ghost action (same `POST
  /api/notifications/[id]/read` — **verify the route authorizes
  students**; today only teachers use it). Rows with `relatedClassId`
  link to the teacher's booking page for that class
  (`/{slug}/book/{classId}`) when the class is still open, otherwise
  plain text.
- "Mark all read" ghost link when more than 2 rows.
- No SSE on the student side (students are not glued to the app; the
  page is server-rendered fresh per visit). Email fallback remains the
  push channel.

### Implementation sketch

1. `/bookings` page: add a query for
   `notification.findMany({ recipientType: 'student', recipientId,
   isRead: false, take: 5, orderBy: createdAt desc })`.
2. New `src/components/student/updates-strip.tsx` (client) reusing the
   notification-list row recipe; mark-read calls the existing route +
   `router.refresh()`.
3. API check: `POST /api/notifications/[id]/read` must accept the
   student recipient (likely already recipient-scoped — verify + add an
   integration test either way).
4. Optional follow-up (defer): "Mark all read" batch route.
5. Tests: integration for student mark-read authorization; e2e — student
   with an unread `waitlist_promoted` sees it on /bookings, marks it
   read, strip disappears; a11y + visual suites pick the new section up
   automatically on their next baseline update.

Effort: ~half a day. Risk: low — read path and row idiom already exist.

### Explicitly out of scope

- Group chat / replies (product principle: one-to-many only).
- Student SSE/live updates.
- Notification preferences beyond the existing email opt-out.
