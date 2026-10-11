# Push card on the student's home (#818)

## Problem

A student can turn on push only from Settings → Notifications
(`src/components/student/notifications-form.tsx`, which embeds
`PushDeviceControl`). Nothing points them there once they are in the installed
app, and a waitlist promotion is the message that most needs to arrive in time.
#817 gave the teacher a one-time card on the schedule; this is the student's.

## What the issue got right, and what it did not

Measured against `main` at `021aeea6`.

**Held:**

- **No student dismissal store exists.** `skippedOnboarding` is a `Teacher`
  column and `POST /api/account/onboarding` is `requireTeacher`.
- **The student's home is `/bookings`.** `src/app/(public)/start/page.tsx`
  (the manifest's `start_url`) sends a session with only a student side to
  `/bookings`; a two-hat session goes to `/schedule` first.
- **`PushDeviceControl`'s `needs-install` state already points students at
  `/account`** (`installHref="/account"` in the notifications form), so this
  card adds no install nudge.
- **The shared hook exists.** `usePushDevice` (`src/components/settings/use-push-device.ts`)
  takes `{ resync }`, so the card can classify without re-POSTing a live
  subscription on every home visit — #817's correction 2 applies here unchanged.

**Did not hold:**

1. **The issue's gate, "`classifyPushDevice` resolves to `off`", is too wide.**
   It inherits #817's first correction: `off` includes a phone where push was
   switched off in Settings (permission stays `granted`). The card shows only
   for `off` **and** `Notification.permission === 'default'`, as the teacher's does.
2. **"e2e dismiss" cannot run.** Playwright's browser never runs in standalone
   display mode, so the device resolves `needs-install` — with or without a
   VAPID key, and none is set in CI or `.env.example` — and the card never
   renders. #817's correction 4 reached the same conclusion. Covered by component and integration tests
   instead.
3. **"Reuse the card component from #817" is not possible as it stands.**
   `PushCard` hard-codes the teacher's copy, the `/settings/notifications` link
   and `OnboardingSkipButton`, whose route is teacher-only. Its rendering and
   enable logic move into a shared component; only the copy and the dismiss
   control differ per side.

## Decisions

- **Store:** `Student.dismissedPushCard Boolean @default(false)`. Students have
  no other onboarding steps, so an enum array would be a list of one; a
  boolean matches the row's other preference columns. **The name must not
  start with `push`:** `StudentPushColumn` (`src/lib/push-policy.ts`) is
  `Extract<keyof Student, \`push${string}\`>`, so a `push…` column would join
  the push preferences and break every tether built on them (the group map,
  GDPR erasure and export, the notifications form).
- **GDPR:** the flag is neither exported nor reset on erasure. It records a UI
  answer, not something about the person, and an erased row has no session to
  read it.
- **Two-hat accounts:** `/start` sends them to `/schedule`, so they meet the
  teacher card first; the student card appears if they open `/bookings`. Turning
  push on from either card makes the device `on`, which retires both.
- **Route:** `POST /api/account/student-push-card`, `requireStudent`, no body.
  A second post answers `respondUnchanged` (the "already done answers 200"
  rule). The write is scoped to `deletedAt: null`, as the student self-update
  route's is. A separate route rather than a role-aware onboarding one: a
  two-hat session carries both ids, and a role-aware route would need the
  client to name the hat — two routes make the independence structural.
- **Gate:** identical to the teacher card — not dismissed, coarse pointer,
  `state === 'off'`, `permission === 'default'`, non-null key.
- **Placement:** `/bookings`, between the heading row and `UpdatesStrip`.

## Design

### `PushOfferCard` (new, `src/components/push/push-offer-card.tsx`)

`PushCard`'s body moved verbatim, with props
`{ dismissed; vapidPublicKey; description: ReactNode; dismissControl: ReactNode }`.
Heading, Turn on button, busy/failed handling and the retry line stay shared.

`PushCard` (teacher) becomes a wrapper passing its existing copy and
`OnboardingSkipButton step="push"`. **`push-card.test.tsx` passes unchanged** —
that is what proves the extraction preserves behaviour.

### `StudentPushCard` (new, `src/components/student/push-card.tsx`)

Wraps `PushOfferCard` with:

- **Copy:** *A heads-up when a waitlist spot opens for you or a class you booked
  is cancelled. Booking emails still come as they do now — you choose which messages
  in Settings.* — "Settings" links to `/account/notifications`. The two named
  groups are the student push groups that are on by default — waitlist
  promotions and spots, and class cancellations (`STUDENT_PUSH_GROUP`), so the
  copy names a cancellation rather than any change (`pushWaitlist`,
  `pushClassChanges`).
- **Dismiss:** a quiet button that POSTs to `/api/account/student-push-card`
  and `router.refresh()`es on success; on failure it re-enables and logs, as
  `OnboardingSkipButton` does.

### Docs

`docs/information-architecture.md` gets a **Student push card** paragraph after
the Push card one; `docs/data-model.md`'s Student (core) table gets the column.

## Tests

- **Component** (`src/components/student/push-card.test.tsx`): renders only
  for `off` + `default` + coarse + not dismissed across every `PushDeviceState`;
  the Settings link targets `/account/notifications`; Turn on → `on`/`blocked`
  hide, `failed` shows the retry line; Dismiss POSTs the student route and
  refreshes; a refused dismiss leaves the button enabled.
- **Integration**: the route stores the flag, answers `unchanged` on a second
  post, refuses a teacher-only session with 403, and — for one account with
  both hats — leaves `Teacher.skippedOnboarding` untouched, while a teacher
  `push` skip leaves `dismissedPushCard` false.
- Each guard is broken once and its failure recorded (plan).

## Not in scope

The install nudge for students; any change to the teacher card's behaviour.
