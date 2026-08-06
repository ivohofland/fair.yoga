-- Invariant, DB-enforced: a terminal class status never changes. `completed`
-- and `cancelled` are terminal in VALID_TRANSITIONS (services/class-lifecycle.ts)
-- and three separate sites could write past one, each deciding from a read
-- taken before it held the row. Those three are fixed; this covers every
-- future one.
--
-- Terminality only, NOT a mirror of VALID_TRANSITIONS. Mirroring the whole
-- table would put a second source of truth in SQL, and it would reject
-- open -> completed, which class-template-lifecycle.test.ts:592-597 does
-- deliberately when building a fixture.
--
-- Fires only on an actual status change, so updates to other columns of a
-- completed class (description, financial totals written by completeClass in
-- the same statement as the status) are unaffected.
CREATE OR REPLACE FUNCTION class_reject_terminal_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('completed', 'cancelled') THEN
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
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION class_reject_terminal_status_change();
