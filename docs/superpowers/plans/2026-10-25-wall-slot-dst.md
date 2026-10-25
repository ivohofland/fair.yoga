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
test), restore real timers in an `afterEach`. Slot offsets and assertions stay
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
with an unrelated assertion. Accepted as the trade the issue asked for. The two
e2e specs that call `wallSlotAt` run with UTC teachers, so they cannot reach a
repeated hour.

## Verification

`pnpm run verify` in the worktree (`worktree:up` first); `pnpm run build` is
not needed (no `src/` change beyond tests).
