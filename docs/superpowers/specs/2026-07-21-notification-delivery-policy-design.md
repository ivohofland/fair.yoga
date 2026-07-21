# Notification delivery policy — essential types and urgency

**Date:** 2026-07-21
**Status:** Approved

## Problem

Two gaps in the email fallback (layer 3 of the communication system),
found while discussing the announcement disclosure:

1. **Urgency.** The fallback emails only notifications unread for 30+
   minutes (sweep every 5 min). An announcement sent an hour before
   class emails at T−25; sent 30 minutes before, the email arrives
   after class starts. Nothing in the system can say "this is urgent."
2. **Transactionality.** `Student.emailNotifications` gates *every*
   email including `class_cancelled` — a student who turned email off
   can show up to a cancelled class. Cancellations, waitlist
   promotions, and payment requests are service messages about the
   student's own booking, not optional comms. (The per-teacher
   `receiveComms` mute already has this right: it only filters
   announcements, at creation time.)

## Decisions (made with Ivo)

- One policy layer covering both axes; no teacher-facing knobs.
- **Essential types** — bypass `emailNotifications` in the fallback:
  `class_cancelled`, `waitlist_promoted`, `spot_available`,
  `payment_request`. Optional (opt-out respected): `announcement`,
  `reminder`, `missed_you`, `booking_confirmed`, `payment_received`.
- **Urgency** — any notification with a `relatedClassId` whose class
  starts within **120 minutes** (in the future, teacher-timezone-aware
  via `classStartInstant`) is email-eligible immediately (next sweep,
  ~0–5 min) instead of after 30 minutes. Applies to all types,
  announcements included — this solves the original use case
  (urgent class-scoped announcement an hour out). Urgency changes
  *when*, never *whether*: consent rules still apply per type.
- The per-teacher mute (`receiveComms`) is untouched — it already
  filters only announcements at creation.

## Design

**New `src/services/notification-policy.ts`** (pure, no I/O):
- `ESSENTIAL_NOTIFICATION_TYPES: ReadonlySet<NotificationType>`
- `isEssential(type): boolean`
- `URGENT_WINDOW_MINUTES = 120`
- `isEmailEligible(input: { createdAt: Date; classStart: Date | null }, now: Date, thresholdMinutes: number): boolean` —
  true when `createdAt` is older than the threshold, OR `classStart`
  is in `(now, now + URGENT_WINDOW_MINUTES]`.

**`getUnreadForEmailFallback` (`src/services/notifications.ts`)** —
query widens to unread+unsent rows that are either past the threshold
or class-linked (`OR: [{ createdAt: { lt: threshold } }, { relatedClassId: { not: null } }]`),
includes `relatedClass` date/startTime + teacher `defaultTimezone`,
computes each class start with `classStartInstant`, and filters through
`isEmailEligible`. Return items keep the full notification shape
(superset object; `renderNotificationEmail` unaffected).

**`processEmailFallback` (`src/services/email-fallback.ts`)** — for
student recipients: `emailEnabled = isEssential(type) || (student.emailNotifications ?? true)`.
Teacher recipients unchanged (no email preference exists).

**Copy (three touches):**
- Student settings (`student-settings-form.tsx`): caption under the
  email checkbox: "Essential messages about your bookings —
  cancellations, waitlist spots, payment requests — are always
  emailed."
- Announcement disclosure (`send-announcement.tsx`), classId variant
  only: "…within 30 minutes — sooner when class is about to start —
  also gets it by email…". The all-students variant stays (those
  announcements have no class, never accelerate).
- `CLAUDE.md` communication layer 3 line gains the essential/urgent
  qualifiers so the project doc stays truthful.

## Testing (test-first)

- Unit (pure): `notification-policy.test.ts` — essential set
  membership; eligibility truth table (old enough / fresh / fresh but
  class in 60 min / class in 3 h / class started 10 min ago / no
  class).
- DB (`email-fallback.test.ts` + `notifications.test.ts`, test DB):
  essential type + `emailNotifications: false` → emailed; optional
  type + `false` → marked handled, not emailed (existing opt-out test
  keeps passing, adjusted to an optional type if it used an essential
  one); fresh class-linked notification with class in 1 h → emailed;
  class in 3 h → left for later; fresh, no class → left.
- Full suite, `tsc`, `eslint` green.

## Out of scope

- Teacher-side email preferences (none exist today).
- Changing `receiveComms` semantics or announcement recipients.
- Digest/batching, reminder scheduling (`reminderPref` is its own
  system), GDPR-erased-recipient filtering (separate follow-up noted in
  PR #13 review).
