-- Invariant, DB-enforced: one teacher cannot hold two LIVE classes at the same
-- date and start time, counted ACROSS the Class and StudioClass families (#296).
-- The same at the template level, across ClassTemplate and StudioClassTemplate.
--
-- Why a trigger and not an index: PostgreSQL has no cross-table unique index.
-- The four partial indexes in 20260811202634 each enforce this within one
-- table, and nothing spanned them, so neither create route, neither edit route
-- and neither hourly sweep could see the other family.
--
-- Why NO LOCK is taken here, which is deliberate and was the design's first
-- mistake. An earlier version had each function take pg_advisory_xact_lock on
-- the slot key. docs/lock-order.md rules that out: a lock inside a trigger is a
-- wait edge no source line issues (see "The RESTRICT trigger is a wait edge",
-- #103, whose fix was a route guard rather than a lock), and the existing
-- advisory lock's own docblock warns that a second call site inside a
-- Class-holding transaction inverts silently — a trigger is not a second call
-- site but every one, and pg_advisory_xact_lock is held to commit. The residual
-- race an unlocked read leaves is documented beside the pre-checks and was
-- measured, not argued.
--
-- Hand-authored because Prisma cannot express triggers. Like the partial
-- indexes, a trigger is invisible to `prisma migrate diff`, so this does not
-- read as drift in CI and will not be dropped.

-- ---------------------------------------------------------------------------
-- Pre-flight. Refuse to install the guard over data that already violates it,
-- so no environment silently gets triggers on top of a broken invariant.
-- `prisma db execute` surfaces RAISE EXCEPTION and swallows RAISE NOTICE.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  instance_violations  int;
  template_violations  int;
BEGIN
  SELECT count(*) INTO instance_violations
  FROM "Class" c
  JOIN "StudioClass" s
    ON  s."teacherId" = c."teacherId"
    AND s."date"      = c."date"
    AND s."startTime" = c."startTime"
  WHERE c."status" <> 'cancelled'
    AND s."cancelledAt" IS NULL;

  SELECT count(*) INTO template_violations
  FROM "ClassTemplate" t
  JOIN "StudioClassTemplate" st
    ON  st."teacherId" = t."teacherId"
    AND st."dayOfWeek" = t."dayOfWeek"
    AND st."startTime" = t."startTime"
  WHERE t."isArchived"  = false
    AND st."isArchived" = false;

  IF instance_violations > 0 OR template_violations > 0 THEN
    RAISE EXCEPTION
      'Cross-family slot violations must be resolved before this guard installs: % instance, % template',
      instance_violations, template_violations;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- #205: the Class -> StudioClass lookup below would otherwise scan. Class
-- already carries the equivalent index.
-- ---------------------------------------------------------------------------
CREATE INDEX "StudioClass_teacherId_date_idx" ON "StudioClass" ("teacherId", "date");

-- ---------------------------------------------------------------------------
-- Class -> StudioClass
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION class_reject_cross_family_slot()
RETURNS TRIGGER AS $$
DECLARE conflicting text;
BEGIN
  SELECT id INTO conflicting
  FROM "StudioClass"
  WHERE "teacherId"   = NEW."teacherId"
    AND "date"        = NEW."date"
    AND "startTime"   = NEW."startTime"
    AND "cancelledAt" IS NULL
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'Teacher % already has a live studio class (%) at % %',
      NEW."teacherId", conflicting, NEW."date", NEW."startTime"
      USING ERRCODE = 'YG001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_cross_family_slot_insert_guard
  BEFORE INSERT ON "Class"
  FOR EACH ROW
  WHEN (NEW."status" <> 'cancelled')
  EXECUTE FUNCTION class_reject_cross_family_slot();

-- Narrow on purpose. Fires only when the row is live AND the slot moved or the
-- row became live, so an unrelated update (spotBroadcastAt, the completion
-- totals, settingsLocked) pays for no sibling lookup — and a pre-existing
-- violating pair stays editable on every other column instead of freezing both
-- rows, which is the failure mode #76 was filed about.
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

-- ---------------------------------------------------------------------------
-- StudioClass -> Class
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studio_class_reject_cross_family_slot()
RETURNS TRIGGER AS $$
DECLARE conflicting text;
BEGIN
  SELECT id INTO conflicting
  FROM "Class"
  WHERE "teacherId" = NEW."teacherId"
    AND "date"      = NEW."date"
    AND "startTime" = NEW."startTime"
    AND "status"   <> 'cancelled'
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'Teacher % already has a live class (%) at % %',
      NEW."teacherId", conflicting, NEW."date", NEW."startTime"
      USING ERRCODE = 'YG001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER studio_class_cross_family_slot_insert_guard
  BEFORE INSERT ON "StudioClass"
  FOR EACH ROW
  WHEN (NEW."cancelledAt" IS NULL)
  EXECUTE FUNCTION studio_class_reject_cross_family_slot();

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

-- ---------------------------------------------------------------------------
-- ClassTemplate -> StudioClassTemplate. Templates key on dayOfWeek: a recurring
-- class recurs on a weekday. Archived templates are excluded so archiving frees
-- the slot, matching 20260811202634. `isActive` (paused) is NOT consulted — a
-- paused template goes on holding its slot, as it already does within families.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION class_template_reject_cross_family_slot()
RETURNS TRIGGER AS $$
DECLARE conflicting text;
BEGIN
  SELECT id INTO conflicting
  FROM "StudioClassTemplate"
  WHERE "teacherId"  = NEW."teacherId"
    AND "dayOfWeek"  = NEW."dayOfWeek"
    AND "startTime"  = NEW."startTime"
    AND "isArchived" = false
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'Teacher % already has an active studio template (%) on day % at %',
      NEW."teacherId", conflicting, NEW."dayOfWeek", NEW."startTime"
      USING ERRCODE = 'YG001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_template_cross_family_slot_insert_guard
  BEFORE INSERT ON "ClassTemplate"
  FOR EACH ROW
  WHEN (NEW."isArchived" = false)
  EXECUTE FUNCTION class_template_reject_cross_family_slot();

CREATE TRIGGER class_template_cross_family_slot_update_guard
  BEFORE UPDATE ON "ClassTemplate"
  FOR EACH ROW
  WHEN (
    NEW."isArchived" = false
    AND (
         OLD."isArchived" = true
      OR OLD."dayOfWeek"  IS DISTINCT FROM NEW."dayOfWeek"
      OR OLD."startTime"  IS DISTINCT FROM NEW."startTime"
      OR OLD."teacherId"  IS DISTINCT FROM NEW."teacherId"
    )
  )
  EXECUTE FUNCTION class_template_reject_cross_family_slot();

-- ---------------------------------------------------------------------------
-- StudioClassTemplate -> ClassTemplate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studio_class_template_reject_cross_family_slot()
RETURNS TRIGGER AS $$
DECLARE conflicting text;
BEGIN
  SELECT id INTO conflicting
  FROM "ClassTemplate"
  WHERE "teacherId"  = NEW."teacherId"
    AND "dayOfWeek"  = NEW."dayOfWeek"
    AND "startTime"  = NEW."startTime"
    AND "isArchived" = false
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'Teacher % already has an active class template (%) on day % at %',
      NEW."teacherId", conflicting, NEW."dayOfWeek", NEW."startTime"
      USING ERRCODE = 'YG001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER studio_class_template_cross_family_slot_insert_guard
  BEFORE INSERT ON "StudioClassTemplate"
  FOR EACH ROW
  WHEN (NEW."isArchived" = false)
  EXECUTE FUNCTION studio_class_template_reject_cross_family_slot();

CREATE TRIGGER studio_class_template_cross_family_slot_update_guard
  BEFORE UPDATE ON "StudioClassTemplate"
  FOR EACH ROW
  WHEN (
    NEW."isArchived" = false
    AND (
         OLD."isArchived" = true
      OR OLD."dayOfWeek"  IS DISTINCT FROM NEW."dayOfWeek"
      OR OLD."startTime"  IS DISTINCT FROM NEW."startTime"
      OR OLD."teacherId"  IS DISTINCT FROM NEW."teacherId"
    )
  )
  EXECUTE FUNCTION studio_class_template_reject_cross_family_slot();
