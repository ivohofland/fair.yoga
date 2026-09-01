# Name-based citations where a name exists — design

Issue: #397. Filed as a follow-up to #395/#396 on the observation that bare
`file:NNN` citations rot silently when content shifts above the cited line,
while a citation quoting a stable name (an exported symbol, a `describe`/`it`
title) survives the same shift.

## Premise verification

#397's proposal was: sweep cross-file `file:NNN` citations, convert the ones
with a locatable name at their target, leave the rest. The premise that
name-based citations survive refactors better is sound and uncontroversial —
it's the same principle CLAUDE.md's Comment Discipline already states
("tether membership to the compiler" / name things over counting them).

**What the premise undercounted: this is not a pure style question.**
Investigating each candidate site required reading its target, and that
turned up **8 of the 16 candidate sites whose citation has already drifted
from reality** — not a style preference, a #395-style factual defect. One
(site 10) doesn't just have a stale line number: the logic it describes moved
to a **different file entirely** (`studio-class-generator.ts` →
`entry-generation.ts`, part of #284's "one generator" unification, which
CLAUDE.md's Class Lifecycle section documents). This spec folds those
corrections in rather than filing them as a second #395 — they're found by
the same sweep, in files this change already touches, and #395/#396's own
"correct a claim in every artifact" discipline argues for fixing them here
rather than deferring.

Investigation method: a fresh general-purpose subagent (not a fork — a fork
launched first for this returned a degenerate handoff response with zero
tool calls, reported separately as product feedback) read all 16 citing
comments and their targets, and I independently spot-checked the four most
consequential/surprising claims directly (sites 3, 5, 10, 12/13) — all
confirmed accurate on direct read.

## Scope

The sweep that found these 16 sites (`grep -rnoE '`[A-Za-z0-9_/.-]+\.[a-z]+:[0-9]+`' src/ --include='*.ts'`,
refined from #397's own broader starting grep to exclude time literals like
`09:30` and port numbers like `:3000`) found 22 raw hits. **6 are excluded
from this pass**: 5 cite immutable migration SQL files (`prisma/migrations/**/migration.sql`)
and 1 cites a spec doc (`docs/superpowers/specs/2026-07-25-*.md`) — neither
has an exported symbol, function, or test title to convert to; a migration
is also, per CLAUDE.md, never edited once applied, so even a comment fix
elsewhere can't touch it. The remaining 16 are this spec's full scope — no
sampling, no "representative subset."

## The 16 sites

Full site-by-site evidence (current text, target content read directly,
verdict, and reasoning) is in the investigation findings:
`/private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga/a88c97c3-bddf-4c82-b757-aa59471f0865/scratchpad/issue-397-site-findings.md`.
That file is a scratchpad, not a durable artifact — this spec is the durable
record; the table below is the actionable summary, condensed from it.

| # | Citing site | Cited target | Content verdict | Style verdict | Action |
|---|---|---|---|---|---|
| 1 | `daily-cleanup/route.ts:22` | `recurring.spec.ts:126` | **drifted** — real line 165 | CONVERT | cite `'the generation cron is idempotent over the already-filled window'` test title, drop number |
| 2 | `student-visibility.ts:175` | `student-signup/route.ts:41` | **drifted** — off by 3, real line 44 | CONVERT | cite `POST` handler's `prisma.student.create` call, drop number |
| 3 | `student-visibility.ts:176` | `student-profile/route.ts:54` | **wrong statement** — line 54 is inside an `update`, not the `create` (real line 77) | CONVERT | cite `POST` handler's `prisma.student.create` call, drop number |
| 4 | `db-locks.test.ts:309` | `gdpr-lock-order.test.ts:67` | accurate | KEEP — only name available (file-spanning `describe`) is no finer-grained than the filename already cited | no change |
| 5 | `timezone.test.ts:452` | `vitest.config.ts:60` | **drifted** — real line ~147 | KEEP — bare `env:` property in a default-exported config object, no named handle | **fix the number to 147**, no style change |
| 6 | `room-search.ts:58` | `use-payment-actions.ts:51` | **drifted** — real line 95, inside `undo` | CONVERT | cite `undo` function's `readUndoStatus` call, drop number |
| 7 | `generation.ts:20` | `tiers.ts:1` | accurate | CONVERT | cite "`tiers.ts`'s first import", drop number |
| 8 | `db-locks-lock-order.test.ts:20` | `db-locks.test.ts:414` | accurate | KEEP — same reasoning as #4 | no change |
| 9 | `db-locks-lock-order.test.ts:156` | `gdpr-lock-order.test.ts:67` | accurate | KEEP — same reasoning as #4 | no change |
| 10 | `studio-class-deletion.test.ts:54` | `studio-class-generator.ts:141,177` | **wrong file** — logic moved to `entry-generation.ts` (#284) | CONVERT | cite `generateEntriesForRule`'s `start > startDate` filter, keep corrected line (`entry-generation.ts:551` — function is ~386 lines, name alone too coarse) |
| 11 | `class-transitions.test.ts:380` | `gdpr.test.ts:132` | accurate | CONVERT | cite `cleanupStudentWaitingInClass` docblock by name, drop number — matches this file's own existing precedent at `gdpr.test.ts:246` |
| 12 | `class-transitions.test.ts:441` | `waitlist.ts:96` | **drifted** — real line 130 | CONVERT | already named (`DEADLINE_HOURS`) in the same sentence; drop number |
| 13 | `class-transitions.test.ts:442` | `class-transitions.ts:21` | **drifted** — real line 25 | CONVERT | already named (`CANCEL_CHECK_HOURS`); drop number |
| 14 | `class-transitions.test.ts:463` | `gdpr.test.ts:132` | accurate | CONVERT | same as #11 |
| 15 | `gdpr.ts:914` | `class-template-lifecycle.ts:497` | accurate | CONVERT | already named (`SCHEDULED_STATUSES_SQL`); drop number |
| 16 | `class-template-lifecycle.test.ts:1465` | `gdpr.test.ts:132` | accurate | CONVERT | same as #11 |

**12 CONVERT, 4 KEEP-LINE-NUMBER (1 of the 4 still needs its number corrected).**
13 individual edits across 9 files; 3 sites (4, 8, 9) need no change at all.

## Design decisions

- **Drop the line number wherever a name alone is unambiguous** — the
  standard this repo already sets for itself (`gdpr.test.ts:246`'s own
  `cleanupStudentWaitingInClass`-by-name citation, site 15's already-named
  `SCHEDULED_STATUSES_SQL`). Every CONVERT site above drops the number except
  #10, kept alongside because the target function spans ~386 lines and the
  name alone leaves too much to scan.
- **Where a name genuinely doesn't exist (sites 4, 8, 9), leave the line
  number** — a file-spanning `describe` block or an anonymous `beforeAll`
  hook is not a finer-grained handle than the citation already has. Forcing
  a name-based citation here would trade a working citation for a
  decorative one.
- **Site 5 is style-KEEP but content-WRONG** — fix the number without
  adding a name, since none exists. This is the one site where the #395-class
  fix and the #397-class question point to different, independent actions on
  the same line.
- **Exact replacement wording is drafted per-site** in the findings file
  linked above; the implementing task should treat that wording as a strong
  starting draft; verified against real file content, but not
  gospel — same latitude #396's own fix wave used when review caught an
  awkward "sibling suite" phrase post-edit.

## What this does not do

- Does not touch the 5 migration-file citations or the 1 spec-doc citation —
  no target has a name to convert to.
- Does not re-sweep for other citation forms (bare `:NNN` without an
  extension, e.g. `gdpr.test.ts:855`'s `":748"` shorthand within the same
  file) — #397's own scope is cross-file citations with an extension.
- Does not change any runtime behavior — every edit is comment-only.
