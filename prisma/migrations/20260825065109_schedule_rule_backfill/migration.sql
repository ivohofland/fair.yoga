-- Explicit, rather than relying on the runner. Prisma wraps migration.sql in a
-- transaction, but `psql` in autocommit and `prisma db execute` do not — and
-- under those, a failure between blocks 1 and 4 leaves the schema half-moved.
-- The file's own guarantee should not depend on who executes it.
BEGIN;

-- ---------------------------------------------------------------------------
-- Pre-flight, against real rows this time. Design doc §7.2.
-- `prisma db execute` surfaces RAISE EXCEPTION and swallows RAISE NOTICE.
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  WITH r AS (
    SELECT id, "teacherId", "dayOfWeek" dow, "startTime"::time st, "durationMinutes" dur
      FROM "ClassTemplate" WHERE "isArchived" = false
    UNION ALL
    SELECT id, "teacherId", "dayOfWeek", "startTime"::time, "durationMinutes"
      FROM "StudioClassTemplate" WHERE "isArchived" = false
  ), x AS (
    SELECT *, int4range((EXTRACT(HOUR FROM st)*60 + EXTRACT(MINUTE FROM st))::int,
                        (EXTRACT(HOUR FROM st)*60 + EXTRACT(MINUTE FROM st))::int + dur,
                        '[)') slot FROM r
  )
  SELECT count(*) INTO n
    FROM x a JOIN x b ON a."teacherId" = b."teacherId" AND a.dow = b.dow
                     AND a.id < b.id AND a.slot && b.slot;
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing to install ScheduleRule: % overlapping live template pair(s). Resolve them before migrating.', n;
  END IF;
END $$;

-- 1. One rule per template. The id is preserved so children link by it.
INSERT INTO "ScheduleRule" ("id","teacherId","kind","classType","dayOfWeek","startTime",
                            "durationMinutes","isActive","isArchived","archivedAt",
                            "withdrawnCount","createdAt","updatedAt")
SELECT "id","teacherId",'regular',"classType","dayOfWeek","startTime"::time,
       "durationMinutes","isActive","isArchived","archivedAt",
       "withdrawnCount","createdAt","updatedAt"
  FROM "ClassTemplate";

INSERT INTO "ScheduleRule" ("id","teacherId","kind","classType","dayOfWeek","startTime",
                            "durationMinutes","isActive","isArchived","archivedAt",
                            "withdrawnCount","createdAt","updatedAt")
SELECT "id","teacherId",'studio',"classType","dayOfWeek","startTime"::time,
       "durationMinutes","isActive","isArchived","archivedAt",
       "withdrawnCount","createdAt","updatedAt"
  FROM "StudioClassTemplate";

-- 2. Link each child to its rule; the ids match by construction above.
ALTER TABLE "ClassTemplate"       ADD COLUMN "scheduleRuleId" TEXT, ADD COLUMN "kind" "RuleKind";
ALTER TABLE "StudioClassTemplate" ADD COLUMN "scheduleRuleId" TEXT, ADD COLUMN "kind" "RuleKind";
UPDATE "ClassTemplate"       SET "scheduleRuleId" = "id", "kind" = 'regular';
UPDATE "StudioClassTemplate" SET "scheduleRuleId" = "id", "kind" = 'studio';
ALTER TABLE "ClassTemplate"       ALTER COLUMN "scheduleRuleId" SET NOT NULL, ALTER COLUMN "kind" SET NOT NULL;
ALTER TABLE "StudioClassTemplate" ALTER COLUMN "scheduleRuleId" SET NOT NULL, ALTER COLUMN "kind" SET NOT NULL;

-- 3. Pin each child's kind to its own literal, THEN attach by (id, kind). The
--    CHECK is what makes the composite FK mean "regular children hang off
--    regular rules"; without it the pair would merely have to agree.
ALTER TABLE "ClassTemplate"       ADD CONSTRAINT "ClassTemplate_kind_check" CHECK ("kind" = 'regular');
ALTER TABLE "StudioClassTemplate" ADD CONSTRAINT "StudioClassTemplate_kind_check" CHECK ("kind" = 'studio');

-- Names and ON UPDATE follow Prisma's own conventions, so `prisma migrate dev`
-- does not read this as drift and offer a corrective migration: every one of
-- the generated foreign keys in prisma/migrations/ is `<Table>_<field…>_fkey`
-- with ON UPDATE CASCADE, and every generated unique is `<Table>_<field>_key`.
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_scheduleRuleId_kind_fkey"
  FOREIGN KEY ("scheduleRuleId","kind") REFERENCES "ScheduleRule"("id","kind")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioClassTemplate" ADD CONSTRAINT "StudioClassTemplate_scheduleRuleId_kind_fkey"
  FOREIGN KEY ("scheduleRuleId","kind") REFERENCES "ScheduleRule"("id","kind")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClassTemplate"       ADD CONSTRAINT "ClassTemplate_scheduleRuleId_key" UNIQUE ("scheduleRuleId");
ALTER TABLE "StudioClassTemplate" ADD CONSTRAINT "StudioClassTemplate_scheduleRuleId_key" UNIQUE ("scheduleRuleId");

-- 4. The four #296 template triggers HOLD four of the columns block 5 drops.
--    PostgreSQL records a column dependency for every column a trigger's WHEN
--    clause names, so the drops below fail without this:
--
--      ERROR: cannot drop column teacherId of table "ClassTemplate" because
--             other objects depend on it
--
--    Measured: 10 dependencies across the four triggers, on teacherId,
--    dayOfWeek, startTime and isArchived. Not `DROP … CASCADE`, which removes
--    the triggers and leaves the two functions behind as broken orphans.
--
--    The exclusion constraint on ScheduleRule has enforced this invariant
--    since the previous migration, so nothing is unguarded in between.
DROP TRIGGER IF EXISTS class_template_cross_family_slot_insert_guard ON "ClassTemplate";
DROP TRIGGER IF EXISTS class_template_cross_family_slot_update_guard ON "ClassTemplate";
DROP TRIGGER IF EXISTS studio_class_template_cross_family_slot_insert_guard ON "StudioClassTemplate";
DROP TRIGGER IF EXISTS studio_class_template_cross_family_slot_update_guard ON "StudioClassTemplate";
DROP FUNCTION IF EXISTS class_template_reject_cross_family_slot();
DROP FUNCTION IF EXISTS studio_class_template_reject_cross_family_slot();

-- 5. Only now drop the moved columns. Nine per table. The two partial unique
--    indexes from 20260811202634 are over columns dropped here, so PostgreSQL
--    removes them silently as a consequence — there is no DROP INDEX to write.
ALTER TABLE "ClassTemplate"
  DROP COLUMN "teacherId", DROP COLUMN "classType", DROP COLUMN "dayOfWeek",
  DROP COLUMN "startTime", DROP COLUMN "durationMinutes", DROP COLUMN "isActive",
  DROP COLUMN "isArchived", DROP COLUMN "archivedAt", DROP COLUMN "withdrawnCount";
ALTER TABLE "StudioClassTemplate"
  DROP COLUMN "teacherId", DROP COLUMN "classType", DROP COLUMN "dayOfWeek",
  DROP COLUMN "startTime", DROP COLUMN "durationMinutes", DROP COLUMN "isActive",
  DROP COLUMN "isArchived", DROP COLUMN "archivedAt", DROP COLUMN "withdrawnCount";

COMMIT;
