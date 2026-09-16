-- Run against a production snapshot BEFORE deploying the account_hybrid
-- migration (to see what the backfill will do), and against production
-- AFTER, to verify the invariants below. Re-run the
-- 'Teacher_account_live_unique missing or non-partial' and
-- 'Student_account_live_unique missing or non-partial' checks after the
-- live_profile_unique_per_account migration (#623) to confirm its two
-- partial unique indexes are in place. On a database that has that
-- migration applied, all counts must be zero; run before it, those two
-- checks return 1.
SELECT 'teachers without account' AS invariant, count(*) FROM "Teacher" WHERE "accountId" IS NULL;
SELECT 'claimed students without account', count(*) FROM "Student" WHERE "claimedAt" IS NOT NULL AND "accountId" IS NULL;
SELECT 'sessions without account', count(*) FROM "Session" s
  WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = s."accountId");
SELECT 'passkeys without account', count(*) FROM "PasskeyCredential" pc
  WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = pc."accountId");
SELECT 'duplicate emails across accounts', count(*) FROM (
  SELECT email FROM "Account" GROUP BY email HAVING count(*) > 1
) d;
SELECT 'Teacher_account_live_unique missing or non-partial' AS invariant,
  1 - count(*) FROM pg_indexes
  WHERE indexname = 'Teacher_account_live_unique'
    AND indexdef LIKE '%WHERE ("deletedAt" IS NULL)%';
SELECT 'Student_account_live_unique missing or non-partial' AS invariant,
  1 - count(*) FROM pg_indexes
  WHERE indexname = 'Student_account_live_unique'
    AND indexdef LIKE '%WHERE ("deletedAt" IS NULL)%';
