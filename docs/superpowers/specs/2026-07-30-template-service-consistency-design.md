# Template service consistency

**Date:** 2026-07-30
**Status:** Approved (issue #100; design agreed with Ivo in discussion — guard the
two real P2025 gaps, align all four failure halves, one shared
`LastScheduledClass`)

## Problem

Issue #100 grouped three consistency gaps in the two template lifecycle
services. Mapping them against the code found the issue is **materially stale on
two of the three** — three PRs landed after it was filed and moved the ground
under it:

| Commit | Issue | What it changed |
|---|---|---|
| `df2dd84` / `2c23731` | #98 | Extracted `TemplateToggleResponse`, deleting two of the inline `{ date; startTime }` declarations |
| `36a9b1c` | #97 | Turned **both** `archiveOrUnarchive*` writes into a compare-and-swap |
| `3181f03` / `f10d87c` | #94 (PR #118) | Turned `pauseOrResumeStudioTemplate`'s resume write into a CAS + claim; added `ResumeTransactionOutcome` |

The issue's third item — `withErrorHandler` logging without operation context —
is a duplicate of **#121**, filed later during #94's review without checking the
backlog first. #121 carries the same finding plus two things this issue does not
(the `NextRequest` route to context, and that the `P2002` branch returns 409
*before* reaching the log). Item 3 belongs to #121 and is out of scope here.

## Design

### 1. P2025: guard the two real gaps, document why three need nothing

The issue says the guard is "handled in one function and not its four
siblings", implying four fixes. That is true of **exactly one** function today.

**Guard `pauseOrResumeTemplate`** (`class-template-lifecycle.ts:379`). Its
`tx.classTemplate.update({ where: { id: templateId }, … })` is the first
statement of its transaction, so nothing holds the row when it runs, and a
delete landing between the `findUnique` at `:351` and that write surfaces as
P2025 → an opaque 500 instead of a clean 404. Map it to `not_found`, mirroring
`updateClassTemplate`'s existing catch.

**Guard `updateClassTemplate`'s sync call** (`class-template-lifecycle.ts:272`).
The issue holds this function up as the exemplar, but its guard covers only the
`update` at `:261`. Eleven lines below, `syncTemplateInstances(db, templateId)`
sits *outside* the `try`, and its first statement is a `findUniqueOrThrow`
(`template-sync.ts:36`) — a P2025 source on Prisma 6. Nothing holds a lock in
between; the docstring at `:200-205` says the write and the propagation are
deliberately not one transaction.

This one needs a distinct comment, because the honest mapping is less obvious:
by the time it fires, the `update` has already committed. Reporting `not_found`
for a write that landed is still correct — the row is gone before we reply, so
"no such template" is what the caller's world now contains — but a reader who
finds `not_found` returned after a successful write deserves to be told that on
purpose rather than left to wonder. The `sync` result is lost with it; that is
fine — but not for the reason first written here. `Class.templateId` is
`onDelete: SetNull`, so deleting a template **orphans** its generated classes
rather than removing them: they stay on the teacher's schedule, still `open`
and still publicly bookable, frozen with their pre-edit settings and with
nothing left that could ever propagate the edit. What makes the lost counts
cost nothing is narrower — `syncTemplateInstances` filters on `templateId`, so
after the delete it matches none of them and would have reported `{0,0,0}`
anyway.

**Document the other three as already correct.** `archiveOrUnarchiveTemplate`,
`pauseOrResumeStudioTemplate` and `archiveOrUnarchiveStudioTemplate` all replaced
their vulnerable write with a CAS. `updateMany` does not raise P2025 on zero
matches — it returns `{ count: 0 }` — and each zero-count branch already
re-reads and answers `not_found` with no exception involved. Their remaining
`findUniqueOrThrow` and single-record `update` sites all run *after* a
successful CAS in the same transaction, which holds the row's write lock until
commit, so a concurrent delete blocks rather than wins.

Writing that down is the point of this half. Without it, the next reader
compares the five functions, sees two catches and three without, and "fixes"
three that are already correct — adding dead catch blocks to lock-protected
statements, which this codebase has repeatedly found attracts false comments
explaining why they exist.

**Reachability, stated once so nobody re-derives it:** no production path
deletes a `ClassTemplate` or `StudioClassTemplate` row. Counting by
`(classTemplate|studioClassTemplate)\.(delete|deleteMany)\(` across `src/` and
`tests/`: **16 at this branch's HEAD**, 14 on `main` — the two extra are this
branch's own new tests. Every one is in a test file.

(This number has now been wrong twice. It was first written as "ten", corrected
to 14 — which was the count on `main`, already stale because the branch had
added two tests before the correction was made. Stating a convention is not
enough if you then run it against the wrong revision.) `gdpr.ts` anonymises
rather than cascade-deletes and never deletes a `Teacher`, so the `onDelete:
Cascade` on both templates' teacher relation is unreachable too. Both guards are
therefore unreachable today and are being added because the window is real and
becomes live the moment template deletion exists — not because anything is
currently broken.

### 2. Align the four failure halves to one member per reason

```ts
- | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' }
+ | { ok: false; reason: 'not_found' }
+ | { ok: false; reason: 'forbidden' }
+ | { ok: false; reason: 'archived' }
```

applied to `PauseTemplateResult`, `ArchiveTemplateResult`,
`PauseStudioTemplateResult` and `ArchiveStudioTemplateResult`, matching
`UpdateClassTemplateResult` and `UpdateClassResult`, which already do this.

The four route sites then narrow on the result itself:

```ts
- const unhandled: never = result.reason;
+ const unhandled: never = result;
```

at `class-templates/[id]/route.ts:128` and `:152`, and
`studio-class-templates/[id]/route.ts:99` and `:126`. Each route's comment
explaining *why* it narrows on `.reason` is deleted, because it stops being
true.

No runtime behaviour changes. Every reason keeps its existing status code and
message; `tsc` verifies the whole change.

**Corrected after review — the original justification here was overclaimed, and
a reviewer disproved it with the compiler.** This spec first said the split
catches a future `ok: false` member that is not a reason at all, which
narrowing on `.reason` cannot see. That is false: the old form caught it too,
as a hard `TS2339` at the `if` lines. It also said the split is what makes a
per-reason payload possible; also false — a payload-carrying member can be
added *alongside* an unsplit member and every existing guard still bites.

What the split actually buys, which is smaller and worth stating honestly:

- the guard's failure becomes legible — `TS2322` naming the unhandled member,
  instead of `Type 'any' is not assignable to type 'never'`;
- the idiom matches `UpdateClassTemplateResult` ninety lines up, which retires
  three comment paragraphs whose only job was explaining why these four sites
  narrowed differently from their neighbour.

On a branch this comment-heavy, retiring an explanation is worth more than it
looks: a divergence that needs a paragraph at every site is a divergence that
will eventually be described wrongly. But this is an error-message and
consistency change, not a new guarantee, and the issue called it right at
filing time — "the consequence is real but small".

**`ResumeTransactionOutcome` is deliberately left alone.** It is module-private,
discriminates on `outcome` rather than `reason`, carries no `ok` field, and
describes transaction outcomes rather than service results. #118 already gave it
a `switch` with a `never` guard, after its accidentally-exhaustive four-`if`
predecessor answered a new arm with `action: 'paused'` and a `lastScheduled`
query it never asked for. Aligning it to a shape it does not share the purpose
of would undo a fix, not extend one.

### 3. One `LastScheduledClass`, and one wire form beside it

The issue says the shape is declared inline in five places. There are **four**,
and they are not the five it names: two of them were dedup'd into
`TemplateToggleResponse` by #98 the day after filing, and the issue missed
`pauseMessage`'s parameter.

```ts
export type LastScheduledClass = { date: Date; startTime: string };
```

Declared once in `class-template-lifecycle.ts` and imported by
`studio-class-template-lifecycle.ts` and `template-action-messages.ts`, matching
the `TemplateSyncResult` precedent — shared types in this codebase live next to
a producer and are exported, not collected in `src/lib/types.ts`, which is
session-only with a single importer.

**The fourth site is not a duplicate and stays.** `TemplateToggleResponse`'s
`lastScheduled` uses `date: string`: it is the post-`JSON.parse` wire form, and
the conversion back is explicit at `template-action-messages.ts:108` and `:123`.
Folding the two together would erase a distinction the code depends on.

**On the parallel-but-separate policy.** `studio-class-template-lifecycle.ts`
opens by recording that PR #92 found the two families had drifted and that
keeping them separate is deliberate. That policy is about shared
*implementation* — it exists because shared code hid the drift. A two-field
structural type has no logic to drift, and the alternative is declaring the same
two fields twice to honour the letter of a rule aimed at something else. Sharing
the type; noting here that the policy was considered rather than overlooked.

## Testing

Nothing in the repo currently pins any of this: there are no type-level tests
(`expectTypeOf`/`assertType` appear nowhere), and no test constructs a P2025 or
deletes a template between a read and a write. The `const unhandled: never`
lines *are* the exhaustiveness test, enforced only by `tsc`.

- **The two new P2025 guards get real tests.** Delete the template row between
  the read and the write — the same three-transaction lever the existing race
  tests use to hold a row and control ordering — and assert
  `{ ok: false, reason: 'not_found' }` rather than a thrown error. If a
  deterministic interleaving is not achievable for one of them, say so plainly
  rather than writing a test that calls the two steps in sequence and claims to
  be a race.
- **The idiom change is verified by the compiler, not by a runtime test.** The
  existing result-shape assertions (`toEqual` on whole objects — 20 across the
  two service test files, counting by `toEqual({ ok:`) must keep passing
  unchanged — they assert
  values, and no value changes. A test that merely re-asserts the same
  `toEqual`s proves nothing new about the split.
- **The `never` guards are verified by mutation**: add a reason to each union
  without handling it at the route, confirm `tsc` rejects it, remove it. That is
  the only way to show the guard bites, since a passing `tsc` on unchanged code
  shows nothing.
- **`LastScheduledClass` is checked by `tsc` plus the existing `lastScheduled`
  assertions** at seven sites, including the two integration tests that assert
  the actual HTTP JSON. Those two deliberately declare a narrower
  `{ startTime: string }` view and should not be widened to use the new type.

## Out of scope

- **`withErrorHandler` log context** — item 3 of the issue, duplicated to #121.
- **The class family's missing generation claim** (#116) and its false locking
  comment (#117), both in `class-template-lifecycle.ts` and both tempting to fold
  in while editing that file. They are separate defects with their own analysis.
- **Adding template deletion.** The guards prepare for it; nothing here creates it.
- **`ResumeTransactionOutcome`**, per §2.
- **A latent P2003, noticed while mapping:** `ClassTemplate.teacherRoom` has no
  `onDelete`, so Prisma defaults to `Restrict`, and both room-delete routes guard
  only on `class` counts, not template counts. Deleting a room that still has
  templates therefore 500s on a raw P2003 rather than returning 409. Real, and
  the same shape as #103's second half — belongs there, not here.

## Risks

- **Churn on files that have just stabilised.** `class-template-lifecycle.ts`
  and `studio-class-template-lifecycle.ts` absorbed #97, #98 and #118 in three
  days. This change touches both again, plus both routes. Mitigated by the
  change being type-level and compiler-verified — but the review should watch
  for comments made stale by the edit, which is the failure mode those three PRs
  produced repeatedly.
- **Two of the three items are documentation.** The P2025 half is mostly a
  comment recording why three functions need no change, and the value of that
  survives only as long as the comment stays true. If a future change replaces
  one of those CASes with a plain write, the comment becomes actively
  misleading — it should name the CAS as the reason, not the function.
- **The guards remain untested against production reality**, because production
  cannot delete a template. The tests will construct the race artificially. That
  is worth doing and worth being honest about: they prove the catch maps
  correctly, not that the window is reachable.
