# Migration remediation leaves no trace (#463) — plan

Design: `docs/superpowers/specs/2026-09-05-migration-remediation-trace-design.md`.
Read §2 first — the issue's stated acceptance criterion is not built, and why
is the load-bearing part of this branch.

Two tasks. **The order is load-bearing**: task 2's prose states the rule task 1
defines and ships its re-derivation command, so the rule must exist first.

---

## Task 1 — the tether: a sweep that binds future migrations

**Files:** `tests/migration-sql.ts` (extend), `src/lib/migration-remediation-trace.test.ts` (new).

### The rule

A migration whose directory name sorts strictly after
`20260903195051_student_signup_purposes` and which contains a data-modifying
statement must also contain either a real `RAISE NOTICE` or an explicit marker
comment declaring why it needs none.

### Helper, in `tests/migration-sql.ts`

Beside the existing `functionEvents` / `liveFunctions` / `migrationSqlFiles`,
and pure in the same way — takes SQL text so a caller can hand it a synthetic
migration and watch the sweep go red.

- **`stripSqlComments(sql: string): string`** — removes `/* … */` blocks, then
  `--` line comments. **Block comments first, and the order matters**: on
  `/* -- */ UPDATE "X"`, line-first leaves a dangling `/*` and loses the
  statement. One migration has a real block comment
  (`20260804200809_move_block_out_of_invitation`, line 1).
  Confirm no migration carries `--` inside a dollar-quoted or single-quoted
  string, which this would strip wrongly; if one does, say so in the docblock
  rather than building a SQL parser.
- **`untracedDataChanges(migrations, cutoff): string[]`** — the names of
  migrations sorting strictly after `cutoff` that change data without a trace.
  Takes the cutoff as a parameter so the tests can run the rule unbounded.

Three detections, and **which text each reads is the subtle part**:

| Detection | Reads | Why |
|---|---|---|
| data change | **stripped** SQL | `20260826080100_calendar_entry_rewire` names `UPDATE "Class" SET status='completed'` inside a comment |
| `RAISE NOTICE` | **stripped** SQL | `20260905120000_class_room_archive_invariant` (PR #462) contains the literal text twice — once real, once in a comment explaining that `prisma db execute` swallows it |
| the marker | **raw** SQL | it *is* a comment; stripping would erase it |

- **Data change** is `UPDATE "…"` or `DELETE FROM "…"`, anywhere in the stripped
  text — including inside function bodies. Deliberately not statement-initial:
  no regex separates a backfill from a remediation, so the rule does not try,
  and over-triggering costs one comment line while under-triggering costs
  another silent remediation. Scoped to `UPDATE`/`DELETE` and not `INSERT`:
  these are the statements that rewrite data a teacher already has. Verify the
  pattern does not match `ON UPDATE CASCADE` or `FOR UPDATE OF`. (The reason
  given here at first — "neither is followed by a quoted identifier" — was
  wrong: `FOR UPDATE OF "Class"` is legal SQL and quoted. What keeps the pattern
  safe is the intervening word, `CASCADE` or `OF`, which `UPDATE\s+"` cannot
  cross.)
- **The marker** is `-- DML WITHOUT NOTICE: <reason>` and the reason must be
  non-empty — a bare marker with nothing after the colon does not exempt.

### Tests, in `src/lib/migration-remediation-trace.test.ts`

`src/**/*.test.ts` is the `unit` project's glob (`vitest.config.ts`), and a test
with no source sibling is ordinary here — `src/lib/db-locks-lock-order.test.ts`
is one. Reads files; touches no database.

Against the **live tree** — these are what prove the detector works on real SQL
rather than only on fixtures:

1. The rule, run with the real cutoff, reports nothing.
2. The cutoff **names a migration that exists in the tree.** Non-vacuity
   against a typo'd or over-large cutoff, which would otherwise disable the rule
   while every assertion above it stayed green. (When this was written nothing
   sorted after the cutoff at all, so this was the sweep's *only* defence;
   #339's two migrations landed after it mid-branch and now give the live sweep
   real subjects.)
3. The rule, run **unbounded**, reports
   `20260827120000_template_room_archive_invariant` — the migration this issue
   is about. Assert containment, not an exact set.
4. ~~The rule, run unbounded, does **not** report
   `20260825065109_schedule_rule_backfill`, which carries a real `RAISE NOTICE`.~~
   **Struck: the premise is false, and the error was mine.** That migration
   carries no `RAISE NOTICE` — its only occurrence of the text is a `--` comment,
   and what it raises is a `RAISE EXCEPTION` pre-flight. Task 1 replaced this
   with two live-tree assertions that are true and stronger, one per side of
   comment-stripping: the unbounded run **does** report that migration (the
   tree's own instance of the comment-only-notice hazard) and does **not**
   report `20260826182710_entry_completion_marker_guard` or
   `20260826200000_entry_marker_exclusivity`, whose only `UPDATE` sits in a
   comment. See the spec §3.2 correction.

Against **synthetic migrations**, each named so it sorts after the cutoff
(`20990101000000_…` and on, as `api-errors.test.ts` does), one case per way of
being right or wrong:

5. DML, no notice, no marker → reported.
6. DML whose only `RAISE NOTICE` sits inside a comment → reported. Build this
   fixture from the real shape in PR #462's migration, so it pins the hazard
   that actually exists.
7. DML with a real `RAISE NOTICE` → clean.
8. DML with the marker and a reason → clean.
9. DML with the marker and **no** reason → reported.
10. No DML at all, whose text contains `ON UPDATE CASCADE` and `FOR UPDATE OF` →
    clean. The false-positive guard for the two phrases this tree is full of.
11. A migration sorting **before** the cutoff with DML and neither trace →
    clean. Proves the cutoff is applied rather than decorative.

### Prove it bites

Per CLAUDE.md and the skill's §3: for the live sweep (1), break it and record
the exact failure text before restoring. The realistic regression is a new
untraced migration, so mutate by adding a synthetic post-cutoff migration
entry to the sweep's input — **not** by editing anything under
`prisma/migrations/`, which is immutable and checksum-pinned. Record the error
text in the task report.

---

## Task 2 — the record: what #272's remediation did, and how to look for it

**File:** `docs/lock-order.md`, the section titled **"The migration comments
that this document owns"**.

That section exists for prose stranded in applied, immutable migrations, and
already discusses `20260827120000`. Add a third entry, matching the form of the
two beside it (what the migration says, why it is wrong or incomplete where it
sits, and the re-derivable live copy).

It must carry:

- **What the remediation did**: paused any live `ClassTemplate` found on an
  archived `TeacherRoom`, by a raw `UPDATE "ScheduleRule" SET "isActive" =
  false`, and left no trace of any kind — no notice, no audit row, and no
  `updatedAt` bump, since `ScheduleRule.updatedAt` is `@updatedAt`, which Prisma
  enforces client-side and a raw SQL statement never reaches.
- **Why it is not fixed in place**: the migration is applied; a comment-only
  edit changes the SHA-256 `_prisma_migrations` stores while
  `prisma migrate status` compares names. This is the same argument the first
  entry in this section already makes — cite it rather than restating it.
- **Why a re-run would be inert**, from spec §2, short: the CHECK added at the
  foot of that same migration forbids exactly the rows the `UPDATE` targets,
  every door is proven refused in `src/services/template-room-constraint.test.ts`,
  and a later migration always runs *after* `20260827120000` — so against the
  one database that would have something to report, the earlier migration
  silently repairs it first.
- **The forensic query**, and honestly what it proves: it lists paused rules
  whose template sits on an archived room, which are **candidates, not a
  roster** — door 1 forces a teacher to pause every live template before
  archiving a room, so the teacher-caused shape is identical in the stored
  state. ~~One discriminator survives, in one direction only:
  `updatedAt >= '2026-08-27 12:00'` rules remediation out.~~ **Struck: the
  instant is wrong to hard-code and the inference is unsound** — see the spec's
  correction and `docs/lock-order.md`'s third entry. `updatedAt` ships as
  evidence in the `SELECT`, never as a `WHERE` filter. Say what the query does
  and does not prove, rather than implying it identifies affected rows.
- **The rule task 1 now enforces**, and its re-derivation command — the shell
  equivalent of the sweep, so a reader can reproduce the census without running
  vitest. Ship the command, per this document's existing habit of shipping the
  SQL that re-derives its own numbers.

**The count.** The section opens "Two of them, both stranded in APPLIED
migrations". A third entry falsifies that. Correct the wording rather than
annotating it (CLAUDE.md: replace, don't narrate the history) — and prefer a
form that does not need re-counting next time.

**Also check** whether anything else in the tree states that count or lists
that section's members, and give every hit a verdict.

---

## Verification

`npm run typecheck`, `npm run lint`, `npx vitest run --project unit`,
`--project unit-sweeps`, `--project components`. Integration and e2e are CI's
signal: this is a worktree with no dev server on `:3000`.

No file under `prisma/migrations/` is added or edited by either task.

---

## Divergences from this plan, and why

A plan is a record of a decision, not a live spec — but one stating something
false *about the repository* is an error rather than history, so those are
struck in place above.

1. **Test 4 struck.** My factual error about
   `20260825065109_schedule_rule_backfill`'s `RAISE NOTICE`.
2. **The `FOR UPDATE OF` reasoning corrected.** Mine again: the pattern is safe,
   the stated reason was not.
3. **Task 1 declined the docblock wording suggested here** — "one migration has
   a real block comment" is a prose count plus a census over another directory,
   which CLAUDE.md's *Comment Discipline* forbids in a comment. It named the
   instance without claiming it is the only one and shipped the re-derivation
   command instead. Correct call.
4. **Running the rule unbounded was underspecified**; task 1 chose `''`, the
   comparison being a strict `>`.
5. **`20260905120000_class_room_archive_invariant` arrived mid-branch.** PR #462
   merged at 21:08:35Z on 2026-09-05, `main` moved to `9f1f95c3`, and this branch
   was rebased onto it. Every census figure in the spec is post-merge; the cutoff
   did not move, and spec §3.2 says why.
