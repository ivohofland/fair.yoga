# Studio class editability — a stated policy, and a surface that reaches it

**Date:** 2026-08-22
**Issue:** #276 (parent tracker #274)
**Branch:** `fix/276-studio-class-edit-surface`
**Status:** Direction agreed at the gate (option A); this round runs the remaining
gates as self-checks at the user's instruction.

## 1. Problem

`PUT /api/studio-classes/[id]` accepts six fields; the teacher's page reaches two.
Two more fields are editable in neither layer. The set of things a teacher may
change about a logged studio class is the intersection of two lists nobody
compared, and #194's template-edit message ("change existing classes individually")
promises a remedy this family cannot honour.

## 2. What was measured (premise verification)

The issue's census was re-derived on `main` @ `f9c9e69`, not inherited.

**Schema** (`src/lib/schemas.ts:476`, `updateStudioClassSchema`, `.strict()`):
exactly six keys — `studentCount`, `location`, `startTime`, `durationMinutes`,
`hourlyRate`, `cancelledAt`. No `date`, no `classType`.

**Page** (`src/app/(teacher)/studio-class/[id]/page.tsx`): two PUT surfaces —
`StudentCountEditor` (`studentCount`) and `CancelStudioClassButton`
(`cancelledAt`) — plus the Remove button PR #295 added under the DELETE route.
Date, time, rate and template render as read-only text.

Arithmetic over the eight candidate fields:
`6 accepted = 2 reachable + 4 wired-but-unreachable`; `+ 2 absent from both
layers = 8`. The four unreachable: `location`, `startTime`, `durationMinutes`,
`hourlyRate` — validated, conflict-checked, and offered to no one.

**Integration coverage** (`tests/integration/studio-api.test.ts`, the
`PUT /api/studio-classes/[id]` surface): `hourlyRate` appears once, in the
other-teacher 403 loop; `startTime` appears only in the two slot-conflict cases;
`cancelledAt` has its set/clear happy path; `location` and `durationMinutes`
have **no** persistence test through this route at all; no field has a
happy-path write-and-read-back test except `cancelledAt`. The issue's claim
here held exactly.

**Stale premise, corrected:** the issue says "there is no delete". Since it was
filed, #279 landed (PR #295): `DELETE /api/studio-classes/[id]` exists with a
Remove button, gated by `studioClassDeletability` (manual always removable;
generated once its calendar date is past). The "permanent struck-through card"
cost now survives only for future generated classes. The editability gap is
untouched by that landing — the deletion spec explicitly reserved it ("279
settles removal only; 276 keeps editability").

**New since filing:** the cross-family slot guard (#296) fires on studio-class
*update* as well as insert; the route already carries both 409 arms (slot-key
P2002 → `DUPLICATE_STUDIO_SLOT`, cross-family SQLSTATE →
`CROSS_FAMILY_CLASS_SLOT`). Any admitted change to `date` or `startTime`
re-enters both arms. They are wired and tested for `startTime` moves only.

**Why this is now urgent:** #194's rule 4 tells a teacher who edits a template
to "change existing classes individually". For the studio family that sentence
is false today in every particular that matters — time, rate and location have
no UI, and moving a class to another day is impossible in both layers. #284
(the studio half of #194) is blocked on this issue by the parent's own ordering.

## 3. Decisions

### D1 — The policy: editability is a function of the calendar date alone

A studio class whose calendar date is **strictly before the teacher's local
today** is an income record. Only `studentCount` and `cancelledAt` remain
writable on it. A class dated today or later is fully editable.

- The comparison is the one `studioClassDeletability` already makes:
  `startOfLocalDay(now, timeZone) > date`, both sides midnight-UTC of a local
  calendar date (`src/lib/timezone.ts`). No start-instant reasoning — the same
  stamp-vs-record argument the deletion service documents, with lower stakes:
  nothing resurrects here, so today-dated classes stay editable.
- **Cancellation does not gate editability.** Unlike the class family's
  terminal statuses, a studio cancellation is recoverable (the API already
  un-cancels; #275 wants a door to it). Freezing edits on a recoverable state
  would only force an un-cancel round-trip before each correction. One
  predicate, one truth: past vs not-past, cancelled or not.
- `studentCount` stays writable on past classes because it *is* the record —
  attendance is logged after the fact, which is existing behaviour, unchanged.

This is the answer to the issue's question 1: yes, a logged studio class is
editable — until its date passes, after which it is money already earned or
already written off, and only the count and the cancellation remain negotiable.

### D2 — `date` is admitted; generated classes may not move

`date` joins `updateStudioClassSchema`. The route refuses it with 409
`STUDIO_CLASS_GENERATED_DATE` whenever `dateEditable` is false — a generated
row (its `templateId` is not null), and, by D1's invariant, any past row. A
past row receiving nothing but a `date` therefore gets this refusal's
template-worded message; unreachable from the edit surface, which omits the
field whenever the verdict says it may not move.

Why generated classes may not move: moving the row frees its
`(templateId, date)` key, and the hourly sweep — which counts any row,
cancelled included, as occupancy *per date* — would recreate the class on the
old date within the hour. That is the exact delete-resurrection race
`studio-class-deletion.ts` exists to prevent, reached through a different
verb. Cancelling is what holds a date against the sweep, so the refusal names
the composite remedy: cancel this occurrence, log a manual class on the new
date. (Under #284's week-keying the same argument holds per week; the refusal
text does not depend on which era is live.)

Why there is **no** template-key 409 arm: with `date` refused whenever
`templateId` is non-null, and `templateId` absent from the schema (so never
written by this route), a P2002 on `@@unique([templateId, date])` is
unreachable through this route — PostgreSQL unique indexes treat NULLs as
distinct, so manual rows cannot collide on it. An arm that cannot fire is the
#39 failure shape (a guard that cannot fail certifies nothing); the reasoning
is recorded beside the existing catches instead of a dead branch.

Manual classes move freely; a moved `date` re-enters the slot index and the
cross-family guard, whose existing arms cover both — new tests prove they bite
through the *date* path, not just the `startTime` path they were built for.

### D3 — `classType` is admitted

`classType: z.string().min(1).optional()`, mirroring create. It renders on the
schedule card (`class-list.tsx:140`) and, since D4 shipped, as the edit form's
class-type input; it feeds no pricing or
reporting arithmetic, so it is editable wherever the rest of the schedule
fields are.

### D4 — The surface mirrors the class family's edit screen

A dedicated page `/studio-class/[id]/edit` (server component: session +
ownership + verdict guards, redirect to the detail page when not full-scope),
prefilling a client `StudioClassEditForm` — the `/class/[id]/edit` pattern
(`docs/superpowers/specs/2026-07-22-class-edit-screen-design.md`), kept
parallel-but-separate like everything else in this mirror family.

- Fields: `classType`, `location`, `date`, `startTime`, `durationMinutes`,
  `hourlyRate`.
- For a generated class the date input renders disabled with an explainer
  naming the cancel-plus-manual remedy — the settingsLocked-explainer pattern
  from the class form, applied to a per-row rather than per-class lock.
- Submit: single `PUT` with every writable field except `date`, which is
  omitted from the payload entirely whenever the verdict says it may not move —
  the API refuses the field's PRESENCE, not a change to it, so re-sending a
  generated row's unchanged date would 409; success stays on the page with a
  `Saved` caption (TemplateForm pattern) and refreshes the router; errors
  surface the API message verbatim in the standard danger slot — including
  both 409 codes, whose messages are written to be actionable.
- Entry: an `Edit class` link on the detail page's actions area, rendered
  exactly when the predicate says full-scope — including on cancelled
  non-past classes, where it sits beside the cancellation notice. Hiding it
  there while the API accepts would re-create this issue's own defect shape
  one state over.

### D5 — The policy lives in a service, shaped like its sibling

`src/services/studio-class-editability.ts`: pure functions, no HTTP imports,
injected `now` and `timeZone`, parameter handed a fresh literal of only the
facts it may read (`{ templateId, date }`) — the fresh-literal discipline
`studio-class-deletion.ts` documents. Verdict shape distinguishes full vs
counts-only scope and date-movability; refusals live in a `Record` keyed by
the refusal union so adding a member fails to compile until it has a message
and code (`STUDIO_CLASS_REFUSALS` pattern):

- `income_record` → 409 `STUDIO_CLASS_INCOME_RECORD`, naming what remains
  writable (the student count and cancellation).
- `generated_date` → 409 `STUDIO_CLASS_GENERATED_DATE`, naming the composite
  remedy.

Unreadable dates fail closed (refuse), mirroring the deletion service's
explicit NaN stance, for the same inversion-proofing reason documented there.

### D6 — Route mechanics

Gate order in `PUT`: ownership → parse → empty-body check (unchanged) →
**gate 1**, past (any gated field present on a past row → 409 `income_record`;
whole request refused, never partially applied) → **gate 2**, immovable date
(`date` present on a row whose `dateEditable` is false → 409, carrying
`generated_date` when the row is a template child and `income_record` when it
is a past manual row, because the generated wording would be a false sentence
about a row with no template) → **gate 3**, backward move (`date` present and
landing strictly before the teacher's today → 409 `past_date`) → update.

Gate 3 is not derivable from the verdict, and that is the point: the predicate
reads the STORED row and answers whether it is editable now, never whether it
stays editable after a given write. A backward move is the one case where
those differ — the row arrives already frozen by gate 1, so the mistyped year
cannot be undone through the editor. It mirrors the `Class` family's #249 rule
(`class-lifecycle.ts`), and takes nothing away: `/studio-class/new` bounds its
date field at neither end, so logging a class that already happened is
unaffected. `date` transforms like the class
route's (`new Date(isoString)`, `src/app/api/classes/[id]/route.ts:54-57`);
it therefore joins `cancelledAt` in the server-owned-fields pin
(`src/lib/schemas.test.ts`, `SERVER_OWNED_FIELDS`), whose entry becomes
`['cancelledAt', 'date']` — a deliberate pin change, asserted by the pin test.

## 4. Field-by-field — the stated decision

| Field | Past | Today/future | Change |
|---|---|---|---|
| `studentCount` | writable | writable | none (already reachable) |
| `cancelledAt` | writable | writable | none (cancel button; un-cancel door is #275) |
| `classType` | frozen | writable | schema + UI |
| `location` | frozen | writable | UI only |
| `startTime` | frozen | writable | UI only |
| `durationMinutes` | frozen | writable | UI only |
| `hourlyRate` | frozen | writable | UI only |
| `date` | frozen | manual only, forwards only | schema + UI + route gates 2 and 3 |

Every API-accepted field is reachable from the page; every unreachable field
was either surfaced or is named above with the reason it stayed out.

## 5. Testing

- **Unit** (`studio-class-editability.test.ts`): boundary matrix across
  timezones — yesterday/today/tomorrow in teacher-local terms at UTC edges
  (a UTC morning where New York still holds yesterday), manual vs generated
  `dateEditable`, NaN fail-closed. Boundaries stated as instants, not prose.
- **Integration** (`tests/integration/studio-api.test.ts`): happy-path
  write-and-read-back per newly reachable field (`location`,
  `durationMinutes`, `hourlyRate`, `classType`, `date` on a manual row);
  past-gate refusal for a representative gated field plus an all-gated-fields
  payload asserting **no partial application** (`studentCount` in the same
  body must not land); generated-date refusal; slot-key 409 via a pure
  `date` move; cross-family 409 via a pure `date` move; empty-body 400
  unchanged; ownership loop unchanged.
- **Components**: form prefill/save/error paths (`vi.stubGlobal('fetch')`),
  disabled date input with explainer on a generated row; detail-page entry
  link gating (full-scope shows it, past hides it, present in both the
  cancelled and live branches).
- **Mutations — each guard proven to bite**, break → record exact error text
  → restore → re-verify:
  1. Delete the past-gate branch → integration red.
  2. Invert the calendar comparison → timezone-boundary unit red.
  3. Delete the date-gate → generated-date integration red.
  4. Revert the `SERVER_OWNED_FIELDS` pin entry → pin test red.
  Mutations use values the code cannot produce (dates no fixture uses), per
  the house mutation rules.

## 6. Out of scope

- The un-cancel door (#275) — this branch leaves the cancelled state's
  actions untouched apart from the entry link D4 places there.
- Week-keyed generation (#284), unblocked by this branch but not touched.
- Any status enum, audit log, or edit notification (no registrations exist on
  `StudioClass` to notify).
- The DELETE route, `studioClassDeletability`, and the reporting pages.
