-- One LIVE profile per account, not one profile ever (#623).
--
-- `deleteStudentAccount`/`deleteTeacherAccount` soft-delete the row and keep
-- `accountId`, so a hard unique made a GDPR erasure permanently bar the
-- account from holding that kind of profile again. The student half of that
-- surfaced as a silent bounce: the control that offered a student side
-- answered 409, its caller read the code as success, and the page it
-- navigated to requires a live student profile.
--
-- Hand-authored because Prisma cannot express a WHERE clause on an index.
-- Measured on the precedent this follows
-- (20260811202634_teacher_slot_unique_indexes): `prisma migrate diff
-- --from-schema-datasource --to-schema-datamodel --exit-code` does NOT see a
-- partial index, so these do not read as drift in CI. The DROPs below are
-- visible to Prisma and arrive with the schema edit that removed `@unique`.
DROP INDEX "Teacher_accountId_key";
DROP INDEX "Student_accountId_key";

CREATE UNIQUE INDEX "Teacher_account_live_unique"
  ON "Teacher" ("accountId")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "Student_account_live_unique"
  ON "Student" ("accountId")
  WHERE "deletedAt" IS NULL;
