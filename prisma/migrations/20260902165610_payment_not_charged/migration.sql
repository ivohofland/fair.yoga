-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'not_charged';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "notChargedAt" TIMESTAMP(3);
