-- AlterTable
ALTER TABLE "ClassTemplate" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "withdrawnCount" INTEGER;

-- AlterTable
ALTER TABLE "StudioClassTemplate" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "withdrawnCount" INTEGER;
