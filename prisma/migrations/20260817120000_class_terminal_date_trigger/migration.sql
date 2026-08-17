-- Invariant, DB-enforced: a terminal class's `date` never changes.
--
-- The sibling trigger `class_terminal_status_guard`
-- (20260805120000_class_terminal_status_trigger) is BEFORE UPDATE OF status,
-- and says in its own comment that "updates to other columns of a completed
-- class ... are unaffected". That was correct and harmless until #238 shipped
-- `waitlist-retention.ts`, which reads `Class.date` on a terminal class and
-- then DELETES the unfulfilled queue entries it finds. Half that sweep's
-- predicate was trigger-enforced and half was not. This is the other half.
--
-- `date` ONLY, not every column, and the narrowness is deliberate. The service
-- (`updateClass`) freezes the whole class; this freezes the one column a
-- deleting sweep reads. Measured before choosing: of the 13 real
-- `class.update`/`updateMany` sites in `src/`, exactly one writes `date`, and
-- it is `updateClass`. `template-sync.ts` rewrites twelve instance columns and
-- pointedly not this one; `completeClass` writes its totals in the same
-- statement as the status flip, so OLD.status is `in_progress` there and this
-- never fires. A wider trigger would gain nothing and would put
-- `spotBroadcastAt` and the completion write at risk.
--
-- The WHEN clause needs both halves. `UPDATE OF date` fires whenever `date` is
-- in the SET list even if the value is identical, so without the IS DISTINCT
-- FROM a future writer that carries the current date alongside the columns it
-- means to change would be rejected by a guard aimed at something else — the
-- same reasoning the sibling trigger records for its own WHEN.
CREATE OR REPLACE FUNCTION class_reject_terminal_date_change()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Class % is %, which is terminal; cannot change its date from % to %',
    OLD.id, OLD.status, OLD.date, NEW.date
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_terminal_date_guard
  BEFORE UPDATE OF date ON "Class"
  FOR EACH ROW
  WHEN (OLD.status IN ('completed', 'cancelled') AND OLD.date IS DISTINCT FROM NEW.date)
  EXECUTE FUNCTION class_reject_terminal_date_change();
