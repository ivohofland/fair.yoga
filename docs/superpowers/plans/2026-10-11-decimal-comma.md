# Decimal comma (#844) — implementation plan

Spec: `docs/superpowers/specs/2026-10-11-decimal-comma-design.md`. Read it first. It
has the measurements, the census of the 16 decimal fields, and the parser rules.

Tasks run in order: task 2 and task 3 import task 1's parser.

## Task 1 — `parseDecimal` and `MONEY_DECIMALS`

**Files:** `src/lib/decimal-input.ts` (new), `src/lib/decimal-input.test.ts`
(new, `unit` project), `src/lib/input-bounds.ts`.

1. Write the unit tests first, from the spec's measurement table and its testing
   list:
   - `4,5`→4.5, `4.5`→4.5, `45.`→45, `,5`→0.5, `5,`→5, `-4,5`→-4.5.
   - At 2 decimals: `4,555`→NaN, `1.000`→NaN, `1,000`→NaN.
   - At 3 decimals: `4,555`→4.555.
   - At `Infinity`: `8,1234`→8.1234.
   - NaN for: `1.000,5`, `1 000`, `-`, `4e`, `4,5,6`, blank, whitespace.
   - Surrounding whitespace is trimmed.
   Run them and see them fail (the module does not exist).
2. Implement `parseDecimal(text: string, maxDecimals: number): number` per the
   spec. Export `MONEY_DECIMALS = 2` from `input-bounds.ts`, beside `MONEY_MAX`.
   The parser's own docblock states its rules and nothing about its callers.
3. Tests pass. `pnpm exec tsc --noEmit` and lint are clean.

## Task 2 — `NumberInput` decimal mode, and its ten call sites

**Files:** `src/components/ui/number-input.tsx` and its test;
`src/app/(teacher)/class/new/new-class-form.tsx`,
`src/components/settings/template-form.tsx`,
`src/components/class/class-edit-form.tsx`,
`src/components/settings/profile-form.tsx`, and each one's test file.

1. Tests first, in `number-input.test.tsx`: with `decimals={2}`, the input is
   `type="text"` with `inputMode="decimal"`. Typing `4,5` reports 4.5 and leaves
   `4,5` displayed. Typing `4,555` reports NaN and leaves the text as typed.
   Clearing it reports 0, and leaving shows `0`. A held `value` whose
   `String(value)` does not parse back in decimal mode (4.555 with
   `decimals={2}`) renders without looping ("Too many re-renders" is the
   failure). Keep the existing integer-mode tests, `badInput` included, but
   correct their comment so it no longer claims a browser flags `4,5` (the
   spec's measurement: Chromium does not).
2. Implement per the spec: the optional `decimals` prop; a props union that
   forbids `min`/`max`/`step` alongside it (`?: never`); and the rewrite guard
   `text !== String(value)`. Add a `@ts-expect-error` pin in the test proving
   `min` beside `decimals` is a compile error. Rewrite the docblock to state
   what is true now.
3. Call sites: the 9 money fields pass `decimals={MONEY_DECIMALS}`, and VAT passes
   `decimals={Infinity}` (spec: `vatPercentViolation` keeps its own decimals
   message). Drop their `min`/`max`/`step` and VAT's own `inputMode` (the
   compiler finds the first three). The existing VAT test expecting "Use at
   most 3 decimals for VAT." for `8.1234` must still pass unchanged.
4. Form tests: in each of the four forms, typing `4,5` into one decimal field
   sends 4.5 in the request body (VAT: `defaultVatPercent: 4.5`). The existing
   `badInput` tests on decimal fields
   (`new-class-form.test.tsx`, `template-form.test.tsx`,
   `class-edit-form.test.tsx`, `profile-form.test.tsx`) are rewritten to type
   genuinely unreadable text (`4,5,6` or `1.000,5`), so each still proves the
   form's "Enter a number for …" refusal. Their `"4,5"` comments go.
5. **Prove the pins bite:** temporarily render `type="number"` in decimal mode.
   The `4,5` tests must fail (jsdom sanitizes `4,5` to `''`). Record the error
   text, restore, re-run green.

## Task 3 — the six string-held decimal fields

**Files:** `src/app/(teacher)/studio-class/new/new-studio-class-form.tsx`,
`src/components/settings/studio-template-form.tsx`,
`src/components/studio-class/studio-class-edit-form.tsx`,
`src/components/settings/edit-room-form.tsx`,
`src/components/settings/room-settings-step.tsx`,
`src/components/settings/edit-teacher-room-form.tsx`, and their tests
(`edit-room-form.test.tsx` and `edit-teacher-room-form.test.tsx` exist but
dispatch no input yet; `room-settings-step` has `room-settings-step.test.tsx`
and is also covered by `add-room-flow.test.tsx`).

1. Tests first:
   - For each form, typing `4,5` (hourly rate or rental rate) sends 4.5.
   - Typing `1.000` refuses and sends nothing. The studio forms show their
     existing "Enter an hourly rate — 0 if this class is unpaid."; the room
     forms show the new "Enter a number for rental rate".
   - In each room form, a blank rental rate still sends 0.
   - In `edit-room-form` and `edit-teacher-room-form`, a rental rate above
     `MONEY_MAX` is refused client-side with `room-settings-step`'s message
     ("Rental rate cannot exceed 100,000").
2. Implement:
   - `type="text" inputMode="decimal"`, and drop `step`/`max`.
   - Replace **every** `Number(<rate>)` on these fields. Studio forms use
     `parseDecimal(<rate>, MONEY_DECIMALS)`. Room forms use
     `<rate>.trim() === '' ? 0 : parseDecimal(<rate>, MONEY_DECIMALS)`, which
     keeps blank as 0.
   - Room forms: split the NaN case off "Rental rate must be 0 or more" into
     "Enter a number for rental rate".
   - `studio-class-edit-form.tsx` converts in two places, the validator and
     the save payload, and its docblock (around lines 60–75) explains the
     string state through `type="number"` reporting `''`. Rewrite that
     docblock for a text field.
   - Before calling the task done, grep each file for `Number(` and give every
     hit a verdict.
3. **Prove it bites:** revert one form's `type` to `"number"` and its parse to
   `Number(`, see its `4,5` test fail, record the text, restore.

## Task 4 — e2e in real Chromium

**Files:** `tests/e2e/class-edit.spec.ts`, `tests/e2e/studio.spec.ts`.

Type key by key: clear the field, then `pressSequentially`. Playwright's
`fill` throws `Cannot type text into input[type=number]` on the old field, so a
`fill`-based proof fails for the wrong reason.

1. `class-edit.spec.ts` is serial, and its second test (~line 148) asserts the
   first test's saved value (~line 167). Do not add a new test. Change the
   first test's Target rate entry (~line 135) to type `24,5`, and update both
   expectations (~144 and ~167) to 24.5.
2. `studio.spec.ts`: change the existing Hourly rate entry (~line 507) to type
   `40,5`. Assert 40.5 through the `prisma.studioClass` lookup the spec already
   does (~line 517).
3. **Prove they bite:** restore `origin/main`'s `number-input.tsx`,
   `class-edit-form.tsx` and `new-studio-class-form.tsx` (`git stash` is shared
   across worktrees, so use `git show origin/main:<path> > <path>` and restore
   with `git checkout`). Run both specs against the worktree app
   (`pnpm run worktree:up`). Both must fail because Chromium saves `245`/`405`.
   Record that, restore, and re-run green.

## After the tasks

- Grep the whole repo (`src`, `tests`, `docs` outside `superpowers/`) for
  `badInput` and for `"4,5"`. Every surviving claim that a browser flags a
  comma is wrong: correct or remove it.
- `pnpm run verify`, then `pnpm run build` (a client import of a server module
  surfaces only there).
