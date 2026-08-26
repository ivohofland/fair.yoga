-- Explicit, rather than relying on the runner, and for the same reason the
-- rewire that follows states: Prisma wraps migration.sql in a transaction, but
-- `psql` in autocommit and `prisma db execute` do not. Block 0 below can
-- refuse, and under those runners a refusal would otherwise leave the rename
-- and the CREATE TABLE applied anyway.
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. The rewire migration that follows MOVES columns between tables and
--    carries no data, so it requires empty "Class"/"StudioClass" tables. Every
--    statement in THIS file succeeds against a populated database, so without
--    this block `prisma migrate deploy` would apply the rename and the new
--    table, then fail the rewire — leaving Prisma a FAILED migration on top of
--    a half-migrated schema, which needs `migrate resolve --rolled-back` to
--    clear. Refuse here, where nothing has been done yet.
--
--    The rewire repeats this check rather than trusting this one: each file's
--    guarantee should hold when that file is executed on its own.
--
--    Remedy: the ordered deletes in the plan (dependents before "Class"),
--    against every database being migrated, then `prisma migrate deploy` and
--    `prisma db seed`. NOT `prisma migrate reset` — Prisma's agent guard
--    refuses a whole-database wipe without fresh human consent, and a scoped
--    delete leaves every other table alone anyway.
--
--    This is a ONE-SHOT check, NOT an enforcement predicate — do not count it
--    as one in any later liveness or constraint audit. The block at the same
--    position in 20260821120000_cross_family_slot_guard was miscounted exactly
--    that way (design doc, stage B section 1.3).
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT (SELECT count(*) FROM "Class") + (SELECT count(*) FROM "StudioClass") INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      'CalendarEntry rewire needs empty Class/StudioClass tables (found % rows). '
      'Empty them with the ordered deletes in the plan, then migrate deploy.', n;
  END IF;
END $$;

-- The two families' shared enum. Renamed from `RuleKind`, which stage A named
-- for the only layer that then had one; it now discriminates at both.
ALTER TYPE "RuleKind" RENAME TO "ClassFamily";

CREATE TABLE "CalendarEntry" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "kind" "ClassFamily" NOT NULL,
    "classType" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TIME NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "classCompletedAt" TIMESTAMP(3),
    "scheduleRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CalendarEntry_teacherId_date_idx" ON "CalendarEntry"("teacherId", "date");

-- The parent key for each child's composite foreign key, without which one
-- entry could carry a child of each family. Emitted by Prisma from
-- @@unique([id, kind]); declared here only because this table is hand-authored.
CREATE UNIQUE INDEX "CalendarEntry_id_kind_key" ON "CalendarEntry"("id", "kind");

-- Replaces the two @@unique([templateId, date]) indexes. TOTAL, not partial:
-- a cancelled entry releases its SLOT but goes on holding its DATE against the
-- hourly sweep, so a date the teacher cancelled is not refilled.
CREATE UNIQUE INDEX "CalendarEntry_scheduleRuleId_date_key"
  ON "CalendarEntry"("scheduleRuleId", "date");

ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_teacherId_fkey"
  FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_scheduleRuleId_fkey"
  FOREIGN KEY ("scheduleRuleId") REFERENCES "ScheduleRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_duration_positive"
  CHECK ("durationMinutes" > 0);

-- `date + time` and `+ interval` are IMMUTABLE, so the range can be a STORED
-- generated column rather than an expression index. A naive tsrange with no
-- zone is correct BECAUSE the constraint is scoped `teacherId WITH =`: two
-- entries are only ever compared inside one teacher's own calendar.
ALTER TABLE "CalendarEntry"
  ADD COLUMN "span" tsrange GENERATED ALWAYS AS (
    tsrange("date" + "startTime",
            "date" + "startTime" + ("durationMinutes" * interval '1 minute'),
            '[)')
  ) STORED;

-- Half-open '[)' so back-to-back teaching stays legal. Partial on liveness so a
-- cancelled entry releases its slot to a replacement.
--
-- Added here, on a table that is empty and stays empty until the seed runs, so
-- the first thing that can violate it is seed data — editable — rather than an
-- ALTER over rows someone would have to reason about.
ALTER TABLE "CalendarEntry"
  ADD CONSTRAINT "CalendarEntry_teacher_slot_excl"
  EXCLUDE USING gist ("teacherId" WITH =, "span" WITH &&)
  WHERE ("cancelledAt" IS NULL);

COMMIT;
