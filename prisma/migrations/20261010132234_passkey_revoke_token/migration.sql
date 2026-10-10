-- CreateTable
CREATE TABLE "PasskeyRevokeToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasskeyRevokeToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyRevokeToken_tokenHash_key" ON "PasskeyRevokeToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasskeyRevokeToken_accountId_idx" ON "PasskeyRevokeToken"("accountId");
