-- AlterTable
ALTER TABLE "PayoutChangeEvent" ADD COLUMN     "identifierChanged" BOOLEAN;

-- CreateTable
CREATE TABLE "RemovedPasskey" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "credentialCreatedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemovedPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemovedPasskey_accountId_idx" ON "RemovedPasskey"("accountId");
