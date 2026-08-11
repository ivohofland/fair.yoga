-- Invariant, DB-enforced: one teacher cannot hold two live classes at the
-- same date and start time (#196). Partial on purpose — a cancelled class
-- must not make its slot permanently unfillable, which is the bug a
-- non-partial index would trade for the one being fixed.
--
-- Hand-authored because Prisma cannot express a WHERE clause on an index.
-- Measured: `prisma migrate diff --from-schema-datasource --to-schema-datamodel
-- --exit-code` does NOT see a partial index (a plain one on the same columns
-- exits 2), so this does not read as drift in CI.
CREATE UNIQUE INDEX "Class_teacher_slot_unique"
  ON "Class" ("teacherId", "date", "startTime")
  WHERE "status" <> 'cancelled';

CREATE UNIQUE INDEX "StudioClass_teacher_slot_unique"
  ON "StudioClass" ("teacherId", "date", "startTime")
  WHERE "cancelledAt" IS NULL;

-- Templates key on dayOfWeek rather than date: a recurring class recurs on a
-- weekday. Archived templates are excluded so archiving frees the slot.
CREATE UNIQUE INDEX "ClassTemplate_teacher_slot_unique"
  ON "ClassTemplate" ("teacherId", "dayOfWeek", "startTime")
  WHERE "isArchived" = false;

CREATE UNIQUE INDEX "StudioClassTemplate_teacher_slot_unique"
  ON "StudioClassTemplate" ("teacherId", "dayOfWeek", "startTime")
  WHERE "isArchived" = false;

-- The room identity key is not chosen here: it is the key the existing
-- dedupe at api/rooms/route.ts already used for public rooms. The private
-- index is scoped by creator because two teachers each keeping a private
-- room at one address is legitimate — that is what TeacherRoom's per-teacher
-- rate model assumes.
CREATE UNIQUE INDEX "Room_public_identity_unique"
  ON "Room" ("address", "floor", "roomName")
  WHERE "isPublic" = true;

CREATE UNIQUE INDEX "Room_private_identity_unique"
  ON "Room" ("createdById", "address", "floor", "roomName")
  WHERE "isPublic" = false;
