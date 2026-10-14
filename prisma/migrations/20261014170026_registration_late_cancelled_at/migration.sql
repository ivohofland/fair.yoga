-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "lateCancelledAt" TIMESTAMP(3);

-- Backfill: every booking standing late-cancelled now was late-cancelled at its cancelledAt.
UPDATE "Registration" SET "lateCancelledAt" = "cancelledAt" WHERE "status" = 'late_cancel';
