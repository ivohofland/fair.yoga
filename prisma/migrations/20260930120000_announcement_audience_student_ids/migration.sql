-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN "audienceStudentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
