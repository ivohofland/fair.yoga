-- Account hybrid: auth unifies, domain doesn't.
-- One Account per authenticated human; Teacher/Student become linked
-- profiles. Sessions and passkeys move from (userId, userType) to
-- accountId WITH backfill: teachers and claimed students keep every
-- session and passkey. Never-claimed CRM students (the old model let
-- them sign in without stamping claimedAt) lose theirs — they re-claim
-- on their next magic-link sign-in.

-- 1. The Account table.
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");

-- 2. Nullable accountId columns everywhere first; tighten after backfill.
ALTER TABLE "Teacher" ADD COLUMN "accountId" TEXT;
ALTER TABLE "Student" ADD COLUMN "accountId" TEXT;
ALTER TABLE "Session" ADD COLUMN "accountId" TEXT;
ALTER TABLE "PasskeyCredential" ADD COLUMN "accountId" TEXT;

-- 3. Backfill: one account per teacher.
INSERT INTO "Account" ("id", "email", "createdAt")
  SELECT gen_random_uuid(), t."email", t."createdAt" FROM "Teacher" t;
UPDATE "Teacher" t SET "accountId" = a."id"
  FROM "Account" a WHERE a."email" = t."email";

-- 4. Claimed students: reuse a matching teacher account when emails
--    collide (absorbs any already-shadowed dual identities into one
--    healthy account), otherwise mint their own account. Unclaimed CRM
--    rows stay accountless until the human authenticates.
UPDATE "Student" s SET "accountId" = a."id"
  FROM "Account" a
  WHERE s."claimedAt" IS NOT NULL AND a."email" = s."email";
INSERT INTO "Account" ("id", "email", "createdAt")
  SELECT gen_random_uuid(), s."email", s."createdAt" FROM "Student" s
  WHERE s."claimedAt" IS NOT NULL AND s."accountId" IS NULL;
UPDATE "Student" s SET "accountId" = a."id"
  FROM "Account" a
  WHERE s."claimedAt" IS NOT NULL AND s."accountId" IS NULL
    AND a."email" = s."email";

-- 5. Sessions and passkeys resolve through the profile they pointed at.
UPDATE "Session" se SET "accountId" = t."accountId"
  FROM "Teacher" t WHERE se."userType" = 'teacher' AND se."userId" = t."id";
UPDATE "Session" se SET "accountId" = s."accountId"
  FROM "Student" s WHERE se."userType" = 'student' AND se."userId" = s."id";
DELETE FROM "Session" WHERE "accountId" IS NULL;

UPDATE "PasskeyCredential" pc SET "accountId" = t."accountId"
  FROM "Teacher" t WHERE pc."userType" = 'teacher' AND pc."userId" = t."id";
UPDATE "PasskeyCredential" pc SET "accountId" = s."accountId"
  FROM "Student" s WHERE pc."userType" = 'student' AND pc."userId" = s."id";
DELETE FROM "PasskeyCredential" WHERE "accountId" IS NULL;

-- 6. Tighten and drop the old identity columns.
ALTER TABLE "Teacher" ALTER COLUMN "accountId" SET NOT NULL;
ALTER TABLE "Session" ALTER COLUMN "accountId" SET NOT NULL;
ALTER TABLE "PasskeyCredential" ALTER COLUMN "accountId" SET NOT NULL;

DROP INDEX "Session_userId_userType_idx";
DROP INDEX "PasskeyCredential_userId_userType_idx";
ALTER TABLE "Session" DROP COLUMN "userId", DROP COLUMN "userType";
ALTER TABLE "PasskeyCredential" DROP COLUMN "userId", DROP COLUMN "userType";

-- 7. Indexes and FKs on the new columns.
CREATE INDEX "Session_accountId_idx" ON "Session"("accountId");
CREATE INDEX "PasskeyCredential_accountId_idx" ON "PasskeyCredential"("accountId");
CREATE UNIQUE INDEX "Teacher_accountId_key" ON "Teacher"("accountId");
CREATE UNIQUE INDEX "Student_accountId_key" ON "Student"("accountId");

ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Student" ADD CONSTRAINT "Student_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
