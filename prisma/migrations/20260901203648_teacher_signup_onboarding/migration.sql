-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('profile', 'bank', 'share');

-- CreateEnum
CREATE TYPE "MagicLinkPurpose" AS ENUM ('sign_in', 'teacher_signup', 'teacher_profile_pending');

-- AlterTable
ALTER TABLE "MagicLinkToken" ADD COLUMN     "purpose" "MagicLinkPurpose" NOT NULL DEFAULT 'sign_in';

-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN     "skippedOnboarding" "OnboardingStep"[] DEFAULT ARRAY[]::"OnboardingStep"[];
