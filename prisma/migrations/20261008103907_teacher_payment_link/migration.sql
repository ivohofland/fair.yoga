-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN     "paymentLink" TEXT;

-- A payment link is shown to students as a link: only https, bounded.
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_payment_link_check"
  CHECK ("paymentLink" IS NULL OR ("paymentLink" LIKE 'https://%' AND char_length("paymentLink") <= 500));
