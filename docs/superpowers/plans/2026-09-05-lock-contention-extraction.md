# Plan — extract the lock-staging tests out of three parallel-tier files

Issue #459. Design: `docs/superpowers/specs/2026-09-05-lock-contention-extraction-design.md`.

Read the spec's §3 (the adjudication) before starting any task. The lists of
which tests move are there and are not repeated here.

Six tasks, **in order**. Tasks 1-3 each leave the repo green on their own,
because each adds its own file to `LOCK_CONTENTION_TESTS` in the same task —
`src/lib/serial-tier-membership.test.ts` fails the moment a file carries the
marker without being listed, so splitting that off would leave two tasks red.

Local verification in this worktree is typecheck + lint + `unit` + `unit-sweeps`
+ `components`. The `integration` and `e2e` tiers need the dev server on `:3000`
and the shared dev database, neither of which a worktree has — CI is the signal
for those.

---

## Task 1 — `waitlist-lock-order.test.ts`

**Create** `src/services/waitlist-lock-order.test.ts` holding the five tests
named in spec §3.2, and remove them from `src/services/waitlist.test.ts`.

The new file needs:

- A header docblock opening with `@serial-tier lock-contention` and this
  file's own reason: three of its five tests hold a `Class` row for 3 500 ms
  on a second connection and assert `55P03`, so they both create lock noise
  and are destroyed by it.
- Its own module-level `PrismaClient`, `uniqueSuffix`, and a `slotTime`
  equivalent. Each moved test builds its own class; give the file one teacher,
  one room, one `TeacherRoom` and enough students, and let each test create the
  class it locks. Three of the five already do exactly that in place.
- The reference docblock currently at `waitlist.test.ts:515-555` — the one that
  argues why there is no upper bound on `waited` — moves with `:556`. Its two
  siblings (`:896`, `:1275`) point at it by describe name; re-point them at
  wherever it lands.
- Each moved test's own `PrismaClient` holder must still be disconnected.

Then, in `waitlist.test.ts`:

- **H1.** Replace `:2025-2031`'s sentence about `takes the class row lock
  before it counts` re-filling the seat. That test is gone from this file. Say
  what is true now: the block's dependency on `stays silent when the class is
  already full…` above it is real and unchanged; nothing below it re-fills.
  Replace the sentence, do not annotate it.
- **H5.** `describe('removeFromWaitlist takes the class lock (DB)')` at `:1671`
  now holds only the interposed-delete test. Rename it for what remains.
- Check that the remaining `:1837` still passes: it used to run after `:1777`
  removed `studentIds[1]`, and now runs first in its block. If it depended on
  that state, make the dependency explicit in the test rather than leaving it
  implicit in ordering.
- Delete any import that loses its last use.

Add `'src/services/waitlist-lock-order.test.ts'` to `LOCK_CONTENTION_TESTS`.

**Verify:** `vitest list` counts on both files match spec §3.4 (45 and 5); both
files pass, and the new one passes run alone.

---

## Task 2 — `class-template-lifecycle-lock-order.test.ts`

**Create** `src/services/class-template-lifecycle-lock-order.test.ts` holding
the five tests named in spec §3.3, and remove them from
`src/services/class-template-lifecycle.test.ts`.

**H3 is the trap here.** The three source describes each allocate `ScheduleRule`
slots from a running counter with block-specific spacing — ×75 against
`durationMinutes: 60` in `updateClassTemplate (DB)`, ×60 against 60 in
`pauseOrResumeTemplate (DB)`, ×10 against 10 for `makeClass` in
`archiveOrUnarchiveTemplate (DB)`. Copying the wrong spacing fails at *fixture
build* under `ScheduleRule_teacher_slot_excl`, with an error that says nothing
about locks. Give the new file its own teacher and its own counter, and keep
each moved test on the spacing of the block it came from — or give each moved
test a teacher of its own, which sidesteps the constraint entirely, whichever
reads better once the five are side by side.

In the source file:

- **H2.** Delete the prose call-counts at `:153`, `:1179` and `:2484` — not
  correct them. Keep each paragraph's load-bearing half (the spacing rule and
  why that multiplier), which needs no count. CLAUDE.md's *Comment Discipline*
  is the reason; `slotTime`'s own `throw` is the tether that replaces them.
- **H2, second half.** `:3154-3158` says `'08:00'` is used because "the last
  counter value is spoken for". Two counter slots are freed by this task, so
  that claim stops being true. Rewrite it to keep only why `'08:00'` is a legal
  slot.
- **H4.** `setLockTimeout` (`:14`) and `isTransientDbError` (`:10`) lose their
  last runtime uses. Remove them. Sweep the rest of the import list the same
  way — `lint` will catch what is missed, but check `vi` and `log` too.

Add the new path to `LOCK_CONTENTION_TESTS`.

**Verify:** counts match spec §3.4 (61 and 5); `npm run lint` is clean; both
files pass, and the new one passes run alone.

---

## Task 3 — append gdpr's thirteen tests to `gdpr-lock-order.test.ts`

**Append** the nine blocks / thirteen tests named in spec §3.1 to
`src/services/gdpr-lock-order.test.ts`, and remove them from
`src/services/gdpr.test.ts`. No new file, no new list entry — that file is
already on `LOCK_CONTENTION_TESTS` and already carries the marker.

- **Rewrite its header docblock.** It currently states one reason scoped to its
  single AB-BA probe. State one reason that covers the whole file after the
  append. Its existing `isClassPreLock` / `awaitHandshake` machinery belongs to
  the original test and stays scoped to it.
- **`makeStudentWaitingInClass` / `cleanupStudentWaitingInClass`
  (`gdpr.test.ts:41-179`) are DUPLICATED, not moved.** Four moving tests use
  them and one staying test (`:888`) does too. Both copies keep the parts of
  the docblock that are true of their own file; neither copy should describe
  the other's callers.
- **`makeStudentWithClosedEntriesInClasses` / `cleanupStudentWithClosedEntries`
  (`:180-267`) are MOVED.** Their only caller is `:689`, inside the block that
  moves. Leaving them behind strands dead code.
- Three whole describes move intact, each holding exactly one moving test:
  `blocks concurrent registrations on classes it locks (#367)` (`:2176`),
  `serialises against a claim in progress (#315)` (`:2719`) and
  `serialises against a studio claim in progress (#315)` (`:2851`).
- One describe splits: `student erasure is retry-safe against a concurrent
  duplicate (#196)` (`:2337`) keeps `:2538` and `:2595`, which share its
  `makeStudentWithFreedSpot` / `cleanup` helpers. Those helpers are duplicated,
  like the pair above.
- The five tests moving out of `describe('GDPR (DB)')` do **not** use that
  block's `beforeAll` fixture — each builds its own through the helpers. They
  need no copy of it.
- Delete imports that lose their last use in either file.

**Verify:** counts match spec §3.4 (22 and 14); both files pass;
`gdpr-lock-order.test.ts` passes run alone.

---

## Task 4 — the citation sweep (H6)

Sweep for citations of the moved tests **by title**, not by filename — a
citation that names the test but not the file is what a filename grep misses.
The spec's §4 H6 gives the command and the title list.

Give every hit a verdict. Expect legitimate survivors:

- `docs/superpowers/plans/**` and `docs/superpowers/specs/**` are **records**
  of what was true when written. Do not update them. This includes
  `2026-08-13-waitlist-reconciliation-design.md:410`, which carries a copy of
  the H1 sentence.
- Live reference documents — `docs/lock-order.md`,
  `docs/technical-architecture.md`, `docs/comment-citation-sweep.md` — and any
  `src/**` or `tests/**` file **are** updated. `docs/lock-order.md:1433` cites
  `gdpr.test.ts` for "waits for a concurrent claim to release the child row…",
  which moves.

Then sweep the other direction: grep for the three source filenames across
live documents and source, and check each hit still describes what that file
holds. A grep finds a stale name, never a stale description — where a citation
says what a file *is* rather than what it is called, read the whole sentence.

---

## Task 5 — the tier config, and the follow-up issue

**`vitest.tiers.ts`.** The note at `:49-52` currently says #459 owns which
parallel-tier files still assert on lock outcomes, and that the list is short
until #459 lands. Spec §1.6 shows seven such files remain afterwards, so the
note is narrowed and re-pointed rather than deleted: this change closed three
of them, a follow-up owns the rest, and no roster of those files goes in the
comment (a roster of other files has no owner there).

Update the same way:

- `:79-84`, the paragraph on `gdpr-lock-order.test.ts`, which says the split is
  "the one #459 proposes for three more files" — that is now done, not proposed.
- `vitest.config.ts:9-16`, whose `unit` bullet points at #459 for the same
  property.

**File the follow-up issue** for the seven files in spec §1.6, with the sweep
command, the two twin tests named (`class-lifecycle.test.ts:1232` and
`studio-class-template-lifecycle.test.ts:552`), and
`transition-class-lock-order.test.ts`'s missing marker called out as the
cheapest of the three. Use a body file, never `--body "…"`.

---

## Task 6 — measure and reconcile

1. `npx vitest run --project unit-sweeps` — record files, tests, duration.
   Baseline is **49.50 s / 17 files / 167 tests** (spec §1.7).
2. `npx vitest run --project unit` — confirm green and record its duration too,
   since three of its files got shorter.
3. Re-derive every count in spec §3.4 with
   `npx vitest list --project <tier> <file> | grep -c '^\['` and reconcile
   against the table. Repo-wide the total must be unchanged at 152.
4. Run the spec §1.6 sweep and confirm none of the three source files is in it.
5. `npm run typecheck`, `npm run lint`, and the three local vitest projects.

Anything that does not reconcile is a defect in this branch, not a number to
adjust — the table is the acceptance criterion.
