# Sweeping for stale cross-file citations

A comment that cites another file — `` `some-file.ts:NNN` ``, or a quoted
name — goes stale the moment the target shifts: a line moves above the
cited number, a test moves to a sibling file, a symbol gets renamed. Nothing
compiles, lints, or fails a test when this happens. #395, #397, and #398
each found real instances of it, and #397/#398's own review round found the
sweep command #397 first used had three structural blind spots hiding more.
This project decided ([#401](https://github.com/ivohofland/fair.yoga/issues/401))
not to build enforcement tooling for this — the harm is a maintainer
occasionally reading a stale line, never a live defect, and a lint rule
can only catch the *shape* of a new citation, not verify an existing one
against reality. Re-run this sweep periodically instead — during a large
refactor, or when picking up a comment-accuracy issue like #395/#397 again.

## The command

```
grep -rnoE '`?[A-Za-z0-9_/.\[\]-]+\.(ts|tsx):[0-9]+' src/ tests/ --include='*.ts' --include='*.tsx'
```

Run from the repo root. Matches a filename ending `.ts` or `.tsx`, optionally
backtick-prefixed, followed by `:NNN`. This supersedes #397's first attempt
(`` grep -rnoE '`[A-Za-z0-9_/.-]+\.[a-z]+:[0-9]+`' src/ --include='*.ts' ``),
which had three blind spots, each one confirmed to hide real drift when
#397/#398's review checked adjacent sites:

- `--include='*.ts'` alone misses `.tsx` — this version includes both.
- Requiring a leading backtick misses plain-prose citations — this version
  makes the backtick optional (`` `? ``).
- The character class `[A-Za-z0-9_/.-]+` excludes `[`/`]`, so a citation
  into a Next.js dynamic route path (`api/registrations/[id]/route.ts`)
  never matched even when correctly backtick-wrapped — this version adds
  `\[\]` to the class.

It still requires an explicit `src/` or `tests/` root; #397's version rooted
at `src/` only and missed `tests/` entirely, which is why this one lists
both.

## Snapshot: 60 raw hits (2026-09-01)

Run against `main` at this doc's commit. **Not individually verified** — a
raw hit needs the same per-site work #395/#397/#398 did (read the citing
comment, read the actual target, verdict: accurate or drifted) before it
means anything. Two known false positives in this snapshot, found by
inspection, not swept for systematically — there may be more of the same
shape:

- `src/lib/check-violation.test.ts:71` and `src/lib/api-errors.test.ts:653`
  match fake Prisma error-message *fixtures* (test data asserting on parsed
  error text), not real citations — the matched text is a stack-trace-shaped
  string inside a mocked error message, coincidentally shaped like a file
  citation. A grep can't tell a citation from a quoted error message; a
  reader has to.

Also excluded from this count by construction, same as #397: migration SQL
files (`prisma/migrations/**/migration.sql`) and spec docs under
`docs/superpowers/specs/` — neither has a name to convert a citation to,
and a migration is never edited once applied regardless.

A meaningful fraction of the 58 real hits are already known-accurate from
#397/#398's own investigation (their sweep just couldn't see them due to
the blind spots above) — re-verifying those is redundant. The rest is
genuinely new territory (first appearances include, among others,
`rooms-api.test.ts`, `invitations-api.test.ts`, `room-archive.test.ts`,
and six citations of `waitlist.test.ts:525` from different generator test
files) that this pass did not investigate.
