-- Invariant, DB-enforced: an income tier is one of five discrete bands.
-- TypeScript's IncomeTier (src/lib/tiers.ts) stops new code from writing
-- anything else; this stops everything else — a psql session, a data fix,
-- a future route that forgets to validate. Without it, `toIncomeTier`'s
-- degrade-and-warn fallback silently becomes load-bearing.
ALTER TABLE "Student" ADD CONSTRAINT "Student_income_tier_check"
  CHECK ("incomeTier" BETWEEN 1 AND 5);

ALTER TABLE "Registration" ADD CONSTRAINT "Registration_tier_at_booking_check"
  CHECK ("tierAtBooking" BETWEEN 1 AND 5);
