-- The waitlist reconciliation sweep's broadcast gate used to ask "does a
-- `spot_available` notification exist in the current claim window", which the
-- index below was added (earlier on this same branch) to serve. That question
-- answered wrong for the sequence the sweep exists to repair: a seat frees, the
-- broadcast succeeds, a waiter claims, the seat frees again, and the live hook
-- drops the second broadcast — the window still held the first notification, so
-- the sweep suppressed itself for the rest of the hour.
--
-- `Class.spotBroadcastAt` replaces it: set when the broadcast goes out, cleared
-- whenever a seat is filled. That makes the gate a field read on a row the sweep
-- already loaded, so the index serves nothing and is dropped with the query.

-- DropIndex
DROP INDEX "Notification_relatedClassId_type_createdAt_idx";

-- AlterTable
ALTER TABLE "Class" ADD COLUMN     "spotBroadcastAt" TIMESTAMP(3);
