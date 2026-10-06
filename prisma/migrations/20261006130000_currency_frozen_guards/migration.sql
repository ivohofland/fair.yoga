-- Explicit, rather than relying on the runner: `psql` in autocommit and
-- `prisma db execute` do not wrap a file in a transaction, and a failure
-- between the statements below would leave a function replaced and its trigger
-- absent.
BEGIN;

-- ---------------------------------------------------------------------------
-- `Class.currency` is a snapshot taken when the class is created, and it stops
-- being relabellable once a booking exists, the class has completed, or its
-- entry is cancelled. `OLD."entryLive"` is the class's own mirror of the
-- entry's liveness, so this function reads nothing outside its own row and
-- takes no lock on the entry.
--
-- A write that leaves the value as it is passes: `UPDATE OF currency` fires on
-- the column's presence in the SET list, not on a change.
--
-- The SQLSTATE is `check_violation` (23514) WITHOUT the `which is terminal`
-- clause, so `classifyApiError` does not answer 409 for it: a currency write
-- reaching this guard means a writer outside the switch's own filter exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION class_reject_frozen_currency_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.currency IS NOT DISTINCT FROM OLD.currency THEN
    RETURN NEW;
  END IF;
  IF OLD."settingsLocked" OR OLD.status = 'completed' OR NOT OLD."entryLive" THEN
    RAISE EXCEPTION 'Class % is booked or terminal and cannot change its currency', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_currency_frozen_guard
  BEFORE UPDATE OF currency ON "Class"
  FOR EACH ROW EXECUTE FUNCTION class_reject_frozen_currency_change();

-- ---------------------------------------------------------------------------
-- A `StudioClass` is an income record once its entry's date is past. The guard
-- refuses from two days back, one day looser than the service's "strictly
-- before the teacher's today", because the database knows only its own
-- `CURRENT_DATE` and a teacher's calendar date can trail it by a day.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studio_class_reject_frozen_currency_change()
RETURNS TRIGGER AS $$
DECLARE
  entry_date date;
BEGIN
  IF NEW.currency IS NOT DISTINCT FROM OLD.currency THEN
    RETURN NEW;
  END IF;
  SELECT e.date INTO entry_date FROM "CalendarEntry" e WHERE e.id = OLD."calendarEntryId";
  IF entry_date < CURRENT_DATE - 1 THEN
    RAISE EXCEPTION 'Studio class % is a past income record and cannot change its currency', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER studio_class_currency_frozen_guard
  BEFORE UPDATE OF currency ON "StudioClass"
  FOR EACH ROW EXECUTE FUNCTION studio_class_reject_frozen_currency_change();

COMMIT;
