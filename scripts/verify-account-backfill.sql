-- Run against a production snapshot BEFORE deploying the account_hybrid
-- migration (to see what the backfill will do), and against production
-- AFTER, to verify the invariants. All counts must be zero.
SELECT 'teachers without account' AS invariant, count(*) FROM "Teacher" WHERE "accountId" IS NULL;
SELECT 'claimed students without account', count(*) FROM "Student" WHERE "claimedAt" IS NOT NULL AND "accountId" IS NULL;
SELECT 'sessions without account', count(*) FROM "Session" s
  WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = s."accountId");
SELECT 'passkeys without account', count(*) FROM "PasskeyCredential" pc
  WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = pc."accountId");
SELECT 'duplicate emails across accounts', count(*) FROM (
  SELECT email FROM "Account" GROUP BY email HAVING count(*) > 1
) d;
