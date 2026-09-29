# Studio start-time guard (#699) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both studio create forms refuse a cleared start time before any request, in product copy, instead of letting `parseBody` print the raw Zod message `Must be HH:mm (00:00-23:59)`.

**Architecture:** One client-side guard per form in `handleSubmit`, in field order, same shape as the #310 duration/rate guards beside it. The studio edit form already has this guard; its gap is only that no test pins it.

**Tech Stack:** Next.js 16 client components, Vitest + Testing Library (`components` project).

**Spec:** none — single subsystem, one obvious approach (solve-issue spec gate: not difficult). The issue is the requirement: https://github.com/ivohofland/fair.yoga/issues/699

## Premise check (measured on `origin/main` at `6ec6f4bd`)

- `src/app/(teacher)/studio-class/new/page.tsx` `handleSubmit` guards class type, location, date, duration, hourly rate — not `startTime`. **Holds.**
- `src/components/settings/studio-template-form.tsx` `handleSubmit` guards class type, location, duration, hourly rate — not `startTime`. **Holds.** This form serves both `mode="create"` and `mode="edit"`, so the guard also covers template edits — wider than the issue names.
- `src/components/studio-class/studio-class-edit-form.tsx` `validate()` already refuses an empty start time with `'Pick a start time.'`. **Already fixed** — but `grep -rn "Pick a start time" src e2e tests` finds only that one source line: no test pins it.

## Global Constraints

- Copy: exactly `Pick a start time.` — the edit form's existing string, so the studio family says one thing for one refusal. Chosen over the issue's suggested "Enter a start time." (copy-unification: the create forms already mix "X is required." and "Enter …", so neither axis gets worse; the cross-file axis gets better).
- Guard condition: `!startTime` (a `type="time"` input reports `''` when cleared or partly filled, and otherwise a valid `HH:mm` — no `step` attribute is set, so no seconds). No regex duplicate of `timeHHmm`.
- Tests assert the copy **and** `fetch` not called, and must not assert any raw Zod text as present.
- Every guard is proven by mutation: remove it, record the exact failing assertion text, restore, re-run green, `git status` clean before committing.
- Test runs: `pnpm exec vitest run --project components <file>`.

---

### Task 1: Guard start time on the log-a-studio-class page

**Files:**
- Modify: `src/app/(teacher)/studio-class/new/page.tsx` (`handleSubmit`, after the `!date` guard)
- Test: `src/app/(teacher)/studio-class/new/page.test.tsx`

- [ ] **Step 1: Write the failing test** — add beside the duration test, using the file's `stubFetch()` and `fillRequired()`:

```tsx
  it('refuses a cleared start time before any request, with product copy', () => {
    stubFetch();
    render(<NewStudioClassPage />);
    fillRequired();

    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Pick a start time.')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it, expect FAIL** (fetch called / copy absent).
- [ ] **Step 3: Implement** — after the date guard:

```tsx
    if (!startTime) {
      setError('Pick a start time.');
      return;
    }
```

- [ ] **Step 4: Run the file, expect PASS.**
- [ ] **Step 5: Mutation** — delete the guard, run, record the exact failure line, restore, re-run green, `git status` shows only the two intended files.
- [ ] **Step 6: Commit** `fix(studio): refuse a cleared start time on the log-class page (#699)`.

### Task 2: Guard start time in the studio template form

**Files:**
- Modify: `src/components/settings/studio-template-form.tsx` (`handleSubmit`, after the location guard — start time is the next field the form validates)
- Test: `src/components/settings/studio-template-form.test.tsx`

- [ ] **Step 1: Write the failing test** — covers both modes, since the form serves both:

```tsx
  it.each(['create', 'edit'] as const)(
    'refuses a cleared start time before any request, with product copy (%s)',
    async (mode) => {
      stubFetch();
      render(
        mode === 'create' ? (
          <StudioTemplateForm mode="create" />
        ) : (
          <StudioTemplateForm mode="edit" templateId="tpl-1" initial={{ ...EDIT_INITIAL }} />
        ),
      );
      // Create mode starts with blank text fields; edit mode is prefilled from
      // EDIT_INITIAL. Filling both in either mode isolates start time as the
      // only field missing.
      fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
      fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });

      fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '' } });
      fireEvent.click(await screen.findByRole('button', { name: /save|create/i }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByText('Pick a start time.')).toBeInTheDocument();
    },
  );
```

  `EDIT_INITIAL` and `stubFetch()` already exist in the file; `templateId="tpl-1"` matches its other edit-mode cases.

- [ ] **Step 2: Run it, expect FAIL.**
- [ ] **Step 3: Implement** — after the location guard:

```tsx
    if (!form.startTime) {
      setError('Pick a start time.');
      return;
    }
```

- [ ] **Step 4: Run the file, expect PASS.**
- [ ] **Step 5: Mutation** — delete the guard, record the failure for **both** parameterised cases, restore, re-run green, `git status` clean apart from the two files.
- [ ] **Step 6: Commit** `fix(studio): refuse a cleared start time in the template form (#699)`.

### Task 3: Pin the studio edit form's existing start-time guard

**Files:**
- Test only: `src/components/studio-class/studio-class-edit-form.test.tsx`
- Source unchanged: `src/components/studio-class/studio-class-edit-form.tsx` (`validate()`, `if (!form.startTime) errors.startTime = 'Pick a start time.';`)

- [ ] **Step 1: Write the test** — beside `refuses a cleared duration in prose…`:

```tsx
  it('refuses a cleared start time in prose, not in Zod\'s words', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '' } });
    save();

    expect(await screen.findByText('Pick a start time.')).toBeInTheDocument();
    expect(screen.queryByText(/HH:mm/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run, expect PASS** (the guard already exists — this is a pin, not TDD red).
- [ ] **Step 3: Mutation** — delete the `startTime` line in `validate()`, run, record the exact failure, restore, re-run green, `git status` shows only the test file.
- [ ] **Step 4: Commit** `test(studio): pin the edit form's start-time refusal (#699)`.

## Order

Independent; any order. Run `pnpm exec vitest run --project components` over all three files at the end.
