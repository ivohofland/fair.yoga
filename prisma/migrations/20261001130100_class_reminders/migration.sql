-- CreateEnum
CREATE TYPE "ReminderTiming" AS ENUM ('evening_before', 'morning_of', 'one_hour_before', 'off');

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('inbox', 'email', 'inbox_and_email');

-- Teacher: rename and retype; every old value exists in the new enum.
ALTER TABLE "Teacher" RENAME COLUMN "defaultReminder" TO "classReminder";
ALTER TABLE "Teacher" ALTER COLUMN "classReminder" DROP DEFAULT;
ALTER TABLE "Teacher" ALTER COLUMN "classReminder" TYPE "ReminderTiming"
  USING ("classReminder"::text::"ReminderTiming");
ALTER TABLE "Teacher" ALTER COLUMN "classReminder" SET DEFAULT 'morning_of';
ALTER TABLE "Teacher" ADD COLUMN "classReminderChannel" "ReminderChannel" NOT NULL DEFAULT 'inbox_and_email';

-- Student: rename and retype through an explicit value map, with no ELSE, so an
-- unmapped value fails the NOT NULL column instead of becoming a default.
ALTER TABLE "Student" RENAME COLUMN "reminderPref" TO "classReminder";
ALTER TABLE "Student" ALTER COLUMN "classReminder" DROP DEFAULT;
ALTER TABLE "Student" ALTER COLUMN "classReminder" TYPE "ReminderTiming"
  USING (CASE "classReminder"::text
           WHEN 'eve' THEN 'evening_before'
           WHEN 'morning' THEN 'morning_of'
           WHEN 'one_hour' THEN 'one_hour_before'
           WHEN 'off' THEN 'off'
         END)::"ReminderTiming";
ALTER TABLE "Student" ALTER COLUMN "classReminder" SET DEFAULT 'morning_of';
ALTER TABLE "Student" ADD COLUMN "classReminderChannel" "ReminderChannel" NOT NULL DEFAULT 'inbox_and_email';

-- DropEnum
DROP TYPE "ReminderPref";
DROP TYPE "StudentReminderPref";

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN "classReminderSentAt" TIMESTAMP(3);
ALTER TABLE "Class" ADD COLUMN "teacherReminderSentAt" TIMESTAMP(3);
