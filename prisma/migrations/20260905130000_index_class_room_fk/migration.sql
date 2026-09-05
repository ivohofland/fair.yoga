-- The referencing side of `Class_teacherRoomId_roomArchived_fkey`.
--
-- PostgreSQL indexes a foreign key's REFERENCED side automatically and its
-- referencing side never. Issue 339 added this key and left this side bare,
-- so two paths read the whole table: the `ON UPDATE CASCADE` that rewrites
-- the mirror when a room's `isArchived` flips, and the `ON DELETE RESTRICT`
-- check behind `ROOM_DELETE_RESTRICT_FKS`. Unlike issue 272's `ClassTemplate`
-- sibling, this door has no explicit application pre-lock of its own to add a
-- third path — the archive takes no `Class` row lock.
--
-- Measured before adding, per issue 272's design §7.3 precedent, which this
-- issue's own plan repeated. The numbers and the method are in
-- `docs/lock-order.md`, the `#339` section.
--
-- Composite and in this order: `teacherRoomId` leads, matching the foreign
-- key exactly, so both the cascade and the RESTRICT check use it.
CREATE INDEX "Class_teacherRoomId_roomArchived_idx"
  ON "Class" ("teacherRoomId", "roomArchived");
