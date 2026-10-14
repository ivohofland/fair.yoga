-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "lateCancelledAt" TIMESTAMP(3);

-- DML WITHOUT NOTICE: backfills the column added above. A booking was late-cancelled when it carries
-- cancelledAt without being cancelled: a free cancel and an erasure write `cancelled`, re-booking clears
-- cancelledAt, and attendance can move a late cancel on to attended or no_show without clearing it.
UPDATE "Registration" SET "lateCancelledAt" = "cancelledAt"
 WHERE "cancelledAt" IS NOT NULL AND "status" <> 'cancelled';
