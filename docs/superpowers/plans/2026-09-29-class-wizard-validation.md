# Class wizard step validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin every message the class-creation wizard's `validateStep` can show. Make
every step-2 rule reachable by validating instead of rewriting typed input. Stop the
Max students input from dragging Min students down, in both class-family forms.

**Architecture:** All wizard changes are in `src/app/(teacher)/class/new/page.tsx`,
and its tests drive the rendered page. Step 2 gains the shared `economicsViolations`
rules (`src/lib/class-economics.ts`) with the class family's existing bare copy. The
recurring-template form gets a one-line removal.

**Tech Stack:** Next.js 16 client component, React 19, Vitest + Testing Library (the
`components` vitest project).

**Spec:** `docs/superpowers/specs/2026-09-29-class-wizard-validation-design.md`

## Global Constraints

- Copy stays unpunctuated (class family voice, #309/#316). The economics strings are
  exactly `'Min students cannot exceed max students'`,
  `'Min rate cannot exceed target rate'`,
  `'Min rate cannot subsidize more than the room cost — prices would go negative'`.
- Tests assert a message as its field's accessible description
  (`expect(screen.getByLabelText('X')).toHaveAccessibleDescription('…')`). `Input`
  wires `aria-describedby` to the error. Never assert only that the text exists on the
  page.
- Every refusal test also asserts the wizard didn't advance and didn't POST.
- Every new pin is mutation-proven: break the source, record the exact failing
  assertion text in the task report, restore, re-run green. Finish with
  `git status` clean apart from intended edits.
- No counts or member lists in comments (CLAUDE.md *Comment Discipline*). Where a
  membership matters, use `satisfies Record<…, true>`.
- `StepErrors` stays `Record<string, string>`.
- Fast loop: `pnpm exec vitest run --project components 'src/app/(teacher)/class/new/page.test.tsx'`
  (quote the path, it has parentheses).

## Review Focus

1. A teacher retypes Max students via select-all and a first keystroke below Min
   students. Min students must not change (Task 2 and Task 3 each pin the `2`→`20`
   keystroke sequence).
2. A teacher fixes a cross-field refusal by editing the *other* field (raising Target
   rate to clear a Min rate refusal). The stale message must disappear (Task 2 pins
   both rules' clearing).
3. Boundary values that are legal must still advance: max = room capacity, min = max,
   room cost 0 with min rate 0, min rate = −room cost (Task 2's boundary test).
4. A field with both a single-field and a cross-field problem shows the single-field
   message. Example: Min students 0 with Max students −1 shows
   `'Min students must be at least 1'` on Min students (Task 2).
5. Switching room after typing a larger max still clamps through
   `handleRoomChange`. That clamp is kept deliberately, so the existing
   thirteen-fields test (max 12 from a 30-capacity room) must stay green unedited.

---

### Task 1: Pin step 1's messages (test-only)

**Files:**
- Test: `src/app/(teacher)/class/new/page.test.tsx` (add a `describe('step 1 validation (#318)')` block inside the existing top-level `describe`)

**Interfaces:**
- Consumes: the file's existing `stubFetch`, `ROOM_ID`, `fetchMock`.
- Produces: a local helper `async function renderAtStep1()` that renders the page and
  awaits the Room select (`await screen.findByLabelText('Room')`). Task 2 reuses it.

- [ ] **Step 1: Write the tests**

```tsx
describe('step 1 validation (#318)', () => {
  async function renderAtStep1() {
    stubFetch();
    render(<CreateClassPage />);
    await screen.findByLabelText('Room');
  }

  /** The step-1 fields render every message in the same pass. */
  it('refuses an empty step 1 with every field message at once, and does not advance', async () => {
    await renderAtStep1();
    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '0' } });
    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    expect(screen.getByLabelText('Room')).toHaveAccessibleDescription('Select a room');
    expect(screen.getByLabelText('Class type')).toHaveAccessibleDescription('Enter a class type');
    expect(screen.getByLabelText('Date')).toHaveAccessibleDescription('Select a date');
    expect(screen.getByLabelText('Start time')).toHaveAccessibleDescription('Enter a start time');
    expect(screen.getByLabelText('Duration (minutes)')).toHaveAccessibleDescription('Duration must be positive');
    expect(screen.queryByLabelText('Room cost')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('refuses a whitespace-only class type', async () => {
    await renderAtStep1();
    fireEvent.change(screen.getByLabelText('Room'), { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    expect(screen.getByLabelText('Class type')).toHaveAccessibleDescription('Enter a class type');
    expect(screen.queryByLabelText('Room cost')).not.toBeInTheDocument();
  });

  it('clears a field message when that field is edited', async () => {
    await renderAtStep1();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Yin' } });

    expect(screen.getByLabelText('Class type')).not.toHaveAccessibleDescription();
    expect(screen.getByLabelText('Date')).toHaveAccessibleDescription('Select a date');
  });
});
```

If the page labels the Room select or Duration field differently, use the rendered
label. Read it from `page.tsx`; don't weaken the assertion to a text query.

- [ ] **Step 2: Run, expect PASS** (these pin existing behaviour)

Run: `pnpm exec vitest run --project components 'src/app/(teacher)/class/new/page.test.tsx'`

- [ ] **Step 3: Mutation-prove each pin**

Apply each mutation to `page.tsx` alone and run the file. Record the failing test and
assertion in the report, then restore:
1. delete the `teacherRoomId` line of `validateStep(1)`
2. delete the `classType` line
3. delete the `date` line
4. delete the `startTime` line
5. delete the `durationMinutes` line
6. `form.classType.trim()` → `form.classType`
7. change `validateStep`'s `return Object.keys(errs).length === 0` to `return true`
   (the not-advance assertion)
8. in `updateField`, delete `delete next[key];`

Every mutation must turn at least one test red. After the last restore,
`git diff --stat src/app/(teacher)/class/new/page.tsx` must be empty.

- [ ] **Step 4: Commit**

```bash
git add 'src/app/(teacher)/class/new/page.test.tsx'
git commit -m "test(class-wizard): pin step 1's validation messages (#318)"
```

---

### Task 2: Step 2 validates instead of rewriting input, with the shared economics rules

**Files:**
- Modify: `src/app/(teacher)/class/new/page.tsx` (imports; a new `ECONOMICS_COPY` and
  `ECONOMICS_FIELDS` near `StepErrors`; `updateField`; `validateStep` step 2; the Min
  students and Max students `onChange` handlers)
- Test: `src/app/(teacher)/class/new/page.test.tsx` (a `describe('step 2 validation (#318)')` block)

**Interfaces:**
- Consumes: `economicsViolations`, `type EconomicsRule`, `type ClassEconomics` from
  `@/lib/class-economics` (import-free module, client-safe); Task 1's test pattern.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('step 2 validation (#318)', () => {
  /** Step 1 filled validly with the 30-capacity room; defaults then read room cost 20, min rate 15, target 25, min 4, max 12. */
  async function renderAtStep2() {
    stubFetch();
    render(<CreateClassPage />);
    fireEvent.change(await screen.findByLabelText('Room'), { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await screen.findByLabelText('Room cost');
  }

  function set(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }

  function next() {
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
  }

  function expectStillOnStep2() {
    expect(screen.getByLabelText('Room cost')).toBeInTheDocument();
    expect(screen.queryByLabelText('Cancellation deadline')).not.toBeInTheDocument();
  }

  it('refuses a negative room cost', async () => {
    await renderAtStep2();
    set('Room cost', '-1');
    next();
    expect(screen.getByLabelText('Room cost')).toHaveAccessibleDescription('Room cost cannot be negative');
    expectStillOnStep2();
  });

  it('refuses min students below 1', async () => {
    await renderAtStep2();
    set('Min students', '0');
    next();
    expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students must be at least 1');
    expectStillOnStep2();
  });

  it('refuses max students below 1', async () => {
    await renderAtStep2();
    set('Max students', '0');
    next();
    expect(screen.getByLabelText('Max students')).toHaveAccessibleDescription('Max students must be at least 1');
    expectStillOnStep2();
  });

  it('refuses max students above the room capacity, keeping what was typed', async () => {
    await renderAtStep2();
    set('Max students', '40');
    expect(screen.getByLabelText('Max students')).toHaveValue(40);
    next();
    expect(screen.getByLabelText('Max students')).toHaveAccessibleDescription('Cannot exceed room capacity (30)');
    expectStillOnStep2();
  });

  it('refuses min students above max students, on Min students, with the class family copy', async () => {
    await renderAtStep2();
    set('Min students', '10');
    set('Max students', '8');
    expect(screen.getByLabelText('Min students')).toHaveValue(10);
    next();
    expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students cannot exceed max students');
    expectStillOnStep2();
  });

  it('refuses a min rate above the target rate before any request', async () => {
    await renderAtStep2();
    set('Min rate', '30');
    const callsBefore = fetchMock.mock.calls.length;
    next();
    expect(screen.getByLabelText('Min rate')).toHaveAccessibleDescription('Min rate cannot exceed target rate');
    expectStillOnStep2();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('refuses a min rate subsidizing more than the room cost', async () => {
    await renderAtStep2();
    set('Room cost', '10');
    set('Min rate', '-15');
    next();
    expect(screen.getByLabelText('Min rate')).toHaveAccessibleDescription(
      'Min rate cannot subsidize more than the room cost — prices would go negative',
    );
    expectStillOnStep2();
  });

  it('shows the single-field message where a field also breaks a cross-field rule', async () => {
    await renderAtStep2();
    set('Max students', '-1');
    set('Min students', '0');
    next();
    expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students must be at least 1');
    expect(screen.getByLabelText('Max students')).toHaveAccessibleDescription('Max students must be at least 1');
  });

  it('advances at every legal boundary: max at capacity, min equal to max, min rate at minus the room cost', async () => {
    await renderAtStep2();
    set('Max students', '30');
    set('Min students', '30');
    set('Room cost', '10');
    set('Min rate', '-10');
    next();
    expect(await screen.findByLabelText('Cancellation deadline')).toBeInTheDocument();
  });

  it('advances with a zero room cost and a zero min rate', async () => {
    await renderAtStep2();
    set('Room cost', '0');
    set('Min rate', '0');
    next();
    expect(await screen.findByLabelText('Cancellation deadline')).toBeInTheDocument();
  });

  /** Spec §1 correction 2: select-all in Max students and type 20; the first keystroke is 2. */
  it('does not drag min students down while max students is being typed', async () => {
    await renderAtStep2();
    set('Max students', '2');
    set('Max students', '20');
    expect(screen.getByLabelText('Min students')).toHaveValue(4);
    expect(screen.getByLabelText('Max students')).toHaveValue(20);
  });

  it('clears a students-order refusal when max students is raised', async () => {
    await renderAtStep2();
    set('Max students', '3');
    next();
    expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students cannot exceed max students');
    set('Max students', '5');
    expect(screen.getByLabelText('Min students')).not.toHaveAccessibleDescription();
  });

  it('clears a rate-order refusal when the target rate is raised', async () => {
    await renderAtStep2();
    set('Min rate', '30');
    next();
    expect(screen.getByLabelText('Min rate')).toHaveAccessibleDescription('Min rate cannot exceed target rate');
    set('Target rate', '35');
    expect(screen.getByLabelText('Min rate')).not.toHaveAccessibleDescription();
  });

  it('keeps a single-field message when a different economics field is edited', async () => {
    await renderAtStep2();
    set('Min students', '0');
    next();
    set('Target rate', '30');
    expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students must be at least 1');
  });
});
```

- [ ] **Step 2: Run, confirm the right tests fail**

Run: `pnpm exec vitest run --project components 'src/app/(teacher)/class/new/page.test.tsx'`

Expected RED:
- the capacity test (the value reads 30, clamped)
- min-above-max (min is clamped or dragged)
- both rate rules (no description; the wizard advances)
- the drag test (min reads 2)
- both clearing tests
- the single-field test, which may pass or fail depending on clamps; record which

Expected GREEN already: negative room cost, min below 1, max below 1, both boundary
tests, the single-field-kept test. Record the actual split in the report.

- [ ] **Step 3: Implement**

In `page.tsx`, import from `@/lib/class-economics`:

```ts
import { economicsViolations, type ClassEconomics, type EconomicsRule } from '@/lib/class-economics';
```

Beside `type StepErrors`:

```ts
/** This form's own wording for each rule `economicsViolations` can report. */
const ECONOMICS_COPY = {
  students_order: 'Min students cannot exceed max students',
  rate_order: 'Min rate cannot exceed target rate',
  room_subsidy: 'Min rate cannot subsidize more than the room cost — prices would go negative',
} as const satisfies Record<EconomicsRule, string>;

const ECONOMICS_MESSAGES: ReadonlySet<string> = new Set(Object.values(ECONOMICS_COPY));

/**
 * The fields `economicsViolations` reads. Editing any of them may settle a
 * cross-field refusal shown on another one, so `updateField` clears those too.
 */
const ECONOMICS_FIELDS = {
  roomCost: true,
  minRate: true,
  targetRate: true,
  minStudents: true,
  maxStudents: true,
} as const satisfies Record<keyof ClassEconomics, true>;
```

`updateField`'s `setErrors` callback becomes:

```ts
setErrors((prev) => {
  const next = { ...prev };
  delete next[key];
  if (key in ECONOMICS_FIELDS) {
    for (const [field, message] of Object.entries(next)) {
      if (ECONOMICS_MESSAGES.has(message)) delete next[field];
    }
  }
  return next;
});
```

`validateStep`'s step-2 block becomes:

```ts
if (s === 2) {
  if (form.roomCost < 0) errs.roomCost = 'Room cost cannot be negative';
  if (form.minStudents <= 0) errs.minStudents = 'Min students must be at least 1';
  if (form.maxStudents <= 0) errs.maxStudents = 'Max students must be at least 1';
  else if (form.maxStudents > roomCapacity)
    errs.maxStudents = `Cannot exceed room capacity (${roomCapacity})`;
  // The shared cross-field rules (#221), each on the field it names. A
  // single-field message already on that field wins, and so does the first
  // rule to claim it.
  for (const v of economicsViolations(form)) {
    errs[v.path] ??= ECONOMICS_COPY[v.rule];
  }
}
```

Min students input `onChange`:
`onChange={(e) => updateField('minStudents', Number(e.target.value))}`.

Max students input `onChange`:
`onChange={(e) => updateField('maxStudents', Number(e.target.value))}`.
The old inline `setForm` and `setErrors` block goes.

Leave `handleRoomChange` exactly as it is (spec §2: a room pick is a prefill). Check
whether any existing comment in `page.tsx` describes the removed clamps or
`'Max must be >= min students'`. The comment near `:658` mentions `validateStep`; read
it, and correct any sentence the change falsifies.

- [ ] **Step 4: Run to green**

Run: `pnpm exec vitest run --project components 'src/app/(teacher)/class/new/page.test.tsx'`
Expected: every test passes, including the unedited thirteen-fields test.

- [ ] **Step 5: Mutation-prove each pin**

One at a time, then restore. Record the failing test for each:
1. delete the `roomCost < 0` line
2. `<= 0` → `< 0` on `minStudents`
3. `<= 0` → `< 0` on `maxStudents`
4. delete the capacity `else if` branch
5. `> roomCapacity` → `>= roomCapacity` (boundary)
6. delete the `economicsViolations` loop
7. `??=` → `=` (single-field-wins)
8. swap two values of `ECONOMICS_COPY` (`rate_order` ↔ `room_subsidy`)
9. restore the drag: the Max students `onChange` also sets
   `minStudents: Math.min(prev.minStudents, max)` through `setForm`
10. restore the capacity clamp: `Number(e.target.value)` →
    `Math.min(Number(e.target.value), roomCapacity)` on Max students
11. delete the `if (key in ECONOMICS_FIELDS)` block in `updateField`
12. remove `targetRate` from `ECONOMICS_FIELDS`. This should be a type error from
    `satisfies`; record the `tsc` message (`pnpm exec tsc --noEmit -p .`), not a test
    result.

13. `if (ECONOMICS_MESSAGES.has(message))` → `if (true)`. This clears every message on
    an economics edit, and the single-field-kept test must go red.

Finish with `git status` clean except the intended edits.

- [ ] **Step 6: Typecheck and lint the file**

Run: `pnpm exec tsc --noEmit -p .` and `pnpm exec eslint 'src/app/(teacher)/class/new/page.tsx' 'src/app/(teacher)/class/new/page.test.tsx'`

- [ ] **Step 7: Commit**

```bash
git add 'src/app/(teacher)/class/new/page.tsx' 'src/app/(teacher)/class/new/page.test.tsx'
git commit -m "fix(class-wizard): validate step 2 instead of rewriting input, with the shared economics rules (#318)"
```

---

### Task 3: The recurring-template form stops dragging Min students

**Files:**
- Modify: `src/components/settings/template-form.tsx` (the Max students `onChange`, near `:650-660`)
- Test: `src/components/settings/template-form.test.tsx`

**Interfaces:**
- Consumes: the test file's existing `stubFetch`, `initial` (min 4, max 12, a
  30-capacity room), `fetchMock`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test** (next to the existing
  `'rejects min students exceeding max students before any request is sent'`)

```tsx
/** #318. Select-all in Max students and type 20: the first keystroke is 2, which must not lower Min students. */
it('does not drag min students down while max students is being typed', async () => {
  stubFetch();
  render(<TemplateForm mode="edit" templateId="tpl-1" initial={initial} />);
  const max = await screen.findByLabelText('Max students');
  fireEvent.change(max, { target: { value: '2' } });
  fireEvent.change(max, { target: { value: '20' } });

  expect(screen.getByLabelText('Min students')).toHaveValue(4);
  expect(max).toHaveValue(20);
});

it('refuses a max typed below min students on submit, instead of lowering min', async () => {
  stubFetch();
  render(<TemplateForm mode="edit" templateId="tpl-1" initial={initial} />);
  fireEvent.change(await screen.findByLabelText('Max students'), { target: { value: '2' } });
  const button = screen.getByRole('button', { name: /save|create/i });
  const callsBefore = fetchMock.mock.calls.length;
  fireEvent.click(button);

  expect(screen.getByLabelText('Min students')).toHaveValue(4);
  expect(screen.getByRole('alert')).toHaveTextContent(/^Min students cannot exceed max students$/);
  expect(fetchMock.mock.calls.length).toBe(callsBefore);
});
```

Match the `render` call's props to the file's existing edit-mode tests if they differ.

- [ ] **Step 2: Run, expect both to FAIL** (min reads 2)

Run: `pnpm exec vitest run --project components src/components/settings/template-form.test.tsx`

- [ ] **Step 3: Implement.** In the Max students `onChange`, drop the
  `minStudents: Math.min(prev.minStudents, max),` line. Keep the capacity clamp
  `Math.min(Number(e.target.value), roomCapacity)` and everything else in the handler.
  Also leave `handleRoomChange`'s clamps (`:246-254`) and the Min students clamp alone.

- [ ] **Step 4: Run to green** (whole file, including the existing `students_order` and
  #590 equal-bounds tests)

- [ ] **Step 5: Mutation-prove.** Re-add the removed line and confirm both new tests go
  red. Record the text, restore, re-run green, then check `git status`.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/template-form.tsx src/components/settings/template-form.test.tsx
git commit -m "fix(template-form): stop max students dragging min students down (#318)"
```
