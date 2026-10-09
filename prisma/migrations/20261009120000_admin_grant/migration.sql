-- CreateTable
CREATE TABLE "AdminGrant" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,

    CONSTRAINT "AdminGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminGrant_accountId_idx" ON "AdminGrant"("accountId");

-- AddForeignKey
ALTER TABLE "AdminGrant" ADD CONSTRAINT "AdminGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one grant per account with "revokedAt" IS NULL.
CREATE UNIQUE INDEX "AdminGrant_account_active_unique" ON "AdminGrant"("accountId") WHERE "revokedAt" IS NULL;

-- "revokedAt" and "revokedBy" are both null or both set.
ALTER TABLE "AdminGrant" ADD CONSTRAINT "AdminGrant_revoke_pair_check" CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL));
