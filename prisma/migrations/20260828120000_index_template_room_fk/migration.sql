-- The referencing side of `ClassTemplate_teacherRoomId_roomArchived_fkey`.
--
-- PostgreSQL indexes a foreign key's REFERENCED side automatically and its
-- referencing side never. Issue 272 added that key and left this side bare, so
-- three paths read the whole table, two of them while holding locks: the
-- archive's pre-lock (`room-archive.ts`), the ON UPDATE CASCADE that rewrites
-- the mirrors when a room's `isArchived` flips, and the ON DELETE RESTRICT
-- check behind `ROOM_DELETE_RESTRICT_FKS`.
--
-- Measured before adding, per that issue's design §7.3, which asked for a
-- measurement rather than an index on principle. The numbers and the method
-- are in `docs/lock-order.md` under the #272 section.
--
-- Composite and in this order: `teacherRoomId` leads, so the pre-lock's
-- single-column filter uses it, and the pair matches the foreign key exactly,
-- so the cascade and the RESTRICT check use it too.
CREATE INDEX "ClassTemplate_teacherRoomId_roomArchived_idx"
  ON "ClassTemplate" ("teacherRoomId", "roomArchived");
