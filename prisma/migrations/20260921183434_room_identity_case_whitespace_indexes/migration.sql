-- Replace byte-exact room identity indexes with case- and whitespace-normalized
-- expression indexes (#260).
--
-- Three raw text columns in the original migration (20260811202634_teacher_slot_unique_indexes)
-- compared byte-for-byte, allowing case- and whitespace-variant rooms to coexist
-- in the shared commons and in private inventories.
--
-- Hand-authored because Prisma cannot express WHERE clauses or function expressions
-- on indexes. Invisible to `prisma migrate diff --from-schema-datasource --to-schema-datamodel`,
-- so this does not read as drift in CI.
DROP INDEX "Room_public_identity_unique";
DROP INDEX "Room_private_identity_unique";

CREATE UNIQUE INDEX "Room_public_identity_unique"
  ON "Room" (lower(trim("address")), lower(trim("floor")), lower(trim("roomName")))
  WHERE "isPublic" = true;

CREATE UNIQUE INDEX "Room_private_identity_unique"
  ON "Room" ("createdById", lower(trim("address")), lower(trim("floor")), lower(trim("roomName")))
  WHERE "isPublic" = false;