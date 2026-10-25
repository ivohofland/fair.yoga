-- CreateEnum
CREATE TYPE "PricingMode" AS ENUM ('tiered', 'donation');

-- AlterTable
ALTER TABLE "Class" ADD COLUMN     "donationTotal" DECIMAL(10,2),
ADD COLUMN     "pricingMode" "PricingMode" NOT NULL DEFAULT 'tiered';

-- AlterTable
ALTER TABLE "ClassTemplate" ADD COLUMN     "pricingMode" "PricingMode" NOT NULL DEFAULT 'tiered';

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "donationInvitedAt" TIMESTAMP(3),
ADD COLUMN     "donationPromptHiddenAt" TIMESTAMP(3);
