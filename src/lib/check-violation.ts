/**
 * True when `err` is a PostgreSQL `23514` raised by the CHECK constraint named
 * `constraint`.
 *
 * BOTH the SQLSTATE and the name are required, and requiring the name is the
 * whole design. `23514` is Postgres's default for every plain CHECK in this
 * schema, and it is additionally what this repo's terminality triggers raise
 * with an explicit `USING ERRCODE` — so a matcher keyed on the code alone would
 * relabel unrelated refusals. `isTerminalStatusViolation` (`./api-errors`)
 * discriminates by message wording for the same reason; this one discriminates
 * by constraint name, which is available here and is not available there.
 *
 * Two error shapes carry the SQLSTATE and both are admitted, as
 * `isExclusionConflictOn` (`./exclusion-conflict`) admits both for `23P01`:
 *
 *   1. A typed model call — the SQLSTATE and the constraint name survive only
 *      in `message`, and Postgres's own quoting arrives escaped.
 *   2. A raw query — Prisma's `P2010`, which spells the code `` Code: `23514` ``
 *      and leaves the name quoted as Postgres wrote it.
 *
 * Matching the name as a bare substring covers both quotings without a second
 * branch; the SQLSTATE is matched inside its Postgres framing rather than as a
 * bare number, which is the trap `isTransientDbError` documents.
 */
export function isCheckViolationOn(err: unknown, constraint: string): boolean {
  if (!(err instanceof Error)) return false;
  const carriesCode =
    err.message.includes('code: "23514"') || err.message.includes('Code: `23514`');
  return carriesCode && err.message.includes(constraint);
}