-- missed_you is retired (#661): the payment_request body now carries the explanation.
-- AlterEnum
BEGIN;
-- Delete before the cast, which fails on a row holding a value the new type lacks.
-- No code path ever created one, so the notice is expected to stay silent.
DO $$
DECLARE
  affected INT;
BEGIN
  DELETE FROM "Notification" WHERE "type" = 'missed_you';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE NOTICE 'issue 661: deleted % missed_you notification(s) before retiring the type', affected;
  END IF;
END $$;
CREATE TYPE "NotificationType_new" AS ENUM ('booking_confirmed', 'booking_cancelled', 'booking_removed', 'class_cancelled', 'payment_received', 'payment_request', 'waitlist_promoted', 'spot_available', 'reminder', 'announcement', 'teacher_invitation');
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType_new" USING ("type"::text::"NotificationType_new");
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
DROP TYPE "public"."NotificationType_old";
COMMIT;
