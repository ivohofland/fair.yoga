-- Blank bank fields become NULL, then an IBAN with no account holder name is
-- cleared, so that every existing row satisfies the two CHECKs added below.
DO $$
DECLARE
  affected INT;
BEGIN
  UPDATE "Teacher" SET "bankIban" = NULL WHERE btrim("bankIban") = '';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE 'teacher bank fields: set % blank bankIban value(s) to NULL', affected;

  UPDATE "Teacher" SET "bankAccountName" = NULL WHERE btrim("bankAccountName") = '';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE 'teacher bank fields: set % blank bankAccountName value(s) to NULL', affected;

  UPDATE "Teacher" SET "bankIban" = NULL WHERE "bankIban" IS NOT NULL AND "bankAccountName" IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE 'teacher bank fields: cleared % bankIban value(s) stored without an account holder name', affected;
END $$;

-- A stored IBAN is never blank.
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_bank_iban_not_blank_check"
  CHECK ("bankIban" IS NULL OR btrim("bankIban") <> '');

-- A stored IBAN always has a non-blank account holder name beside it.
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_bank_holder_name_check"
  CHECK ("bankIban" IS NULL OR ("bankAccountName" IS NOT NULL AND btrim("bankAccountName") <> ''));
