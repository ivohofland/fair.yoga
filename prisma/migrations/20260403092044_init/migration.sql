-- CreateEnum
CREATE TYPE "ReminderPref" AS ENUM ('morning_of', 'evening_before', 'one_hour_before');

-- CreateEnum
CREATE TYPE "PaymentLevel" AS ENUM ('LEVEL_1', 'LEVEL_2');

-- CreateEnum
CREATE TYPE "ProcessorType" AS ENUM ('mollie', 'stripe');

-- CreateEnum
CREATE TYPE "StudentReminderPref" AS ENUM ('eve', 'morning', 'one_hour', 'off');

-- CreateEnum
CREATE TYPE "CancelDeadline" AS ENUM ('HOURS_48', 'HOURS_24', 'HOURS_12', 'HOURS_6');

-- CreateEnum
CREATE TYPE "AutoCancelCheck" AS ENUM ('HOURS_4', 'HOURS_2', 'HOURS_1');

-- CreateEnum
CREATE TYPE "ClassStatus" AS ENUM ('draft', 'open', 'full', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('registered', 'attended', 'no_show', 'late_cancel', 'cancelled');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('waiting', 'promoted', 'claimed', 'expired', 'removed');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'paid', 'overdue');

-- CreateEnum
CREATE TYPE "RecipientType" AS ENUM ('teacher', 'student');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('booking_confirmed', 'class_cancelled', 'payment_received', 'waitlist_promoted', 'spot_available', 'reminder', 'missed_you', 'announcement');

-- CreateTable
CREATE TABLE "Teacher" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "photoUrl" TEXT,
    "bio" VARCHAR(250) NOT NULL,
    "pageSlug" TEXT NOT NULL,
    "customDomain" TEXT,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "defaultTimezone" TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
    "defaultReminder" "ReminderPref" NOT NULL DEFAULT 'morning_of',
    "paymentLevel" "PaymentLevel" NOT NULL DEFAULT 'LEVEL_1',
    "bankIban" TEXT,
    "bankAccountName" TEXT,
    "processorType" "ProcessorType",
    "processorAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Teacher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "incomeTier" INTEGER NOT NULL DEFAULT 3,
    "phone" TEXT,
    "birthday" DATE,
    "address" TEXT,
    "reminderPref" "StudentReminderPref" NOT NULL DEFAULT 'morning',
    "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentPrivacy" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "shareEmail" BOOLEAN NOT NULL DEFAULT false,
    "sharePhone" BOOLEAN NOT NULL DEFAULT false,
    "shareBirthday" BOOLEAN NOT NULL DEFAULT false,
    "shareAddress" BOOLEAN NOT NULL DEFAULT false,
    "receiveComms" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentPrivacy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "venueName" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "postcode" TEXT NOT NULL,
    "floor" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "maxCapacity" INTEGER NOT NULL,
    "equipment" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherRoom" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "capacityOverride" INTEGER NOT NULL,
    "rentalRate" DECIMAL(10,2) NOT NULL,
    "equipmentNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassTemplate" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "teacherRoomId" TEXT NOT NULL,
    "classType" TEXT NOT NULL,
    "description" TEXT,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "roomCost" DECIMAL(10,2) NOT NULL,
    "minRate" DECIMAL(10,2) NOT NULL,
    "targetRate" DECIMAL(10,2) NOT NULL,
    "minStudents" INTEGER NOT NULL,
    "maxStudents" INTEGER NOT NULL,
    "cancelDeadline" "CancelDeadline" NOT NULL DEFAULT 'HOURS_24',
    "autoCancelCheck" "AutoCancelCheck" NOT NULL DEFAULT 'HOURS_2',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Class" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "teacherRoomId" TEXT NOT NULL,
    "templateId" TEXT,
    "classType" TEXT NOT NULL,
    "description" TEXT,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "roomCost" DECIMAL(10,2) NOT NULL,
    "minRate" DECIMAL(10,2) NOT NULL,
    "targetRate" DECIMAL(10,2) NOT NULL,
    "minStudents" INTEGER NOT NULL,
    "maxStudents" INTEGER NOT NULL,
    "cancelDeadline" "CancelDeadline" NOT NULL DEFAULT 'HOURS_24',
    "autoCancelCheck" "AutoCancelCheck" NOT NULL DEFAULT 'HOURS_2',
    "status" "ClassStatus" NOT NULL DEFAULT 'draft',
    "settingsLocked" BOOLEAN NOT NULL DEFAULT false,
    "effectiveTeacherRate" DECIMAL(10,2),
    "totalStudents" INTEGER,
    "totalRevenue" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Class_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioClass" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "studentCount" INTEGER,
    "hourlyRate" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudioClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Registration" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'registered',
    "isWalkIn" BOOLEAN NOT NULL DEFAULT false,
    "tierAtBooking" INTEGER NOT NULL,
    "price" DECIMAL(10,2),
    "tierRatio" DECIMAL(5,4),
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'waiting',
    "promotedAt" TIMESTAMP(3),
    "registrationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "method" TEXT,
    "processorRef" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "recipientType" "RecipientType" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "relatedClassId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "emailSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "classId" TEXT,
    "message" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Teacher_email_key" ON "Teacher"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Teacher_pageSlug_key" ON "Teacher"("pageSlug");

-- CreateIndex
CREATE UNIQUE INDEX "Student_email_key" ON "Student"("email");

-- CreateIndex
CREATE UNIQUE INDEX "StudentPrivacy_studentId_teacherId_key" ON "StudentPrivacy"("studentId", "teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "Room_address_roomName_key" ON "Room"("address", "roomName");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherRoom_teacherId_roomId_key" ON "TeacherRoom"("teacherId", "roomId");

-- CreateIndex
CREATE INDEX "Class_teacherId_date_idx" ON "Class"("teacherId", "date");

-- CreateIndex
CREATE INDEX "Registration_studentId_status_idx" ON "Registration"("studentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Registration_classId_studentId_key" ON "Registration"("classId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_registrationId_key" ON "WaitlistEntry"("registrationId");

-- CreateIndex
CREATE INDEX "WaitlistEntry_classId_position_idx" ON "WaitlistEntry"("classId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_classId_studentId_key" ON "WaitlistEntry"("classId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_registrationId_key" ON "Payment"("registrationId");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_recipientType_recipientId_isRead_idx" ON "Notification"("recipientType", "recipientId", "isRead");

-- AddForeignKey
ALTER TABLE "StudentPrivacy" ADD CONSTRAINT "StudentPrivacy_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPrivacy" ADD CONSTRAINT "StudentPrivacy_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherRoom" ADD CONSTRAINT "TeacherRoom_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherRoom" ADD CONSTRAINT "TeacherRoom_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_teacherRoomId_fkey" FOREIGN KEY ("teacherRoomId") REFERENCES "TeacherRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Class" ADD CONSTRAINT "Class_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Class" ADD CONSTRAINT "Class_teacherRoomId_fkey" FOREIGN KEY ("teacherRoomId") REFERENCES "TeacherRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Class" ADD CONSTRAINT "Class_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClassTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudioClass" ADD CONSTRAINT "StudioClass_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_relatedClassId_fkey" FOREIGN KEY ("relatedClassId") REFERENCES "Class"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE SET NULL ON UPDATE CASCADE;
