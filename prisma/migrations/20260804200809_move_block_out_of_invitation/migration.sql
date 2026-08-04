/*
  Warnings:

  - You are about to drop the column `origin` on the `Invitation` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Invitation" DROP COLUMN "origin";

-- DropEnum
DROP TYPE "InvitationOrigin";

-- CreateTable
CREATE TABLE "TeacherBlock" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeacherBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherBlock_teacherId_email_key" ON "TeacherBlock"("teacherId", "email");

-- AddForeignKey
ALTER TABLE "TeacherBlock" ADD CONSTRAINT "TeacherBlock_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
