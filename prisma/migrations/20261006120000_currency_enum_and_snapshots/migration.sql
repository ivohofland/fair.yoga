-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('EUR', 'GBP', 'USD', 'CHF', 'SEK', 'NOK', 'DKK');

-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'EUR';

-- A free-text code outside the enum stays at the column default, EUR.
DO $$
DECLARE
  n INT;
BEGIN
  UPDATE "Teacher"
     SET "currency" = "defaultCurrency"::"Currency"
   WHERE "defaultCurrency" IN ('EUR', 'GBP', 'USD', 'CHF', 'SEK', 'NOK', 'DKK');
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'currency: copied % teacher currency value(s) into the enum column', n;
END $$;

ALTER TABLE "Teacher" DROP COLUMN "defaultCurrency";

-- AlterTable
ALTER TABLE "Class" ADD COLUMN "currency" "Currency";
ALTER TABLE "StudioClass" ADD COLUMN "currency" "Currency";

DO $$
DECLARE
  n INT;
BEGIN
  UPDATE "Class" c
     SET "currency" = t."currency"
    FROM "CalendarEntry" e
    JOIN "Teacher" t ON t."id" = e."teacherId"
   WHERE e."id" = c."calendarEntryId";
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'currency: stamped % class row(s) from their teacher', n;

  UPDATE "StudioClass" s
     SET "currency" = t."currency"
    FROM "CalendarEntry" e
    JOIN "Teacher" t ON t."id" = e."teacherId"
   WHERE e."id" = s."calendarEntryId";
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'currency: stamped % studio class row(s) from their teacher', n;
END $$;

ALTER TABLE "Class" ALTER COLUMN "currency" SET NOT NULL;
ALTER TABLE "StudioClass" ALTER COLUMN "currency" SET NOT NULL;
