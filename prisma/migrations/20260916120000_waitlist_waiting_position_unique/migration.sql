-- Hand-authored: Prisma cannot express a partial unique index.
-- Why partial, why immediate, and why gaps stay legal: docs/data-model.md (WaitlistEntry).

-- First, so no other writer runs between the renumber and the index build.
LOCK TABLE "WaitlistEntry" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  affected INT;
BEGIN
  UPDATE "WaitlistEntry" w
     SET "position" = r.rn
    FROM (
      SELECT "id",
             (row_number() OVER (
               PARTITION BY "classId"
               ORDER BY "position", "createdAt", "id"
             ))::int AS rn
        FROM "WaitlistEntry"
       WHERE "status" = 'waiting'
    ) r
   WHERE w."id" = r."id"
     AND w."position" <> r.rn;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE NOTICE 'issue 183 remediation: renumbered % waiting WaitlistEntry row(s) to 1..n per class', affected;
  END IF;
END $$;

CREATE UNIQUE INDEX "WaitlistEntry_waiting_position_key"
  ON "WaitlistEntry" ("classId", "position")
  WHERE "status" = 'waiting';
