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
grep -rnoE '`?[][A-Za-z0-9_/.-]+\.(ts|tsx):[0-9]+' src/ tests/ --include='*.ts' --include='*.tsx'
```

(`]` sits right after the opening `[` in that character class deliberately — POSIX bracket expressions treat backslash as a literal character, not an escape, so `\[\]` inside one does not mean "the characters `[` and `]`"; it terminates the class at the first literal `]`, silently breaking the whole pattern. `]` is only literal when it is the class's first character. Verified against real `/usr/bin/grep`, not a grep-compatible wrapper — this project's CLI environment shadows `grep` with `ugrep`, which does not share this POSIX quirk and would have made an earlier, broken version of this command look correct.)

Run from the repo root. Matches a filename ending `.ts` or `.tsx`, optionally
backtick-prefixed, followed by `:NNN`. This supersedes #397's first attempt
(`` grep -rnoE '`[A-Za-z0-9_/.-]+\.[a-z]+:[0-9]+`' src/ --include='*.ts' ``),
which had three blind spots, each one confirmed to hide real drift when
#397/#398's review checked adjacent sites:

- `--include='*.ts'` alone misses `.tsx` — this version includes both (53 →
  60 hits, measured with everything else held constant).
- Requiring a leading backtick misses plain-prose citations — this version
  makes the backtick optional (`` `? ``) (11 → 60 hits, the largest single
  contributor).
- The character class `[A-Za-z0-9_/.-]+` excludes `[`/`]`. This doesn't
  change the *hit count* on its own — relaxing the backtick requirement
  already causes a match to start somewhere inside a bracketed path — but
  it changes *what gets captured*: without `[`/`]` in the class, a citation
  into a Next.js dynamic route (`api/registrations/[id]/route.ts:98`)
  truncates to `/route.ts:98`, silently dropping the one path segment that
  disambiguates it from every other file named `route.ts`. Adding the
  bracket characters back (`[][A-Za-z0-9_/.-]+` — `]` placed right after
  the opening `[`, its only legal position as a literal in a POSIX bracket
  expression) captures the citation whole.

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

- `src/lib/check-violation.test.ts`'s `sourceEcho` fixture (inside
  `it('does not match the name echoed by a source line or a failing-row
  dump', ...)`) and `src/lib/api-errors.test.ts`'s `measured` fixture
  (inside `it('maps the real Class_teacher_slot_unique deadlock ... to a
  503, not a 500', ...)`) both match fake Prisma error-message *fixtures*
  (test data asserting on parsed error text), not real citations — the
  matched text is a stack-trace-shaped string inside a mocked error
  message, coincidentally shaped like a file citation. A grep can't tell
  a citation from a quoted error message; a reader has to.

Also excluded from this count by construction, same as #397: migration SQL
files (`prisma/migrations/**/migration.sql`) and spec docs under
`docs/superpowers/specs/` — neither has a name to convert a citation to,
and a migration is never edited once applied regardless.

**The command's roots (`src/`, `tests/`) leave `docs/` out entirely** —
unlike the two exclusions above, that's not a deliberate "no name to
convert to" call, just the roots this pass used. The same command against
`docs/*.md` (not the vendored design system or the dated `superpowers/`
specs and plans, both archival by nature) finds citations there too,
including 8 in `docs/lock-order.md` — the file CLAUDE.md itself designates
as the owner-bearing home for exactly the cross-file claims a comment is
told to link to rather than restate. Not swept or verified here; flagging
the gap rather than leaving it implied by omission.

A meaningful fraction of the 58 real hits are already known-accurate from
#397/#398's own investigation (their sweep just couldn't see them due to
the blind spots above) — re-verifying those is redundant. The rest is
genuinely new territory (first appearances include, among others,
`rooms-api.test.ts`, `invitations-api.test.ts`, `room-archive.test.ts`,
and 9 citations of `waitlist.test.ts:525` spread across 5 files — only 2
of them, `studio-class-generator.test.ts` and `class-generator.test.ts`,
are generator tests; the other 3 are `class-lifecycle.test.ts`,
`studio-class-template-lifecycle.test.ts`, and
`room-archive-lock-order.test.ts`) that this pass did not investigate.
