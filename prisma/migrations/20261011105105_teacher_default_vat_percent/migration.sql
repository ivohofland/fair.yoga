-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN     "defaultVatPercent" DECIMAL(6,3) NOT NULL DEFAULT 0;

-- Hand-authored: Prisma cannot express a CHECK. The wire refuses the same
-- range with copy (`vatPercentViolation`); this holds it for every writer.
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_default_vat_percent_range_check"
  CHECK ("defaultVatPercent" >= 0 AND "defaultVatPercent" <= 100);
