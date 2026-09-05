-- Invariant, DB-enforced: a live Class may not sit in an archived
-- TeacherRoom. Held until now by two application doors, both
-- non-transactional reads (issue 339).
--
-- The predicate spans three tables, so it is collapsed onto one row by
-- mirroring each parent's state through a composite foreign key. The mirrors
-- cannot drift: each is one column of a key whose other columns are the
-- parent's, so a disagreeing row is refused rather than stored, and
-- ON UPDATE CASCADE rewrites the children when a parent changes.
--
-- Liveness reaches one table further than issue 272's did. Cancellation left
-- Class in #327, so it is the ENTRY's cancelledAt that decides whether a
-- class is still a commitment the room has to honour.

-- Entry liveness, per row, so a foreign key can reference it.
ALTER TABLE "CalendarEntry"
  ADD COLUMN "live" BOOLEAN GENERATED ALWAYS AS ("cancelledAt" IS NULL) STORED;
-- NOT NULL is required, not tidy: a generated column is nullable by default
-- and Prisma's Boolean is required, so without this the drift check in CI
-- fails.
ALTER TABLE "CalendarEntry" ALTER COLUMN "live" SET NOT NULL;
ALTER TABLE "CalendarEntry"
  ADD CONSTRAINT "CalendarEntry_id_kind_live_key" UNIQUE ("id", "kind", "live");

-- REMEDIATION, and it must precede the backfill below.
-- `ADD CONSTRAINT ... CHECK` validates every existing row, and the backfill
-- mirrors each parent faithfully — so a database that already holds a live
-- class in an archived room mirrors that state into a violating row and the
-- constraint at the foot of this file refuses it, aborting the migration.
-- That state is not hypothetical: it is the premise of issue 339, and the
-- doors this constraint replaces were measured letting it through.
--
-- UN-ARCHIVING THE ROOM, where issue 272's sibling migration paused the
-- template. The mirror image here would be cancelling the class, and that is
-- refused: cancelling a Class is terminal, may carry registered students, and
-- everywhere else in the app notifies them. Un-archiving is also already the
-- documented recovery for exactly this state, so this repairs it the way the
-- application tells a teacher to. The teacher re-archives afterwards, and the
-- constraint then either allows it or names what to clear.
--
-- The cascade this fires — ClassTemplate.roomArchived := false, through issue
-- 272's foreign key — can only satisfy ClassTemplate_live_needs_open_room
-- further and can never violate it.
--
-- `prisma db execute` surfaces RAISE EXCEPTION and swallows RAISE NOTICE;
-- `prisma migrate deploy` (what CI and the test suite's global setup actually
-- run) does not.
DO $$
DECLARE
  affected INT;
BEGIN
  UPDATE "TeacherRoom" tr SET "isArchived" = false
   WHERE tr."isArchived"
     AND EXISTS (SELECT 1 FROM "Class" c
                   JOIN "CalendarEntry" ce ON ce."id" = c."calendarEntryId"
                  WHERE c."teacherRoomId" = tr."id"
                    AND c."status" IN ('open','in_progress')
                    AND ce."cancelledAt" IS NULL);
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE NOTICE 'issue 339 remediation: un-archived % room(s) that were holding a live class', affected;
  END IF;
END $$;

-- The mirrors, backfilled from the parents they mirror.
ALTER TABLE "Class" ADD COLUMN "entryLive"    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Class" ADD COLUMN "roomArchived" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Class" c SET "entryLive"    = ce."live"
  FROM "CalendarEntry" ce WHERE ce."id" = c."calendarEntryId";
UPDATE "Class" c SET "roomArchived" = tr."isArchived"
  FROM "TeacherRoom"  tr WHERE tr."id" = c."teacherRoomId";

-- The two existing foreign keys, widened to carry the mirrored column.
-- Referential actions are preserved exactly; delete behaviour is unchanged.
ALTER TABLE "Class" DROP CONSTRAINT "Class_calendarEntryId_kind_fkey";
ALTER TABLE "Class" ADD  CONSTRAINT "Class_calendarEntryId_kind_entryLive_fkey"
  FOREIGN KEY ("calendarEntryId", "kind", "entryLive")
  REFERENCES "CalendarEntry"("id", "kind", "live")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Class" DROP CONSTRAINT "Class_teacherRoomId_fkey";
ALTER TABLE "Class" ADD  CONSTRAINT "Class_teacherRoomId_roomArchived_fkey"
  FOREIGN KEY ("teacherRoomId", "roomArchived")
  REFERENCES "TeacherRoom"("id", "isArchived")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The invariant. The two statuses are also spelled in BLOCKING_CLASS_STATUSES
-- (`src/services/room-archive.ts`); a constraint cannot import a constant, so
-- what keeps them together is a test that iterates the enum
-- (`class-room-constraint.test.ts`), not this comment.
ALTER TABLE "Class" ADD CONSTRAINT "Class_live_needs_open_room"
  CHECK (NOT ("status" IN ('open','in_progress') AND "entryLive" AND "roomArchived"));
