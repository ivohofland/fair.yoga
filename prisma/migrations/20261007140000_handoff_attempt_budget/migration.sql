-- CreateTable
CREATE TABLE "HandoffAttemptBudget" (
    "email" TEXT NOT NULL,
    "windowStartsAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL,

    CONSTRAINT "HandoffAttemptBudget_pkey" PRIMARY KEY ("email")
);

-- Every stored email address is lowercase (#170).
ALTER TABLE "HandoffAttemptBudget" ADD CONSTRAINT "HandoffAttemptBudget_email_lowercase_check"
  CHECK (email = lower(email));
