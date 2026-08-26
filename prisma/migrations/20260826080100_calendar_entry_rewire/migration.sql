-- Explicit, rather than relying on the runner. Prisma wraps migration.sql in a
-- transaction, but `psql` in autocommit and `prisma db execute` do not — and
-- under those, a failure between blocks 1 and 5 leaves the schema half-moved.
-- The file's own guarantee should not depend on who executes it.
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. This migration MOVES columns between tables and does not carry data.
--    Pre-production: production's first deploy runs against an empty database
--    and the dev/test databases are disposable. Refuse loudly rather than
--    half-moving a schema or inventing timestamps the rows never recorded.
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

-- ---------------------------------------------------------------------------
-- 1. Drop FIRST every object whose stored definition names a column or a type
--    the rest of this file changes. PostgreSQL re-checks those definitions in
--    place rather than cascading, so each is a hard blocker:
--
--    THE TRIGGERS. A trigger's WHEN clause records a dependency on every
--    column it names. The four cross-family guards read columns block 4 drops;
--    the two terminality guards read the `status` column block 3 retypes.
--
--    THE TWO #196 PARTIAL SLOT INDEXES. `Class_teacher_slot_unique` is
--    predicated on `status <> 'cancelled'`, and block 3's retype rebuilds
--    every index on `status` against the NEW enum — which has no `cancelled`
--    for that literal to resolve to, so the predicate fails to re-parse:
--
--      ERROR:  operator does not exist: "ClassStatus" <> "ClassStatus_old"
--
--    Measured, not assumed. Its `StudioClass` twin is predicated on
--    `cancelledAt` rather than on the enum and would have fallen out with its
--    columns in block 4; it is dropped here beside its pair, because the pair
--    is the unit #196 created and this migration replaces.
--
--    Not `DROP … CASCADE` anywhere below, which would remove the triggers and
--    leave their functions behind as broken orphans.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS class_cross_family_slot_insert_guard        ON "Class";
DROP TRIGGER IF EXISTS class_cross_family_slot_update_guard        ON "Class";
DROP TRIGGER IF EXISTS studio_class_cross_family_slot_insert_guard ON "StudioClass";
DROP TRIGGER IF EXISTS studio_class_cross_family_slot_update_guard ON "StudioClass";
DROP TRIGGER IF EXISTS class_terminal_status_guard                 ON "Class";
DROP TRIGGER IF EXISTS class_terminal_date_guard                   ON "Class";
DROP FUNCTION IF EXISTS class_reject_cross_family_slot();
DROP FUNCTION IF EXISTS studio_class_reject_cross_family_slot();
DROP FUNCTION IF EXISTS class_reject_terminal_date_change();
-- class_reject_terminal_status_change() is REPLACED in block 5, not dropped.

DROP INDEX IF EXISTS "Class_teacher_slot_unique";
DROP INDEX IF EXISTS "StudioClass_teacher_slot_unique";

-- ---------------------------------------------------------------------------
-- 2. Each child hangs off an entry. NOT NULL immediately — the tables are
--    empty, which block 0 has already established.
-- ---------------------------------------------------------------------------
ALTER TABLE "Class"
  ADD COLUMN "calendarEntryId" TEXT NOT NULL,
  ADD COLUMN "kind" "ClassFamily" NOT NULL;
ALTER TABLE "StudioClass"
  ADD COLUMN "calendarEntryId" TEXT NOT NULL,
  ADD COLUMN "kind" "ClassFamily" NOT NULL;

-- The CHECK is what makes the composite FK mean "regular children hang off
-- regular entries"; without it the pair would merely have to AGREE, which both
-- children can do at once. Load-bearing, not redundant with the FK — and the
-- constraint that actually raises when a parent's kind is flipped, because the
-- FK's ON UPDATE CASCADE rewrites the child first.
ALTER TABLE "Class"       ADD CONSTRAINT "Class_kind_check"       CHECK ("kind" = 'regular');
ALTER TABLE "StudioClass" ADD CONSTRAINT "StudioClass_kind_check" CHECK ("kind" = 'studio');

-- Names and ON UPDATE follow Prisma's conventions so `prisma migrate dev` does
-- not read this as drift.
ALTER TABLE "Class" ADD CONSTRAINT "Class_calendarEntryId_kind_fkey"
  FOREIGN KEY ("calendarEntryId","kind") REFERENCES "CalendarEntry"("id","kind")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioClass" ADD CONSTRAINT "StudioClass_calendarEntryId_kind_fkey"
  FOREIGN KEY ("calendarEntryId","kind") REFERENCES "CalendarEntry"("id","kind")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Class"       ADD CONSTRAINT "Class_calendarEntryId_key"       UNIQUE ("calendarEntryId");
ALTER TABLE "StudioClass" ADD CONSTRAINT "StudioClass_calendarEntryId_key" UNIQUE ("calendarEntryId");

-- ---------------------------------------------------------------------------
-- 3. Liveness has moved to the entry, so `cancelled` leaves ClassStatus.
--    PostgreSQL cannot drop an enum value, so the type is recreated. No USING
--    cast can fail here: the table is empty.
-- ---------------------------------------------------------------------------
ALTER TYPE "ClassStatus" RENAME TO "ClassStatus_old";
CREATE TYPE "ClassStatus" AS ENUM ('draft', 'open', 'in_progress', 'completed');
ALTER TABLE "Class" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Class" ALTER COLUMN "status" TYPE "ClassStatus" USING "status"::text::"ClassStatus";
ALTER TABLE "Class" ALTER COLUMN "status" SET DEFAULT 'draft';
DROP TYPE "ClassStatus_old";

-- ---------------------------------------------------------------------------
-- 4. Only now drop the moved columns. The two @@unique([templateId, date])
--    indexes, the two (teacherId, date) indexes and the four foreign keys over
--    these columns are removed by PostgreSQL as a consequence — there is no
--    DROP INDEX to write for them. The two partial slot indexes are not in
--    that set: they had to go earlier, in block 1, for the reason stated
--    there.
--
--    "StudioClass"."cancelledAt" leaves in the same statement but for a
--    different reason than the six beside it. Those six are the shared
--    calendar identity, which moved to the entry wholesale. This one moves
--    because liveness collapsed to a single spelling:
--    "CalendarEntry_teacher_slot_excl" is partial on the ENTRY's
--    "cancelledAt", so a child column kept here would be a second truth that
--    releases no slot — a cancelled studio class would go on holding one, with
--    nothing raising. "Class" has no twin to drop: its cancellation was a
--    "status" member, which block 3 removed.
-- ---------------------------------------------------------------------------
ALTER TABLE "Class"
  DROP COLUMN "teacherId", DROP COLUMN "classType", DROP COLUMN "date",
  DROP COLUMN "startTime", DROP COLUMN "durationMinutes", DROP COLUMN "templateId";
ALTER TABLE "StudioClass"
  DROP COLUMN "teacherId", DROP COLUMN "classType", DROP COLUMN "date",
  DROP COLUMN "startTime", DROP COLUMN "durationMinutes", DROP COLUMN "templateId",
  DROP COLUMN "cancelledAt";

-- ---------------------------------------------------------------------------
-- 5. The three triggers that replace the six.
-- ---------------------------------------------------------------------------

-- (a) A terminal class cannot leave its status. Same guarantee as before, on a
--     terminal set that is now one member because cancellation is not a status.
--
--     The one-member `OLD.status IN (...)` is deliberate and must not be
--     simplified to `=`: a drift pin under `tests/` reads this exact shape out
--     of this file to re-derive the terminal set, and compares it against the
--     constant the services use.
CREATE OR REPLACE FUNCTION class_reject_terminal_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('completed') THEN
    RAISE EXCEPTION
      'Class % is %, which is terminal; cannot change status to %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_terminal_status_guard
  BEFORE UPDATE OF status ON "Class"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION class_reject_terminal_status_change();

-- (b) Terminality reaches the entry as a WRITE, not as a cross-table read. A
--     guard on "CalendarEntry" that read "Class".status would acquire
--     Entry -> Class, against lockClassRow's Class -> Entry: a measured ABBA
--     (40P01) on the schedule-write hot path. This fires inside the completing
--     transaction, so marker and status commit atomically, and it acquires
--     Class -> Entry, which composes with lockClassRow. See docs/lock-order.md.
--
--     A marker synced from TypeScript instead would miss a raw
--     `UPDATE "Class" SET status='completed'` — and reaching clients that
--     bypass the services is the whole reason the freeze is a trigger.
--
--     `NEW.status IN (...)`, one member and deliberately not `=`, for the
--     reason (a) states: this is the SECOND frozen text carrying the terminal
--     set, and it gets its own drift pin. The two pins anchor on their
--     function names because both texts now live in one file.
CREATE OR REPLACE FUNCTION class_sync_entry_completed()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('completed') THEN
    UPDATE "CalendarEntry" SET "classCompletedAt" = now()
     WHERE id = NEW."calendarEntryId" AND "classCompletedAt" IS NULL;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_sync_entry_completed_guard
  AFTER UPDATE OF status ON "Class"
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION class_sync_entry_completed();

-- (c) The freeze. Single-table: it reads OLD on the very row the statement
--     already holds, so a concurrent completion cannot slip past it — when the
--     completing transaction commits, EvalPlanQual re-fetches and OLD carries
--     the fresh marker. Measured.
--
--     THREE columns, not one. The predecessor was BEFORE UPDATE OF date
--     because "Class" had one column to name; here the frozen thing is the
--     span, and the span is generated from three.
--
--     The kind conjunct is the two families' asymmetry: cancelling a Class is
--     terminal, cancelling a StudioClass is reversible and its un-cancel path
--     is live, so a cancelled studio entry must stay editable.
CREATE OR REPLACE FUNCTION entry_reject_frozen_schedule_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."classCompletedAt" IS NOT NULL
     OR (OLD.kind = 'regular' AND OLD."cancelledAt" IS NOT NULL) THEN
    RAISE EXCEPTION
      'CalendarEntry % is frozen; cannot change its date, start time or duration',
      OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entry_frozen_schedule_guard
  BEFORE UPDATE OF "date", "startTime", "durationMinutes" ON "CalendarEntry"
  FOR EACH ROW EXECUTE FUNCTION entry_reject_frozen_schedule_change();

COMMIT;
