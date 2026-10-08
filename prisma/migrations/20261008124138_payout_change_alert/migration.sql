-- CreateEnum
CREATE TYPE "PayoutChangeKind" AS ENUM ('bank_account_added', 'bank_account_changed', 'bank_account_removed', 'payment_link_added', 'payment_link_changed', 'payment_link_removed');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "passkeyCredentialId" TEXT;

-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN     "pausePasskeyCutoff" TIMESTAMP(3),
ADD COLUMN     "pauseWindowStart" TIMESTAMP(3),
ADD COLUMN     "paymentsPausedAt" TIMESTAMP(3),
ADD COLUMN     "paymentsResumedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PayoutChangeEvent" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "kind" "PayoutChangeKind" NOT NULL,
    "accountCurrency" "Currency",
    "before" TEXT,
    "after" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutPauseToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutPauseToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutChangeEvent_teacherId_createdAt_idx" ON "PayoutChangeEvent"("teacherId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutPauseToken_tokenHash_key" ON "PayoutPauseToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PayoutPauseToken_teacherId_idx" ON "PayoutPauseToken"("teacherId");

-- AddForeignKey
ALTER TABLE "PayoutChangeEvent" ADD CONSTRAINT "PayoutChangeEvent_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutPauseToken" ADD CONSTRAINT "PayoutPauseToken_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutPauseToken" ADD CONSTRAINT "PayoutPauseToken_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "PayoutChangeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_passkeyCredentialId_fkey" FOREIGN KEY ("passkeyCredentialId") REFERENCES "PasskeyCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
