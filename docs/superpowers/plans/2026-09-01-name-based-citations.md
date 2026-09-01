# Name-based citations where a name exists — plan

Spec: `docs/superpowers/specs/2026-09-01-name-based-citations-design.md`
(full evidence and reasoning for every site lives there — this plan is the
task breakdown only).

Comment-only change, no new tests needed (same as #395/#396). 9 files need
edits; 3 sites (4, 8, 9 in the spec's table) are verified-accurate citations
with no better available handle — no change.

## Tasks

Independent — no ordering dependency between them, all touch different
files.

1. **`src/app/api/cron/daily-cleanup/route.ts`** — site 1. Replace the
   `tests/e2e/recurring.spec.ts:126` citation with the test title
   `'the generation cron is idempotent over the already-filled window'`.

2. **`src/lib/student-visibility.ts`** — sites 2, 3 (one sentence, both
   citations). Replace both `route.ts:NN` line citations with references to
   each route's `POST` handler's `prisma.student.create` call.

3. **`src/lib/timezone.test.ts`** — site 5. Fix `vitest.config.ts:60` to the
   correct line (~147, re-verify before writing — the spec's own line note
   is a snapshot, not gospel). No name to add; this is a number-only fix.

4. **`src/lib/room-search.ts`** — site 6. Replace `use-payment-actions.ts:51`
   with a reference to the `undo` function's `readUndoStatus` call.

5. **`src/lib/generation.ts`** — site 7. Replace `tiers.ts:1` with "tiers.ts's
   first import".

6. **`src/services/studio-class-deletion.test.ts`** — site 10. Replace both
   `studio-class-generator.ts:141`/`:177` citations with a reference to
   `generateEntriesForRule`'s `start > startDate` filter in
   `entry-generation.ts`, keeping a corrected line number alongside the name
   (re-verify the exact line before writing).

7. **`src/services/class-transitions.test.ts`** — sites 11, 12, 13, 14 (three
   separate paragraphs in one file — apply independently within the file).
   - 11 and 14: replace `gdpr.test.ts:132` with a reference to
     `cleanupStudentWaitingInClass`'s docblock, matching this file's own
     existing by-name precedent at `gdpr.test.ts:246`.
   - 12 and 13 (one shared sentence): replace `waitlist.ts:96` and
     `class-transitions.ts:21` with the already-named `DEADLINE_HOURS` and
     `CANCEL_CHECK_HOURS` constants, dropping both line numbers.

8. **`src/services/gdpr.ts`** — site 15. Drop the redundant `:497` next to
   the already-named `SCHEDULED_STATUSES_SQL`.

9. **`src/services/class-template-lifecycle.test.ts`** — site 16. Same
   `cleanupStudentWaitingInClass`-by-name replacement as task 7's sites 11/14.

## Verification, per task and overall

- After all edits: `npx eslint <touched files>` and `npx tsc --noEmit` clean.
- `npx prettier --check <touched files>` — expect some pre-existing drift
  (as in #396); confirm via `git stash` that any flagged file was already
  flagged on `main` before this branch, same as #396's approach, don't fix
  unrelated formatting.
- Re-read every edited sentence for grammar after the substitution — a
  citation swap can leave a sentence reading awkwardly (#396's own review
  caught exactly this on the "sibling suite" phrase).

## Review

Same two specialists as #396, parallel: `comment-analyzer` (this is
literally its specialty) and `code-reviewer` (general CLAUDE.md compliance,
comment-only diff). Aggregate findings, adjudicate, fix real ones, then PR
review via `/pr-review-toolkit:review-pr`.

## PR body

Must state plainly that this PR does two things, not one: converts citation
*style* where #397 asked for it, AND fixes 8 sites where the *content* had
already drifted (found while investigating #397, not from a separate sweep)
— with the arithmetic (16 sites total, 8 drifted, 12 converted, 4 kept,
1 of the 4 needed a number-only fix). Name the migration-file and spec-doc
citations excluded from scope and why.
