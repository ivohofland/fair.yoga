-- CalendarEntry: two single-row CHECKs on the completion marker.
--
-- Both are STATIC, single-row and cross-table-free, which is what makes them
-- CHECKs rather than triggers. Neither reads another table, so neither takes a
-- lock and neither can be ordered wrongly against lockClassRow.
--
-- ---------------------------------------------------------------------------
-- 1. Only a regular entry can carry a completion marker.
--
--    `entry_completion_marker_guard` (20260826182710) is BEFORE UPDATE OF
--    "classCompletedAt" with `IF OLD."classCompletedAt" IS NOT NULL THEN
--    RAISE`, so what it enforces is MONOTONICITY, not authorship: NULL ->
--    NOT NULL passes for every client, and an INSERT carrying a marker is not
--    an UPDATE and fires nothing at all. schema.prisma says the column is
--    "Written ONLY by class_sync_entry_completed" and that "THAT IS ENFORCED,
--    not conventional"; before this constraint it was neither.
--
--    Three consequences, and the studio one is the reason this CHECK is
--    phrased on `kind` rather than on the writer:
--      * a stray stamp freezes an entry's schedule permanently, because the
--        same guard then refuses to clear it;
--      * on a `kind = 'studio'` entry it produces a state the schema declares
--        impossible — only a `Class` has a `status`, so only a regular entry
--        can ever be completed — and freezes a class whose cancellation is
--        REVERSIBLE and whose un-cancel path is live;
--      * on an entry 365+ days past its date it makes a never-completed
--        class's unfulfilled queue rows reapable by `waitlist-retention.ts`'s
--        permanent DELETE, which rests on this column having one writer.
--
--    A CHECK covers INSERT as well as UPDATE, which is the half the trigger
--    structurally cannot reach.
-- ---------------------------------------------------------------------------
ALTER TABLE "CalendarEntry"
  ADD CONSTRAINT "CalendarEntry_completion_marker_regular_only"
  CHECK ("kind" = 'regular' OR "classCompletedAt" IS NULL);

-- ---------------------------------------------------------------------------
-- 2. An entry cannot be both cancelled and completed.
--
--    Recorded as known-open in `class-lifecycle.ts` on the grounds that a
--    guard "would have to sit on `Class` and read `CalendarEntry.cancelledAt`,
--    a cross-table read inside a trigger" — the mechanism spec §4.3 priced and
--    rejected for its ABBA against lockClassRow. THAT STOPPED BEING TRUE WHEN
--    THE EXTRACTION PUT BOTH MARKERS ON ONE ROW. Liveness and completion are
--    now two columns of the same tuple, so the invariant is a single-row CHECK
--    with no read, no lock and no ordering cost. The extraction is what made
--    it expressible; the design did not notice.
--
--    WHERE THE REFUSAL LANDS is the point. Raw SQL walking a cancelled class
--    up to `completed` is what the known-open described:
--    `class_reject_terminal_status_change` refuses only a class LEAVING
--    `completed`, and cancellation is no longer a `ClassStatus`, so nothing
--    stopped the move. It fires `class_sync_entry_completed`, whose own
--    `UPDATE "CalendarEntry" SET "classCompletedAt" = now()` then violates this
--    constraint and aborts the completing transaction — the refusal arrives at
--    the statement that caused it.
--
--    No legitimate path produces the pair. `completeClass` refuses when
--    `cls.calendarEntry.cancelledAt !== null`; `autoCompleteClasses` filters
--    `cancelledAt: null`; every cancel CAS in `src/` carries a non-terminal
--    status alongside `cancelledAt: null`, and
--    `entry_terminal_liveness_guard` refuses cancelling a marked regular entry
--    from raw SQL as well. Measured on the dev and test databases before this
--    migration: 0 rows carried both.
-- ---------------------------------------------------------------------------
ALTER TABLE "CalendarEntry"
  ADD CONSTRAINT "CalendarEntry_not_cancelled_and_completed"
  CHECK (NOT ("classCompletedAt" IS NOT NULL AND "cancelledAt" IS NOT NULL));
