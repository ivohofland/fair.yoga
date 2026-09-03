-- AlterTable
ALTER TABLE "MagicLinkToken" ADD COLUMN     "handoffAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "handoffCode" TEXT,
ADD COLUMN     "originBrowserHash" TEXT;

-- CreateIndex
CREATE INDEX "MagicLinkToken_originBrowserHash_idx" ON "MagicLinkToken"("originBrowserHash");
