-- Explicit, rather than relying on the runner, for the reason every #327
-- migration before it states: Prisma wraps migration.sql in a transaction, but
-- `psql` in autocommit and `prisma db execute` do not, and under those a
-- failure between the statements below would leave the functions replaced and
-- the triggers absent.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. CalendarEntry -> ScheduleRule kind-mismatch guard.
--
--    `CalendarEntry.scheduleRuleId` is the only single-column foreign key into
--    a kind-discriminated parent. A composite foreign key `(scheduleRuleId, kind)`
--    cannot be declared in Prisma because `ON DELETE SET NULL` on a composite key
--    nulls all referencing columns, including `kind` which is NOT NULL.
--
--    This trigger validates that any non-null `scheduleRuleId` references a
--    `ScheduleRule` whose `kind` equals `CalendarEntry.kind`.
--
--    SHORT-CIRCUIT ON NULL IS LOAD-BEARING: manual class creation leaves
--    `scheduleRuleId` NULL, and `ON DELETE SET NULL` fires this as a BEFORE UPDATE
--    of `scheduleRuleId` to NULL.
--
--    `which is terminal` is load-bearing for `isTerminalStatusViolation`.
--    `cannot attach to mismatched rule kind` is the tail `TERMINAL_TRIGGER_TAILS`
--    recognises to classify this as `entry_rule_kind`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION entry_reject_rule_kind_mismatch()
RETURNS TRIGGER AS $$
DECLARE
  r "ClassFamily";
BEGIN
  IF NEW."scheduleRuleId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT kind INTO r FROM "ScheduleRule" WHERE id = NEW."scheduleRuleId";

  IF r IS DISTINCT FROM NEW.kind THEN
    RAISE EXCEPTION
      'CalendarEntry % references ScheduleRule % of kind %, which is terminal; cannot attach to mismatched rule kind',
      NEW.id,
      NEW."scheduleRuleId",
      r
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entry_rule_kind_mismatch_guard
  BEFORE INSERT OR UPDATE OF "scheduleRuleId", "kind" ON "CalendarEntry"
  FOR EACH ROW EXECUTE FUNCTION entry_reject_rule_kind_mismatch();

-- ---------------------------------------------------------------------------
-- 2. ScheduleRule kind immutability guard.
--
--    A point-in-time check on CalendarEntry becomes stale if ScheduleRule.kind
--    can be modified after creation. This trigger guarantees that ScheduleRule.kind
--    is immutable once written.
--
--    `which is terminal` is load-bearing for `isTerminalStatusViolation`.
--    `cannot change its kind` is the tail `TERMINAL_TRIGGER_TAILS` recognises
--    to classify this as `rule_kind`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION schedule_rule_reject_kind_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.kind IS NOT DISTINCT FROM OLD.kind THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'ScheduleRule % is %, which is terminal; cannot change its kind',
    OLD.id,
    OLD.kind
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_rule_kind_immutability_guard
  BEFORE UPDATE OF "kind" ON "ScheduleRule"
  FOR EACH ROW EXECUTE FUNCTION schedule_rule_reject_kind_change();

COMMIT;
