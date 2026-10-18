/*
  Warnings:

  - Added the required column `profileId` to the `ProcessorPayment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `testmode` to the `ProcessorPayment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ProcessorPayment" ADD COLUMN     "profileId" TEXT NOT NULL,
ADD COLUMN     "testmode" BOOLEAN NOT NULL;
