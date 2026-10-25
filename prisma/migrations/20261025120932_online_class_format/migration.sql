-- CreateEnum
CREATE TYPE "ClassFormat" AS ENUM ('in_person', 'online');

-- AlterTable
ALTER TABLE "Class" ADD COLUMN     "format" "ClassFormat" NOT NULL DEFAULT 'in_person',
ADD COLUMN     "videoUrl" TEXT,
ALTER COLUMN "teacherRoomId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ClassTemplate" ADD COLUMN     "format" "ClassFormat" NOT NULL DEFAULT 'in_person',
ADD COLUMN     "videoUrl" TEXT,
ALTER COLUMN "teacherRoomId" DROP NOT NULL;

-- AddCheckConstraint
ALTER TABLE "Class" ADD CONSTRAINT "Class_format_shape" CHECK (
  ("format" = 'in_person' AND "teacherRoomId" IS NOT NULL AND "videoUrl" IS NULL)
  OR ("format" = 'online' AND "teacherRoomId" IS NULL AND NOT "roomArchived" AND "roomCost" = 0));

-- AddCheckConstraint
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_format_shape" CHECK (
  ("format" = 'in_person' AND "teacherRoomId" IS NOT NULL AND "videoUrl" IS NULL)
  OR ("format" = 'online' AND "teacherRoomId" IS NULL AND NOT "roomArchived" AND "roomCost" = 0));
