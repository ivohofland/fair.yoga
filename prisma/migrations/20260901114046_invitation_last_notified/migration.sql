-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "lastNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "lastNotifiedEmail" TEXT;

-- Invariant, DB-enforced: the delivery-attempt marker is lowercase, matching
-- every other email column on this table (Invitation_email_lowercase_check).
-- Written by `deliverInvitation`'s two callers (POST /api/students,
-- POST /api/invitations/[id]/resend, #173) from an already-normalised value
-- — this asserts that precondition rather than re-normalising.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_last_notified_email_lowercase_check"
  CHECK ("lastNotifiedEmail" IS NULL OR "lastNotifiedEmail" = lower("lastNotifiedEmail"));

-- Invariant, DB-enforced: the marker is written unconditionally, in one
-- statement, both fields or neither — same paired-nullability shape as
-- Invitation_responded_at_status_check. A future writer that sets only one
-- would leave a timestamp with no address to explain it, or an address
-- with no time to date it.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_last_notified_pair_check"
  CHECK (("lastNotifiedAt" IS NULL) = ("lastNotifiedEmail" IS NULL));
