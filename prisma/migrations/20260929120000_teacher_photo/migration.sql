-- AlterTable
ALTER TABLE "Teacher" DROP COLUMN "photoUrl";

-- CreateTable
CREATE TABLE "TeacherPhoto" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeacherPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherPhoto_teacherId_key" ON "TeacherPhoto"("teacherId");

-- AddForeignKey
ALTER TABLE "TeacherPhoto" ADD CONSTRAINT "TeacherPhoto_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

