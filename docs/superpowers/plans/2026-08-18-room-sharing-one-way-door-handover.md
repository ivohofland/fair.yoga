# Handover — room sharing, the one-way door (#73)

You are implementing a plan you did not write, from a spec you did not agree. Both are good and both will mislead you in specific ways. This document is only the ways.

**Branch:** `fix/73-room-sharing-one-way-door`, off `main` at `0adb293`. Spec and plan are already committed there (`0b0b64e`, `29afa6f`).

---

## 1. Read in this order

Four documents. Which part of each actually matters:

1. **`AGENTS.md`** (80 lines). Your harness may auto-load this. It carries the quick start and the verify commands, and it *points to* `CLAUDE.md` rather than duplicating it (`:78`) — so loading it is not the same as having read `CLAUDE.md`.
2. **`CLAUDE.md`**. Read *Class Lifecycle* for the house style of a service-level policy, *Data Model* for `TeacherRoom` vs `Room`, and *Design Philosophy* for why the copy in this branch is flat and unpersuasive. Skip the pricing engine; this branch never touches it.
3. **`docs/superpowers/specs/2026-08-18-room-sharing-one-way-door-design.md`**. **§1 is the section that matters most** — it is the correction to the GitHub issue, and the issue itself will mislead you (derailer 1). §3 is the copy, verbatim, and is not yours to improve. §6 is the eleven guards.
4. **`docs/superpowers/plans/2026-08-18-room-sharing-one-way-door.md`**. Ten tasks. Its *Global Constraints* block applies to every task implicitly; read it once and mean it.

**Do not read the GitHub issue as your primary source.** See derailer 1.

---

## 2. Derailers — read before anything actionable

These are not hazards. They are wrong turns you will take *because you read the correct documents carefully*.

### D1. Issue #73 argues for a smaller change than the one you are building

The issue says the trap is *"API-only today. That makes it lower urgency"*, proposes four options, and leans toward option 1. If you open it first — the natural move — you will build a narrower thing and think you are done.

**That premise is false and the spec's §1 measures why.** The *flip* is API-only. The *lock* is the default outcome of the only room-creation flow in the app: `add-room-flow.tsx:95` is `useState(true)`, the route defaults the same way at `rooms/route.ts:58`, and so does the column. A teacher who leaves a pre-checked box alone creates a room they can never edit or delete.

The issue is evidence, not instruction. The spec supersedes it. This will be corrected on the issue at merge, not before — so it will still read wrong while you work.

### D2. "Public" appears in three registers and only one of them changes

A global find-and-replace on "public" will wreck this branch. The split is deliberate and stated in spec §3:

| Register | Example | Changes? |
|---|---|---|
| Teacher-facing prose | `Public rooms cannot be edited` | **Yes** → "Shared" |
| Wire / DB | `isPublic`, `Room_public_identity_unique` | **No** |
| Route path | `/api/rooms/[id]/publish` | **No** |

`PublicRoomNotice` is a *component name* — wire side, keeps its name, renders prose that says "shared". That looks like an oversight and is not.

### D3. The publish route's guard order looks like a bug you should fix

`PUT` and `DELETE` check `isPublic` before `createdById`. The new publish route checks `createdById` first. Reading them side by side, the instinct is to make them consistent.

**Both orders are correct.** A shared room is community property regardless of who asks, so PUT/DELETE lead with `isPublic`. Only the creator may *donate*, so publish leads with `createdById`. There is a test for this — and the failure mode to watch is that you will be tempted to change the *test* to match the reordered route. If you reorder, exactly one test fails and it is the one whose name says "not ALREADY_SHARED". That test is right.

### D4. `sameRoomIdentity` looks unhelpfully strict and you will want to soften it

It compares three strings byte-for-byte. No `.trim()`, no `.toLowerCase()`. Every instinct says a teacher typing `prinsengracht 42` means the same room as `Prinsengracht 42`.

**Softening it makes the feature actively harmful.** The predicate mirrors a Postgres partial index with no `citext` and no `lower()`. If the predicate is *stricter* than the index, the UI refuses a share the database would have accepted — and tells the teacher "already shared" about a room that is neither theirs nor the same. That refusal is invisible to everyone. A predicate *looser* than the index merely reaches the 409 that already exists.

The residual — case-variant duplicates in the commons — is filed as **#260** and is not yours to fix here.

### D5. `room-identity.ts` has one caller and looks like over-abstraction

Nothing on the server imports it. The publish route lets the index refuse, exactly as `POST /api/rooms` already does and for the reason its own comment gives (`rooms/route.ts:60-68`). So the module has exactly one consumer: the client pre-check.

A simplification pass will want to inline it into `share-room-button.tsx`. **Don't.** It exists so a rule that must track a database index is named, unit-tested and greppable. Inlined, drift from the index becomes invisible. The docblock says this; leave the docblock.

### D6. The Zod default and the column default are redundant, and that is the point

`createRoomSchema.isPublic` defaults to `false`, and `Room.isPublic` defaults to `false`. Remove either one and the observable API behaviour is identical. A reviewer will say "delete one".

**They mask each other, which is exactly why each is tested at its own level** — the schema in a unit test, the column in an integration test. A single end-to-end assertion ("a create without the field yields a private room") passes with either layer removed and certifies neither. Plan Task 5 Step 7 makes you prove this: drop the Zod default, and the unit test fails while the integration suite stays green.

### D7. Task 1 looks trivial and is the only task with unmeasured reach

Flipping a column default is three lines. But **31 of the 38 `prisma.room.create` sites in `tests/` omit `isPublic`** and today produce *public* rooms; after the flip they produce private ones. Two of the 31 were spot-checked and both were safe (raw-Prisma setup, room's own creator, no route guard involved). Two is not thirty-one.

That is why it is Task 1 and not Task 4. Run the **full** suite at Step 6. If something breaks, it is a fixture that was silently depending on rooms being public — **fix the fixture, never revert the default**, and record which files needed it. That list belongs in the PR body.

---

## 3. Verify-don't-assume

I ran every one of these on `0adb293` before writing this. **Two references drifted and are already corrected** in both the spec and the plan — that is the worked example for why you re-run them rather than trusting me.

```bash
# Each should print the line described. All fifteen were confirmed.
sed -n '29,30p' "src/app/api/rooms/[id]/route.ts"   # isPublic guard + 'Public rooms cannot be deleted'
sed -n '78,79p' "src/app/api/rooms/[id]/route.ts"   # isPublic guard + 'Public rooms cannot be edited'
sed -n '58p'    src/app/api/rooms/route.ts          # const isPublic = body.isPublic ?? true;
sed -n '60p'    src/app/api/rooms/route.ts          # 'No pre-check here on purpose.'
sed -n '32p'    "src/app/(teacher)/settings/rooms/[id]/page.tsx"  # canEditRoom
sed -n '95p'    src/components/settings/add-room-flow.tsx         # useState(true)
sed -n '380p'   src/components/settings/add-room-flow.tsx         # 'Make this room visible to other teachers'
sed -n '104p'   src/components/settings/edit-room-form.tsx        # 'Sync capacity, notes, and rental rate'
sed -n '171p'   src/components/settings/profile-form.tsx          # 'Public page'  <- the vocabulary collision
sed -n '33p'    prisma/migrations/20260811202634_teacher_slot_unique_indexes/migration.sql
sed -n '75p'    tests/helpers.ts                    # cookie(token): { Cookie: string }
sed -n '170p'   tests/helpers.ts                    # seedSession(db, accountId): Promise<string>
sed -n '422,425p' src/lib/schemas.test.ts           # the KNOWN GAP block naming #73
sed -n '630p'   tests/integration/rooms-api.test.ts # 'refuses flipping a private room public...'
sed -n '563,570p' tests/integration/rooms-api.test.ts # the #196 docblock that becomes false
```

**Corrected while writing this handover, left visible as the example:** the KNOWN GAP block is at `:422-425`, not `:420-424`; the flip test is at `:630`, not `:628`. Both were wrong in the spec *and* the plan, and both were fixed in both — a fix landing in one artifact while its twin stands is this project's single most repeated failure.

**Also resolved, so you don't have to:**

```ts
seedSession(db: PrismaClient, accountId: string): Promise<string>   // tests/helpers.ts:170
cookie(token: string): { Cookie: string }                            // tests/helpers.ts:75 — spread it
```

An earlier draft of plan Task 3 assumed `seedSession(prisma, label, { teacher: true })` returning `{ teacherId, token }`, and `headers: { cookie: cookie(token) }`. **All three were wrong.** The plan's fixtures are rewritten against the real shape at `tests/integration/rooms-api.test.ts:65-81` — a `Teacher` owns its email and *nests* its `Account`; there is no top-level `accountId` on create.

`rounded-card` is real: `--radius-card` sits inside the `@theme` block (`src/app/globals.css:3`, token at `:34`).

**Environment:**

```bash
docker compose up -d          # PostgreSQL. Container is fairyoga-db-1.
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000   # expect 307
```

**The dev server on :3000 is already running and is NOT yours to start, stop or restart.** It serves this checkout and the `integration` project talks to it over HTTP. Without it you get a wall of `ECONNREFUSED` and will misread it as broken tests.

---

## 4. Harness differences

- **No skills system, no enforced TDD ordering.** Nothing will stop you writing the implementation first. The plan's step order *is* the enforcement; follow it literally.
- **Mutations are deliverables, not scratch work.** Where a step says *Mutation*, apply it, record the **exact** failure text, restore, re-run. That text goes in your task report. A guard proved only by "I read it and it looks right" is what this project keeps shipping.
- **Commit per task.** The PR is **rebase-merged, never squashed** — the commit-per-task history is the record. Do not squash locally either.
- **Stage exact paths.** Never `git add -A` or `git add .`. Quote anything containing parentheses: `git add "src/app/(teacher)/settings/rooms/[id]/page.tsx"` — unquoted, zsh silently matches nothing.
- **`npm run verify` needs the DB and the dev server up.** It runs typecheck → lint → all three vitest projects. Green verify is strong but **not** CI: CI additionally runs `prisma validate`, a migration-drift check, `npm run build`, and Playwright.
- **`npm run build` catches one class `verify` cannot** — a `'use client'` component transitively importing `@/lib/log` (pino, server-only). This branch is exposed to exactly that: `share-room-button.tsx` value-imports `room-identity.ts` and `room-search.ts`. Run it at Task 10.

---

## 5. Task order — what is load-bearing and what is preference

**Load-bearing (do not reorder):**

- **Task 1 first.** Not for dependency reasons — for discovery. It is the only task whose blast radius is unmeasured (D7). Finding a fixture wave at task 1 is cheap; finding it at task 8 is not.
- **Task 3 before Task 4.** Task 4 deletes the collision test from `rooms-api.test.ts` because the publish route now owns that property. If the route doesn't exist yet, you delete coverage and replace it with nothing.
- **Task 9 last.** The split's entire proof is that `add-room-flow.test.tsx` passes **unedited**. Doing it earlier means later tasks legitimately edit that file, and the proof evaporates.

**Preference (reorder if you have a reason, and say so):**

- Task 2 could come before Task 1. It depends on nothing.
- Tasks 6/7/8 are ordered for narrative, not necessity — 6 produces what 7 and 8 consume, but 7 and 8 are independent of each other.

---

## 6. Stop conditions

**Stop and report** — do not work around — if any of these happens:

1. **A mutation produces a symmetric result.** Four mutations are designed to fail *asymmetrically*, and the asymmetry is the evidence, not the failure:

   | Mutation | Expected |
   |---|---|
   | T2 S5 — lowercase `sameRoomIdentity` | case test **fails**, whitespace test **passes** |
   | T3 S5 — swap the publish guards | **exactly one** of the two non-creator tests fails |
   | T5 S7 — drop the Zod default | unit **fails**, integration **stays green** |
   | T8 S5 — hardcode `isPublic: true` in the body | checkbox assertion **passes**, body assertion **fails** |

   If everything fails, or nothing does, **the test design is wrong, not the mutation.** That is the finding; report it rather than adjusting until it looks right.

2. **Task 9 requires editing `add-room-flow.test.tsx`.** Then the split moved behaviour and is wrong.

3. **Task 6 Step 6 requires editing `add-room-flow.test.tsx`.** Same reason — the extraction was supposed to be behaviour-neutral.

4. **A line reference in §3 above does not point where it says.** Fix it, and **report the drift** — do not silently work around it. That is how the two errors above were caught.

5. **Task 1's full-suite run breaks more than a handful of fixtures.** That is a scope conversation, not a grind.

---

## 7. Hazards this branch can actually hit

Trimmed from the project's list to what applies here:

- **`@/lib/log` is pino and server-only.** `room-identity.ts` and `room-search.ts` must stay import-free of it. `import type` is safe — it erases completely.
- **Prisma cannot express CHECK constraints.** Not needed here: Task 1's migration is a plain `ALTER COLUMN … SET DEFAULT`, which Prisma generates. **Read the generated SQL anyway** and confirm there is no `UPDATE` — existing rows must keep their values.
- **Never edit an applied migration.**
- **`prisma db execute` swallows `RAISE NOTICE`** but does surface `RAISE EXCEPTION`. Use `psql` inside `fairyoga-db-1` if you need to see a success notice.
- **Integration tests are re-runnable.** Every rate-limited request carries its own `x-forwarded-for` via `freshIp()` (`tests/helpers.ts:150`), so re-running costs nothing.
- **Never write "does not close #N".** GitHub's parser matches the keyword and ignores the negation in front of it — it has closed an issue on this repo twice, the second time in the commit written to document the first. Write "**#N is unaffected**".

---

## 8. Baseline, done, and what to report

**Measured on `main` at `0adb293`** — `npm test`, all green, 234s. Not inherited; I ran it.

| Project | Files | Tests |
|---|---|---|
| `unit` — `src/**/*.test.ts` | 57 | 871 |
| `components` — `src/{components,app}/**/*.test.tsx` | 38 | 211 |
| `integration` — `tests/integration/**/*.test.ts` | 28 | 414 |
| **Total** | **123** | **1496** |

Both columns reconcile: `57 + 38 + 28 = 123`, `871 + 211 + 414 = 1496`. The integration *test* count is derived by subtraction; its *file* count was measured directly, which is the independent check on that subtraction.

**Do not predict the after-figure from this table — measure it.** A branch's own review adds tests no prediction can know about; #212 predicted 1294 and measured 1296.

### Runs vs changes

This branch **changes** three integration files — `rooms-api.test.ts`, plus the new `rooms-publish-api.test.ts`, `room-identity-index.test.ts`, `room-default-privacy.test.ts` — and **runs** all 28 of them, because `npm run verify` runs all three vitest projects. Say it that way in the PR body. Do not hand-list the ones you didn't touch.

### Done looks like

- `npm run verify` green, and `npm run build` green.
- Every one of spec §6's eleven guards has a recorded mutation, its exact error text, and a restore.
- Every row of spec §7's artifact table has **its own verdict, naming its file.** A finding that names three locations gets three verdicts, not one — a fix wave that corrects two of three reports success either way.
- The post-fix sweep is derived from `git diff --stat main...HEAD`, **not** from grepping a keyword. A keyword scoped to one finding cannot see another finding's twin.

### The PR body must record

- Which of #73's claims were checked and which held — **the "API-only, lower urgency" claim is the one that failed**, and that correction is the most useful thing in the PR.
- The arithmetic behind every number: the `38 = 7 + 31` classification, any fixtures Task 1 had to make explicit, and the before/after suite figures per project.
- That `npm run verify` ran all three projects, with the per-project arithmetic that proves "every integration file ran" is checkable rather than reassuring.
- What the branch does **not** do: **#259 and #260 are unaffected**, and the read-only lock itself is untouched.

### Report back

Task-by-task: what you built, the mutation texts, any plan defect you found and how you adjudicated it. **Surface plan defects rather than bending code to match a wrong instruction** — subagents on earlier issues caught four wrong predicted outputs that way, and every one was a real improvement.

---

## 9. Final checklist — one line per irreversible mistake

- [ ] Never `git add -A` or `git add .` — exact paths only, and quote the ones with `(parentheses)`.
- [ ] Never edit an applied migration; new migrations only.
- [ ] Never start, stop or restart the dev server on :3000.
- [ ] Never squash — the PR is rebase-merged and the per-task history is the record.
- [ ] Never write `does not close #N`; write "#N is unaffected".
- [ ] Never change a test to match a reordered guard (D3). The test is right.
- [ ] Never add `.trim()` or `.toLowerCase()` to `sameRoomIdentity` (D4).
- [ ] Never revert Task 1's column default to make a fixture pass (D7) — fix the fixture.
- [ ] Never delete one of the two privacy defaults as "redundant" (D6).
- [ ] Never rename `isPublic`, the index, or the `/publish` path to say "shared" (D2).
