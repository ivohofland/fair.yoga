-- Invariant, DB-enforced: an active ClassTemplate may not reference an
-- archived TeacherRoom. Held until now by four application doors, every one a
-- non-transactional read; two of them were measured losing the race.
--
-- The predicate spans three tables, so it is collapsed onto one row by
-- mirroring each parent's state through a composite foreign key. The mirrors
-- cannot drift: each is one column of a key whose other columns are the
-- parent's, so a disagreeing row is refused rather than stored, and
-- ON UPDATE CASCADE rewrites the children when a parent changes.

-- The parent key the room mirror points at.
ALTER TABLE "TeacherRoom"
  ADD CONSTRAINT "TeacherRoom_id_isArchived_key" UNIQUE ("id", "isArchived");

-- Rule liveness, per row, so a foreign key can reference it.
ALTER TABLE "ScheduleRule"
  ADD COLUMN "live" BOOLEAN GENERATED ALWAYS AS ("isActive" AND NOT "isArchived") STORED;
-- NOT NULL is required, not tidy: a generated column is nullable by default and
-- Prisma's Boolean is required, so without this the drift check in CI fails.
ALTER TABLE "ScheduleRule" ALTER COLUMN "live" SET NOT NULL;
ALTER TABLE "ScheduleRule"
  ADD CONSTRAINT "ScheduleRule_id_kind_live_key" UNIQUE ("id", "kind", "live");

-- The mirrors, backfilled from the parents they mirror.
ALTER TABLE "ClassTemplate" ADD COLUMN "ruleLive"     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClassTemplate" ADD COLUMN "roomArchived" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ClassTemplate" ct SET "ruleLive"     = sr."live"
  FROM "ScheduleRule" sr WHERE sr."id" = ct."scheduleRuleId";
UPDATE "ClassTemplate" ct SET "roomArchived" = tr."isArchived"
  FROM "TeacherRoom"  tr WHERE tr."id" = ct."teacherRoomId";

-- The two existing foreign keys, widened to carry the mirrored column.
-- Referential actions are preserved exactly; delete behaviour is unchanged.
ALTER TABLE "ClassTemplate" DROP CONSTRAINT "ClassTemplate_scheduleRuleId_kind_fkey";
ALTER TABLE "ClassTemplate" ADD  CONSTRAINT "ClassTemplate_scheduleRuleId_kind_ruleLive_fkey"
  FOREIGN KEY ("scheduleRuleId", "kind", "ruleLive")
  REFERENCES "ScheduleRule"("id", "kind", "live") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "ClassTemplate" DROP CONSTRAINT "ClassTemplate_teacherRoomId_fkey";
ALTER TABLE "ClassTemplate" ADD  CONSTRAINT "ClassTemplate_teacherRoomId_roomArchived_fkey"
  FOREIGN KEY ("teacherRoomId", "roomArchived")
  REFERENCES "TeacherRoom"("id", "isArchived") ON UPDATE CASCADE ON DELETE RESTRICT;

-- The invariant.
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_live_needs_open_room"
  CHECK (NOT ("ruleLive" AND "roomArchived"));