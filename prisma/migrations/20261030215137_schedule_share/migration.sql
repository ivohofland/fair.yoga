/*
  Warnings:

  - A unique constraint covering the columns `[scheduleShareKey]` on the table `Teacher` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "StudioClass" ADD COLUMN     "bookingUrl" TEXT;

-- AlterTable
ALTER TABLE "StudioClassTemplate" ADD COLUMN     "bookingUrl" TEXT;

-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN     "scheduleShareKey" TEXT,
ADD COLUMN     "scheduleShareStudio" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scheduleShareWeeks" INTEGER NOT NULL DEFAULT 4;

-- CreateIndex
CREATE UNIQUE INDEX "Teacher_scheduleShareKey_key" ON "Teacher"("scheduleShareKey");

-- The shared schedule shows one to four weeks ahead.
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_schedule_share_weeks_range"
  CHECK ("scheduleShareWeeks" BETWEEN 1 AND 4);
