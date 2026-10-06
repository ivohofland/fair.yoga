-- CreateTable
CREATE TABLE "TeacherBankAccount" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "holderName" TEXT NOT NULL,
    "iban" TEXT,
    "bic" TEXT,
    "sortCode" TEXT,
    "accountNumber" TEXT,
    "routingNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherBankAccount_teacherId_currency_key" ON "TeacherBankAccount"("teacherId", "currency");

-- AddForeignKey
ALTER TABLE "TeacherBankAccount" ADD CONSTRAINT "TeacherBankAccount_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every row names a non-blank holder; a stored BIC is never blank; and each
-- currency sets exactly its scheme's columns: the required ones non-blank,
-- the others NULL. A currency this CHECK does not name is refused.
ALTER TABLE "TeacherBankAccount" ADD CONSTRAINT "TeacherBankAccount_scheme_check" CHECK (
  btrim("holderName") <> ''
  AND ("bic" IS NULL OR btrim("bic") <> '')
  AND CASE
    WHEN "currency" IN ('EUR', 'CHF', 'SEK', 'NOK', 'DKK') THEN
      "iban" IS NOT NULL AND btrim("iban") <> ''
      AND "sortCode" IS NULL AND "accountNumber" IS NULL AND "routingNumber" IS NULL
    WHEN "currency" = 'GBP' THEN
      "sortCode" IS NOT NULL AND btrim("sortCode") <> ''
      AND "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "routingNumber" IS NULL
    WHEN "currency" = 'USD' THEN
      "routingNumber" IS NOT NULL AND btrim("routingNumber") <> ''
      AND "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "sortCode" IS NULL
    ELSE false
  END
);

-- Each teacher's IBAN and holder name, where both are set, become that
-- teacher's EUR account: the IBAN without whitespace and uppercased, the
-- holder name trimmed.
DO $$
DECLARE
  affected INT;
BEGIN
  INSERT INTO "TeacherBankAccount" ("id", "teacherId", "currency", "holderName", "iban", "updatedAt")
  SELECT
    gen_random_uuid()::text,
    t."id",
    'EUR',
    btrim(t."bankAccountName", E' \t\r\n'),
    upper(regexp_replace(t."bankIban", '\s', '', 'g')),
    CURRENT_TIMESTAMP
  FROM "Teacher" t
  WHERE regexp_replace(coalesce(t."bankIban", ''), '\s', '', 'g') <> ''
    AND btrim(coalesce(t."bankAccountName", ''), E' \t\r\n') <> '';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE 'teacher bank accounts: copied % teacher IBAN(s) into EUR accounts', affected;
END $$;

-- The teacher's own bank columns, and the CHECKs that paired them, go.
ALTER TABLE "Teacher" DROP CONSTRAINT "Teacher_bank_holder_name_check";
ALTER TABLE "Teacher" DROP CONSTRAINT "Teacher_bank_iban_not_blank_check";

-- AlterTable
ALTER TABLE "Teacher" DROP COLUMN "bankAccountName",
DROP COLUMN "bankIban";
