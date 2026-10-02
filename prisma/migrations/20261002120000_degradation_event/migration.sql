-- CreateTable
CREATE TABLE "DegradationEvent" (
    "code" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastNotifiedAt" TIMESTAMP(3),
    "sample" JSONB NOT NULL,

    CONSTRAINT "DegradationEvent_pkey" PRIMARY KEY ("code")
);

-- A row exists only because an event happened at least once.
ALTER TABLE "DegradationEvent"
    ADD CONSTRAINT "DegradationEvent_occurrences_check" CHECK ("occurrences" > 0);
