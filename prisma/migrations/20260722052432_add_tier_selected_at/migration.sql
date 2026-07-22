-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "tierSelectedAt" TIMESTAMP(3);

-- Backfill: under pre-#23 behavior every booking showed the picker, so
-- anyone who ever signed in has had the choice. Unclaimed CRM students
-- stay NULL — their tier is a teacher-created default, not a choice.
UPDATE "Student" SET "tierSelectedAt" = "claimedAt" WHERE "claimedAt" IS NOT NULL;
