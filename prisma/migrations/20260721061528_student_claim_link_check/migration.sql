-- Invariant, DB-enforced: a student is claimed exactly when it is linked
-- to an account. Three write sites maintain this today; the constraint
-- covers every future one.
ALTER TABLE "Student" ADD CONSTRAINT "Student_claim_link_check"
  CHECK (("claimedAt" IS NULL) = ("accountId" IS NULL));
