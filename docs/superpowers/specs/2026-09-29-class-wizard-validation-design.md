# #318 — the class wizard's step validation: pinned, and made reachable

Base: `origin/main` `6ec6f4bd`. Surface: `src/app/(teacher)/class/new/page.tsx`
(`validateStep` and the step-2 inputs) and one line of
`src/components/settings/template-form.tsx`.

## 1. What was measured

### The issue's claims that hold

- **No message is asserted.** `page.test.tsx`'s tests cover submission, the settled
  state, the date bound, rooms and the alternatives links; none reaches a validation
  message (`grep -n "Select a room\|Enter a class type\|must be" page.test.tsx` → only
  the room-picker placeholder option, which is not the error).
- **The create path has no server-side capacity check.** `POST /api/classes`
  (`src/app/api/classes/route.ts`) reads the `TeacherRoom` for ownership and
  `isArchived` only; `createClassSchema` bounds `maxStudents` at `MAX_CLASS_SIZE` and
  checks `economicsViolations`, never `capacityOverride`.
  `rg -l capacityOverride src/services src/app/api/classes` lists only
  `room-switch.ts`, `teacher-room-attach.ts` and `gdpr.ts`, none of them on this path.

### Corrections

1. **Two of `validateStep`'s ten branches can't be reached through the page.** The
   step-2 inputs rewrite their value on every keystroke before `validateStep` ever
   sees it:
   - Min students: `Math.min(typed, form.maxStudents)`, so min never exceeds max.
   - Max students: `Math.min(typed, roomCapacity)`, and it sets
     `minStudents: Math.min(prev.minStudents, max)`, so max never exceeds capacity
     and never drops below min.
   - `handleRoomChange` applies the same two clamps when a room is picked.

   So `'Max must be >= min students'` and `` `Cannot exceed room capacity (…)` `` are
   dead code. The issue calls the capacity branch "the only enforcement of room capacity
   on the create path", but that enforcement is actually the max input's clamp, and it
   has no pin either. Deleting the capacity branch leaves every test green because it
   can't fire, not only because nothing asserts it.

2. **The max input's clamp is a live defect, not just an unpinned guard.** A browser
   fires `onChange` once per keystroke. A teacher who selects the Max students field
   (showing `12`) and types `20` passes through `2` first. That intermediate value
   drags `minStudents` from 4 down to 2, and it stays 2 once `20` lands. Min students
   is the auto-cancel threshold and the point at which the teacher rate starts
   scaling, so the class is created with economics the teacher never chose. Any edit
   to max that passes through a value below min triggers it. `template-form.tsx`
   carries the same line in its Max students `onChange`, so recurring templates have
   the same defect.

3. **The wizard skips two of the three shared economics rules.** `economicsViolations`
   (`src/lib/class-economics.ts`, #221) is what `template-form.tsx` and
   `class-edit-form.tsx` check before sending, each with its own bare `ECONOMICS_COPY`.
   The wizard checks neither `rate_order` nor `room_subsidy`. A teacher who enters a min
   rate above the target rate gets through steps 2 and 3, reaches the review, presses
   Create, and only then sees the server's `parseBody` text:
   `minRate: minRate cannot exceed targetRate`. That's developer copy, shown on step 4
   while the field that caused it is on step 2. The wizard renders
   `error={errors.minRate}`, but nothing ever sets it. Same defect class as #700,
   different form.

4. **Room capacity isn't a class invariant anywhere, so server-side enforcement would be
   a new rule, not a missing guard.** `class-edit-form.tsx`'s Max students input
   (`set('maxStudents', Number(…))`) has no capacity check. A teacher can raise an
   existing class above their room's capacity through the UI today, and the
   `updateClass` service accepts it. `capacityOverride` is described as "Teacher's own
   cap" in `docs/data-model.md`, and the product concept says a "personal max". Walk-ins
   already exceed `maxStudents` by design. The only person a bypass affects is the
   teacher who set the cap.

## 2. Decision

**Validation, not input rewriting, for every step-2 rule in the wizard. Pin every
message. Fix the drag in both forms.**

In the wizard:

- The Min and Max students inputs store what was typed. Neither clamps its own value or
  rewrites the other field. `handleRoomChange` keeps its clamps: picking a room is a
  prefill, like the `rentalRate` → room cost prefill beside it, not a keystroke.
- `validateStep(2)` runs the single-field checks (room cost ≥ 0, min ≥ 1, max ≥ 1,
  max ≤ room capacity), then `economicsViolations` for the cross-field rules, each
  placed on the violation's `path` field. A single-field message on a field wins over
  a cross-field one there, and the first violation per field wins, in rule order.
- The cross-field copy is the class family's existing bare wording, the same strings
  as `template-form.tsx` and `class-edit-form.tsx`, held in the wizard's own
  `ECONOMICS_COPY … satisfies Record<EconomicsRule, string>`, per the per-form pattern.
  `'Max must be >= min students'` goes away: no teacher could ever reach it, so
  replacing it changes nothing anyone has seen.
- Editing a field clears the cross-field message it takes part in, not only its own
  key. Otherwise a refusal shown on Min rate would stay after the teacher fixed it by
  raising the target rate.

In `template-form.tsx`: remove only the drag (`minStudents: Math.min(prev.minStudents,
max)` in the Max students `onChange`). A max below min then reaches the form's existing
`students_order` refusal on submit. Its capacity and min clamps stay: that form has no
capacity message to fall back on, and its min clamp rewrites only its own field.

Chosen over:

- **Delete the two dead branches and pin the clamps instead** (test-only, smallest). It
  keeps the drag, which is a live defect, and the silent capacity clamp gives no reason
  why 40 became 30.
- **Extract `validateStep` into a pure module and unit-test it.** This pins branches the
  page can't reach, which certifies a function rather than the wizard. Driving the
  rendered page proves the message lands on its field.
- **Server-side capacity enforcement on create.** See correction 4: without the edit
  path and a decision on what capacity *is*, it would be a one-door rule. That's a
  product question, not a gap, and nobody but the cap's owner is exposed.

## 3. Coverage

Every pin is driven through the rendered wizard and asserts the message as the field's
accessible description (`Input` wires `aria-describedby`), so a message on the wrong
field fails. Every refusal also asserts the step didn't advance and no POST was sent.
Each pin gets a recorded mutation.

- Step 1: an empty Next shows all five messages at once. The render is simultaneous.
  A whitespace-only class type is refused (the `.trim()`).
- Step 2: each single-field message; each economics rule's copy on its field; the
  boundaries that must pass (max = capacity, min = max, room cost 0,
  min rate = −room cost).
- The drag: Max students `2` then `20` leaves Min students at 4, in both forms.
- Clearing: a cross-field message clears when its other field is edited.

## 4. What this does not do

- No server-side capacity rule, on create or edit (correction 4).
- **#700 is unaffected**: the start-time copy of the template and class edit forms.
- The template form's capacity and min clamps stay (see §2).
- The unpunctuated voice of the class family is kept (#309/#316).
