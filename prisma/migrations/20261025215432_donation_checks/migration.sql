-- Invariants, DB-enforced, for donation-based classes (#912). A total is
-- never negative and exists only on a donation class; a prompt is hidden
-- only after its booking was invited. "Only a donation class's bookings are
-- invited" reads the Class row, so no CHECK can hold it: the two writers of
-- "donationInvitedAt" gate on the class's mode instead.
ALTER TABLE "Class" ADD CONSTRAINT "Class_donation_total_nonnegative_check"
  CHECK ("donationTotal" IS NULL OR "donationTotal" >= 0);
ALTER TABLE "Class" ADD CONSTRAINT "Class_donation_total_mode_check"
  CHECK ("donationTotal" IS NULL OR "pricingMode" = 'donation');
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_donation_hidden_requires_invited_check"
  CHECK ("donationPromptHiddenAt" IS NULL OR "donationInvitedAt" IS NOT NULL);
