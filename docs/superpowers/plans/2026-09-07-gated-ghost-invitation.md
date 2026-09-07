# Close the gated ghost invitation's delayed confirmation oracle (#418)

Design: `docs/superpowers/specs/2026-09-07-gated-ghost-invitation-design.md`.
Read §1 (the premise correction) and §2 (the decision table) before Task 2 —
they are what makes `declined` staying unconditional a decision rather than an
omission.

## Premise, as measured

The mechanism holds exactly as #418 and its status comment describe. The one
claim that does not: **no migration is needed.** `linkTeacherStudent`
(`src/services/roster-link.ts`) is `createMany({ skipDuplicates: true })` →
`INSERT … ON CONFLICT DO NOTHING`, and the `count` it already returns
distinguishes "this call inserted the link" from "the link already stood".
Probed directly against `ethical_yoga_test`: `{"count":1}` then `{"count":0}`.
The spec explains why that runtime fact is also *better* than the persisted
marker the issue proposed.

No existing test asserts the behaviour being removed. Every integration test in
`describe('Booking and waitlisting resolve invitations (#166 task 7)')`
(`tests/integration/invitations-api.test.ts:2032`) that expects a resolution
first puts the pair in an **unlinked** state — `:2345` deletes the
`TeacherStudent` row before booking, `:2592` asserts the link is `null` before
the queue join — so all of them take the `linkCreatedNow: true` column and stay
green. Checked before writing this plan; re-check rather than assume if Task 2
reddens that file in CI.

Task order is load-bearing: **Task 2 cannot compile before Task 1 lands.**

## Task 1 — `linkTeacherStudent` reports whether it inserted

`src/services/roster-link.ts`. Return the fact the statement already computes.

- Signature becomes `Promise<boolean>`: `true` when this call inserted the row,
  `false` when the link already stood. Positive polarity, chosen so no call
  site has to negate it — `resolveInvitationOnLink`'s parameter in Task 2 reads
  the same way round.
- **Rewrite the closing paragraph of the docblock**, which currently reads
  "Returns nothing on purpose: whether this call was the one that inserted is
  not a distinction any caller has a use for." That is now false, and per
  *Comment Discipline* it is corrected by replacement, not annotation — the
  before-and-after belongs in the PR body. The replacement must say what the
  boolean means, that it comes from the single `ON CONFLICT DO NOTHING` and is
  therefore race-free, and name `resolveInvitationOnLink` as the reader that
  needs it. Do not restate the old sentence.
- The other four callers (`acceptInvitation` `invitations.ts:849`,
  `waitlist.ts:284`, `:559`, `:681`) ignore the value. Leave them untouched.

`src/services/roster-link.test.ts` — extend the two existing cases rather than
adding new ones where the assertion belongs to a case that already exists:

- "creates the link when there is none" also asserts the return is `true`.
- "is a no-op when the link already exists" also asserts the return is `false`.
- The insert-race test (`:105`) asserts the **race loser** gets `false`. That
  is the case that carries the whole design: the loser must not read a lost
  race as "I created this link".

## Task 2 — resolve a pending invitation only on a link this act created

Depends on Task 1.

`src/services/link-consent.ts`:

- `resolveInvitationOnLink`'s input gains `linkCreatedNow: boolean` — a named
  property in the existing object argument, not a positional flag.
- `teacherBlock.deleteMany` is **unchanged and unconditional**. Do not gate it.
- The `invitation.updateMany`'s `where` narrows to
  `status: input.linkCreatedNow ? { not: 'accepted' } : 'declined'`.
- The docblock states the rule in prose before the mechanism: a booking or
  waitlist join resolves a `pending` invitation only when it was the act that
  put the student on the roster; someone already on the roster has nothing left
  to consent to. It must also carry (a) why `declined` is unconditional —
  `unlinkTeacher` writes the tombstone and deletes the link in one transaction,
  so `declined` implies unlinked and every ordinary route back creates the link
  anyway, and narrowing it would strand a student behind an
  un-deletable tombstone — and (b) the contract on the new parameter: pass what
  `linkTeacherStudent` returned, from the same transaction; do not compute it
  another way. It must NOT carry a count of call sites.
- The existing paragraph explaining `{ not: 'accepted' }` ("so a `declined` row
  flips too") is now only half the story. Replace it; do not append to it.

Call sites, threading the value:

- `src/app/api/registrations/route.ts:235`/`:242`
- `src/services/waitlist.ts:284`/`:291`
- `src/services/invitations-lock-order.test.ts:613` calls the function directly
  and must pass the flag. Read the surrounding test's intent and pass the value
  that keeps it testing what it says it tests — that file is about lock
  acquisition order, so the invitation's status must still move for its
  assertions to mean anything.

New file `src/services/link-consent.test.ts`, `unit` tier, real `PrismaClient`
against `ethical_yoga_test` (follow `roster-link.test.ts`'s fixture and
`afterAll` reaping conventions). The decision table from the spec, one case per
row, plus the oracle itself:

1. `pending` + `linkCreatedNow: false` → row stays `pending`, `respondedAt`
   stays `null`.
2. `pending` + `linkCreatedNow: true` → `accepted`, `respondedAt` set.
3. `declined` + `linkCreatedNow: false` → `accepted`. This pins the deliberate
   asymmetry: a later "simplification" that skips everything when the link
   pre-existed breaks here.
4. `declined` + `linkCreatedNow: true` → `accepted` (the escape hatch, both
   ways).
5. `accepted` → untouched, original `respondedAt` preserved, under both values.
6. `TeacherBlock` is deleted under both values.

7. **The oracle, end to end, through the real service functions** — the test
   this issue exists for. Teacher + a claimed student linked to them with
   `shareEmail: false`. `inviteContact` → `ok`, a `pending` row created (the
   decoy). `resolveInvitationOnLink(..., { linkCreatedNow: false })`, which is
   what that student's next ordinary booking now does. `inviteContact` again →
   the refusal must be `ALREADY_INVITED`, **not** `ALREADY_LINKED`. Assert the
   reason string, not just that it refused: `ALREADY_LINKED` is precisely the
   answer #418 is about, and a test that only asserts `ok: false` passes on the
   bug.

## Task 3 — pin both guards' archived-link scoping

Independent of Tasks 1–2. Bundled gap A (spec §4). Both guards read
`teacherStudents` unfiltered and must keep treating an archived link as
still-linked; nothing currently holds that down, and #424's second tripwire
comment is the shipped code that depends on it.

- `src/services/invitations.gate.test.ts` — a linked pair whose `TeacherStudent`
  row has `isArchived: true` and `shareEmail: true` still answers
  `ALREADY_LINKED`. (`shareEmail: true` so the assertion turns on `linked`
  alone; with it false the test would pass for the wrong reason.)
- `src/services/invitations.notify.test.ts` — `notifyInvitee` still withholds
  the "A teacher would like to connect" notification for a pair whose link is
  archived.

Both name `isArchived` on `TeacherStudent`, not on `Invitation` — the confusion
the issue's status comment specifically warns about.

## Task 4 — one comparative indistinguishability test

Independent of Tasks 1–2. Bundled gap B (spec §4).
`src/services/invitations.gate.test.ts`: invite a genuine stranger and a gated
linked-unshared student **in the same test**, and assert the two outcomes are
equal rather than each separately correct — same `ok`, same result-object
shape, and the same resulting `Invitation` row shape (status, `respondedAt`,
`isArchived`, and that both rows exist). Compare the two observations against
each other; do not restate a literal on each side, or a change that moves both
in step still passes.

`delivered` differs between them by design and never reaches the wire — assert
that difference explicitly, so the test records that the divergence is known
and bounded rather than looking like an oversight.

## Task 5 — correct the claims this branch falsifies

Last, once 1–4 have landed. Each of these states something this branch makes
untrue. Give every one a verdict; some are expected to survive unchanged.

- `src/app/api/invitations/[id]/route.ts:34` — "`resolveInvitationOnLink` …
  flips `status: { not: 'accepted' }` to `accepted`, declined rows included".
  The literal is now conditional. The scenario the comment supports still holds
  (a declined row's owner books, and after a decline the pair is unlinked);
  correct the mechanism, keep the conclusion.
- `src/services/invitations.ts:870` — the `acceptInvitation` zero-count branch's
  "a booking or waitlist join … resolves the identical invitation as a side
  effect". Still reachable (the booking is the one that inserted the link), now
  conditionally. Add the condition; do not rewrite the branch's reasoning.
- `docs/data-model.md`, Invitation section — the resolution rule is a policy
  spanning `link-consent.ts`, `roster-link.ts` and two callers, so it belongs
  in the doc that owns cross-module rules rather than in any one docblock.
- `docs/superpowers/specs/2026-09-03-already-linked-email-confirmation-design.md`
  — §"The decision" and §"Filed, not folded" both assert the residual stays
  open and that "no cheaper alternative exists". Mark what #418 changed; that
  spec is the record of a decision, so amend it in place with a dated note
  rather than rewriting its history.
- Expected to survive, and to be checked rather than assumed:
  `src/components/students/contact-list.tsx:27`,
  `src/components/student/pending-invitation-card.tsx:20`,
  `src/app/(student)/account/privacy/page.tsx:106`, and every
  `resolveInvitationOnLink` mention in `docs/lock-order.md` (no table, no
  acquisition order and no `update: {}` payload changes here).

Re-derive the surface rather than trusting this list:

```
grep -rn 'resolveInvitationOnLink\|linkTeacherStudent' src docs tests --include='*.ts' --include='*.tsx' --include='*.md'
```

## Verification, per task

Every guard must be shown to bite. Per new assertion:

1. Run it against unmutated source. Expect PASS.
2. Apply the mutation it exists to catch. Expect FAIL; record the exact message.
3. Restore by editing the line back — never `git checkout`, which would eat the
   task's other edits — and re-run. Expect PASS.

The mutations, named so they are not chosen for convenience:

- Task 1: make `linkTeacherStudent` return a constant `true`.
- Task 2: restore the unconditional `status: { not: 'accepted' }`. Case 1 and
  case 7 must both fail — case 7 with `ALREADY_LINKED` received where
  `ALREADY_INVITED` was expected, which is the oracle reappearing verbatim.
- Task 3: add `isArchived: false` to `rosterLinkState`'s `teacherStudents`
  select (`invitations.ts:149`) and to `notifyInvitee`'s (`:555`) — the exact
  edit #424's tripwire comment says the suite currently survives.
- Task 4: make one side's outcome differ from the other's.

Runnable from this worktree: `--project unit`, `--project unit-sweeps`,
`--project components`, `typecheck`, `lint`. **Not** runnable here:
`--project integration` and Playwright, both wired to `:3000` and the shared
dev database. CI is the signal for those two tiers and the PR body cites the
run, not a local pass.

## Out of scope

- **No migration.** Nothing in `prisma/` is touched; the `Invitation` table is
  unchanged.
- **`acceptInvitation`/`declineInvitation` keep no decoy guard.** Reaching
  either means guessing a v4 UUID, and the party who could is the student —
  the victim, not the attacker. Spec §2 records the classification.
- **`#412` and `#419` are unaffected**; the gate itself is not touched.
