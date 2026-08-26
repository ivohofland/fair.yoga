-- Explicit, rather than relying on the runner, for the reason every #327
-- migration before it states: Prisma wraps migration.sql in a transaction, but
-- `psql` in autocommit and `prisma db execute` do not, and under those a
-- failure between the two statements below would leave the function replaced
-- and the trigger absent.
BEGIN;

-- ---------------------------------------------------------------------------
-- The completion marker is write-once, and until this migration nothing said
-- so at the database.
--
-- `CalendarEntry."classCompletedAt"` is what makes a completed class's
-- schedule immovable: `entry_reject_frozen_schedule_change` refuses a `date`,
-- `startTime` or `durationMinutes` change on a row whose marker is set. But
-- that guard is `BEFORE UPDATE OF date, "startTime", "durationMinutes"`, and
-- `UPDATE OF` fires on a column's PRESENCE IN THE SET LIST — so
-- `UPDATE "CalendarEntry" SET "classCompletedAt" = NULL` fired no trigger at
-- all, and the very next statement moved the date past a guard whose `OLD` now
-- read NULL. TWO STATEMENTS DEFEATED THE FREEZE.
--
-- That is not a "raw SQL can do anything" shrug. `waitlist-retention.ts`
-- PERMANENTLY DELETES a terminal class's unfulfilled queue rows once the class
-- is more than 365 days past its date, and its licence to do so is that the
-- date cannot move from any client. The symmetric hole on `cancelledAt` was
-- closed by `20260826140000_entry_guard_restorations`; this one was left open,
-- and it is also reachable from TypeScript — `classCompletedAt` is a plain
-- nullable `DateTime` in the generated client, so
-- `prisma.calendarEntry.update({ data: { classCompletedAt: null } })` compiles.
--
-- MONOTONE, not "terminal": NULL -> NOT NULL is allowed (that is
-- `class_sync_entry_completed`, the marker's only legitimate writer, on both
-- its UPDATE and its INSERT trigger), and every departure from a NOT NULL
-- value is refused — clearing it, and moving it to a different timestamp. A
-- second stamp cannot reach here anyway: the sync function filters on
-- `"classCompletedAt" IS NULL`.
--
-- A GUARD OF ITS OWN rather than a widening of
-- `entry_reject_terminal_liveness_change`. That function's early return asks
-- about `cancelledAt` alone and its message says "cannot change its
-- cancellation"; folding a second column into it would mean two predicates and
-- two message tails behind one name. It also carries a `kind = 'regular'`
-- conjunct for the studio family's reversible cancellation, which this rule
-- does not want and would not use: only a `Class` has a `status`, so only a
-- regular entry ever carries a marker, and `OLD."classCompletedAt" IS NOT
-- NULL` already scopes this to that family without naming it.
--
-- `which is terminal` IS LOAD-BEARING in the message: `isTerminalStatusViolation`
-- (`src/lib/api-errors.ts`) matches on that clause to answer 409 rather than
-- 500. `cannot change its completion` is the tail `classifyApiError` reads to
-- log this trigger at `error` — the same level a date fire gets, and for the
-- same reason: both mean an unguarded writer of the column the retention sweep
-- reads has appeared.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION entry_reject_completion_marker_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."classCompletedAt" IS NOT DISTINCT FROM OLD."classCompletedAt" THEN
    RETURN NEW;
  END IF;

  IF OLD."classCompletedAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'CalendarEntry % is completed, which is terminal; cannot change its completion',
      OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entry_completion_marker_guard
  BEFORE UPDATE OF "classCompletedAt" ON "CalendarEntry"
  FOR EACH ROW EXECUTE FUNCTION entry_reject_completion_marker_change();

COMMIT;
