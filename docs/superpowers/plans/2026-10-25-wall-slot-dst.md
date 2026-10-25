# #915 — `wallSlotAt` refuses an instant no slot can name

Design: option A, agreed in chat (no spec — bounded, test-only change).

## The defect

`wallSlotAt(instant, zone)` (`tests/class-fixtures.ts`) formats `instant` into a
`(date, startTime)` pair. In the repeated hour of an autumn clock change, the
pair names two instants and `readClassStart` (`src/lib/class-start.ts`)
resolves it to the second. A first-occurrence instant therefore comes back as a
slot one hour later than asked, silently. Reproduced: clock faked to
`2026-10-24T22:35Z`, `now + 90 min` gives `2026-10-25 02:05`, read back as
`01:05Z` (150 min ahead), and the #836 stamp test fails.

## Task 1 — `wallSlotAt` round-trips, and the #836 block pins its clock

Order matters: the fixture change lands first, so the pinned-clock change is
proven against a fixture that would refuse the bad slot rather than shift it.

**Fixture.** After building the pair, `wallSlotAt` reads it back with
`readClassStart(pair, timeZone)` and compares with `instant` truncated to the
minute. On a mismatch (or a fault) it throws an `Error` naming the instant, the
zone, the slot, and the instant the slot reads back as. The docblock states the
refusal: the instant is the earlier of a repeated wall-clock hour, which no
`(date, startTime)` pair can name.

**Fixture unit test** — new `tests/class-fixtures.test.ts`, added to the `unit`
project's `include` list in `vitest.config.*` (the list is explicit; a file not
named there never runs — confirm it appears in the run's output):
- refuses `2026-10-25T00:05:00Z` in `Europe/Amsterdam` (the first 02:05 CEST);
- accepts `2026-10-25T01:05:00Z` (the second 02:05, CET) → `2026-10-25`, `02:05`;
- truncates to the minute: `…T10:00:42Z` in UTC round-trips without throwing.

**#836 describe** (`src/services/class-lifecycle.test.ts`, "the auto-cancel
decision (#836)"): fake only `Date` in a `beforeEach`, fixed to an instant clear
of either DST transition (as `class-generator.test.ts` does for its boundary
test), and have it restore real timers when each test ends, through
`pinDateClear()`'s `onTestFinished`. Slot offsets and assertions stay
as they are. Verified before planning: on these paths every `now` is a JS
`new Date()`; the only database clock reads (`CURRENT_DATE` in
`20261006130000_currency_frozen_guards`) fire on `UPDATE OF currency`, which no
test in this block issues.

**Prove the guards bite** (record the exact output of each):
1. Run the stamp test with the pre-change file and the clock faked to
   `2026-10-24T22:35Z` → fails `expected null not to be null` (done in chat;
   re-record).
2. With the change in place, fake the system clock for the whole file to
   `2026-10-24T22:35Z` (one-off edit, reverted) → the #836 block passes; any
   other test in the file that calls `wallSlotAt` with an Amsterdam instant in
   the first 02:xx throws the fixture's error, not a wrong assertion.
3. Remove the stamp in `redecideAfterMove` (one-off, reverted) → the stamp test
   fails.
4. Delete the round-trip check (one-off, reverted) → the refusal unit test fails.

## Not done here, stated in the PR

The one out-of-process caller that cannot fake the server's clock and still
reaches a repeated hour is `tests/integration/classes-api.test.ts` (two "started
50 minutes ago" Amsterdam slots, now in [00:50, 01:50) UTC on the last Sunday of
October): it fails at the fixture for that hour, naming the cause, instead of
with an unrelated assertion. Accepted as the trade the issue asked for. Every
e2e spec that calls `wallSlotAt` runs with a UTC teacher, so none can reach a
repeated hour.

## Task 2 — the #249 "teacher's zone" tests pin their clock

Found after Task 1's review, outside `wallSlotAt`: two tests in
`src/services/class-lifecycle.test.ts` build an Amsterdam slot 30 minutes in
the past with the file's own `localWallClockMinutesAgo` helper —
"reads the start in the teacher's zone, not UTC, when publishing (#249)" and
"… when rescheduling (#249)". When that slot falls in the first 02:xx of the
autumn change it reads back 30 minutes in the FUTURE, and `past_start` is not
returned. Measured: with `Date` faked per test to `2026-10-25T00:45:00Z`, both
fail (`expected { ok: true … } to deeply equal { ok: false, reason:
'past_start' }`; the publishing one at its precondition, `expected
1792890900000 to be less than 1792889100000`). Window: `now` in [00:30, 01:30)
UTC on the last Sunday of October.

**Change.** Each of the two tests fakes only `Date`, fixed to an instant clear
of either DST transition, and restores real timers even when it fails: both
tests call the file's shared `pinDateClear()`, as the `#836` block's
`beforeEach` does. The slot stays "30 minutes ago in
Amsterdam" and the UTC-misreading precondition stays: the tests still prove
what #249 pinned. Verify the fixed instant keeps the precondition true (Amsterdam
ahead of UTC at that instant, so the misread is in the future). On the
publishing and rescheduling paths every `now` is a JS `new Date()` — check that
for the publish path (`transitionClass`) the same way it was checked for
`updateClass` before relying on it.

**Prove the guards bite** (record exact output):
1. Before the change, a per-test `beforeEach` faking `Date` to
   `2026-10-25T00:45:00Z` (one-off, reverted) fails both tests as measured
   above. A module-top `vi.useFakeTimers` is NOT a valid probe — the
   `transitionClass (DB)` describe's `afterEach` calls `vi.useRealTimers()`, and
   `pinDateClear()` restores real timers when each test ends, so a fake set at
   module top does not survive into the tests it was meant to reach.
2. After the change, the same one-off probe → both pass.
3. Make the zone read hardcode `'UTC'` in the guard each test protects
   (one-off, reverted) → each test fails. This is the #249 regression they
   exist for; the pin must not have blunted it.

## Verification

`pnpm run verify` in the worktree (`worktree:up` first); `pnpm run build` is
not needed (no `src/` change beyond tests).
