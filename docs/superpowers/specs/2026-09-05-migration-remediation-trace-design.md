# Migration remediation leaves no trace (#463) — design

**Status:** accepted, and it does not build what the issue asked for. §2 is why.

## 1. The issue, and what held

> Two applied migrations silently remediate a pre-existing invariant violation
> with no discoverable trace of it happening.

Four of the issue's claims were checked. Three hold:

- **`20260827120000_template_room_archive_invariant` remediates silently.**
  Holds. Its `UPDATE "ScheduleRule" sr SET "isActive" = false … WHERE …
  tr."isArchived"` is a bare statement under a `REMEDIATION` comment, with no
  `RAISE NOTICE`, no `GET DIAGNOSTICS`, and — being raw SQL rather than a
  Prisma client write — no `updatedAt` bump, since `ScheduleRule.updatedAt` is
  `@updatedAt`, which Prisma enforces client-side.
- **This codebase has no audit log.** Holds.
  `grep -rn "AuditLog\|audit_log" src/ prisma/` returns nothing.
- **`RAISE NOTICE` is swallowed by `prisma db execute` and not by
  `prisma migrate deploy`.** Holds, and `migrate deploy` is what CI's
  `test-unit` job runs (`.github/workflows/ci.yml`).

One does not:

- **"Two *applied* migrations."** Only one is.
  `20260905120000_class_room_archive_invariant` is neither applied nor merged:
  PR #462 is open, and the migration exists only on branch
  `339-class-room-archive-constraint`. The issue's own *Related* section says
  this was spun out of that PR's review, so it is a tense error rather than an
  invention — but it constrains the work, because nothing here may depend on
  that migration existing.

## 2. The acceptance criterion cannot be satisfied

> A new migration adds the equivalent `RAISE NOTICE` … to #272's remediation
> path — a `DO $$ … GET DIAGNOSTICS … RAISE NOTICE … END $$` block wrapping the
> existing pause logic.

**Such a migration can never report a non-zero count, on any database, ever.**

`20260827120000` ends by adding

```sql
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_live_needs_open_room"
  CHECK (NOT ("ruleLive" AND "roomArchived"));
```

and `ruleLive` / `roomArchived` are not free columns. Each is one column of a
composite foreign key whose other columns are its parent's, with
`ON UPDATE CASCADE`:

- `ClassTemplate(scheduleRuleId, kind, ruleLive)` → `ScheduleRule(id, kind, live)`,
  where `ScheduleRule.live` is `GENERATED ALWAYS AS ("isActive" AND NOT "isArchived") STORED`;
- `ClassTemplate(teacherRoomId, roomArchived)` → `TeacherRoom(id, isArchived)`.

A row whose mirror disagrees with its parent is refused rather than stored, so
`ruleLive AND roomArchived` is identically
`(sr.isActive AND NOT sr.isArchived) AND tr.isArchived` — **the remediation's own
`WHERE` clause**. The CHECK forbids exactly the rows the `UPDATE` would target.

Every door into that state is enumerated and proven refused in
`src/services/template-room-constraint.test.ts`: archiving a room a live
template sits on, resuming a template whose room is archived, creating a live
template on an archived room, moving a live template onto an archived room, and
two cases proving neither mirror can lie about its parent.

And the one scenario where the violating state genuinely exists at the start of
a run is the scenario the notice is worst at. Prisma applies migrations in name
order, so against a stale database holding real violating rows,
`20260827120000` runs **first**, silently repairs them, and the new migration
then reports `0`. **The notice would be guaranteed silent in precisely the case
it exists to report.**

Shipping it would leave a migration that *looks* like the gap is closed while
being structurally incapable of reporting. That is worse than shipping nothing,
so it is not built. The issue's escape hatch — "or an equivalent
operator-visible signal" — does not rescue it: no signal on #272's remediation
path can fire, because the path is unreachable.

## 3. What is built instead

The issue's real subject is *a remediating migration left no trace*. That
splits cleanly into a fact about the past and a rule about the future, and both
are leaf-sized.

### 3.1 Backward — the record (`docs/lock-order.md`)

`docs/lock-order.md` already carries a section titled **"The migration comments
that this document owns"**, holding prose stranded in applied, immutable
migrations. It already discusses `20260827120000`. That is the home, per
CLAUDE.md's *Comment Discipline* ("Prose about a migration goes in `docs/`").

A third entry records:

- what the remediation did, and that it did it without a trace of any kind;
- why it cannot be retrofitted (applied; a comment-only edit changes the
  SHA-256 that `_prisma_migrations` stores while `prisma migrate status`
  compares names);
- why a re-run is inert, per §2, citing `template-room-constraint.test.ts`;
- **the forensic query an operator can still run**, and honestly what it does
  and does not prove.

The query lists *candidates*, not a roster. A rule the migration paused and a
rule the teacher paused before archiving the room are indistinguishable in the
stored state — door 1 requires pausing every live template before a room can be
archived, so the teacher-caused shape is identical. One discriminator survives,
in one direction only: the migration's raw `UPDATE` did not bump `updatedAt`,
so a remediated row's `updatedAt` necessarily **predates** the migration.
`updatedAt >= '2026-08-27 12:00'` therefore *rules out* remediation; an earlier
value does not rule it in.

The section opens "Two of them" — a prose count this entry falsifies. It is
corrected in the same change (CLAUDE.md, *Counts*).

### 3.2 Forward — the tether (a sweep test)

`tests/migration-sql.ts` already exposes `migrationSqlFiles()`, whose own
docblock says it "sweeps the directory rather than naming the known files, so it
covers migrations that do not exist yet — which is the entire point of the pins
built on it." `src/lib/api-errors.test.ts` is the working example of a pin built
on it, negative controls included. No CI job inspects migration SQL for this
(checked `.github/workflows/ci.yml`: `prisma validate`, a migrate-drift check,
typecheck, lint, vitest — none of them), so this is a new pin on existing
infrastructure, not a second copy of an existing gate.

**The rule.** A migration sorting after a named cutoff that contains a
data-modifying statement must also contain either a real `RAISE NOTICE` or an
explicit marker declaring why it needs none:

```sql
-- DML WITHOUT NOTICE: <reason>
```

**Fail toward the marker, deliberately.** No regex can tell a backfill from a
remediation, so the rule does not try. Over-triggering costs the author one
comment line stating their reasoning — which is exactly the artifact #339's
review produced by hand. Under-triggering costs another silent remediation,
which is the bug. The asymmetry decides the design.

**A cutoff, not a roster.** The rule binds migrations sorting strictly after
`20260903195051_student_signup_purposes`, the last on `main` when this lands.
One constant, not a list of grandfathered names — and it can never grow, since
every migration before it is frozen by policy. CLAUDE.md forbids prose rosters
for exactly this reason.

**Comments are stripped on both sides, and that is load-bearing.**
`20260905120000_class_room_archive_invariant` (PR #462) contains the literal
text `RAISE NOTICE` twice: once as the real call, and once inside a comment
explaining that `prisma db execute` swallows it. A detector that did not strip
comments would accept a migration that merely *talks about* announcing. The
same applies to the DML side: `20260826080100_calendar_entry_rewire` names
`UPDATE "Class" SET status='completed'` inside a comment.

**Measured against the current tree.** Of 46 migration directories on `main`, 7
contain `UPDATE "…"` or `DELETE FROM "…"` outside comments; 6 of those carry one
as a top-level migration statement, the seventh
(`20260826080100_calendar_entry_rewire`) having its only one inside a trigger
function body, where it defines runtime behaviour rather than running at
migration time. Exactly 1 of the 7 (`20260825065109_schedule_rule_backfill`)
carries a real `RAISE NOTICE`. All 7 sort before the cutoff and are unaffected.
Re-derive with the script in `docs/lock-order.md`.

**PR #462 is checked against this rule and complies**: its
`20260905120000_class_room_archive_invariant` sorts after the cutoff, contains
DML, and carries a real `RAISE NOTICE` (1 after comment-stripping, 2 before);
its `20260905130000_index_class_room_fk` contains no DML at all. Merging #462 in
either order relative to this branch leaves the sweep green.

## 4. Not built

- **No new migration.** §2. This branch adds no file under `prisma/migrations/`,
  so there is no timestamp to order against PR #462's two.
- **No audit table, and no `updatedAt` trigger.** The issue rules the first out
  itself; the second is the same redesign wearing a smaller hat, and would need
  a decision about every table rather than this one.
- **No retrospective notice reporting the candidate set.** It would conflate
  migration-paused with teacher-paused rules (§3.1) and fire on every
  environment forever. A misleading signal is worse than none.
- **#272 and #339 are unaffected** — neither invariant, constraint, nor door
  changes here.

## 5. Acceptance

1. `docs/lock-order.md` carries the third entry of §3.1, its count corrected,
   with a forensic query that runs.
2. A sweep test enforces §3.2 against the live tree and is green.
3. The sweep is proven able to fail: synthetic migrations covering DML with no
   notice and no marker (reported), DML with a comment-only `RAISE NOTICE`
   (reported), DML with a real notice (clean), DML with the marker (clean), and
   a migration before the cutoff carrying neither (clean).
4. `npm run typecheck`, `npm run lint`, and the unit/components projects are
   green. Integration and e2e are CI's signal — this branch is a worktree with
   no dev server and no shared database.
