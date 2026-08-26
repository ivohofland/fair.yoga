-- Explicit, rather than relying on the runner, for the reason both #327
-- migrations before it state: Prisma wraps migration.sql in a transaction, but
-- `psql` in autocommit and `prisma db execute` do not, and under those a
-- failure between the blocks below would leave some guards replaced and others
-- not.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The freeze guard refuses writes that change nothing.
--
--    Its predecessor was `BEFORE UPDATE OF date … WHEN (OLD.status IN
--    ('completed','cancelled') AND OLD.date IS DISTINCT FROM NEW.date)` — two
--    conjuncts. `20260826080100_calendar_entry_rewire` moved the terminality
--    half into the function body and dropped the actual-change half, so
--    `BEFORE UPDATE OF date, "startTime", "durationMinutes"` began refusing a
--    statement that merely MENTIONS one of those columns at an unchanged
--    value. `UPDATE OF` fires on presence in the SET list, not on change.
--
--    Restored in the BODY rather than as a three-way WHEN clause, which is
--    what the rewire was reaching for by omitting the WHEN: the guard's whole
--    decision then reads in one place.
--
--    THE MESSAGE ALSO CARRIES `which is terminal` NOW. That clause is what
--    `isTerminalStatusViolation` (src/lib/api-errors.ts) matches on to answer
--    409 instead of 500, and the rewire's wording dropped it — so a caller
--    that reached this backstop got an "Internal server error" for a
--    well-formed request that conflicts with a state the class had already
--    reached. `src/lib/api-errors.test.ts`'s contract sweep checks the clause
--    per FILE, and the rewire carries it in a sibling function, so nothing
--    reddened. `cannot change its date` is kept verbatim: `classifyApiError`
--    reads that substring to log a date fire at `error` and a status fire at
--    `warn`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION entry_reject_frozen_schedule_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD."date", OLD."startTime", OLD."durationMinutes")
     IS NOT DISTINCT FROM (NEW."date", NEW."startTime", NEW."durationMinutes") THEN
    RETURN NEW;
  END IF;

  IF OLD."classCompletedAt" IS NOT NULL
     OR (OLD.kind = 'regular' AND OLD."cancelledAt" IS NOT NULL) THEN
    RAISE EXCEPTION
      'CalendarEntry % is %, which is terminal; cannot change its date, start time or duration',
      OLD.id,
      CASE WHEN OLD."classCompletedAt" IS NOT NULL THEN 'completed' ELSE 'cancelled' END
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. The completion marker survives a raw INSERT.
--
--    `class_sync_entry_completed_guard` is AFTER UPDATE OF status, so
--    `INSERT INTO "Class" (…, status) VALUES (…, 'completed')` never fired it
--    and produced a completed class whose entry carried no `classCompletedAt`
--    — leaving its `date` editable, which is the guarantee
--    `waitlist-retention.ts` rests on when it permanently deletes queue rows.
--    The predecessor `class_terminal_date_guard` read `OLD.status` live and so
--    froze a terminal class however it got there.
--
--    A SECOND TRIGGER rather than widening the first to
--    `AFTER INSERT OR UPDATE OF status`. A trigger firing on INSERT may not
--    reference OLD in its WHEN clause at all, so one combined trigger would
--    have to drop `WHEN (NEW.status IS DISTINCT FROM OLD.status)` for both
--    events — or restate the terminal set in a WHEN clause, which would be a
--    third frozen copy of it with no drift pin. Two triggers keep the UPDATE
--    half byte-identical to what the rewire created and give the INSERT half
--    the only WHEN it can have, which is none: the function's own
--    `IF NEW.status IN ('completed')` is the decision, and its
--    `classCompletedAt IS NULL` filter makes a second stamp a no-op.
-- ---------------------------------------------------------------------------
CREATE TRIGGER class_sync_entry_completed_insert_guard
  AFTER INSERT ON "Class"
  FOR EACH ROW EXECUTE FUNCTION class_sync_entry_completed();

-- ---------------------------------------------------------------------------
-- 3. A terminal regular entry cannot change its liveness.
--
--    Before #327 one predicate covered this: `class_terminal_status_guard`
--    refused a status change on `OLD.status IN ('completed','cancelled')`, and
--    cancellation was a status. Both arms of it moved onto a column no trigger
--    guards —
--      * un-cancelling      (`cancelled` -> live), which `VALID_TRANSITIONS`
--        recorded as `cancelled: []`, and
--      * cancelling a completed class (`completed` -> `cancelled`), which
--        would leave `Payment` rows hanging off a class the app then renders
--        as cancelled.
--    Both succeeded from raw SQL against `CalendarEntry` until this trigger.
--
--    SEPARATE FROM the freeze guard above, not a widening of it: a different
--    column list, and a predicate that asks about `kind` where the freeze also
--    fires for a completed studio entry.
--
--    THE `kind` CONJUNCT IS THE TWO FAMILIES' ASYMMETRY, the same one the
--    freeze guard's second disjunct carries. Cancelling a `Class` is terminal;
--    cancelling a `StudioClass` is reversible and its un-cancel path is live
--    (`api/studio-classes/[id]/route.ts` writes `cancelledAt` back to null),
--    so a studio entry's liveness stays writable in both directions.
--
--    No production writer is affected: every cancel in `src/` is a CAS
--    carrying `cancelledAt: null` plus a non-terminal status, so none of them
--    can reach a row this refuses. This is the backstop for the clients that
--    bypass them, which is the whole reason the guard is a trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION entry_reject_terminal_liveness_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."cancelledAt" IS NOT DISTINCT FROM OLD."cancelledAt" THEN
    RETURN NEW;
  END IF;

  IF OLD.kind = 'regular'
     AND (OLD."cancelledAt" IS NOT NULL OR OLD."classCompletedAt" IS NOT NULL) THEN
    RAISE EXCEPTION
      'CalendarEntry % is %, which is terminal; cannot change its cancellation',
      OLD.id,
      CASE WHEN OLD."cancelledAt" IS NOT NULL THEN 'cancelled' ELSE 'completed' END
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entry_terminal_liveness_guard
  BEFORE UPDATE OF "cancelledAt" ON "CalendarEntry"
  FOR EACH ROW EXECUTE FUNCTION entry_reject_terminal_liveness_change();

COMMIT;
