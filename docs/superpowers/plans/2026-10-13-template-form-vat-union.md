# #874 — TemplateForm create mode requires the VAT default; the visual ERD learns VAT

**Issue:** #874 (follow-ups from #819). **Spec:** none — gated out: one component's
props type plus one static doc, one obvious design, no data-model or invariant change.
The issue body is the requirements.

**Premise verified on `bfec4ec5`:**
- `TemplateFormProps` (`src/components/settings/template-form.tsx`) has
  `mode: 'create' | 'edit'` with `templateId?`, `defaultVatPercent?`, `initial?` all optional.
- Callers outside tests: `src/app/(teacher)/settings/recurring/new/page.tsx` (create, passes
  `defaultVatPercent`) and `src/app/(teacher)/settings/recurring/[id]/page.tsx` (edit, passes
  `templateId` and `initial`). Nobody is affected today — the hazard is the next caller.
- `docs/visual/data-model.html` has no VAT field; its `settings_locked` Design Note lists
  five fields by name.

## Global Constraints

- TypeScript `strict`, no `any`, no casts to silence the compiler.
- CLAUDE.md *Comment Discipline*: no prose counts or member rosters in comments; comments
  state what is true now (no "previously" history).
- Behaviour of the form is unchanged for every existing caller; only the type tightens.
- Stage exact paths; quote paths containing parentheses.

## Task 1 — `TemplateFormProps` becomes a union discriminated on `mode`

**Files:** `src/components/settings/template-form.tsx`,
`src/components/settings/template-form.test.tsx`.

**Behaviour:**
- `TemplateFormProps` is
  `{ mode: 'create'; currency: Currency; defaultVatPercent: number }`
  `| { mode: 'edit'; currency: Currency; templateId: string; initial: TemplateFormValues }`.
  Keep the existing docblock on `defaultVatPercent` (adapt wording if the "An edit reads
  `initial`" clause no longer fits).
- The component can no longer destructure `templateId`/`initial`/`defaultVatPercent` from
  the union in its signature. Take `props`, and derive what the body uses by narrowing on
  `props.mode`. The initial form state becomes: edit → `props.initial`; create →
  `{ ...INITIAL_VALUES, vatPercent: props.defaultVatPercent }` — the `?? INITIAL_VALUES.vatPercent`
  fallback goes, since the prop is now required. Every other use of `templateId` / `initial`
  in the body must keep its exact current behaviour (in create mode they were `undefined`;
  e.g. `initial?.teacherRoomId` and the `mode === 'edit' && teacherRoomId === initial?.teacherRoomId`
  comparison). Prefer the smallest change that keeps the body readable — e.g. local
  `const templateId = props.mode === 'edit' ? props.templateId : undefined;` style bindings —
  over restructuring the component.
- `INITIAL_VALUES.vatPercent` stays (the type requires the field); it is now always overridden
  in create mode.

**Tests (test-first):**
1. Add a compile-time pin test to `template-form.test.tsx`, following the precedent in
   `src/components/ui/number-input.test.tsx` ("refuses … at compile time": JSX elements built
   under `// @ts-expect-error <reason>` lines, then `expect([...]).toHaveLength(n)`). Pin three
   refusals: create without `defaultVatPercent`; edit without `templateId`; edit without
   `initial`. Name the issue (#874) in the test title. Run `pnpm run typecheck` before the
   type change: it must fail with TS2578 "Unused '@ts-expect-error' directive" on those lines
   (RED). Record the exact error text in the report.
2. Change the type. Typecheck now fails on every existing `mode="create"` render that omits
   `defaultVatPercent` (and on any edit render missing a prop). Fix each by adding
   `defaultVatPercent={0}` — 0 is exactly what those renders got before (the old fallback),
   so their behaviour is unchanged. Do not change any assertion. Report how many renders you
   touched, measured with a command, not estimated.
3. **Prove each pin bites:** for each of the three `@ts-expect-error` lines, temporarily
   loosen the corresponding prop to optional in the union (one at a time), run typecheck,
   record the TS2578 error, restore. Then typecheck clean.
4. `pnpm exec vitest run src/components/settings/template-form.test.tsx` green; `pnpm run
   typecheck` and `pnpm run lint` green.

**Commits:** test commit (pin), then the type change + test-render updates (one or two
commits; message suffix `(#874)`).

## Task 2 — the visual ERD carries the VAT fields and stops enumerating locked fields

**Files:** `docs/visual/data-model.html` only.

**Behaviour:** source of truth is `docs/data-model.md` (grep `-i vat` there for the rows).
Add, using the HTML's existing `<div class="field">…<span class="field-name">…</span><span
class="field-type">…</span></div>` markup and snake_case names:
- `Teacher.default_vat_percent` — `decimal(6,3), default 0` — in the Teacher card's
  "Defaults" section.
- `ClassTemplate.vat_percent` — `decimal(6,3), default 0` — in its "Economics (copied to
  instances)" section.
- `Class.vat_percent` — `decimal(6,3), default 0` — in its "Economics (locked after first
  registration)" section.
- `Class.vat_total` — `decimal(10,2), nullable` — in its "Calculated (after class ends)"
  section, after `total_revenue`.
- `Payment.vat_amount` — `decimal(10,2), default 0` — directly after `amount`.
Short type strings only, matching the surrounding fields' terseness; a one-line note is fine
only where the card already uses `field-note` for that kind of thing — do not paste the
markdown's long notes.

Replace the roster in the Design Notes `settings_locked` paragraph
("economic fields (room_cost, min_rate, target_rate, min_students, max_students) become
immutable") with a pointer: the fields `LOCKED_FIELDS` names (`src/lib/class-fields.ts`) become
immutable. Verify `LOCKED_FIELDS` exists there under that name before writing it.

**Verification:** `grep -n -i vat docs/visual/data-model.html` shows each of the five fields;
`grep -n "room_cost, min_rate" docs/visual/data-model.html` returns nothing. Open the file's
HTML structure sanity: every added `<div class="field">` is balanced (count `<div` vs `</div>`
before/after: the difference must be equal).

**Commit:** `docs: the visual ERD carries VAT and points at LOCKED_FIELDS (#874)`.

## Order

Independent; Task 1 first.
