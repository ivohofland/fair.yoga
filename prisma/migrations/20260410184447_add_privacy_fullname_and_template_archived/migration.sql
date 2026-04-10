-- DropIndex
DROP INDEX "Room_address_roomName_key";

-- AlterTable
ALTER TABLE "ClassTemplate" ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StudentPrivacy" ADD COLUMN     "shareFullName" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TeacherRoom" ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Room_address_floor_roomName_idx" ON "Room"("address", "floor", "roomName");
