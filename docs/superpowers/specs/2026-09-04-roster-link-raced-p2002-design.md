# The roster link is written once, atomically, by one function

**Issue:** #181
**Date:** 2026-09-04
**Status:** design

## What #181 asked for, and what is actually there

#181 says `acceptInvitation`'s `TeacherStudent` upsert is not atomic, that a
concurrent booking landing between its read and its write raises `P2002`, and
that `classifyApiError` turns that into a 409 telling a student their valid
acceptance conflicted. **All three hold.** The mechanism is exactly as stated,
the quoted comment (`invitations.ts:852-854`) is false under concurrency, and
`src/lib/api-errors.ts:534` is the branch that answers it.

**The scope does not hold: it is one of five identical sites.**

```bash
grep -rn "teacherStudent\.\(upsert\|create\|createMany\)" src --include="*.ts" | grep -v "\.test\."
```

11 hits = **5 calls** + 6 prose mentions inside comments. Every call is the
same statement — `upsert({ where: { teacherId_studentId }, update: {}, create:
{…} })` — on the same key, `TeacherStudent @@unique([teacherId, studentId])`,
and therefore carries the same race:

| # | Site | Function | What a raced `P2002` tells the user |
|---|---|---|---|
| 1 | `app/api/registrations/route.ts:234` | `POST /api/registrations` | 409 **"Student is already registered for this class"** |
| 2 | `services/invitations.ts:855` | `acceptInvitation` | 409 "Resource already exists" — #181's headline |
| 3 | `services/waitlist.ts:276` | `addToWaitlist` | 409 "Resource already exists" |
| 4 | `services/waitlist.ts:555` | `promoteNext` | swallowed post-commit; the seat waits for the next sweep |
| 5 | `services/waitlist.ts:678` | `claimSpot` | 409 "Resource already exists" |

**Three independent enumerations agree on this set**, which is why the number
is stated here rather than re-measured downstream:

- the grep above,
- `docs/lock-order.md:989-995`, which names all five in prose to warn against
  editing their `update: {}`,
- `src/lib/student-visibility.ts:192-209`, which names all five to argue that
  four require a session and `promoteNext` does not.

### Row 1 is a worse defect than #181's own

`registrations/route.ts:289-294` catches a **bare** `P2002` — no column
narrowing — and answers `'Student is already registered for this class'`. A
`TeacherStudent` collision therefore arrives as a **false statement** about a
different table, with the entire registration rolled back: the student is told
they already hold a seat they do not hold.

That is precisely the failure `unique-conflict.ts`'s docblock and the #161
raced-create spec warn about — a bare `P2002` check swallowing a constraint the
reasoning was only ever established for. It is also why #197's assessment needs
a note: that issue lists this string among the messages that are *already
fine*, which is true of the intended path and blind to the raced one.

### Row 4 is the mildest, and is still real

`promoteNext` runs inside `handleSpotFreed`, invoked post-commit from the
cancel routes and from `reconcileWaitlists`. A `P2002` there aborts the
promotion; the waiting student's seat is not lost, but it waits for the next
reconciliation sweep. No user sees a wrong message — the harm is latency, not a
lie.

## The design

**One function replaces all five upserts.** New module,
`src/services/roster-link.ts`:

```ts
export async function linkTeacherStudent(
  tx: Prisma.TransactionClient,
  pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput,
): Promise<void> {
  await tx.teacherStudent.createMany({ data: [pair], skipDuplicates: true });
}
```

### Why `createMany({ skipDuplicates: true })`

It compiles to `INSERT … ON CONFLICT DO NOTHING`: one statement, so there is no
read-then-write gap for a concurrent insert to land in, and no `P2002` to
escape. This is already the codebase's idiom for this exact shape —
`classes/route.ts:123`, `studio-classes/route.ts:96`, `entry-generation.ts:842`,
`class-template-lifecycle.ts:982`, `studio-class-template-lifecycle.ts:723`.

`$executeRaw` with a hand-written `ON CONFLICT` was the other candidate #181
names. It is rejected because **`TeacherStudent.id` has no database default** —
`20260405131611_add_teacher_student_crm/migration.sql:6` declares plain `"id"
TEXT NOT NULL`, and Prisma's `@default(uuid())` is minted client-side. A raw
insert would have to generate the uuid by hand, duplicating something Prisma
already does correctly.

Catching `P2002` per site — the #161 spec's answer for its four windows — is
rejected here for a different reason: those were four *different* constraints
on four different tables, so a shared helper was not available. These five are
one constraint on one table, written five times. Closing the window beats
catching its tail, and it leaves one place to be correct instead of five to
keep in sync.

### Why the argument is typed as the compound unique input

`skipDuplicates` emits a bare `ON CONFLICT DO NOTHING` with no conflict target,
so it depends on `(teacherId, studentId)` actually being a unique key. Typing
the parameter as `Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput`
tethers that to the compiler: Prisma generates that type only for a declared
compound unique, so dropping or renaming the key deletes the type and the
helper stops compiling, rather than silently degrading to an unguarded insert.

**A residual this does not close, stated rather than engineered around:** a
target-less `ON CONFLICT DO NOTHING` skips on *any* unique violation, so a
second unique key added to `TeacherStudent` in future would be silently
swallowed too. Today there is exactly one (`@@unique([teacherId, studentId])`;
the PK is a freshly-minted uuid that cannot collide). The tether above pins that
the roster pair *is* a unique key; nothing pins that it is the *only* one, and
building machinery for a second key on a two-column join table would be
speculative. This paragraph is the record.

### What it does to the lock order

This is the part that must be **measured**, not reasoned about, because
`docs/lock-order.md` turns on it and #179's reorder was justified by it.

| Case | Today (`update: {}`) | After (`ON CONFLICT DO NOTHING`) |
|---|---|---|
| Row exists, **committed** | 3 non-locking `SELECT`s — no wait, no lock | conflict → no-op — no wait, no lock |
| Row absent, concurrent **uncommitted** inserter | `SELECT` (blind to it) → `INSERT` → **waits** → `P2002` | `INSERT` → **waits?** → no-op |

The row-exists case is settled by inspection: neither shape takes a row lock,
which is what `docs/lock-order.md:999-1007` asserts and this change preserves —
though for a better reason, since it becomes a property of the statement rather
than an accident of how Prisma compiles an empty `update`.

**The absent-row case is the open question, and the whole design hangs on it:**

> Does `INSERT … ON CONFLICT DO NOTHING` wait on a conflicting **uncommitted**
> tuple the way a plain `INSERT` does?

If it waits, the wait edge is unchanged, the `40P01` cycle between
`acceptInvitation` and `POST /api/registrations` is unchanged, and #179's
reorder remains load-bearing. If it does not, that cycle is closed by
construction as well — a larger result, and one `docs/lock-order.md` would have
to state differently.

**The decisive experiment already has its machinery, and its baseline.**
`src/services/invitations-lock-order.test.ts:479-482` records the measurement
this branch has to re-take, three runs per order:

```
old: {"accept":"REJECTED 40P01","booking":"ok"}   x3
new: {"accept":"REJECTED P2002","booking":"ok"}   x3
```

That second line **is #181's defect**, already reproduced and written down here
— the same 3/3 the issue cites. The docblock names it "a real, separately-filed,
pre-existing bug… pinning it here would make this test fail the day it is
fixed," which is this branch.

So the experiment is: re-run the **old** (pre-#179) order with the new statement
on the accept side.

- still `40P01` → the wait edge survives; #179's reorder remains load-bearing
  and `docs/lock-order.md`'s account of it needs only the statement's name
  changed.
- no longer `40P01` → the wait edge is gone, the cycle is closed by construction
  as well, and the doc must say so rather than crediting the reorder alone.

Do not infer the answer from the *new* order's test passing: it passes under
either outcome, so it cannot distinguish them. This is the "ask whether a
verification could have failed at all" rule applied to the one claim that
matters.

### The bare catch at `POST /api/registrations`

Once no `TeacherStudent` write can raise `P2002`, the bare catch at
`registrations/route.ts:289-294` becomes accidentally true. Narrow it anyway:

```ts
isUniqueConflictOn(err, ['classId', 'studentId'])   // Registration's own key
```

An unmatched `P2002` then falls through to `withErrorHandler`'s generic branch,
which answers 409 and logs `warn` naming `meta.target` — observable, and the
right family for a unique violation. It is deliberately **not** rethrown as an
ordinary `Error` for a 500, which is what the #161 spec prescribes for its
service-level catches: those routes had a *coded* 409 to mirror, so an
unrecognised `P2002` reaching the code-less fallback would have delivered the
same defect through the other door. This route codes nothing — `respondError(msg,
409)` with no third argument — so there is no code to lose, and a 409 plus a
targeted `warn` is strictly better than a 500 for a unique violation raised by a
transaction this broad.

This is hardening, not a live-bug fix: the helper is what removes the false
statement. It is in scope because it is two lines in a `catch` this PR already
edits, and because leaving it lets the next write added to that transaction
re-arm the mislabel silently.

## What this falsifies, and where

`P2002` and the word `upsert` are both greppable, so this sweep is mechanical.
The **argument** in `student-visibility.ts` survives and only its mechanism name
changes — that one needs reading, not grepping.

### Source

| Location | Claim | Disposition |
|---|---|---|
| `invitations.ts:852-854` | "`upsert`, not `create`… accepting must not throw on that overlap" | The false comment #181 names. Gone with the statement. |
| `invitations.ts:805-850` | The lock-order comment: "compiles to three plain, non-locking `SELECT`s", "one real column away from vanishing", "give this `update` a single field" | Substantially falsified — there is no `update: {}` left here. Rewrite to what the new statement guarantees. |
| `invitations.ts:722, 727, 773` | `NotPendingError`'s and the docblock's references to "the upsert above/below" | Name change only. |
| `invitations.ts:985` | "promotion's own `teacherStudent.upsert`" | Name change only. |
| `waitlist.ts:263, 445, 550, 989, 1068, 1076` | Six references to "the upsert" at or about sites 3-5 | Name change; `:1068` ("waited on the row — a deadlock instead of a race") is contingent on the measurement above. |
| `registrations/route.ts:111, 231-238` | "four places — `addToWaitlist`, `promoteNext`, `claimSpot` and…"; the roster-link comment | Name change. |
| `student-visibility.ts:192-209` | **A prose count of five**, plus a four-of-five roster | The argument survives; the census becomes "the callers of `linkTeacherStudent`" — a compiler-findable set rather than a prose roster. This is the Comment Discipline win, not just a rename. |
| `invitations.ts:920, 1015-1042, 1076` | `StudentPrivacy` and `TeacherBlock` upserts | **Unaffected.** Different tables; `SILENCED_PRIVACY` is six real columns and was never empty. |

### Docs

- `docs/lock-order.md:977-1027` — "The empty-`update` upsert quirk". Its five
  `TeacherStudent` sites become zero; `unlinkTeacher`'s `TeacherBlock` upsert is
  the sole survivor. The section's standing instruction to a future reader
  ("stop… you have just reintroduced a live `40P01`") currently protects five
  call sites by asking people to read a document; after this it protects one,
  because at the other five there is no `update: {}` left to tidy. **Replace the
  section, do not annotate it** — the before-and-after goes in the PR body.
- `docs/lock-order.md:694, 1583-1611, 1793, 1868-1874` — cross-references to the
  quirk and the `acceptInvitation`/registrations conformance entries.
- `docs/lock-order.md:359` — a `grep` pattern listing Prisma write verbs;
  `createMany` must be in it or the pattern stops finding these sites.

### Tests

`src/services/invitations-lock-order.test.ts` (12 tests, green at baseline):

- `:203` "with the real empty-update upsert…", `:248` and `:307`, which force
  the atomic path with a synthetic `update: { isArchived: false }`. They
  document a Prisma behaviour that remains true and stay valid as mechanism
  documentation; their **prose about what the real code does** goes stale and
  must be re-aimed at `unlinkTeacher`'s `TeacherBlock` upsert, now the only real
  code the quirk governs.
- `:499` "does not deadlock when a real accept races a real booking on an
  unlinked pair", and its docblock at `:468-497`. This is the test that
  currently **tolerates** the P2002 — it asserts the absence of `40P01` and
  nothing more, and says so deliberately: *"pinning it here would make this test
  fail the day it is fixed."* Today is that day. The tolerance goes; what
  replaces it is the assertion that the accept **succeeds**, which is exactly
  the shape #181's acceptance criterion 2 demands and the shape it warns against
  copying from #179.
- Every `$extends` interceptor in the file that hooks `teacherStudent.upsert`
  (`:513` and its siblings) — see the trap in Verification below.

`src/lib/student-visibility.ts`'s own tests, if any assert that census, and the
`invitations.ts` docblock tests — swept from the diff, not from a keyword.

### Tracker

- **#197** gets a comment: `'Student is already registered for this class'` is
  no longer reachable from a roster-link collision, so its place on that
  issue's "already fine" list stops being accidental.
- **#418** is unaffected — different table, different statement, needs a
  migration. It asks for a lock-order check on these same two call paths, which
  this branch performs; it inherits the result.
- **#183** is unaffected — `WaitlistEntry`'s missing constraint and
  `deleteStudentAccount`'s lock-set gap.

## Verification

**The tier is `unit-sweeps`, and it runs from a worktree.** The hazard note
that a worktree cannot run these tests is narrower than it reads: only the
`integration` project uses `devUrl` and needs the dev server on `:3000`. `unit`
and `unit-sweeps` use `DATABASE_URL_TEST` with `globalSetup:
['./tests/setup/unit-db.ts']` (`vitest.config.ts:163,187`), which builds its own
database. Measured: `npx vitest run --project unit-sweeps
src/services/invitations-lock-order.test.ts` → 12 passed, 8.31s, against
`ethical_yoga_test`.

That matters because it puts real-Postgres concurrency inside the local loop
rather than deferring it to CI.

**The lever is the `$extends` query interceptor plus a deferred-promise
handshake** — `invitations-lock-order.test.ts:504-520`. A counterparty
transaction inserts `(teacherId, studentId)` and resolves a promise; the
function under test has its own roster write wrapped by a client extension that
awaits that promise before proceeding. The window between the two inserts is one
round trip wide, so unforced this is a race rather than a reproduction — the
file's own docblock records 1 of 6 unforced runs reproducing (`:484-488`).

The other instrument this project uses, the **uncommitted holder**, is at
`tests/integration/teacher-rooms-api.test.ts:713`. It is the wrong one here: it
lives in the `integration` tier, which needs the dev server on `:3000` and
cannot run from a worktree.

> **A correction to inherited prose.** The #161 spec
> (`2026-09-01-raced-create-coded-conflicts-design.md`) cites the holder as
> `tests/integration/signup-api.test.ts:196-235`. That is stale — those lines
> hold `freshIp` tests today. Verified on this branch, not carried forward.

**The trap that would make all of this pass vacuously.** The interceptor names a
Prisma method:

```ts
prisma.$extends({ query: { teacherStudent: { async upsert({ args, query }) { … } } } })
```

Changing the source from `upsert` to `createMany` without moving the interceptor
leaves it hooked to a method nobody calls any more. The handshake then never
fires, both transactions run unsynchronised, and the test goes green having
exercised nothing. Every interceptor in this file that hooks `teacherStudent`
must be re-aimed in the same commit as the source change, and the proof that it
was is the mutation below still going red.

Per site: assert the **returned value** — `{ ok: true }` for `acceptInvitation`,
the created registration for the route — not merely that nothing threw. #181
names this explicitly, because PR #179 contains a test asserting only
absence-of-rejection that would have passed against this defect.

**Prove every guard bites.** Per the standing rule, break it, record the exact
error text, restore, re-verify. The mutation that matters is **restoring the
`upsert`** at the site under test — the realistic regression is someone
reverting to the familiar idiom, not deleting the call. A test that stays green
with the `upsert` back is not exercising the race.

## Out of scope

- **`unlinkTeacher`'s `TeacherBlock` upsert** (`invitations.ts:1076`). Also
  `update: {}`, also non-atomic, and `docs/lock-order.md:1868-1874` records that
  it is knowingly unfixed. It is a different table and a different question —
  whether a raced block insert should be swallowed at all is a policy call, not
  a transcription. Named in the docs section that survives.
- **`StudentPrivacy`'s upsert.** Six real columns, always atomic, never had this
  race.
- **`api/students/[id]/route.ts`'s `teacherStudent.update`** — the archive
  toggle, a sixth writer that only flips a flag on an existing link.
- **#197's copy work.** This branch removes one false reachability; it does not
  rewrite any of the eighteen strings.
- **The `40P01` cycle itself.** #179 closed it by reordering. This branch
  measures whether the new statement changes that story and records the answer;
  it does not re-litigate the order.
