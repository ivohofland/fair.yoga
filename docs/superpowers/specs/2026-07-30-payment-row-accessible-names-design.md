# Distinct accessible names on the payments overview

**Date:** 2026-07-30
**Status:** Approved (issue #59; design agreed with Ivo in discussion — fix all
three buttons, one string feeding both the visible caption and the accessible
names)

## Problem

Issue #59 reports that the reminder button's accessible name collides when a
student owes on two classes of the same type on the same calendar day. The
disambiguator is `"{classType} · {formatDay(date)}"`, and `formatDay` renders
month and day only, so a morning and an evening Vinyasa on Jun 12 produce two
buttons with identical accessible names — and, because that same string is the
row's visible caption, two identical rows on screen.

**The issue names the narrower of two collisions.** Twenty lines from the button
it describes, in the same component:

```tsx
aria-label={`Mark ${studentName} payment as paid`}
aria-label={`Undo marking ${studentName} as paid`}
```

These carry no disambiguator at all. They collide whenever a student has **two
outstanding payments of any kind** — different class types, different weeks,
different months. Nothing in the page's query constrains a student to one
outstanding payment.

So the reminder button, which at least has a partial disambiguator, is the *best*
of the three, and the issue proposes improving it while leaving the two worse
ones untouched. This spec fixes all three.

## Design

### 1. One disambiguator, three consumers

Add `startTime` to the class `select` in the payments page query — the only data
change — and build the context once:

```tsx
classContext={`${p.registration.class.classType} · ${formatDay(p.registration.class.date)} · ${p.registration.class.startTime}`}
```

`Class.startTime` is a plain `'HH:MM'` string, so no formatting is involved.

`outstanding-payment-row.tsx` then feeds it to all three:

```
Send reminder to Ana for Vinyasa · Jun 12 · 09:30
Mark paid — Ana, Vinyasa · Jun 12 · 09:30
Undo marking Ana as paid for Vinyasa · Jun 12 · 09:30
```

The reminder button's `context` prop already exists and already appends this way;
the other two gain the same treatment inline.

**Mark paid does not follow the shared shape, and that is deliberate.**
This section first specified `Mark Ana's payment as paid for {context}`, with a
note that the possessive was a grammar fix riding along. Review found the real
problem: WCAG 2.5.3 (Label in Name) requires the visible text to appear
*contiguously and in order* inside the accessible name, and every `Mark
{name}'s payment as paid` form splits the visible `Mark paid` across the label
— leaving a speech-input user unable to activate a button they can read. So the
label leads with the visible text instead. The possessive fix is gone with the
phrasing that needed it.

The other two buttons already conform — their visible text (`Send reminder`,
`Undo`) starts their accessible name — so they keep the `… for {context}` shape
rather than being reshaped for symmetry. Three labels, two shapes, on purpose.

### 2. The time is visible, deliberately

`classContext` is a single value used for both the visible caption and the
accessible name. That is kept, so the two cannot drift — a codebase that has
repeatedly shipped a corrected claim in one place and not its copy should not
introduce two strings that must agree.

The consequence is that every Outstanding row now shows the class time, not only
the colliding ones. That is accepted: the collision is visual as well as
audible — two identical `Vinyasa · Jun 12` rows with the same amount are
ambiguous to a sighted teacher too — and the time is informative on a row that
is *about* a specific class.

Rejected: showing the time only where it disambiguates. It needs collision
detection across the outstanding list, and a label whose shape depends on its
neighbours is harder to reason about and to test than this bug warrants.

### 3. What is deliberately not changed

**The local `formatDay` stays.** This page declares its own, with its own
month-name array, separate from `format.ts`'s `formatDayHeader` and
`formatHistoricalDate`. Neither shared formatter produces `"Jun 12"`, so
adopting one would change the visible date format — a decision **#96** owns
("the same class date renders four ways via three mechanisms"), and one that is
design-gated.

Worth recording, since a reader might mistake it for the bug: the local
`formatDay` is *correct*. It reads a `@db.Date` column with `getUTCMonth`/
`getUTCDate`, which is the right way to read a calendar date pinned to UTC
midnight, and matches what `formatDayHeader` does for the same reason.

**`MarkUnpaidButton` in the Received section is out of scope**, and filed
separately. It has no `aria-label` at all — its accessible name is its text
content, so every `Mark unpaid` / `Confirm unpaid` / `Keep` button on the page
shares a name, across different students. That is the widest instance of this
defect on the page, but it is a different component with a different fix shape:
it takes only `paymentId`, so naming it means threading the student and the
context through it. Different blast radius, and Received is a historical record
rather than a dunning surface.

## Testing

There are no component tests under `src/components/class/` today — the
`components` project (jsdom) covers `settings/` and `students/` only. This adds
the first.

The test that matters renders two rows for the same student, same class type,
same day, different start times, and asserts their accessible names are distinct
across the pair. A test asserting a single row's label proves nothing about a
collision.

Specifically:

- the two mark-paid buttons have distinct accessible names;
- the two undo buttons do too (added in review — see correction 1);
- the two reminder buttons do too;
- the visible caption differs between the two rows as well — the collision is
  visual, so the fix is pinned visually;
- each button's *visible* text is contained in its accessible name (added in
  review). The four assertions above pin only the accessible name, which is one
  half of what WCAG 2.5.3 relates: renaming the visible "Mark paid" to "Settle"
  while leaving the label alone passed every test in the repo, because every
  test reaches these buttons by accessible name. That mutant now dies.

The Received caption is pinned in `teacher-journey.spec.ts`, not here — the
page builds it inline, so there is no prop for a component test to drive. It
shipped unpinned; the assertion is scoped to the Received section, because both
sections render the same class and an unscoped one is satisfied by the
Outstanding caption.

Assert whole accessible names via `getByRole('button', { name: … })` with exact
strings, not substrings.

**Corrected after implementation — this section originally overstated what the
tests do, in four ways a reader could falsify quickly:**

1. It said "all three" accessible names are asserted. That was written when
   **two** were: the Undo button renders only after a successful `markPaid`
   round trip, and reaching it means stubbing `fetch`. It was left to
   inspection, on the reasoning that a stub added purely to claim coverage is
   worth less than an honest gap. Review overturned that — `vi.stubGlobal`
   through a real click is the established pattern in six component test files,
   so the stub is scaffolding this suite already relies on, not a contrivance.
   **All three are asserted now**, in a fourth test that clicks both rows'
   Mark paid and then reads both Undo labels.
2. It said that assertion "fails before the fix and passes after". **Two of the
   four do** — mark-paid and undo, both of whose labels were rewritten
   outright, so the asserted strings are simply absent from the unfixed
   component. The reminder and caption assertions pass against it too, because
   the fixture hands the component two already-distinct `classContext` values;
   they are regression cover for the row continuing to consume `classContext`,
   worth keeping but not proof of the fix. (This item said "only the mark-paid
   one" until the undo test landed above it in correction 1; it was not
   remeasured at the time, and a reviewer caught the contradiction between
   two adjacent items of this very list.)
3. It said a single row is tested for natural reading. **There is no single-row
   test.** It also said the possessive is covered inside the pair test; **there
   is no possessive left to cover.** §1's reshape for WCAG 2.5.3 replaced
   `Mark {name}'s payment as paid` with `Mark paid — {name}, {context}`, taking
   the grammar wart out with the phrasing that carried it.
4. It said a substring match "would pass on the colliding version, which is
   precisely the defect". **It would not.** On a colliding pair both accessible
   names are identical, so any query — substring or exact — matches 0 or 2
   elements and `getByRole` throws either way. Verified by re-running the
   assertion in substring form against the pre-fix labels; it still failed.
   Exactness is still worth keeping, for a different reason: it pins the copy,
   so a superstring mutant (label + `" (outstanding)"`) dies. What catches a
   collision is the duplicate-name throw, not the exactness.

Worth stating plainly given what §2 argues: this is a claim corrected in the
test file and left standing here — one string, two copies, exactly the drift the
one-string design exists to avoid. The design was right; the spec's own prose
was the thing that drifted.

**Retracted exclusion — the `context` prop reaching the reminder button.** This
was written as a deliberate omission ("`SendReminderButton`'s existing contract,
already documented on the prop"), and it is not what the test file does: the
reminder assertion is there, and correction 2 above records it. It is kept here,
corrected rather than deleted, because the reasoning behind the omission is
still the reason that assertion proves less than the mark-paid and undo ones —
it passes against the unfixed component, so it is regression cover, not proof of
the fix.

## Out of scope

- **`MarkUnpaidButton`'s accessible names** — filed separately, per §3.
- **Consolidating the local `formatDay`** — #96.
- **The class page's mark-paid label** — `payment-checklist.tsx:110`, still
  `Mark {name} payment as paid`. #129 already tracks it, but as a *grammar*
  divergence, which was the accurate framing when the payments page's fix was
  the possessive. §1's reshape changes that: the payments page no longer has a
  possessive either, and the reason it was reshaped — WCAG 2.5.3, the visible
  `Mark paid` split across the accessible name — applies to the class page
  identically. So the class page has the same accessibility defect this spec
  exists to fix, and #129 as written does not say so. Left out of scope because
  it is a second surface with its own component and tests, but #129 needs
  re-scoping rather than closing alongside this.
- **Any change to `SendReminderButton`.** Its `context` prop already exists,
  already nullable, and already appends correctly. This spec changes what is
  passed to it, not the component.
- ~~**The Received section's visible captions.**~~ **Brought into scope during
  review.** The exclusion argued they "carry no interactive control whose name
  collides, so there is nothing to disambiguate" — which answers the accessible
  half and skips the visible one. §2 above accepts the time on every Outstanding
  row precisely *because* two identical captions with the same amount are
  ambiguous to a sighted teacher; that argument does not stop at the Received
  heading. The captions now carry the start time too.
  `MarkUnpaidButton`'s accessible name is untouched and still #128 — the
  Received change fixes the visible half only, which its comment says.

## Risks

- **Row width on a phone.** The caption gains roughly eight characters inside a
  640px column. It sits in `type-caption` next to an amount and up to two
  buttons; if it wraps, it wraps in the text column, which already handles the
  `· ! overdue` suffix and the `Reminded …` line. Worth an eye at 375px during
  review rather than an assumption either way.
- **The time is now on every row, forever.** If it reads as noise in practice,
  the alternative is the conditional form rejected in §2 — and that is a
  materially more complex change to make later. This is the cheap direction to
  be wrong in, but it is a one-way door in the sense that undoing it means
  building the thing we declined to build.
- **`classContext`'s docblock names its own format.** It currently reads
  `"{classType} · {date}"`. It must be updated, or it becomes the branch's first
  false comment.
