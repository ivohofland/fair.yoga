/**
 * True when `err` is the cross-family slot guard firing (#296) — a teacher
 * already holds this slot in the *other* class family.
 *
 * Matched by SQLSTATE inside the message rather than by a Prisma error code,
 * which is the technique `isTerminalStatusViolation` and `isTransientDbError`
 * (`src/lib/api-errors.ts`) already use, for the reason measured below: a
 * `RAISE EXCEPTION` with a user-defined SQLSTATE has no Prisma code of its own.
 *
 * TWO ERROR SHAPES CARRY THE SQLSTATE, and which one arrives is decided by how
 * the statement was issued, not by what failed. Both were observed against
 * `ethical_yoga_test` on this checkout's real triggers (issue #296 task 3
 * step 1); both are matched.
 *
 *   1. A typed model call — `create`, `update`, and `createManyAndReturn`
 *      inside an interactive transaction were each observed, all identical:
 *
 *        constructor : PrismaClientUnknownRequestError
 *        code        : undefined
 *        meta        : undefined
 *
 *        Invalid `prisma.studioClass.create()` invocation in …
 *        Error occurred during query execution:
 *        ConnectorError(ConnectorError { user_facing_error: None, kind:
 *          QueryError(PostgresError { code: "YG001", message: "Teacher <id>
 *          already has a live class (<id>) at 2029-04-03 09:00", severity:
 *          "ERROR", detail: None, column: None, hint: None }), transient: false })
 *
 *   2. A raw query, which has a P-code of its own and spells the SQLSTATE the
 *      other way:
 *
 *        constructor : PrismaClientKnownRequestError
 *        code        : "P2010"
 *
 *        Invalid `prisma.$executeRaw()` invocation:
 *        Raw query failed. Code: `YG001`. Message: `ERROR: Teacher <id>
 *        already has a live class (<id>) at 2029-06-06 09:00`
 *
 * Nothing in `src/` writes these four tables raw today, so shape 2 is
 * unreachable as the code stands. It is matched anyway, and deliberately:
 * `isTerminalStatusViolation`'s docblock records an earlier revision that
 * admitted only shape 1 and argued the raw one was unreachable — which made a
 * 409-vs-500 hinge on a whole-repo census nothing could keep honest, and the
 * census was already false when written. The same argument would be the same
 * mistake here.
 *
 * `YG001` is user-defined on purpose, and the two alternatives were rejected
 * for reasons that are about *discrimination*, not taste:
 *
 *   - `23505` collides with the within-family partial unique indexes, which is
 *     the conflict `isUniqueConflictOn` (`unique-conflict.ts`) identifies by
 *     `meta.target`. Measured by mutation rather than argued (task 3 step 6):
 *     `studio_class_reject_cross_family_slot` was re-applied with
 *     `USING ERRCODE = '23505'`, and the colliding insert then reported
 *
 *       constructor : PrismaClientKnownRequestError
 *       code        : "P2002"
 *       meta        : {"modelName":"StudioClass","target":null}
 *       message     : Unique constraint failed on the (not available)
 *
 *     `target` is **null**, not the column array a real index produces — so
 *     `isUniqueConflictOn` returns false at its `Array.isArray` guard, this
 *     function returns false too, and the request falls through to a 500. Both
 *     matchers declining is the good outcome of the two available: the bad one
 *     would be `isUniqueConflictOn` matching and answering the within-family
 *     sentence ("cancel the other one") for a cross-family collision, which no
 *     status assertion could see. The trigger was restored from a
 *     `pg_get_functiondef` capture and the restore verified byte-identical.
 *   - `23514` is already raised by `class_reject_terminal_date_change` and by
 *     the terminal-status trigger, and two triggers sharing a SQLSTATE cannot
 *     be told apart by the code mapping them. `isTerminalStatusViolation`
 *     needs the `which is terminal` wording for exactly this reason.
 *
 * That is also why this matcher needs no wording discriminator of its own,
 * where its 23514 neighbour does: `YG001` is emitted by the cross-family slot
 * guard's triggers and by nothing else in the schema, so the SQLSTATE alone
 * is the whole predicate. The trigger roster — how many, on which tables — is
 * `docs/lock-order.md`'s to keep ("The cross-family slot guard reads, and
 * does not lock"), including the grep that re-derives it; do not duplicate a
 * count here. What stays true regardless of that roster's size: it must stay
 * a roster of exactly one meaning — a second user-defined `YG001` would make
 * this function silently wrong, and no test would notice.
 *
 * The SQLSTATE is matched inside its Postgres framing (`code: "YG001"` /
 * ``Code: `YG001` ``) rather than as a bare substring — the trap
 * `isTransientDbError` documents, where a message that merely mentions the
 * code would match.
 */
export function isCrossFamilySlotConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('code: "YG001"') || err.message.includes('Code: `YG001`');
}
