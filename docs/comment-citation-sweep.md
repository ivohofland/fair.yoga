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

## Sweeping by TITLE, when a test moves between files

The command above finds a citation written as `file.ts:NNN`. It cannot find one
that names a test by its title, which is the form this project asks for
(`docs/superpowers/specs/2026-09-01-name-based-citations-design.md`) and
therefore the form most of its cross-file citations now take. When a test moves
to another file — the `*-lock-order.test.ts` extractions of #459 and #468 — the
citations that break are exactly those, and a fixed-string sweep for the moved
titles is the pass that finds most of them — with a second sweep, below, for
the ones that name only the file the test left.

**A whole title is the wrong needle.** Comment prose is wrapped, so a cited
title is usually split across two `*` lines, and `grep -F` on the whole string
matches neither. Measured on #468 at `701fd4e3` — after the extractions, with
the titles read off the four destination files — against the nine live sites
the spec predicted:

- The WHOLE-title pass over the nineteen moved test titles hit **one** of them,
  the single citation short enough to sit on one line. It is not a weaker
  version of the fragment pass; it is a pass that silently returns almost
  nothing.
- The FRAGMENT pass over every overlapping four-word window of those titles
  (155 fragments) hit **five**, and one of the five was luck: it matched
  `answers busy when a` inside a citation reading `answers busy when an
  ordinary booking holds a class row` — a title no test in this repo carries.

The four it missed are two distinct blind spots, and neither miss looks like a
miss.

**Read `describe(` titles too, not just `it(` ones.** A citation can name the
BLOCK rather than the case: `rule-lifecycle.ts` cites "the bound reaches its
pre-lock", which is the tail of a moving `describe` title. Adding the
destination blocks' `describe(` titles to `titles.txt` (31 titles, 189
fragments on #468) makes the same pass hit it. That blind spot accounts for one
of the four.

**A title pass cannot reach a citation that names only the FILE.** The other
three miss for that reason — "`class-generator.test.ts`'s own use of this spy",
or the moved file listed among others in `docs/lock-order.md`. No needle built
out of titles can match them; what finds those is a fixed-string sweep for the
moved file's own name, which is a second run rather than an optional extra.

**The auditor's trap.** Two of those three name-only sites do have a hit within
a few lines — one on the `it(` line directly below the docblock that cites it,
one on a second citation further down the same test body — and both of those
hits are the kind an auditor skips, because an `it(` line reads as a test
definition rather than as drift. The third (`docs/lock-order.md`) produced no
hit anywhere in the file. So read AROUND every hit that lands in a file the
moved tests did not move to.

```sh
# titles.txt: one title per line — every moved test's `it(` title, plus the
# `describe(` title of each block they landed in
awk '{for (i = 1; i + 3 <= NF; i++) print $i, $(i+1), $(i+2), $(i+3)}' titles.txt \
  | sort -u > fragments.txt
/usr/bin/grep -rnF -f fragments.txt . \
  --include='*.ts' --include='*.tsx' --include='*.md' \
  --exclude-dir=node_modules --exclude-dir=.git \
  | /usr/bin/grep -v '^\./docs/superpowers/'

# second run, for the citations that name only the file:
/usr/bin/grep -rnF 'old-file.test.ts' src tests docs \
  --include='*.ts' --include='*.tsx' --include='*.md'
```

`/usr/bin/grep` explicitly, for the reason the parenthesis above gives.

**Expect false positives, and do not re-point them.** A title sweep cannot tell
a citation from a block or a test that simply shares the title, and in this repo
several do: the studio family mirrors the class family case for case,
`waitlist-lock-order.test.ts` carries three tests under one title, and an
extraction leaves the SOURCE file's `describe` standing under the same name the
destination's new one took. Of #468's thirty-one moved titles, **ten are also
carried elsewhere, across five files — twelve colliding sites in all**.
Re-derived with the same `titles.txt`, matching the quoted literal so a citation
in prose does not count, and excluding the four files the tests moved to:

```sh
while IFS= read -r t; do
  /usr/bin/grep -rnF "'$t'" src tests --include='*.test.ts'
done < titles.txt \
  | /usr/bin/grep -vE 'class-generator-lock-order|class-lifecycle-lock-order|room-archive-lock-order|studio-class-template-lifecycle-lock-order'
```

Each hit needs the same per-site read every other pass here needs.

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
`rooms-api.test.ts`, `invitations-api.test.ts`, and `room-archive.test.ts`)
that this pass did not investigate. It also surfaced 9 citations of
`waitlist.test.ts:525` spread across 5 files — `studio-class-generator.test.ts`,
`class-generator.test.ts`, `class-lifecycle.test.ts`,
`studio-class-template-lifecycle.test.ts`, and
`room-archive-lock-order.test.ts` — which are no longer open: #459 moved the
cited docblock to `waitlist-lock-order.test.ts`, and all 9 now name that file
and the docblock's test title instead of a line number.
