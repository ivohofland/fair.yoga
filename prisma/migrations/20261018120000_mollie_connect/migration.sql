-- CreateEnum
CREATE TYPE "ProcessorPaymentStatus" AS ENUM ('open', 'pending', 'authorized', 'paid', 'canceled', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "ProcessorRefundStatus" AS ENUM ('queued', 'pending', 'processing', 'refunded', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "RefundOutcome" AS ENUM ('waived', 'reopened');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'processor_disconnected';
ALTER TYPE "NotificationType" ADD VALUE 'payment_paid_twice';
ALTER TYPE "NotificationType" ADD VALUE 'payment_charged_back';
ALTER TYPE "NotificationType" ADD VALUE 'refund_failed';
ALTER TYPE "NotificationType" ADD VALUE 'payment_refunded';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PayoutChangeKind" ADD VALUE 'processor_connected';
ALTER TYPE "PayoutChangeKind" ADD VALUE 'processor_changed';
ALTER TYPE "PayoutChangeKind" ADD VALUE 'processor_disconnected';

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "processorRef";

-- AlterTable
ALTER TABLE "Teacher" DROP COLUMN "paymentLevel",
DROP COLUMN "processorAccountId",
DROP COLUMN "processorType";

-- DropEnum
DROP TYPE "PaymentLevel";

-- CreateTable
CREATE TABLE "ProcessorConnection" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "processor" "ProcessorType" NOT NULL,
    "organizationId" TEXT NOT NULL,
    "profileId" TEXT,
    "accessToken" BYTEA,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshToken" BYTEA,
    "scopes" TEXT[],
    "testmode" BOOLEAN NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "revokeAfter" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ProcessorConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessorPayment" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "connectionId" TEXT,
    "processorPaymentId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" "ProcessorPaymentStatus" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "checkoutUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "settledPayment" BOOLEAN NOT NULL DEFAULT false,
    "chargedBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessorPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessorRefund" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "processorRefundId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "ProcessorRefundStatus" NOT NULL,
    "outcome" "RefundOutcome",
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessorRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessorConnection_teacherId_key" ON "ProcessorConnection"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessorPayment_processorPaymentId_key" ON "ProcessorPayment"("processorPaymentId");

-- CreateIndex
CREATE INDEX "ProcessorPayment_paymentId_idx" ON "ProcessorPayment"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessorRefund_processorRefundId_key" ON "ProcessorRefund"("processorRefundId");

-- CreateIndex
CREATE INDEX "ProcessorRefund_attemptId_idx" ON "ProcessorRefund"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_stateHash_key" ON "OAuthState"("stateHash");

-- AddForeignKey
ALTER TABLE "ProcessorConnection" ADD CONSTRAINT "ProcessorConnection_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessorPayment" ADD CONSTRAINT "ProcessorPayment_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessorPayment" ADD CONSTRAINT "ProcessorPayment_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProcessorConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessorRefund" ADD CONSTRAINT "ProcessorRefund_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ProcessorPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A connection holds both tokens and their expiry until it is revoked.
ALTER TABLE "ProcessorConnection" ADD CONSTRAINT "ProcessorConnection_tokens_present_check"
  CHECK ("revokedAt" IS NOT NULL OR ("accessToken" IS NOT NULL AND "refreshToken" IS NOT NULL AND "accessTokenExpiresAt" IS NOT NULL));

-- A revoked connection holds no token.
ALTER TABLE "ProcessorConnection" ADD CONSTRAINT "ProcessorConnection_tokens_absent_check"
  CHECK ("revokedAt" IS NULL OR ("accessToken" IS NULL AND "refreshToken" IS NULL AND "accessTokenExpiresAt" IS NULL));

-- Revocation is scheduled and recorded only on a disconnected connection.
ALTER TABLE "ProcessorConnection" ADD CONSTRAINT "ProcessorConnection_revoke_check"
  CHECK ("disconnectedAt" IS NOT NULL OR ("revokeAfter" IS NULL AND "revokedAt" IS NULL));

-- At most one attempt settled each payment.
CREATE UNIQUE INDEX "ProcessorPayment_one_settling_per_payment" ON "ProcessorPayment"("paymentId") WHERE "settledPayment";

-- At most one refund per attempt that has not failed or been canceled.
CREATE UNIQUE INDEX "ProcessorRefund_one_live_per_attempt" ON "ProcessorRefund"("attemptId") WHERE "status" NOT IN ('failed', 'canceled');
