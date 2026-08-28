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
 * The name is matched inside Postgres's `violates check constraint "…"` clause
 * in both quotings, never as a bare substring — see the note on the return
 * below for what else `err.message` carries. The SQLSTATE is likewise matched
 * inside its Postgres framing rather than as a bare number, which is the trap
 * `isTransientDbError` documents.
 */
export function isCheckViolationOn(err: unknown, constraint: string): boolean {
  if (!(err instanceof Error)) return false;
  // An empty name would make the name half vacuous — `''.includes('')` is true
  // — and collapse this to "is this a 23514", which is the one match the
  // docblock above exists to prevent. `isRestrictViolationOn` needs no such
  // line because `[].includes(x)` is false; a string needs it.
  if (constraint === '') return false;
  const carriesCode =
    err.message.includes('code: "23514"') || err.message.includes('Code: `23514`');
  // Matched inside Postgres's own phrasing, not as a bare name. `err.message`
  // is not only Postgres's classification: it also carries the calling file's
  // source lines (Prisma quotes them around the failing statement) and
  // `Failing row contains (…)`, which for this table includes
  // `ClassTemplate.description` — teacher-supplied free text. A bare
  // `includes(constraint)` therefore lets a caller's own comment, or a
  // teacher's template name, decide the classification. The full clause is
  // Postgres's to write, and appears in both quotings the docblock enumerates.
  return (
    carriesCode &&
    (err.message.includes(`violates check constraint \\"${constraint}\\"`) ||
      err.message.includes(`violates check constraint "${constraint}"`))
  );
}
