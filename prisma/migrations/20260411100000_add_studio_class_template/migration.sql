-- CreateTable
CREATE TABLE "StudioClassTemplate" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "hourlyRate" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudioClassTemplate_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "StudioClassTemplate" ADD CONSTRAINT "StudioClassTemplate_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add templateId to StudioClass
ALTER TABLE "StudioClass" ADD COLUMN "templateId" TEXT;

-- AddForeignKey
ALTER TABLE "StudioClass" ADD CONSTRAINT "StudioClass_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "StudioClassTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
