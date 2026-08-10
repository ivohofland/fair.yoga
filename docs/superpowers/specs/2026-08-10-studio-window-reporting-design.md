# Studio templates: report what the window holds, and fill it on create

**Date:** 2026-08-10
**Status:** Approved (issues #119 and #120; three decisions taken with Ivo in
discussion — report window occupancy rather than a bare delta, split the toggle
response type per family, and say nothing on create)

Two issues, one sitting, because they are the same sentence from opposite ends:
*the studio window is wrong or unexplained and nothing on screen says so.* #119
is a resume that generates between zero and four classes and reports none of it;
#120 is a create that generates nothing at all. The roadmap already pairs them
("#119 ‖ #120 — both are 'the window is empty and nothing says so' — do
together").

## What was measured

Both issues were checked claim by claim before any design. Most held. The ones
that did not are the useful part.

### #119 — the five discard layers hold, verbatim

Every layer the issue names is where it says it is:

| # | Site | What it drops |
|---|---|---|
| 1 | `studio-class-template-lifecycle.ts:342` | `await generateStudioInstancesForTemplate(tx, claimed);` — return value unused |
| 2 | `studio-class-template-lifecycle.ts:119` | `ResumeTransactionOutcome`'s `active` arm carries only `template` |
| 3 | `studio-class-template-lifecycle.ts:56` | `PauseStudioTemplateResult`'s `active` arm, likewise |
| 4 | `api/studio-class-templates/[id]/route.ts:106` | `respondOk({ ...result.template, action: result.action })` |
| 5 | `components/settings/template-action-messages.ts:127` | `resolveStudioConfirmation` falls through to `return null` |

Layer 5 lands in `toggle-studio-template-button.tsx:32` —
`setMessage(resolveStudioConfirmation(data) ?? '')` — so the button relabels and
says nothing, exactly as described.

### The `cancelledAt` asymmetry is real

- The existence probe, `studio-class-generator.ts:144-146`:
  `findFirst({ where: { templateId: template.id, date } })` — no `cancelledAt`.
- Archive's predicate, `studio-class-template-lifecycle.ts:92-96`: `scheduledWhere`
  carries `cancelledAt: null`, and feeds the `deleteMany` at `:537`.

So `pause → archive → un-archive → resume` regenerates only the dates with no row
at all, and returns fewer classes than the archive withdrew. Confirmed.

### Correction 1: #119's second "product call" is not one

The issue asks whether the probe *should* skip dates holding a cancelled row.
`StudioClass` carries `@@unique([templateId, date])` (`prisma/schema.prisma:477`),
so skipping is the only thing the probe can do. Adding `cancelledAt: null` to it
would not produce "regenerate over the cancelled row" — it would produce a P2002,
which lands in the hedge at `studio-class-generator.ts:178-193` and logs
`'studio class insert hit @@unique([templateId, date]) — generated without the
claim held'`. That message would then be false at the one site that emits it,
turning a working diagnostic into a misleading one.

**The behaviour is therefore settled by the schema, and only the reporting is
open.** This makes #119 a smaller and more focused change than it reads as:
nothing about *which* classes get created is in question.

### Correction 2: the discard is six call sites across two families, not five layers in one

#119 frames the drop as five studio layers. Measured across both generators —
every production reference, no `head` limit:

| Generator | Call site | Count |
|---|---|---|
| `generateInstancesForTemplate` | `api/class-templates/route.ts:63` | discarded |
| | `class-template-lifecycle.ts:454` | discarded |
| | `template-sync.ts:109` | discarded |
| | `class-generator.ts:265` | **consumed** (summed into the sweep total) |
| `generateStudioInstancesForTemplate` | `studio-class-template-lifecycle.ts:342` | discarded |
| | `studio-class-generator.ts:251` | **consumed** (summed into the sweep total) |

Six production call sites; two consume the count, four discard it. Only one of
those four is the studio resume #119 names. **The class family's resume is silent
in exactly the same way** — see Out of scope for why that stays out of this
branch.

### Correction 3: one #119 sub-claim is stale, and self-awarely so

#119 says `template-action-messages.ts` "still reads *Resuming needs no
explanation, so this is only ever called on the pause direction.*" It does not —
PR #118 replaced that docblock, and #119's own parenthetical predicted it would
("The comment itself is being corrected in that PR"). The current text at `:4-16`
says the copy decision is "deliberately not taken here", which is this spec.
Nothing to fix.

### #120 — both premises hold, with one extension and one emphasis correction

Confirmed:

- `api/studio-class-templates/route.ts:25-30` is a plain
  `prisma.studioClassTemplate.create` — no transaction, no generation.
- `api/class-templates/route.ts:43-65` wraps `create` and
  `generateInstancesForTemplate` in one `$transaction`.
- The `unchanged` fast path (`studio-class-template-lifecycle.ts:197-199`) returns
  before the `$transaction` at `:206`, so it neither claims nor generates.
- `isActive @default(true)` (`prisma/schema.prisma:412`), so a new template is
  immediately eligible for the sweep.

**Extension:** the `PUT` at `api/studio-class-templates/[id]/route.ts:51-54` is
also a plain update with no generation, so *editing* does not fill the window
either. This strengthens the issue's claim rather than contradicting it.

**Emphasis correction:** #120's "there is **no user action** that fills the
window" is literally true, but reads as though the window stays empty
indefinitely. It does not. The `class-generation` job runs every 60 minutes
(`lib/scheduler.ts:106`, `intervalMs: 60 * MINUTE`) and sweeps every active,
unarchived template with no user action at all. **The real gap is up to 60
minutes of empty schedule immediately after creating a template, during which the
only control the teacher can see ("Resume studio class") answers `200 unchanged`
and does nothing.** That is a genuine bug and generate-on-create closes it
completely — but the impact is bounded, and the same bound retires the issue's
"stranded template" case: a template stuck `isActive: true` with a short window
self-heals on the next sweep unless the sweep is persistently erroring on it,
which is #122's surface, not this one.

### Prior art that already settled part of this

`docs/superpowers/specs/2026-07-23-template-generate-on-create-design.md` (#44,
superseded on atomicity by `2026-07-23-class-generation-hardening-design.md`,
#56) is the class family's version of #120. Its decision — "**Response shapes are
unchanged** … The front-end needs no changes … the instances are simply there" —
independently reaches the same conclusion this spec takes for create. Its
supporting sentence ("the teacher lands on the schedule") is itself now stale:
`template-form.tsx:240` pushes to `/settings/recurring`, exactly as
`studio-template-form.tsx:119` pushes to `/settings/studio-classes`. The two
families are fully parallel on create navigation, which strengthens the decision
rather than weakening it.

## Design

### 1. The `active` arm carries two numbers

`PauseStudioTemplateResult`'s `active` arm, and the `ResumeTransactionOutcome`
arm behind it, gain `scheduled` and `added` — deliberately a pair, mirroring
archive's `deleted`/`remaining`:

```ts
| { ok: true; action: 'active'; template: StudioClassTemplate;
    scheduled: number; added: number }
```

- **`added`** is `generateStudioInstancesForTemplate`'s existing return value.
  **No signature change**, so the parallel its own docblock advertises — "same
  client union, same optional `from`, same count of rows created — so the two
  families can be read against each other" — survives intact.
- **`scheduled`** is `tx.studioClass.count({ where: scheduledWhere(templateId, { gte: today }) })`,
  the same helper and the same boundary archive's `remaining` uses, so the two
  numbers a teacher sees from archiving and from resuming mean the same thing.

Both are computed inside the transaction, under the claim's `FOR UPDATE`, from
`claimed.teacher.defaultTimezone` — authoritative under the lock, unlike the
paused arm's `today`, which is derived after the transaction from the
pre-transaction snapshot.

**Invariant: `scheduled >= added`.** Every row `added` creates is future-dated
with `cancelledAt` null by default, so it necessarily falls inside `scheduled`'s
range. A consequence worth stating because the copy relies on it:
`scheduled === 0` implies `added === 0`.

### 2. The copy makes no claim the query does not bound

```ts
export function resumeStudioMessage(added: number, scheduled: number): string
```

| `added` | `scheduled` | message |
|---|---|---|
| 4 | 4 | `4 classes on your schedule.` |
| 0 | 4 | `4 classes on your schedule. Nothing needed adding.` |
| 2 | 2 | `2 classes on your schedule.` |
| 0 | 1 | `1 class on your schedule. Nothing needed adding.` |
| 0 | 0 | `Nothing is scheduled from this template.` |

Three deliberate choices:

**No "for the next 4 weeks".** `scheduled` is unbounded above — it counts every
uncancelled row from the start of the teacher's today onward. Bounding it to the
window would mean re-deriving the generator's date set, which is
`getNextOccurrences(dayOfWeek, startDate, DEFAULT_WEEKS + 1).filter(start > startDate).slice(0, DEFAULT_WEEKS)`
— a *set of dates*, not a range. Approximating it as `date: { gte: today, lte: <4 weeks out> }`
gives a second boundary that can disagree with the first at the edges, which is
the `gt`/`gte` class of defect this codebase has already paid for twice. The copy
therefore states occupancy and promises no window.

**The `scheduled === 0` branch names no cause.** It is reachable exactly when
every candidate date holds a cancelled row — the `pause → archive → un-archive →
resume` sequence taken to its limit. That inference is sound today, but it
depends on generator internals, and copy encoding an inference is copy that goes
stale silently. Occupancy is checkable by the reader; cause is not.

**No verb or pronoun that has to agree with `classWord`.** `archiveMessage`'s
docblock records two successive slips here ("cancel them individually", "There
are still 1 class"). "`N classes on your schedule.`" has no verb left to fall out
of agreement.

**On the argument order.** `(added, scheduled)` is delta-first, matching
`archiveStudioMessage(deleted, remaining)` — but unlike that sibling, the
sentence leads with the *second* argument. Two adjacent `number` parameters whose
order does not match the prose they produce is a transposition waiting to happen,
and a signature mismatch in this exact file is what #93 was. Rather than change
the convention, the risk is closed by test data: the `added: 0, scheduled: 4` row
yields "4 classes on your schedule. Nothing needed adding.", while its
transposition (`added: 4, scheduled: 0`) yields "Nothing is scheduled from this
template." A swapped call site therefore cannot pass the copy tests. That
asymmetry is the guard — the table in this section must keep at least one row
where `added !== scheduled`.

### 3. The toggle response type splits per family

`TemplateToggleResponse`'s third arm is `{ action: 'active' | 'unarchived' | 'unchanged' }`,
shared today by all four buttons — `toggle-template-button`,
`archive-template-button`, `toggle-studio-template-button`,
`archive-studio-template-button` — while the *resolvers* are already split per
family. Studio gets its own type:

```ts
export type StudioTemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | { action: 'active'; scheduled: number; added: number }
  | { action: 'unarchived' | 'unchanged' };
```

`resolveStudioConfirmation` narrows to this; both studio buttons adopt it.
`TemplateToggleResponse` and `resolveTemplateConfirmation` are untouched, and
both class buttons stay on them.

Rejected alternative: optional `scheduled?`/`added?` on the shared arm. It is the
smaller diff, and it certifies nothing — the class family's `active` would carry
fields it never sets, and nothing would notice if studio stopped setting them.
That is the failure `resolveTemplateConfirmation`'s own docblock records (#93's
wrong-shape bug: "`archiveStudioMessage` had the wrong signature and the button
silently discarded `remaining`") and the failure #136's pins exist to prevent.
Splitting follows the grain the resolvers already established: "A separate
function rather than a parameter … the two families are kept
parallel-but-separate throughout."

### 4. The PATCH route switches rather than ternaries

With `active` carrying fields, the route's two-way ternary at
`api/studio-class-templates/[id]/route.ts:104-106` needs a third branch. It
becomes a `switch` with a `never` default, matching both the exhaustiveness idiom
this file already uses twice for its public unions and the reasoning
`pauseOrResumeStudioTemplate` records for its own switch at `:354-362` — that an
if-chain's exhaustiveness there was accidental, and a new arm compiled clean and
was answered with the wrong action.

### 5. `POST` generates, inside a transaction, and says nothing

`api/studio-class-templates/route.ts` takes the shape of
`api/class-templates/route.ts:43-65`:

```ts
const template = await prisma.$transaction(async (tx) => {
  const created = await tx.studioClassTemplate.create({
    data: { teacherId: session.teacherId, ...parsed.data },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  await generateStudioInstancesForTemplate(tx, created);
  return created;
});

const { teacher, ...created } = template;
void teacher;
return respondOk(created, 201);
```

Atomic, per #56's rule for the class family: a generation failure rolls the
template create back and propagates a 500, rather than leaving a template that
silently produces no classes. Response shape unchanged; no message; no new
front-end seam. `studio-template-form.tsx` is not touched.

**No claim is taken, and that is reasoning rather than omission.** The row's uuid
is brand-new inside this transaction, so nothing else can reference it yet and
nothing can race the insert — the argument
`claimStudioTemplateForGeneration`'s docstring already makes for the class
family's POST at `:53-55` ("nothing else can reference that id yet, so nothing can
race the insert. Its hedge is dead, not load-bearing").

### 6. Two docstrings predicted this caller and both must be corrected

Per §4 of the process — correct a claim in every artifact, not just the one in
front of you. Adding a third production caller that deliberately does not claim
falsifies a specific sentence in each of two places:

- **`studio-class-generator.ts:150-158`** — "In production,
  `generateStudioClassInstances`'s sweep and `pauseOrResumeStudioTemplate`'s
  resume both claim before calling this function." That roster becomes
  incomplete. The new caller is classified there as hedge-dead, with the
  brand-new-uuid reason.
- **`studio-class-generator.ts:70-76`** — "a future caller that skips the claim
  and goes straight to `generateStudioInstancesForTemplate` would reopen it."
  This branch *is* that caller, and it does **not** reopen the P2002 branch, for
  a reason the sentence does not anticipate. It must name the exception and why
  it is one.

Both are required edits. Neither the "six test callers / one transactional"
figure in the same docblock nor `claimStudioTemplateForGeneration`'s class-family
roster changes — both were re-measured and are accurate.

## Testing

Test-first throughout. The one that carries the issue is the third.

**Service (`studio-class-template-lifecycle.test.ts`)**

1. Resume on an empty window returns `added: 4, scheduled: 4`.
2. Resume on an intact window (fast pause→resume) returns `added: 0, scheduled: 4`.
3. **The sharp case.** Build `pause → archive → un-archive → resume` with two
   occurrences cancelled before the archive. Assert `added` and `scheduled` are
   both short of four, and that the two cancelled rows still stand. This is the
   test #119 exists for; it must fail against `main`.
4. `scheduled` counts a class dated today (the `gte` boundary), and excludes
   cancelled rows.
5. The `scheduled >= added` invariant.

**Copy (`template-action-messages.test.ts`)** — every row of the table in §2,
including singular/plural at `scheduled === 1`.

**Button (`toggle-studio-template-button.test.tsx`)** — the resume path renders
the message rather than clearing it.

**Route (`tests/integration/studio-api.test.ts`)**

6. `PATCH ?state=active` carries `scheduled` and `added` in its body.
7. `POST` leaves four studio classes behind.
8. **Atomicity**, ported from the proven class-family pattern in
   `class-templates-api.test.ts`: inside a real `prisma.$transaction`, create a
   valid studio template, then call
   `generateStudioInstancesForTemplate(tx, { ...created, teacherId: <nonexistent uuid> })`
   so `studioClass.create` hits a deterministic P2003 rather than the hedged
   P2002; assert the transaction rejects and neither the template nor any studio
   class persisted.

**Guards, each broken and restored with the exact error text recorded** (§3 — a
pin that compiles but cannot fail certifies nothing):

| Guard | Mutation | Must fail |
|---|---|---|
| `cancelledAt: null` in `scheduled`'s count | remove the filter | test 3 |
| the `gte` boundary | `gte` → `gt` | test 4 |
| `POST` generation | delete the `generateStudioInstancesForTemplate` call | test 7 |
| `POST` atomicity | move the generate outside the `$transaction` | test 8 |
| the type split | revert one studio button to `TemplateToggleResponse` | `tsc` |

The last one is the #39 trap in its natural habitat and is the reason it is
listed: a type pin that compiles clean proves nothing. The expected mechanism is
that `TemplateToggleResponse`'s `active` arm has no `scheduled`, so it is not
assignable where `StudioTemplateToggleResponse` is required — but that is a
prediction until the error text is in hand.

## Out of scope

- **The class family's identical discard** at `class-template-lifecycle.ts:454`,
  plus `template-sync.ts:109` and `api/class-templates/route.ts:63`. Recorded as
  an **Update on #116**, which is already "the class family measured against
  #118's studio work", rather than a new issue — §7's "can it attach to something
  that already exists?". The class resume additionally generates *without* taking
  the claim, so reporting a count from a known-racy generation is premature, and
  #116's fix will touch the same lines.
- **Making `unchanged` top up a stranded window.** #120 warns against this
  explicitly and it is correct to: the fast path is load-bearing for #118's two
  race-order tests. The hourly sweep bounds the stranded case at 60 minutes.
- **Any message on create** — decided, §5. Recorded beside
  `resolveStudioConfirmation` so the next reader does not mistake the asymmetry
  for an oversight, which is precisely how #119's stale "resuming needs no
  explanation" comment came to exist.
- **#122** (a teacher's resume reddening the sweep on `/api/health`) and **#113**
  (an archive losing the lock race reporting "Internal server error"). Both are
  error surfaces on this code, both already filed, neither touched here.
- The probe's missing `cancelledAt` filter is **left alone deliberately** —
  Correction 1. Not an omission.

## Risks

- **The type split may not bite.** Mitigated by mutation-testing it rather than
  asserting it; if `tsc` accepts the reverted button, the split is worthless as
  written and needs rethinking before the branch is worth merging.
- **`POST` sets no explicit transaction timeout**, matching the class family, so
  it takes Prisma's 5s default. The generated `StudioClass` inserts each need
  `FOR KEY SHARE` on the `Teacher` row for their FK, which a concurrent update to
  `Teacher.email`/`pageSlug`/`accountId` (all `@unique`, so `FOR UPDATE`) would
  block. Negligible odds and identical to the class family's exposure; noted
  because `pauseOrResumeStudioTemplate`'s docstring enumerates exactly this class
  of thing and this branch adds a site.
- **The hedge-dead reasoning is inherited, not re-derived.** It rests on "nothing
  can reference a brand-new uuid", which holds for a create and would not hold
  for a future caller that reuses this shape against an existing row. §6's
  docstring edit is what carries that warning forward.
