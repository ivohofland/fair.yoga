-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "pushHandledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "pushAnnouncements" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pushClassChanges" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pushClassReminders" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pushInvitations" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pushPayments" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pushWaitlist" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN     "pushAutoCancelled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pushBookings" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pushClassCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pushClassReminders" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pushInvitations" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_accountId_idx" ON "PushSubscription"("accountId");

-- CreateIndex
CREATE INDEX "Notification_pushHandledAt_createdAt_idx" ON "Notification"("pushHandledAt", "createdAt");
