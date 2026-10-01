-- Teacher-side notification preferences: an inbox/email choice for new bookings and two email toggles.

-- CreateEnum
CREATE TYPE "TeacherBookingNotifications" AS ENUM ('inbox_and_email', 'inbox_only', 'off');

-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN     "bookingNotifications" "TeacherBookingNotifications" NOT NULL DEFAULT 'inbox_and_email',
ADD COLUMN     "emailOnClassCompleted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "emailOnInvitation" BOOLEAN NOT NULL DEFAULT true;
