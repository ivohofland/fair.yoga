-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "lateCancelledAt" TIMESTAMP(3);

-- DML WITHOUT NOTICE: backfills the column added above; every booking standing late-cancelled now was late-cancelled at its cancelledAt.
UPDATE "Registration" SET "lateCancelledAt" = "cancelledAt" WHERE "status" = 'late_cancel';
