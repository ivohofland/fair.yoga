-- Each currency sets exactly its scheme's columns, the required ones
-- non-blank, the others NULL. A currency this CHECK does not name is refused.
ALTER TABLE "TeacherBankAccount" DROP CONSTRAINT "TeacherBankAccount_scheme_check";
ALTER TABLE "TeacherBankAccount" ADD CONSTRAINT "TeacherBankAccount_scheme_check" CHECK (
  btrim("holderName") <> ''
  AND ("bic" IS NULL OR btrim("bic") <> '')
  AND CASE
    WHEN "currency" IN ('EUR', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'ILS', 'AED') THEN
      "iban" IS NOT NULL AND btrim("iban") <> ''
      AND "sortCode" IS NULL AND "accountNumber" IS NULL AND "routingNumber" IS NULL AND "bankCode" IS NULL
    WHEN "currency" = 'GBP' THEN
      "sortCode" IS NOT NULL AND btrim("sortCode") <> ''
      AND "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "routingNumber" IS NULL AND "bankCode" IS NULL
    WHEN "currency" = 'USD' THEN
      "routingNumber" IS NOT NULL AND btrim("routingNumber") <> ''
      AND "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "sortCode" IS NULL AND "bankCode" IS NULL
    WHEN "currency" IN ('AUD', 'CAD', 'INR', 'SGD', 'HKD', 'ZAR', 'BRL') THEN
      "bankCode" IS NOT NULL AND btrim("bankCode") <> ''
      AND "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "sortCode" IS NULL AND "routingNumber" IS NULL
    WHEN "currency" IN ('NZD', 'MXN') THEN
      "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "sortCode" IS NULL AND "routingNumber" IS NULL AND "bankCode" IS NULL
    ELSE false
  END
);
