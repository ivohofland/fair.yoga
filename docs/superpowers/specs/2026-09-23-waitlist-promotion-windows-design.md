# Waitlist promotion windows hang off class start — design (#236)

## Problem

A seat freed after the cancel deadline is never offered to the waitlist.
`getWaitlistWindow` returns `'frozen'` from the cancel deadline onward, and a
late cancel is by definition after that deadline, so `handleSpotFreed` returns
`{ action: 'frozen' }` before reading the queue. The students queuing for the
seat are not told it exists.

## What the issue got right, and what it did not

Measured on `origin/main` at `1d12833c`.

**Held.** The late-cancel branch of `DELETE /api/registrations/[id]` still
calls `promoteAfterCancel` → `handleSpotFreed`, which still returns on
`'frozen'` before doing any work.

**Wrong: the queue is not shut out of the seat, only uninformed.** Nothing
closes new bookings at the deadline. `POST /api/registrations` checks only
`status === 'open'` and `isFull`, the public booking page offers **Book**
whenever the active count is below `maxStudents`, and a waitlisted student
who books there has their entry marked `claimed`. The defect is silence, not
exclusion.

**Wrong: the fix direction.** The issue keeps the cancel deadline as the
waitlist's anchor and stretches the claim window from `deadline − 1h` to
start. The intended model — and the one `docs/data-model.md` (Waitlist,
"Hybrid waitlist promotion") already describes — anchors the waitlist on
**class start**: auto-promote until one hour before start, first-come-first-
claimed in the final hour. The code diverged from the doc, not the other way
round.

**Wrong: "class start needs no new guard".** `claimSpot` refuses only on
`status !== 'open'`, and the `open → in_progress` flip runs on a per-minute
scheduler tick, so a claim can land after start. The window itself must end at
start.

**Missed: money.** `late_cancel` is in `CHARGED_STATUSES`
(`class-lifecycle.ts`), so a late canceller keeps paying when someone else takes
the seat. The newcomer is one more charged student in a class whose teacher
rate is already capped at target, so every share — the late canceller's
included — falls and the teacher's revenue does not move. This is already what
happens when a stranger books the seat; this design only changes who hears
about it. Kept as is (decision 1).

**Missed: auto-promotion after the deadline bills without a free exit.** Under
the start-anchored model a student can be auto-promoted after the cancel
deadline, and would owe their share from the instant of promotion. Decisions 3
and 4 answer that.

**Already done.** The issue's last acceptance item — trimming
`handleSpotFreed`'s "at least 6 h before the start" timing argument — landed
before this spec; the comment now argues structurally and names #236.

## Decisions (agreed in brainstorming, 2026-09-23)

1. **A late canceller still pays when their seat is taken.** No billing change.
2. **The waitlist's windows are anchored on class start, not on the cancel
   deadline.** Joining a waitlist is a conscious decision to take a seat.
3. **An auto-promoted student may cancel for free until the later of the cancel
   deadline and their promotion + 15 minutes.** Fixed constant, not a teacher
   setting. It applies to auto-promotion only; a claim is the student's own act
   at that instant and gets no grace.
4. **Every `waitlist_promoted` notification is email-eligible immediately**,
   so the grace is not spent before the student can know about it (the
   unread-30-min fallback would otherwise land after it expired).
5. **Students who lose a claim race are told** — a notification when the
   broadcast seat is taken.
6. The waitlist's window type keeps three members; "past the cancel deadline"
   stays owned by `isPastCancelDeadline`, not duplicated into the window.

## Design

### Windows

Example: class starts 18:00, cancel deadline 12 h (06:00).

| When | Seat frees → | Free cancellation for the new holder |
|---|---|---|
| before start − 1h (until 17:00) | queue head **auto-promoted** (`promoteNext`), emailed at once | until `max(deadline, promotedAt + 15 min)` |
| start − 1h ≤ now < start (17:00–18:00) | **every waiting student told** (`spot_available`); first to claim (`claimSpot`) gets it | none — the claim confirmation says so |
| now ≥ start | `frozen` — nothing | — |

`getWaitlistWindow` takes the class start instant (via `classStartInstant`) and
no longer takes `cancelDeadline`:

- `now >= start` → `'frozen'`
- `now >= start − 1h` → `'first_come_first_claimed'`
- otherwise → `'auto_promote'`

The window ends at start itself, so the scheduler's `in_progress` lag cannot
admit a late claim or promotion.

**Every claim is past the cancel deadline.** The shortest `DEADLINE_HOURS`
value (6) exceeds the one-hour claim window, so the claim warning is
unconditional. A test pins `min(DEADLINE_HOURS) > 1`, so a shorter deadline
added later fails loudly instead of making the warning false.

### Guards

- `promoteNext` refuses unless the window is `'auto_promote'` (today it refuses
  only `'frozen'`, which would admit a promotion in the claim hour if a caller
  ever reached it with the wrong window).
- `claimSpot` refuses unless the window is `'first_come_first_claimed'`; its
  two refusal messages are reworded to name class start, not the deadline.
  Error codes unchanged.

### The free-cancel grace

A single pure predicate, beside `isPastCancelDeadline` in
`src/lib/cancel-deadline.ts` (import-free so the client can use it):
`freeCancelUntil(deadline, promotedAt | null) = promotedAt === null ? deadline : max(deadline, promotedAt + 15 min)`.
The 15 minutes is a named constant there.

**Auto-promoted vs claimed is recorded, not inferred.** `claimSpot` writes
`WaitlistEntry.status = 'claimed'` instead of `'promoted'`, matching the direct
booking path, which already writes `'claimed'`. `promoted` then means "the
system placed you", `claimed` means "you took it". Both are already in
`FULFILLED_WAITLIST_STATUSES`, so capacity and retention readers are
unaffected; the plan sweeps every reader of the two literals to confirm. The
grace reads the entry linked by `registrationId` with `status = 'promoted'`.

Three consumers, all through the one predicate:

1. `DELETE /api/registrations/[id]` — decides `late_cancel` vs `cancelled`
   against `freeCancelUntil` instead of the bare deadline.
2. `/bookings` → `CancelBookingButton` — receives the `freeCancelUntil` instant
   instead of `cancelDeadlineAt`, so its #664 held-copy logic keeps working
   unchanged against the new instant.
3. `promoteNext`'s `waitlist_promoted` body names the free-cancel time:
   "You can cancel for free until {time}."

Known edge, accepted: a student who grace-cancels and rebooks the same seat
directly within those 15 minutes can cancel it free again. The linked entry
still reads `promoted`. The seat was free and unclaimed; nobody is worse off.

### Notifications

- `waitlist_promoted`: email-eligible immediately (`notification-policy.ts`
  gains an always-urgent type rule beside the class-within-2h one). Still
  skipped if read in-app before the 5-minute fallback sweep runs.
- `spot_available`: already essential and already urgent inside the claim hour
  (class within 2 h), so it emails within a sweep. Body reworded: claiming in
  the app is what secures the seat.
- **New `spot_taken` type** (Prisma enum migration): sent to every student still
  `waiting` when a class holding a standing broadcast (`spotBroadcastAt` set)
  becomes full again, in the same transaction. Hooked where the broadcast flag is
  cleared — `activateRegistration` — so it covers a claim, a direct booking and
  a teacher walk-in alike. Essential, and retained like `spot_available`.
- Joining a waitlist (`booking-flow.tsx`) states the commitment: "If a spot
  opens up until 1 hour before class, you're booked automatically. The usual
  cancellation deadline applies, with at least 15 minutes to change your mind."

### Reconciliation

`waitlist-reconciliation.ts` follows the window: it now auto-promotes up to
start − 1h and broadcasts in the final hour. `broadcastStillStands` compares
`spotBroadcastAt` with the claim window's start, which becomes start − 1h. Its
comments assuming a 60-minute window ending at the deadline are rewritten
(also `scheduler.ts`).

## Not in scope

- Waiving the late canceller's charge when their seat is taken (decision 1).
- A booking cutoff for the public page after the deadline.
- Backfill or deploy-time backlog: not in production.

## Acceptance

- A seat freed before start − 1h auto-promotes the queue head, whatever the
  cancel deadline; a seat freed in the final hour is broadcast to every waiting
  student; nothing happens from start on.
- `promoteNext` cannot promote outside `auto_promote`; `claimSpot` cannot claim
  outside `first_come_first_claimed`. Each guard mutation-tested.
- An auto-promoted student cancels free until `max(deadline, promotedAt + 15 min)`
  and pays after it — boundary pinned on both sides; a claimant gets no grace.
- The server's charge decision and `/bookings`' copy read the same instant.
- A promotion is emailed without the 30-minute wait.
- Losers of a claim race receive `spot_taken`.
- CLAUDE.md (Waitlist), `docs/product-concept.md`, `docs/data-model.md`,
  `docs/technical-architecture.md`, `docs/implementation-plan.md` and the
  waitlist docblocks describe the start-anchored rule; the plan derives the
  full site list by grep for "deadline" in waitlist-related prose, not from this
  spec.
