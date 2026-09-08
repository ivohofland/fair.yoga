# Close the two decoy-Invitation leaks (#502)

Design: `docs/superpowers/specs/2026-09-08-invitation-erasure-tombstone-design.md`.
Read "The decision" (both fixes) and "What this does not do" before starting
— the backfill residual it names is expected, not a bug to chase.

## Task order

**Task 3 is independent of Tasks 1-2** (different file, different writer, no
shared code) and can be built and reviewed in parallel with them. **Task 2
depends on Task 1** — it filters on the `delivered` column Task 1 adds, and
won't compile against a schema that doesn't have it yet.

## Task 1 — persist `delivered` on `Invitation`

`prisma/schema.prisma`: add `delivered Boolean @default(true)` to the
`Invitation` model, after `lastNotifiedEmail`.

Migration: `npx prisma migrate dev --name invitation_delivered_marker`. Let
Prisma generate it from the schema diff — for a single `ADD COLUMN ...
DEFAULT true` this needs no hand-authored SQL. Confirm the generated file
matches `ALTER TABLE "Invitation" ADD COLUMN "delivered" BOOLEAN NOT NULL
DEFAULT true;` (or Prisma's equivalent) before moving on — if it also
regenerates the CHECK constraints from `20260805074500_invitation_check_
constraints` or the `20260901114046_invitation_last_notified` migration as
a side effect (an existing-migration drift), stop and investigate rather
than accepting it; that would mean the local schema and migration history
have already drifted from something unrelated to this task.

`src/services/invitations.ts`, inside `inviteContact`:

- Move the `blocked` lookup (currently `const blocked = await db.teacherBlock
  .findUnique(...)`, positioned after both the revive and create branches)
  to immediately after the `rosterLinkState` call and its `ALREADY_LINKED`
  early return — i.e., before `if (existing) { ... } else { ... }`. Keep its
  own comment block; only its position moves, not its query or comment.
- Compute `const delivered = blocked === null && !link.linked;` right after
  moving it, and use `delivered` both in the two write sites below and in the
  function's final `return { ok: true, value: { id: invitationId, delivered }
  }`.
- `db.invitation.create`'s `data`: add `delivered`.
- `revivePendingInvitation`'s signature gains a `delivered: boolean`
  parameter (alongside the existing `names` parameter — a named field on a
  new or existing options object, matching how `names` is already passed);
  its `updateMany`'s `data` adds `delivered`. Update its one call site
  (inside `inviteContact`) to pass the value computed above. Update the
  function's docblock only if it currently claims to write a fixed set of
  fields that this changes — read it first; don't add a sentence if the
  existing prose already speaks generally ("names are rewritten...").

**Tests** — `src/services/invitations.gate.test.ts` already builds both
shapes (a genuine stranger invite and a gated linked-unshared one) and
already asserts `result.value.delivered` for each (lines ~146, ~244, ~293,
~351 as of this plan — re-locate by content, they will have shifted). Extend
the existing cases rather than adding parallel new ones:

- Wherever the test currently asserts `result.value.delivered === true`,
  also assert the row read back from `prisma.invitation.findUnique` (or
  whatever fixture read the test already does) has `delivered: true`.
- Wherever it asserts `false`, same, for `false`.
- One new case: revive a `declined`-then-reset or `accepted` row (however
  the existing revive tests in this file or `invitations.revive.test.ts`
  already construct a revive) first as delivered, confirm `delivered: true`
  persisted; then, in a second invite of the same address after the pair
  becomes linked-but-unshared (or blocked), confirm the *same row* flips to
  `delivered: false` on the revive write — this is the case Task 2 depends
  on being correct, since a row's `delivered` value must reflect its most
  recent write, not its first one.

Do not touch `unlinkTeacher` in this task — Task 2 owns it.

## Task 2 — scope the unlink tombstone by `delivered`

Depends on Task 1 (`delivered` column must exist and be populated).

`src/services/invitations.ts`, `unlinkTeacher`: narrow the tombstone
`updateMany`'s `where` from `{ teacherId: input.teacherId, email }` to
`{ teacherId: input.teacherId, email, delivered: true }`. Update the
comment immediately above it (currently explains only why `updateMany`
rather than `update`) to also state the new scope's reason — a decoy
invitation's invitee was never told it exists, so there is nothing for a
`declined` status to honestly represent; point to the spec rather than
restating its argument in full.

**Tests** — `tests/integration/invitations-api.test.ts`, in or beside the
existing `describe` block that already covers `unlinkTeacher`'s tombstone
write (search for "blocks a booking-only unlink" — same file, same
fixtures pattern: a real teacher/student pair via the actual HTTP routes,
not fabricated rows):

- New case: produce a genuinely never-delivered invitation the way
  `invitations.gate.test.ts` already does (a real linked-but-unshared pair,
  so `POST /api/students` — or `inviteContact` directly — falls through
  #417/#418's gate and creates a `delivered: false` row), then unlink via
  `DELETE /api/teacher-links/[teacherId]`, then assert the invitation row
  is **still `pending`** (not `declined`) afterward.
- New case, same shape, for a genuinely delivered `pending` invitation still
  standing at unlink time (the existing test fixture already produces this,
  or adapt the two residual-route shapes named in the 2026-09-07 spec §3):
  assert it **does** flip to `declined` — regression coverage proving the
  narrowed `where` still matches what it always matched.
- New case, `GET /api/invitations` (or wherever the route's JSON response is
  asserted elsewhere in this file): with at least one `delivered: false` and
  one `delivered: true` row in the fixture, assert the response body for
  neither row contains a `delivered` key at all — `Object.keys` on each
  returned invitation, not a `toEqual` on the whole array (a `toEqual` would
  need updating every time an unrelated field is added; `Object.keys(...)
  .sort()` against the known selected-field list is the narrower, correct
  assertion here).

## Task 3 — anonymise with a random token, not `studentId` (independent)

`src/services/gdpr.ts`:

- Add `import crypto from 'crypto';` near the top, with the other imports.
- Inside `deleteStudentAccount`, immediately before the first of the three
  `tx.invitation.updateMany` calls it touches, add:
  `const anonymizedEmail = \`deleted-${crypto.randomUUID()}@deleted.invalid\`;`
- Replace `` `deleted-${studentId}@deleted.invalid` `` with `anonymizedEmail`
  in all three `updateMany` calls (the two `email`/`firstName`/`lastName`
  writes and the `lastNotifiedEmail`-only write) — same literal, one
  variable, three use sites.
- Leave `firstName: 'Deleted'`, `lastName: 'Student'` untouched — they
  encode nothing today.

**Tests** — `src/services/gdpr.test.ts`, the existing `describe` around
lines 580-720 (as of this plan) that builds `inviterId`/`blockerId`/
`movedId` invitation fixtures and erases `studentId`:

- Rewrite the assertions currently reading
  `expect(row.email).toBe(\`deleted-${studentId}@deleted.invalid\`)` (and
  the equivalent `lastNotifiedEmail` ones) to instead assert (a) the value
  does **not** contain `studentId` as a substring, and (b) it matches
  `/^deleted-[0-9a-f-]{36}@deleted\.invalid$/` (or the exact shape
  `crypto.randomUUID()` produces) — both properties, not just one, since (a)
  alone would pass a token that happens not to collide by luck rather than
  by construction.
- New case: run `deleteStudentAccount` for two different students (two
  separate calls, two separate fixtures) and assert the two resulting
  anonymised addresses differ — proves the token isn't a second
  deterministic derivation (e.g., accidentally hashing something else
  student-identifying) that would just move the oracle rather than close it.
- Confirm the existing `movedInvitation`/`lastNotifiedEmail` test (the one
  exercising the third, marker-keyed statement) still passes with the new
  token — it should, since all three statements now share one variable.

`docs/data-model.md:216` (as of this plan — re-locate by content: the
Invitation paragraph starting "Invitations are handled differently"):
correct the sentence describing anonymisation as
`` `deleted-<student_id>@deleted.invalid` `` to describe a random per-erasure
token instead. Replace, per *Comment Discipline* — don't append a
"previously read" note.

## Task 4 — close the `PUT` re-address bypass (added after whole-branch review)

Depends on Task 1 and Task 2 (both already landed) — not on Task 3. The
whole-branch review found a Critical gap Tasks 1-3 left open: `PUT
/api/invitations/[id]` can change a pending invitation's `email` without
touching `delivered`, so a teacher can build a genuinely-delivered row at
an address they control, then `PUT` it onto a guessed victim address —
`delivered` stays stale at `true`, and #502's leak #2 reproduces through
this second door. See the spec's "Fix #3" section (added alongside this
task) for the full argument, including the accepted residual (a legitimate
typo-correct-then-resend loses its unlink-tombstone eligibility — a safe,
non-disclosing failure direction, not a second leak).

`src/app/api/invitations/[id]/route.ts`, `PUT` handler: in the existing
`prisma.invitation.updateMany` call, change

```ts
data: { ...rest, ...(email !== undefined ? { email } : {}) },
```

to

```ts
data: { ...rest, ...(email !== undefined ? { email, delivered: false } : {}) },
```

Unconditional on the new address's status — no `TeacherBlock`/roster query
needed, `false` is simply true the instant `email` changes (nothing has
been delivered to whoever now holds the new address).

`src/services/invitations.ts:461-467`'s docblock (in `notifyInvitee`'s
comment block) currently states the opposite of what will now be true —
that a stale `delivered` from a `PUT` edit "reaches nobody." Correct it by
replacement (not annotation) to state the current mechanism: `PUT` now
recomputes `delivered` to `false` on every `email` change, so it does not
go stale.

`docs/data-model.md:150` (the `delivered` row added in Task 1): correct
"the last time the row was written" (overclaims — most writers of this row
don't touch `delivered`) to name its actual writers precisely: `inviteContact`'s
create/revive paths, and `PUT` on any `email` change (which sets it to
`false`).

**Tests** — `src/services/invitations.gate.test.ts` or `tests/integration/invitations-api.test.ts`,
whichever can express an HTTP `PUT` call most naturally given this
worktree's no-`:3000` constraint (prefer driving the route handler or the
underlying update logic directly if a unit-tier equivalent is possible;
otherwise write the integration test and note it as CI-verified-only, same
handling as Task 2's `GET` shape test):

- Acceptance criterion 7: build a genuinely-delivered invitation
  (`delivered: true`), `PUT` its `email` to a linked-but-unshared student's
  address, assert the row's `delivered` is now `false`, then run the real
  `unlinkTeacher` for that student and assert the row stays `pending` — the
  exact bypass, now closed, proven end to end in one test.
- Acceptance criterion 8: an ordinary `PUT` re-address to an unrelated,
  unblocked, unlinked address also sets `delivered: false` — proves the
  write is unconditional, not accidentally gated on the new address
  happening to be a decoy shape.

**Also fold into this task** (found by the same whole-branch review,
same area, cheap enough not to warrant a separate task):

- `src/services/gdpr.test.ts`: acceptance criterion 1 asks for "both a
  genuinely-delivered shape and a never-delivered/decoy shape" — every
  existing fixture takes the schema default `delivered: true`. Add
  `delivered: false` to one of the existing fixtures (e.g. the `blockerId`
  row) so the anonymisation assertions are proven against both shapes, not
  just one. `deleteStudentAccount`'s three `where` clauses don't currently
  reference `delivered` at all, so this is currently a no-op assertion-
  wise — it exists so a future edit that scopes `gdpr.ts` by `delivered`
  (a plausible "consistency" change, given #502 groups both writers) can't
  silently leave a decoy's real address unanonymised without a test
  noticing.
- `docs/data-model.md:150`: add one clause noting the migration-backfill
  residual (every pre-existing row reads `delivered: true` regardless of
  history) — currently only in the spec, which is a dated branch artifact,
  not the durable reference this column's semantics should live in.
- `src/services/invitations.ts`'s `revivePendingInvitation` docblock
  (~line 388-412): it itemizes specific rewritten fields with individual
  rationale but says nothing about `delivered`, which it also now writes.
  One sentence: `delivered` is re-derived by the caller and rewritten here
  because a revive is a fresh delivery decision, not an inherited one —
  carrying the OLD row's `delivered` forward would undermine Task 2.
- `src/services/gdpr.ts:703` (or wherever `Student.email` is anonymised to
  `deleted-${studentId}@...`, unlike `Invitation.email`): one half-line
  noting why this asymmetry is correct — a teacher reading `Student.email`
  already holds that `studentId` (they're looking at that student's own
  profile), so there is no oracle here the way there is on an `Invitation`
  row from a *different*, guessed identity.
- `src/services/gdpr.test.ts`'s anonymised-shape regex (~line 549): tighten
  `/^deleted-[0-9a-f-]{36}@deleted\.invalid$/` to actually pin UUID grouping
  (`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`) rather
  than any 36 characters from the hex-plus-hyphen set, matching what the
  test's own comment already claims it checks.
- One assertion (on the existing `inviterId` fixture) that `row.email ===
  row.lastNotifiedEmail` after erasure — pins "one token, reused across all
  three statements" as an actual tested property, not just spec prose nothing
  currently verifies.

Do not fold in: the `$disconnect()` ordering observation or the
gdpr.test.ts in-test-body cleanup observation from the whole-branch
review — both pre-existing-pattern questions unrelated to #502's security
property, left as ledger-only notes.

## Whole-branch review

Two tasks touch shared ground worth a cross-task look even though this plan
has 3 tasks (2+ triggers it per the skill): Task 1 changes where `blocked`
is computed and what `inviteContact` returns; Task 2 relies on that value
being correct in every code path that can reach `unlinkTeacher`'s scoped
write, including rows created before Task 1 shipped (the backfill residual
the spec already names — confirm the whole-branch review doesn't try to
"fix" that; it's accepted). Task 3 is unlikely to interact with either, but
confirm no test fixture shared across files (e.g., a `deleted-` email
literal asserted somewhere outside `gdpr.test.ts`) breaks.

## Verification

`npm run verify` scoped to what runs outside a worktree (typecheck, lint,
unit, components — per CLAUDE.md's worktree hazard, `integration` needs the
shared dev DB and a live `:3000` this worktree doesn't have). Push and read
CI for `test-integration` and `test-e2e`. `prisma validate` and the
migration-drift check are CI-only gates too — confirm both green on CI
before treating Task 1's migration as proven.
