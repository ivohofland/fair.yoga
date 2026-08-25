-- CreateEnum
CREATE TYPE "RuleKind" AS ENUM ('regular', 'studio');

-- CreateTable
CREATE TABLE "ScheduleRule" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "kind" "RuleKind" NOT NULL,
    "classType" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TIME NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "withdrawnCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleRule_teacherId_dayOfWeek_idx" ON "ScheduleRule"("teacherId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleRule_id_kind_key" ON "ScheduleRule"("id", "kind");

-- AddForeignKey
ALTER TABLE "ScheduleRule" ADD CONSTRAINT "ScheduleRule_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Minutes since midnight, so the range is over a built-in type: PostgreSQL has
-- no range type over `time`. EXTRACT on a time value is IMMUTABLE, which is
-- what allows a stored generated column rather than an expression index.
ALTER TABLE "ScheduleRule"
  ADD COLUMN "slot" int4range GENERATED ALWAYS AS (
    int4range(
      (EXTRACT(HOUR FROM "startTime") * 60 + EXTRACT(MINUTE FROM "startTime"))::int,
      (EXTRACT(HOUR FROM "startTime") * 60 + EXTRACT(MINUTE FROM "startTime"))::int
        + "durationMinutes",
      '[)'
    )
  ) STORED;

-- Half-open '[)' so back-to-back teaching stays legal: a rule ending 20:30 and
-- one starting 20:30 do not overlap.
ALTER TABLE "ScheduleRule"
  ADD CONSTRAINT "ScheduleRule_teacher_slot_excl"
  EXCLUDE USING gist ("teacherId" WITH =, "dayOfWeek" WITH =, "slot" WITH &&)
  WHERE ("isArchived" = false);

-- `ScheduleRule_id_kind_key` — the parent key for each child's composite
-- foreign key, without which one rule could carry a template of each family —
-- is emitted by Prisma from `@@unique([id, kind])`. Do not add it here.

ALTER TABLE "ScheduleRule" ADD CONSTRAINT "ScheduleRule_duration_positive"
  CHECK ("durationMinutes" > 0);
