# #702 — number-field refusals in the class template and class edit forms

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The class-template form and the class edit form refuse every number value their wire schema refuses, before any request leaves, in the class wizard's copy — so no teacher sees `parseBody`'s `<path>: <Zod message>` from them.

**Architecture:** One module-level `numberFieldError(form)` function per form, called in the submit handler after the existing detail checks (#700) and before `economicsViolations`. It returns the first refusal in field order, or `undefined`. The single-banner `role="alert"` each form already has shows it. Tests drive the rendered form.

**Tech Stack:** React 19 client components, Vitest `components` project (jsdom, Testing Library).

**Spec:** none. This is one client-side subsystem with one obvious approach and no invariant change (solve-issue's spec gate). The premise record is below, and the PR body carries it too.

## Premise, as measured on `origin/main` `6bf38dd3`

- **Holds.** Both forms store `Number(e.target.value)`, so a cleared number input is `0`. Neither checks duration or student counts client-side. `createClassTemplateSchema`, `updateClassTemplateSchema` and `updateClassSchema` (`src/lib/schemas.ts`) put these bounds on the number fields: `durationMinutes` int + positive; `roomCost` nonnegative; `minStudents`/`maxStudents` int + positive + `.max(MAX_CLASS_SIZE)`; `minRate`/`targetRate` none. The DB CHECKs (`minStudents BETWEEN 0 AND 200`, `maxStudents BETWEEN 1 AND 200`, `roomCost >= 0`, `durationMinutes > 0`) all sit inside those, so Zod is the whole refusal surface.
- **Widened by the issue's comment, and correct to be.** Fractional durations and counts, a negative room cost, and a max above `MAX_CLASS_SIZE` also reach `parseBody`. The wizard's `validateStep` (since #318) has copy for each of them.
- **Narrowed.** Max above `MAX_CLASS_SIZE` is reachable only on the **edit form**. On the template form, the Max students `onChange` clamps to `min(typed, roomCapacity, MAX_CLASS_SIZE)`, and so does `handleRoomChange`. The Min students `onChange` clamps to Max. So neither count can exceed the limit there, and a branch for it could never fire. It is left out rather than shipped unfailable.
- **Also widened.** The template form's `<form>` gives no protection either. None of these inputs has a `min`, `max` or `required` attribute, so a zero or negative value passes native constraint validation. A fractional one does too. Measured in Chromium on `/settings/recurring/new` before any change: typing `60.5`, clearing the field, or typing `-5` into Duration and clicking Create each sent one POST and showed `durationMinutes: Invalid input: expected int, received number` or `durationMinutes: Too small: expected number to be >0`, with `validity.valid === true` every time. Native `step` never fires because its base is the input's `value` attribute, and React syncs that attribute from the current value when a number input blurs, which the click on Create does first.
- **Room capacity on the edit form is out of scope.** That form has no room, and capacity isn't a class invariant (#318 spec, correction 4).

## Global Constraints

- Copy, verbatim, no trailing period (the class family's unpunctuated voice):
  - `Duration must be positive` (≤ 0)
  - `Duration must be whole minutes` (not an integer)
  - `Room cost cannot be negative` (< 0)
  - `Min students must be at least 1` (≤ 0)
  - `Min students must be a whole number` (not an integer)
  - `Max students must be at least 1` (≤ 0)
  - `Max students must be a whole number` (not an integer)
  - `` `Max students cannot exceed ${MAX_CLASS_SIZE}` `` (edit form only)
- Order within `numberFieldError`: duration, room cost, min students, max students. For each field, `<= 0` or `< 0` comes before the integer check. Single-field refusals run before `economicsViolations`, so a cleared Max students reads `Max students must be at least 1`, not the students-order message.
- Comments follow CLAUDE.md *Comment Discipline*. A comment annotates the code it sits on: no roster of which forms share this copy, no counts, no "previously". Don't name the wizard's file in a comment. The copy match is recorded here and in the PR body.
- Tests assert copy through `getByRole('alert')` / `findByRole('alert')` with an anchored full-string regex, and assert that no request left.
- Inner loop: `pnpm exec vitest run --project components <test file>`. `pnpm exec tsc --noEmit` and `pnpm lint` before each commit.
- Stage exact paths. Never `git add -A` or `git add .`.

---

### Task 1: class edit form

**Files:**
- Modify: `src/components/class/class-edit-form.tsx` (imports; a new module-level function after `ECONOMICS_COPY`; `handleSave` after the start-time check)
- Test: `src/components/class/class-edit-form.test.tsx`

**Interfaces:**
- Produces: `numberFieldError(form: ClassEditInitial, settingsLocked: boolean): string | undefined`, module-private.

- [ ] **Step 1: Write the failing tests.** Add `import { MAX_CLASS_SIZE } from '@/lib/schemas';` to the test file. Place these after the #700 `it.each` block:

```tsx
  /**
   * #702. The number inputs store `Number(value)`, so a cleared one is `0`.
   * Every bound `updateClassSchema` puts on a number field is refused before
   * the request leaves. Duration is a detail, sent and checked at any lock
   * state. Room cost and the student counts are economics, checked only while
   * unlocked, since locked economics are never sent.
   */
  it.each([
    ['a cleared duration', 'Duration (minutes)', '', false, /^Duration must be positive$/],
    ['a cleared duration, settings locked', 'Duration (minutes)', '', true, /^Duration must be positive$/],
    ['a fractional duration', 'Duration (minutes)', '60.5', false, /^Duration must be whole minutes$/],
    ['a negative room cost', 'Room cost (€)', '-5', false, /^Room cost cannot be negative$/],
    ['a cleared min students', 'Min students', '', false, /^Min students must be at least 1$/],
    ['a fractional min students', 'Min students', '2.5', false, /^Min students must be a whole number$/],
    ['a cleared max students', 'Max students', '', false, /^Max students must be at least 1$/],
    ['a fractional max students', 'Max students', '12.5', false, /^Max students must be a whole number$/],
    [
      'a max students over the class size limit',
      'Max students',
      String(MAX_CLASS_SIZE + 1),
      false,
      new RegExp(`^Max students cannot exceed ${MAX_CLASS_SIZE}$`),
    ],
  ] as const)(
    'refuses %s before any request, with product copy',
    async (_label, fieldName, value, settingsLocked, copy) => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      render(<ClassEditForm classId="cls-1" settingsLocked={settingsLocked} initial={initial} />);

      fireEvent.change(screen.getByLabelText(fieldName), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    },
  );

  /** #702. Each bound is inclusive: every field at its edge still saves. */
  it.each([
    ['the lower edges', { durationMinutes: 1, roomCost: 0, minStudents: 1, maxStudents: 1 }],
    ['the class size limit', { maxStudents: MAX_CLASS_SIZE }],
  ] as const)('saves every number field at %s, with no alert', async (_label, edges) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm classId="cls-1" settingsLocked={false} initial={{ ...initial, ...edges }} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * #702. The count checks sit inside the unlocked branch. A locked class's
   * stored counts are never sent, so a stored zero min must not block a save.
   */
  it('locked settings: saves despite a stored zero min students, with no alert', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm classId="cls-1" settingsLocked={true} initial={{ ...initial, minStudents: 0 }} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run and see the new refusal cases fail.** Run `pnpm exec vitest run --project components src/components/class/class-edit-form.test.tsx`. Expected: every `refuses …` case FAILs, either because fetch was called or because the alert text differs (a cleared max still hits `Min students cannot exceed max students`). Both `saves …` tests PASS already. They pin boundaries and placement, which Step 5 proves by mutation.

- [ ] **Step 3: Implement.** In `class-edit-form.tsx`, change the schemas import to `import { MAX_CLASS_SIZE, type updateClassSchema } from '@/lib/schemas';`. Add after `ECONOMICS_COPY`:

```ts
/**
 * #702. The number inputs store `Number(value)`, so a cleared one is `0`, and
 * nothing native bounds them: this form has no `<form>` element. The first
 * value `updateClassSchema` would refuse, in this form's copy, or `undefined`.
 * Duration is always sent. The rest are economics, sent only while unlocked.
 */
function numberFieldError(form: ClassEditInitial, settingsLocked: boolean): string | undefined {
  if (form.durationMinutes <= 0) return 'Duration must be positive';
  if (!Number.isInteger(form.durationMinutes)) return 'Duration must be whole minutes';
  if (settingsLocked) return undefined;
  if (form.roomCost < 0) return 'Room cost cannot be negative';
  if (form.minStudents <= 0) return 'Min students must be at least 1';
  if (!Number.isInteger(form.minStudents)) return 'Min students must be a whole number';
  if (form.maxStudents <= 0) return 'Max students must be at least 1';
  if (!Number.isInteger(form.maxStudents)) return 'Max students must be a whole number';
  if (form.maxStudents > MAX_CLASS_SIZE) return `Max students cannot exceed ${MAX_CLASS_SIZE}`;
  return undefined;
}
```

In `handleSave`, directly after the `if (!form.startTime) { … }` block and before the economics comment:

```ts
    const numberError = numberFieldError(form, settingsLocked);
    if (numberError !== undefined) {
      setError(numberError);
      return;
    }
```

Update the #700 comment above the class-type check only if it now says something false. It describes those three checks, and it stays true.

- [ ] **Step 4: Run and see everything pass.** Same command. Expected: whole file PASS. Then run `pnpm exec tsc --noEmit` and `pnpm lint`.

- [ ] **Step 5: Prove every guard bites.** One at a time, apply each mutation, run the file, record the failing test name(s) and the assertion's error text, restore, and confirm the file is green and `git status` is clean for the source file. Store each mutation as exact text in the task report.
  1. Delete the duration `<= 0` line. (With duration 0, the integer check doesn't fire, so the request leaves.)
  2. Delete the duration integer line.
  3. Move `if (settingsLocked) return undefined;` to the top of the function. The locked-duration case must fail.
  4. Delete the `if (settingsLocked) return undefined;` line. The stored-zero-min test must fail.
  5. Delete each of the six economics lines in turn (room cost, min ≤ 0, min integer, max ≤ 0, max integer, max over limit).
  6. Boundary mutants: `<= 0` → `<= 1` on duration, `< 0` → `<= 0` on room cost, `<= 0` → `<= 1` on min, `<= 0` → `<= 1` on max, `> MAX_CLASS_SIZE` → `>= MAX_CLASS_SIZE` on max. A bound test must fail each time.
  7. Delete the `handleSave` call block entirely.
  8. Move the call block to after the `economicsViolations` check. The cleared-max case must fail, because students-order now wins.

  Expected: each mutation turns at least one test red. A mutation that stays green is reported, not papered over.

- [ ] **Step 6: Commit.**

```bash
git add src/components/class/class-edit-form.tsx src/components/class/class-edit-form.test.tsx
git commit -m "fix(class): refuse out-of-bounds numbers in the class edit form (#702)"
```

---

### Task 2: class template form

**Files:**
- Modify: `src/components/settings/template-form.tsx` (a new module-level function after `ECONOMICS_COPY`; `handleSubmit` after the start-time check)
- Test: `src/components/settings/template-form.test.tsx`

**Interfaces:**
- Produces: `numberFieldError(form: TemplateFormValues): string | undefined`, module-private. It has no `MAX_CLASS_SIZE` branch (see Premise, "Narrowed").

**Why these tests dispatch `submit` and don't click.** In jsdom, a click submit runs native constraint validation. The pricing preview's range input goes out of range when Max drops below Min, and a fractional value can fail `step` there, so the click would be blocked before `handleSubmit` runs. That would prove jsdom, not the guard. The existing test "refuses a max typed below min students on submit" dispatches `fireEvent.submit(form)` for the same reason. A real browser lets the click through (see Premise), so `submit` is the faithful stand-in.

**Why this form fetches on mount.** `GET /api/teacher-rooms` is called on mount, so "no request left" is asserted as a delta against `callsBefore`, as the #700 and #317 tests in this file do.

- [ ] **Step 1: Write the failing tests.** Place after the #700 `it.each` block:

```tsx
  /**
   * #702. The number inputs store `Number(value)`, so a cleared one is `0`,
   * and none carries a native `min`. Every bound the template schemas put on
   * a number field that the inputs' own clamps don't already hold is refused
   * before any request leaves, on create and on edit.
   */
  const NUMBER_REFUSALS = [
    ['a cleared duration', 'Duration (minutes)', '', /^Duration must be positive$/],
    ['a fractional duration', 'Duration (minutes)', '60.5', /^Duration must be whole minutes$/],
    ['a negative room cost', 'Room cost', '-5', /^Room cost cannot be negative$/],
    ['a cleared min students', 'Min students', '', /^Min students must be at least 1$/],
    ['a fractional min students', 'Min students', '2.5', /^Min students must be a whole number$/],
    ['a cleared max students', 'Max students', '', /^Max students must be at least 1$/],
    ['a fractional max students', 'Max students', '12.5', /^Max students must be a whole number$/],
  ] as const;

  /** Renders `mode` ready to submit: create picks the room and names the class first. */
  async function renderReady(mode: 'create' | 'edit') {
    stubFetch();
    render(
      mode === 'create' ? (
        <TemplateForm mode="create" />
      ) : (
        <TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />
      ),
    );
    await screen.findByLabelText('Room');
    if (mode === 'create') {
      fireEvent.change(screen.getByLabelText('Room'), {
        target: { value: '11111111-1111-4111-8111-111111111111' },
      });
      fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    }
  }

  function submitForm() {
    const form = screen.getByLabelText('Duration (minutes)').closest('form');
    if (!form) throw new Error('expected Duration to be inside a form');
    fireEvent.submit(form);
  }

  describe.each(['create', 'edit'] as const)('number refusals (%s)', (mode) => {
    it.each(NUMBER_REFUSALS)(
      'refuses %s before any request, with product copy',
      async (_label, fieldName, value, copy) => {
        await renderReady(mode);
        fireEvent.change(screen.getByLabelText(fieldName), { target: { value } });

        const callsBefore = fetchMock.mock.calls.length;
        submitForm();

        expect(fetchMock.mock.calls.length).toBe(callsBefore);
        expect(screen.getByRole('alert')).toHaveTextContent(copy);
      },
    );

    /** Each bound is inclusive: every field at its edge still sends. */
    it('sends every number field at its bound, with no alert', async () => {
      await renderReady(mode);
      fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '1' } });
      fireEvent.change(screen.getByLabelText('Room cost'), { target: { value: '0' } });
      fireEvent.change(screen.getByLabelText('Min students'), { target: { value: '1' } });
      fireEvent.change(screen.getByLabelText('Max students'), { target: { value: '1' } });

      const callsBefore = fetchMock.mock.calls.length;
      submitForm();

      await waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsBefore + 1));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
```

If the create-mode bound test logs the file's `recurring class create: unreadable counts` warning (the stubbed POST answers with the rooms body), that's expected. Don't change the stub to hide it unless the suite fails on console output.

- [ ] **Step 2: Run and see the refusal cases fail.** Run `pnpm exec vitest run --project components src/components/settings/template-form.test.tsx`. Expected: every `refuses …` case FAILs in both modes. The cleared-max case shows `Min students cannot exceed max students` instead. The bound tests PASS already.

- [ ] **Step 3: Implement.** In `template-form.tsx`, add after `ECONOMICS_COPY`:

```ts
/**
 * #702. The number inputs store `Number(value)`, so a cleared one is `0`, and
 * none carries a native `min`. The first value the template schemas would
 * refuse, in this form's copy, or `undefined`. No class-size branch: both
 * handlers that write Max students clamp it to `MAX_CLASS_SIZE`, the Min
 * students input clamps to Max, and an edit's `initial` is a saved template.
 */
function numberFieldError(form: TemplateFormValues): string | undefined {
  if (form.durationMinutes <= 0) return 'Duration must be positive';
  if (!Number.isInteger(form.durationMinutes)) return 'Duration must be whole minutes';
  if (form.roomCost < 0) return 'Room cost cannot be negative';
  if (form.minStudents <= 0) return 'Min students must be at least 1';
  if (!Number.isInteger(form.minStudents)) return 'Min students must be a whole number';
  if (form.maxStudents <= 0) return 'Max students must be at least 1';
  if (!Number.isInteger(form.maxStudents)) return 'Max students must be a whole number';
  return undefined;
}
```

In `handleSubmit`, directly after the `if (!form.startTime) { … }` block and before the economics comment:

```ts
    const numberError = numberFieldError(form);
    if (numberError !== undefined) {
      setError(numberError);
      return;
    }
```

- [ ] **Step 4: Run and see everything pass.** Same command, then `pnpm exec tsc --noEmit` and `pnpm lint`.

- [ ] **Step 5: Prove every guard bites.** Same protocol as Task 1 Step 5: exact mutation text, failing test names with error text, restore, clean `git status` on the source file.
  1. Delete each of the seven lines of `numberFieldError` in turn. Each must fail in both modes.
  2. Boundary mutants: `<= 0` → `<= 1` on duration, `< 0` → `<= 0` on room cost, `<= 0` → `<= 1` on min, and `<= 0` → `<= 1` on max. The bound test must fail each time, in both modes.
  3. Delete the `handleSubmit` call block.
  4. Move the call block to after the `economicsViolations` check. The cleared-max case must fail, because students-order now wins.

- [ ] **Step 6: Commit.**

```bash
git add src/components/settings/template-form.tsx src/components/settings/template-form.test.tsx
git commit -m "fix(template-form): refuse out-of-bounds numbers before sending (#702)"
```

---

## Final verification (controller, after the whole-branch review)

- `pnpm run verify` against the worktree's own app (`pnpm run worktree:up` first). Record the per-project arithmetic.
- **Real-browser re-run of the premise measurement.** Repeat the Chromium run from the premise (`60.5`, cleared, `-5` in Duration, then Create). Expected: no POST, and the form's alert reads `Duration must be whole minutes`, `Duration must be positive`, `Duration must be positive`.

## Plan review (adjudicated)

- *Template form's integer branches are unreachable in a real browser, since the default `step` is 1.* Declined, measured: in Chromium, `60.5` in Duration was `validity.valid === true` and was POSTed (Premise). The branches stay, and so does the rule that drops the class-size branch.
- *Edit form's bound test can't kill `<= 0` → `<= 1` on max.* Taken: the bound test is now two cases, the lower edges and the class-size limit, and the mutant is listed.
- *Template docblock omits the `initial` writer.* Taken, reworded. *Locked-test docblock names a migration's CHECK.* Taken, the clause is dropped.
- *Non-finite values.* Declined, measured: Chromium sanitizes `1e999` and `-1e999` in a number input to `''` (`badInput`), which is `Number('') === 0`, the cleared case. `Infinity` can't be produced.
- *Edit form's mutation list lacks "call after `economicsViolations`".* Taken.
