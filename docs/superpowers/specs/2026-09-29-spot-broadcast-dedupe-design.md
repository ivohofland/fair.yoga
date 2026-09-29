# Spot broadcast dedupe under the class row lock (#691)

## 1. The premise, as measured

The issue holds. Read against `origin/main` at `861e7c09`:

- `reconcileOne` (`src/services/waitlist-reconciliation.ts`) gates the broadcast
  on `broadcastStillStands(cls)`, where `cls` came from the sweep's **unlocked**
  candidate query.
- `handleSpotFreed`'s `first_come_first_claimed` branch (`src/services/waitlist.ts`)
  takes `lockClassRow`, re-counts seats through `readSeatCount`, and broadcasts
  whenever a seat is free. It never reads `spotBroadcastAt`.
- A broadcast leaves the seat free. So when two callers reach the lock for one
  freed seat, both find it free and both write a `spot_available` set.

**Both orderings double up, and #220 recorded only one of them.**
`2026-08-13-waitlist-reconciliation-design.md` §4.3 ("The one race it does not
close") accepted *sweep reads the gate → hook broadcasts → sweep invokes* as
"one duplicate notification, against a current cost of no notification at all".
The reverse also happens: the sweep invokes first and broadcasts, then the
route hook arrives. The hook has no gate at all, so it doubles the sweep's
broadcast. Nothing in #220 names that direction.

The trade #220 weighed has changed since. Back then the gate was a notification
query. Since #236 it is a column on the row the lock already holds, so checking
it under the lock costs one indexed read inside a transaction that is already
open.

## 2. Decision: suppress under the lock for every caller (option A)

Under `lockClassRow`, the broadcast branch declines to broadcast when a
broadcast already stands for the current claim window. It uses the same
predicate the sweep uses: `spotBroadcastAt !== null && spotBroadcastAt >=
claimWindowStart(entry, tz)`.

**Why not B** (re-check only on the sweep's invocation): that closes
hook-then-sweep, where the sweep is second and would see the flag. It leaves
sweep-then-hook open, because the hook is second and never checks. That is half
the bug.

**What A changes, and why nobody loses a notification.** Today a route cancel
that frees a *second* seat while the first broadcast is still unclaimed sends
every waiter a second "A spot opened up". Under A it sends nothing. That is only
safe if everyone waiting at the second cancel already received the standing
broadcast. The chain that guarantees it:

1. `addToWaitlist` refuses when a seat is free (`class_not_full`, under the
   class row lock). A queue only grows while the class is full.
2. `spotBroadcastAt` is cleared only by `activateRegistration`, and only on the
   fill that makes the class full (#236).
3. Every fill goes through `activateRegistration`. That covers booking, walk-in
   (`POST /api/registrations` passes `isWalkIn` into it), `promoteNext` and
   `claimSpot`. Re-derive with
   `grep -rnE "activateRegistration|registration\.(create|upsert|update|updateMany)\(" src --include='*.ts' | grep -v '\.test\.'`.
   The remaining writers each have a verdict:
   - the `updateMany` calls in `api/registrations/[id]/route.ts` only move rows
     out of the counted set, except attendance `late_cancel → attended`, which
     is refused while the class is `open` (the argument in `handleSpotFreed`'s
     own comment);
   - `class-lifecycle.ts` writes `price`/`tierRatio` at completion;
   - `gdpr.ts` cancels rows.
4. Capacity cannot shrink under a queue. `maxStudents` is in `ECONOMIC_FIELDS`,
   which lock at first registration, and a queue implies a full class, which
   implies registrations.

So while the flag stands, the class has not been full since the broadcast, no
one has joined the queue since, and every current waiter was told. A second
broadcast would tell them nothing new. It is the duplicate this issue is
removing, sent by the same hook.

The sweep already behaves this way. A makes the hook follow the same rule.

## 3. Design

**The predicate moves to `waitlist.ts`.** `broadcastStillStands` moves from
`waitlist-reconciliation.ts` to `waitlist.ts`, beside `claimWindowStart`, and
becomes exported. Its input is structural: `{ spotBroadcastAt, calendarEntry:
{ date, startTime } }` plus the teacher's timezone. That way the sweep's
`CandidateClass` and the locked re-read both satisfy it. The sweep keeps calling
it on its pre-read, still only to decide whether to ask.

**The locked re-read.** Inside the broadcast transaction, after `lockClassRow`,
re-read `spotBroadcastAt` together with the entry's `date`/`startTime` and the
teacher's timezone. Do not reuse the pre-lock `cls`. The reason is not that the
flag goes stale (the lock is exactly what makes it fresh). It is that
`updateClass` moves an entry's schedule only while holding this same `Class`
lock (`docs/lock-order.md`: `Class` then entry). So only a read taken after the
lock can see a reschedule that committed while this call waited. The
claim-window bound exists precisely for rescheduled classes (see the predicate's
docblock).

**Order inside the transaction:** seat count first, as today (`suppressed` when
full). Then the standing check, returning a new internal outcome
`{ kind: 'already_broadcast' }`. Full with the flag standing cannot happen,
because the fill to full clears the flag. So the order only decides which
outcome a log line names.

**Result and logging.** `already_broadcast` maps to `{ action: 'none' }`.
`SpotFreedResult` is unchanged, and the sweep's `repaired` stays false for it,
which is correct: nothing was repaired. It gets its own `log.debug` line, for
the reason the `suppressed` branch gives for its own: neither live caller reads
the return value, so without a line a firing guard looks the same as an
unreached one.

## 4. Tests

- **Deterministic pin (the mutation target).** On a claim-window class with a
  waiting queue and two free seats, call `handleSpotFreed` twice in sequence,
  like two route cancels. Assert exactly one `spot_available` per waiter.
  Today's code writes two per waiter. That is RED before the fix, with no race
  to stage.
- **Sweep-then-hook, deterministic.** Run `reconcileWaitlists` (it broadcasts
  and sets the flag), then `handleSpotFreed` directly. Assert one per waiter.
  This is the direction #220 missed, and it needs no harness.
- **The interleaving the issue asks for, in both orders.** The second caller's
  pre-lock reads have to see `spotBroadcastAt: null`, and its lock has to be
  granted after the first caller commits. Pause the first caller inside
  `lockClassRow` right after it holds the row, with a spy on the module
  namespace (the `complete/route-lock-order.test.ts` pattern). Start the second
  caller and confirm it parked from `pg_stat_activity`/`pg_blocking_pids`, not
  by sleeping. Then release and assert one per waiter. Pausing the lock HOLDER
  rather than holding the row from a third connection keeps the first caller
  off `lockClassRow`'s 2s `lock_timeout` clock entirely. Run it with the hook
  first and with the sweep first: only the sweep-first run tests the hook's
  own locked re-read.
- **Reschedule bound.** A flag stamped before the current claim window starts
  does not suppress. This pins the `>= claimWindowStart` half under the lock,
  like the sweep's own reschedule test.
- **Mutations**, each run, with the failing assertion recorded:
  1. delete the under-lock check: the deterministic pins go 2 per waiter;
  2. drop the `claimWindowStart` bound from the locked predicate: the
     reschedule test fails;
  3. read the flag from the pre-lock `cls` instead of re-reading: survives
     the sequential pins, because each call there reads after the previous one
     committed. The interleaving test catches it. Both callers read `null`
     before parking, so whichever is granted the lock second acts on a stale
     `null` and doubles. That makes the interleaving test the only pin on the
     re-read, and the reason it is not optional.

## 5. Prose to rewrite (state what is true now; history goes in the PR body)

- `handleSpotFreed`'s branch comment. It describes the lock as serializing
  writers. It now also dedupes broadcasts.
- `reconcileOne`'s unlocked-read paragraph ("Stale in either direction costs
  almost nothing"). The stale-flag direction is now answered by the locked
  re-check, in the same place the stale-count direction already was.
- `broadcastStillStands`'s docblock. It is written as the sweep's gate and
  becomes the predicate both sides share, so the "this module" framing moves
  with it.
- `handleSpotFreed`'s docblock line "Nothing about this function's signature or
  behaviour changed for it". Its behaviour now does change for the sweep's
  benefit, though not its signature.

#220's spec is a record and stays as written. The correction lives here and in
the PR body.

## 6. Not in scope

- #680 (durable freed-seat outbox) touches the same hand-off. It is unaffected:
  the race exists with or without an outbox.
- The per-recipient edge #220 §4.3 "What the gate gives up" named (two live-hook
  failures inside one window) is unchanged by this.
