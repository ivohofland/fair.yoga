-- Pre-production: the column converts in place with a cast, no data migration.
-- `USING` is required — PostgreSQL will not implicitly cast text to time.
--
-- Both cross-family UPDATE guards (20260821120000) reference "startTime" in
-- their trigger WHEN clause, and PostgreSQL refuses ALTER COLUMN TYPE on a
-- column a trigger's WHEN clause depends on (ERRCODE 0A000) — measured, not
-- assumed. Each guard is dropped and recreated verbatim around its table's
-- ALTER; the INSERT guards do not reference "startTime" in their WHEN clause
-- and are untouched.
DROP TRIGGER "class_cross_family_slot_update_guard" ON "Class";
DROP TRIGGER "studio_class_cross_family_slot_update_guard" ON "StudioClass";

ALTER TABLE "Class"       ALTER COLUMN "startTime" TYPE TIME USING "startTime"::time;
ALTER TABLE "StudioClass" ALTER COLUMN "startTime" TYPE TIME USING "startTime"::time;

CREATE TRIGGER class_cross_family_slot_update_guard
  BEFORE UPDATE ON "Class"
  FOR EACH ROW
  WHEN (
    NEW."status" <> 'cancelled'
    AND (
         OLD."status"    =  'cancelled'
      OR OLD."date"      IS DISTINCT FROM NEW."date"
      OR OLD."startTime" IS DISTINCT FROM NEW."startTime"
      OR OLD."teacherId" IS DISTINCT FROM NEW."teacherId"
    )
  )
  EXECUTE FUNCTION class_reject_cross_family_slot();

CREATE TRIGGER studio_class_cross_family_slot_update_guard
  BEFORE UPDATE ON "StudioClass"
  FOR EACH ROW
  WHEN (
    NEW."cancelledAt" IS NULL
    AND (
         OLD."cancelledAt" IS NOT NULL
      OR OLD."date"        IS DISTINCT FROM NEW."date"
      OR OLD."startTime"   IS DISTINCT FROM NEW."startTime"
      OR OLD."teacherId"   IS DISTINCT FROM NEW."teacherId"
    )
  )
  EXECUTE FUNCTION studio_class_reject_cross_family_slot();
