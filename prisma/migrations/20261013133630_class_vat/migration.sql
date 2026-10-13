-- AlterTable
ALTER TABLE "Class" ADD COLUMN     "vatPercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
ADD COLUMN     "vatTotal" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "ClassTemplate" ADD COLUMN     "vatPercent" DECIMAL(6,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "vatAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Hand-authored: Prisma cannot express a CHECK.
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_vat_percent_range_check"
  CHECK ("vatPercent" >= 0 AND "vatPercent" <= 100);
ALTER TABLE "Class" ADD CONSTRAINT "Class_vat_percent_range_check"
  CHECK ("vatPercent" >= 0 AND "vatPercent" <= 100);

-- Every class completed before this migration was priced at 0% VAT.
-- DML WITHOUT NOTICE: sets the new column to the 0% the class was already priced at; no row changes meaning.
UPDATE "Class" SET "vatTotal" = 0 WHERE "totalRevenue" IS NOT NULL;

ALTER TABLE "Class" ADD CONSTRAINT "Class_vat_total_nonnegative_check"
  CHECK ("vatTotal" >= 0);
ALTER TABLE "Class" ADD CONSTRAINT "Class_vat_total_snapshot_check"
  CHECK (("vatTotal" IS NULL) = ("totalRevenue" IS NULL));
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_vat_amount_range_check"
  CHECK ("vatAmount" >= 0 AND "vatAmount" <= "amount");
