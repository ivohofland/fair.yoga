-- Invariant, DB-enforced: the two email columns #166 added are lowercase.
-- Everything about acceptance-gated linking is keyed on them matching an
-- address someone typed somewhere else — `@@unique([teacherId, email])`,
-- `listPendingInvitations`, `acceptInvitation`, `notifyInvitee`,
-- `resolveInvitationOnLink`, `unlinkTeacher` — and every one of those
-- lowercases the person-supplied side in JS before querying, which is only
-- correct because the stored side is already lowercase. Today that holds by
-- convention at roughly seven call sites; drop one and nothing throws, the
-- teacher just sees a pending invitation the student is never shown.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_email_lowercase_check"
  CHECK (email = lower(email));

ALTER TABLE "TeacherBlock" ADD CONSTRAINT "TeacherBlock_email_lowercase_check"
  CHECK (email = lower(email));

-- Invariant, DB-enforced: a pending invitation has no response time, and a
-- responded one has one. Four writers maintain it (`acceptInvitation`,
-- `declineInvitation`, `unlinkTeacher`, `resolveInvitationOnLink`) plus the
-- revive in `inviteContact`, which is the one that made this worth pinning:
-- it moves a row BACK to `pending`, so it is the only write in the codebase
-- that has to clear the column rather than set it. A future writer that
-- forgets leaves an accepted-looking timestamp on a row the student has not
-- answered.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_responded_at_status_check"
  CHECK (("respondedAt" IS NULL) = (status = 'pending'));
