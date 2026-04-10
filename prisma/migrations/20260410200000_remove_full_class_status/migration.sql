-- Update any classes with status 'full' to 'open' before removing the enum value
UPDATE "Class" SET status = 'open' WHERE status = 'full';

-- Remove 'full' from ClassStatus enum
-- Must drop and re-add the default because PostgreSQL can't cast defaults automatically
ALTER TABLE "Class" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "ClassStatus" RENAME TO "ClassStatus_old";
CREATE TYPE "ClassStatus" AS ENUM ('draft', 'open', 'in_progress', 'completed', 'cancelled');
ALTER TABLE "Class" ALTER COLUMN "status" TYPE "ClassStatus" USING "status"::text::"ClassStatus";
ALTER TABLE "Class" ALTER COLUMN "status" SET DEFAULT 'draft';
DROP TYPE "ClassStatus_old";
