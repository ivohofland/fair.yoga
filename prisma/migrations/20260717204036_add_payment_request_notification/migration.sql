-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'payment_request';

-- AlterTable
ALTER TABLE "StudioClassTemplate" ALTER COLUMN "classType" DROP DEFAULT;
