# Late-move notice on the class edit form (#847)

## Problem

#840's `LatePublishNotice` warns on a draft's page when publishing now would
land inside the class's cancellation deadline. Moving an unbooked open class on
`/class/[id]/edit` reaches the same state and warns nothing: after the move,
students who book can't cancel free, and once the new check instant has passed
`redecideAfterMove` (`src/services/auto-cancel-decision.ts`) stamps
`autoCancelDecidedAt`, so the class goes ahead however few book.

## Premise check (measured against `origin/main` at `ca9285a8`)

- **Held:** `redecideAfterMove` stamps the marker when the moved class's check
  has passed (`auto-cancel-decision.ts:54–55`), and only for an `open`,
  unlocked, uncancelled class (`:52`).
- **Held:** a booked class cannot move — the edit form disables date and start
  time under `settingsLocked`, and `updateClass` answers `SETTINGS_LOCKED`.
- **Held:** both instants were server-only before this change.
  `cancelDeadlineInstant` lives in `src/services/waitlist.ts` and
  `cancelCheckInstant` in `src/lib/auto-cancel-check.ts`; both call
  `classStartInstant` (`src/lib/timezone.ts`), which imports `@/lib/log`
  (`server-only`) and `@/lib/degradation`.
- **Wider than stated:** the issue names `cancelDeadlineInstant` and
  `classStartInstant`; `cancelCheckInstant` is a third, also
  server-only before this change, that the form needs.
- **The template path is wider than "created on the day":** the generator
  inserts a class already inside its window whenever a template is saved
  within the cancel deadline (up to 48 h, `DEADLINE_HOURS.HOURS_48`) of its first
  candidate, and stamps `autoCancelDecidedAt` itself when inside the check
  window (`class-generator.ts:80`).

## Design

### One implementation, split at the logging seam

The arithmetic moves to client-safe modules; the server functions keep their
names and signatures and become wrappers that add the degradation logging.

- **`src/lib/class-start.ts` (new, client-safe):** `readClassStart(entry,
  timeZone)` returns a discriminated reading — the instant, plus which fault
  (`date`, `start-time`, `timezone`) produced a substitute instant, if any.
  `timeZoneOffsetMs` moves here with it. `classStartInstant` in
  `timezone.ts` calls it and maps each fault to the `logDegraded` call it
  makes today — same codes, same `site`, same messages — so every existing
  `timezone.test.ts` pin holds unchanged.
- **`src/lib/cancel-deadline.ts` (already client-safe):** gains
  `DEADLINE_HOURS` (moved from `waitlist.ts`) and
  `cancelDeadlineFrom(start, cancelDeadline)`. `cancelDeadlineInstant` becomes
  `cancelDeadlineFrom(classStartInstant(...), ...)`.
- **`src/lib/cancel-check.ts` (new, client-safe):** `CANCEL_CHECK_HOURS`,
  `DEFAULT_CANCEL_CHECK_HOURS`, `MAX_CANCEL_CHECK_HOURS` and
  `cancelCheckFrom(start, autoCancelCheck)`. `cancelCheckInstant` becomes
  `cancelCheckFrom(classStartInstant(...), ...)`.
- **`src/lib/late-publish.ts`:** `latePublishInstants({ start, cancelDeadline,
  autoCancelCheck })` → `{ start, deadline, checkAt }`. The overview page and
  the edit form both call it — that is the acceptance criterion's "one
  implementation shared with the overview page". The overview passes the
  logging `classStartInstant`; the form passes `readClassStart(...).instant`.

Constants move rather than being re-exported: importers are updated, so there is
one import path per name.

On the client a fault is silent: any fault `readClassStart` names (a half-typed
date or time, or a timezone that cannot be read) reads as no notice. The form
branches on `fault` explicitly rather than relying on an Invalid Date comparing
as `none`, so a timezone fault, whose instant is the wall clock read as UTC,
never reaches the clock. The timezone comes from the server, whose own reads of
it log the fallback.

### The form

- The edit page passes `moveWarning: { timeZone, cancelDeadline, autoCancelCheck }`
  only for an `open`, unlocked class, and `null` otherwise. A draft's notice
  stays on its overview page (#840): moving a draft has no consequence until it
  is published. A locked class cannot move.
- The notice shows only when the entered date or start time differs from the
  stored one, because this is a warning about the move. An open class already
  inside its window, edited for its description, is not being moved into anything.
- `now` is component state, reset on every field change and re-armed by one
  timer. It arms for the next refresh instant (`latePublishRefreshInstants`) at
  or after `now` and wakes 1 ms past it. A delay beyond `MAX_TIMEOUT_MS`
  (`src/lib/timer-bounds.ts`) is skipped, not clamped, and the effect re-arms on
  `now`. The notice therefore follows
  the fields and the clock. The first render never shows it (nothing has moved
  yet), so no hydration mismatch is possible.
- The notice sits directly above the "Save changes" row.

### Copy

`LatePublishNotice` takes a required `action: 'publish' | 'move'`. The
`publish` copy is unchanged byte for byte. `move`:

- `past_deadline`: "The new start is inside this class's cancellation deadline.
  Students who book after you save can't cancel for free."
- `past_check`: "The new start is inside this class's cancellation deadline
  and past its auto-cancel check. Students who book after you save can't cancel
  for free, and the class goes ahead however few book. If {shortfall}, you
  cover what {missing} would have paid." (same singular/plural rule as publish)

## Template path: decided (c), filed separately

Decision (by the issue author, 2026-10-12): **(c)**, skip generating a candidate
that is already inside its cancellation deadline. It changes the generator's
rules, so it gets its own issue and spec: #849. This branch does not touch the
generator.

## Not done

- No server-side refusal or confirmation: the move stays allowed, as publishing
  late does.
- No notice on the overview page of an open class after its move.
