# Default VAT % Implementation Plan (#833)

> Written before implementation; the code is authoritative where they differ.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher can store a default VAT percentage in Settings → Profile, next to currency, that #819 will later use to pre-fill each new class and class template.

**Architecture:** One new column, `Teacher.defaultVatPercent` (`Decimal(6,3)`, default 0), bounded 0–100 by a hand-authored CHECK. It is written through the existing `PUT /api/teachers/[id]` (`updateTeacherSchema` → `updateTeacherProfile`), shown and edited in `ProfileForm`, and included in the teacher's GDPR data export. One pure validator (`vatPercentViolation`, `src/lib/vat.ts`) owns the rule and its copy, used by both the zod schema and the form. Nothing else reads the column yet; that's #819.

**Tech Stack:** Next.js 16 App Router, Prisma + PostgreSQL, zod, vitest (projects `unit`, `components`, `integration`), React Testing Library.

**Spec:** none. A single-subsystem change with one obvious design. Issue #833 and its parent #819 (plus the decisions comment on #819) are the source.

## Premise check (measured, 2026-10-11)

- #833 says the field is "saved through the same profile route that saves currency (`/api/account/teacher-profile`)". **Wrong:** that route is the signup *create* (`teacherProfileSchema`, POST only). Currency is saved by `PUT /api/teachers/[id]` (`src/app/api/teachers/[id]/route.ts`) with `updateTeacherSchema`, from `src/components/settings/profile-form.tsx`. This plan uses the PUT. The create route needs nothing: the column default covers new teachers.
- Every money and ratio column in `prisma/schema.prisma` is `Decimal` (`@db.Decimal(10, 2)` for money, `Decimal(5, 4)` for `tierRatio`), so a percentage is `Decimal` too. `Decimal(6,3)` holds 14.975 and anything up to 999.999. The CHECK narrows that to 0–100.
- Postgres `numeric(6,3)` **silently rounds** extra decimals (8.1234 → 8.123). So the 3-decimal rule must be refused at the wire, not left to the column.

## Global Constraints

- Node 24 (`.nvmrc`). Prefix shell commands with `export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH`.
- Worktree: `/Users/ivohofland/Projects/fair.yoga-833`. Its app runs on port 3136 (`pnpm run worktree:up`); integration tests read `INTEGRATION_BASE_URL` automatically. Never touch `:3000`.
- Column name `defaultVatPercent`; wire key `defaultVatPercent`; a JSON **number** on the wire. 9 means 9%.
- Range 0 to 100 inclusive, at most 3 decimal places, default 0.
- Copy, verbatim:
  - Label: `Default VAT %`
  - Hint: `It's your responsibility to set the right VAT rate. You can change it on each class. This is only the default for new classes. Use 0 if you don't charge VAT.`
  - Errors: `VAT can't be negative.` / `Keep VAT to 100% or less.` / `Use at most 3 decimals for VAT.`
- Migrations via `pnpm exec prisma migrate dev --name <name> --create-only`, then hand-append the CHECK, then `pnpm exec prisma migrate dev`. Never edit an applied migration.
- Comment discipline (CLAUDE.md): no counts or rosters in comments; comments describe their own code.
- Stage exact paths; quote paths containing parentheses.

## Review Focus

1. **A body of `"9"` (string) instead of `9`.** Expected: 400, nothing written. Pinned in Task 2's integration test.
2. **14.975 round-trips exactly.** Expected: the stored value reads back `14.975` and the form shows `14.975`, not `14.975000000000001` or `14.98`. Pinned in Task 2 (integration reads the column; component renders the initial value).
3. **8.1234 (four decimals).** Expected: refused with the decimals message at the wire, never silently rounded by `numeric(6,3)`. Pinned in Task 1 (unit) and Task 2 (integration 400).
4. **A teacher who never touches the field.** Expected: 0, both for existing rows after the migration and for a new signup. Pinned in Task 1 (row created without the field reads 0).
5. **The field cleared and saved.** `Number('')` is 0 (the same convention `class-edit-form.tsx` documents for #702). Expected: saves 0, no error. Pinned in Task 2's component test.

---

### Task 1: Column, CHECK constraint, validator, data export, data-model doc

Order matters: this task must land before Task 2, and must **not** touch `updateTeacherSchema`. `profile-form.tsx` pins the schema's keys against `ProfileFormValues` in both directions (`_formCoversSchema`, `_formHasNoExtras`), so adding the wire key without the form field breaks typecheck. Task 2 adds both together.

**Files:**
- Modify: `prisma/schema.prisma` (model `Teacher`, after `currency`)
- Create: `prisma/migrations/<timestamp>_teacher_default_vat_percent/migration.sql` (generated, then the CHECK appended)
- Create: `src/lib/vat.ts`
- Create: `src/lib/vat.test.ts` (unit project)
- Modify: `src/services/gdpr.ts` (teacher export `profile`, after `currency`)
- Modify: `src/services/gdpr.test.ts` (the teacher export assertion)
- Modify: `tests/integration/teachers-api.test.ts` (new `describe` for the CHECK)
- Modify: `docs/data-model.md` (`### Teacher (core)` table, a row after `currency`)

**Interfaces:**
- Produces: `Teacher.defaultVatPercent: Prisma.Decimal` (not null, default 0).
- Produces: `src/lib/vat.ts`:
  ```ts
  export const VAT_PERCENT_MAX = 100;
  export const VAT_PERCENT_DECIMALS = 3;
  /** The copy for why `value` is not a VAT percentage, or null when it is one. */
  export function vatPercentViolation(value: number): string | null;
  ```

- [ ] **Step 1: Write the failing validator test** (`src/lib/vat.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { vatPercentViolation } from './vat';

describe('vatPercentViolation', () => {
  it.each([0, 9, 21, 8.1, 14.975, 100])('accepts %s', (v) => {
    expect(vatPercentViolation(v)).toBeNull();
  });
  it('refuses a negative rate', () => {
    expect(vatPercentViolation(-0.001)).toBe("VAT can't be negative.");
  });
  it('refuses more than 100', () => {
    expect(vatPercentViolation(100.001)).toBe('Keep VAT to 100% or less.');
  });
  it('refuses four decimals rather than letting the column round them', () => {
    expect(vatPercentViolation(8.1234)).toBe('Use at most 3 decimals for VAT.');
  });
  it('refuses a non-finite number', () => {
    expect(vatPercentViolation(Number.NaN)).toBe('Use at most 3 decimals for VAT.');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (module not found)

Run: `pnpm exec vitest run --project unit src/lib/vat.test.ts`

- [ ] **Step 3: Implement `src/lib/vat.ts`**

```ts
export const VAT_PERCENT_MAX = 100;
export const VAT_PERCENT_DECIMALS = 3;

const SCALE = 10 ** VAT_PERCENT_DECIMALS;

/**
 * The copy for why `value` is not a VAT percentage, or null when it is one.
 * The decimals rule is checked here because `numeric(6,3)` would round a
 * fourth decimal silently instead of refusing it.
 */
export function vatPercentViolation(value: number): string | null {
  if (value < 0) return "VAT can't be negative.";
  if (value > VAT_PERCENT_MAX) return `Keep VAT to ${VAT_PERCENT_MAX}% or less.`;
  const scaled = value * SCALE;
  // Tolerance absorbs binary representation: 1.001 * 1000 is 1000.9999999999999.
  if (!Number.isFinite(scaled) || Math.abs(scaled - Math.round(scaled)) > 1e-9) {
    return `Use at most ${VAT_PERCENT_DECIMALS} decimals for VAT.`;
  }
  return null;
}
```

- [ ] **Step 4: Run it, expect PASS.** Prove the guard bites: change `> 1e-6` to `> 0.5`, rerun, record that the 8.1234 case fails, restore, rerun green.

- [ ] **Step 5: Add the column** (`prisma/schema.prisma`, in `model Teacher` directly after `currency`)

```prisma
  defaultVatPercent     Decimal                     @default(0) @db.Decimal(6, 3)
```

- [ ] **Step 6: Generate the migration without applying it, then append the CHECK**

Run: `pnpm exec prisma migrate dev --name teacher_default_vat_percent --create-only`

Append to the generated `migration.sql`:

```sql
-- Hand-authored: Prisma cannot express a CHECK. The wire refuses the same
-- range with copy (`vatPercentViolation`); this holds it for every writer.
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_default_vat_percent_range_check"
  CHECK ("defaultVatPercent" >= 0 AND "defaultVatPercent" <= 100);
```

Then apply: `pnpm exec prisma migrate dev` (it applies the pending migration and regenerates the client).

- [ ] **Step 7: Write the failing integration tests for the default and the CHECK** (`tests/integration/teachers-api.test.ts`, a new top-level `describe`, following the `TeacherBankAccount_scheme_check` block's `isCheckViolationOn` pattern and the file's teacher-creation fixture)

```ts
describe('Teacher.defaultVatPercent (#833)', () => {
  let vatTeacherId: string;

  beforeAll(async () => {
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Vat',
        lastName: 'Teacher',
        email: `vat-teacher-${suffix}@test.local`,
        account: { create: { email: `vat-teacher-${suffix}@test.local` } },
        bio: 'VAT default tests',
        pageSlug: `vat-teacher-${suffix}`,
      },
    });
    vatTeacherId = t.id;
  });

  afterAll(async () => {
    await prisma.teacher.delete({ where: { id: vatTeacherId } });
  });

  it('is 0 for a teacher created without it', async () => {
    const t = await prisma.teacher.findUniqueOrThrow({ where: { id: vatTeacherId } });
    expect(t.defaultVatPercent.toString()).toBe('0');
  });

  it.each([-0.001, 100.001])('refuses %s at the database', async (value) => {
    const err = await prisma.teacher
      .update({ where: { id: vatTeacherId }, data: { defaultVatPercent: value } })
      .then(() => null, (e: unknown) => e);
    expect(isCheckViolationOn(err, 'Teacher_default_vat_percent_range_check')).toBe(true);
  });
});
```

If the file's existing `afterAll` cleanup needs the account removed too, match how it cleans up its own fixtures instead of the `delete` above.

- [ ] **Step 8: Run, see PASS** (column and CHECK exist now). Then prove the CHECK bites: `docker exec fairyoga-db-1 psql -U <user> -d ethical_yoga_test_fair_yoga_833 -c 'ALTER TABLE "Teacher" DROP CONSTRAINT "Teacher_default_vat_percent_range_check"'`, rerun, record the failing assertion, re-add the constraint with the SQL from Step 6, rerun green. (Read the DB user from the worktree `.env`.)

Run: `pnpm run worktree:up` once, then `pnpm exec vitest run --project integration tests/integration/teachers-api.test.ts`

- [ ] **Step 9: Export it.** In `src/services/gdpr.ts`, teacher export `profile`, add after `currency: teacher.currency,`:

```ts
      defaultVatPercent: teacher.defaultVatPercent.toNumber(),
```

Update `src/services/gdpr.test.ts`: wherever the teacher fixture or `profile` expectation spells `currency`, add `defaultVatPercent` (fixture `new Prisma.Decimal(9)`, expectation `9`). Run `pnpm exec vitest run src/services/gdpr.test.ts`; fix whichever project config it lives under.

- [ ] **Step 10: Document it** (`docs/data-model.md`, `### Teacher (core)` table, a row directly after `currency`)

```markdown
| defaultVatPercent | decimal(6,3), default 0 | The VAT percentage the teacher usually charges (9 means 9%), 0 to 100 with at most 3 decimals: `vatPercentViolation` (`src/lib/vat.ts`) on the wire, `Teacher_default_vat_percent_range_check` in the database. Saved by `PUT /api/teachers/[id]`. Meant to pre-fill the VAT % of each new class and class template (#819); changing it never touches an existing one. |
```

- [ ] **Step 11: Typecheck and commit**

Run: `pnpm exec tsc --noEmit` (expect clean), then:

```bash
git add prisma/schema.prisma prisma/migrations/*_teacher_default_vat_percent src/lib/vat.ts src/lib/vat.test.ts src/services/gdpr.ts src/services/gdpr.test.ts tests/integration/teachers-api.test.ts docs/data-model.md
git commit -m "feat: teachers hold a default VAT percent, bounded 0–100 (#833)"
```

---

### Task 2: Wire field and the Settings → Profile input

**Files:**
- Modify: `src/lib/schemas.ts` (`updateTeacherSchema`)
- Modify: `src/lib/schemas.test.ts` (a `describe('updateTeacherSchema.defaultVatPercent')` next to the `defaultTimezone` one)
- Modify: `src/components/settings/profile-form.tsx`
- Modify: `src/components/settings/profile-form.test.tsx`
- Modify: `src/app/(teacher)/settings/profile/page.tsx`
- Modify: `src/app/(teacher)/settings/profile/page.test.tsx`
- Modify: `tests/integration/teachers-api.test.ts` (the Task 1 `describe`)

**Interfaces:**
- Consumes: `vatPercentViolation` from `@/lib/vat`; `Teacher.defaultVatPercent: Prisma.Decimal`.
- Produces: wire key `defaultVatPercent?: number` on `updateTeacherSchema`; `ProfileFormValues.defaultVatPercent: number`.

- [ ] **Step 1: Failing schema tests** (`src/lib/schemas.test.ts`)

```ts
describe('updateTeacherSchema.defaultVatPercent (#833)', () => {
  it.each([0, 9, 14.975, 100])('accepts %s', (v) => {
    expect(updateTeacherSchema.safeParse({ defaultVatPercent: v }).success).toBe(true);
  });
  it.each([
    [-1, "VAT can't be negative."],
    [101, 'Keep VAT to 100% or less.'],
    [8.1234, 'Use at most 3 decimals for VAT.'],
  ])('refuses %s with its copy', (v, message) => {
    const r = updateTeacherSchema.safeParse({ defaultVatPercent: v });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(message);
  });
  it('refuses a string', () => {
    expect(updateTeacherSchema.safeParse({ defaultVatPercent: '9' }).success).toBe(false);
  });
});
```

Run `pnpm exec vitest run src/lib/schemas.test.ts`, expect FAIL (`.strict()` rejects the unknown key, so the accept cases fail).

- [ ] **Step 2: Add the wire field** (`updateTeacherSchema`, after `currency`)

```ts
  defaultVatPercent: z.number().superRefine((v, ctx) => {
    const message = vatPercentViolation(v);
    if (message) ctx.addIssue({ code: 'custom', message });
  }).optional(),
```

with `import { vatPercentViolation } from '@/lib/vat';`. Typecheck now fails on `_formCoversSchema` in `profile-form.tsx`, as expected: Step 4 fixes it.

- [ ] **Step 3: Failing component tests** (`profile-form.test.tsx`). Add `defaultVatPercent: 0` to the shared `initial` fixture, then:

```ts
describe('default VAT % (#833)', () => {
  it('shows the stored rate and the responsibility hint', () => {
    renderForm({ ...initial, defaultVatPercent: 14.975 });
    expect(screen.getByLabelText('Default VAT %')).toHaveValue(14.975);
    expect(
      screen.getByText("It's your responsibility to set the right VAT rate. You can change it on each class. This is only the default for new classes. Use 0 if you don't charge VAT."),
    ).toBeInTheDocument();
  });

  it('sends the rate as a number', async () => {
    // ok response, as the existing 'PUTs the profile' test stubs it
    renderForm(initial);
    fireEvent.change(screen.getByLabelText('Default VAT %'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // await the fetch as the file's other tests do
    expect(sentBody().defaultVatPercent).toBe(9);
  });

  it('sends 0 when the field is cleared', async () => {
    renderForm({ ...initial, defaultVatPercent: 21 });
    fireEvent.change(screen.getByLabelText('Default VAT %'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sentBody().defaultVatPercent).toBe(0);
  });

  it('refuses four decimals before sending', async () => {
    renderForm(initial);
    fireEvent.change(screen.getByLabelText('Default VAT %'), { target: { value: '8.1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at most 3 decimals for VAT.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

Reuse the file's own `renderForm`, `sentBody` and fetch-stub helpers. If `sentBody` lives inside the currency `describe`, lift it to the outer `describe`. Adapt the async waits to match the file. Run `pnpm exec vitest run --project components src/components/settings/profile-form.test.tsx`, expect FAIL.

- [ ] **Step 4: Implement the form field** (`profile-form.tsx`)

- `ProfileFormValues` gains `defaultVatPercent: number;`.
- `handleSubmit`: after the page-slug check, add
  ```ts
  const vatMessage = vatPercentViolation(form.defaultVatPercent);
  if (vatMessage) {
    setError(vatMessage);
    return;
  }
  ```
- `payload` gains `defaultVatPercent: form.defaultVatPercent,` (typed by `ProfileFormWire`, so the excess-property check covers it).
- In the Preferences section, directly after the Currency `Select`:
  ```tsx
  <Input
    id="defaultVatPercent"
    label="Default VAT %"
    type="number"
    inputMode="decimal"
    min={0}
    max={VAT_PERCENT_MAX}
    step="any"
    value={String(form.defaultVatPercent)}
    onChange={(e) => update('defaultVatPercent', Number(e.target.value))}
    hint="It's your responsibility to set the right VAT rate. You can change it on each class. This is only the default for new classes. Use 0 if you don't charge VAT."
  />
  ```
  `step="any"`, not `0.001`: the browser's own step validation would block the submit before `vatPercentViolation` could show its copy. Imports: `vatPercentViolation, VAT_PERCENT_MAX` from `@/lib/vat`.

- [ ] **Step 5: Pass the stored value from the page** (`settings/profile/page.tsx`, `initial`)

```ts
          defaultVatPercent: teacher.defaultVatPercent.toNumber(),
```

Update `page.test.tsx`'s teacher fixtures (the objects that spell `currency: 'GBP', defaultTimezone: ...`) with `defaultVatPercent: new Prisma.Decimal(9)`, and assert the form receives `9` the way that test already asserts `currency`.

- [ ] **Step 6: Run the component and page tests, expect PASS.** Prove the client guard bites: delete the `vatMessage` early-return, rerun, record that "refuses four decimals before sending" fails (fetch called), restore, rerun green.

- [ ] **Step 7: Integration: the PUT writes it** (extend the Task 1 `describe` in `teachers-api.test.ts`; it needs a session for `vatTeacherId` via `seedSession`, as the file's main fixture does)

```ts
  it('saves 14.975 exactly through PUT', async () => {
    const res = await putTeacher(vatTeacherId, { defaultVatPercent: 14.975 }, vatToken);
    expect(res.status).toBe(200);
    const t = await prisma.teacher.findUniqueOrThrow({ where: { id: vatTeacherId } });
    expect(t.defaultVatPercent.toString()).toBe('14.975');
  });

  it.each([[8.1234], [-1], [101], ['9']])('answers 400 for %s and writes nothing', async (value) => {
    await prisma.teacher.update({ where: { id: vatTeacherId }, data: { defaultVatPercent: 21 } });
    const res = await putTeacher(vatTeacherId, { defaultVatPercent: value }, vatToken);
    expect(res.status).toBe(400);
    const t = await prisma.teacher.findUniqueOrThrow({ where: { id: vatTeacherId } });
    expect(t.defaultVatPercent.toString()).toBe('21');
  });
```

Run against the worktree app: `pnpm exec vitest run --project integration tests/integration/teachers-api.test.ts`. Warm the route first (`curl -s -o /dev/null http://localhost:3136/api/teachers/x`) so first-compile latency doesn't read as a failure.

- [ ] **Step 8: Full verify and commit**

Run: `pnpm run verify` (worktree app up). Expect typecheck, lint and every vitest project green. Then:

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts src/components/settings/profile-form.tsx src/components/settings/profile-form.test.tsx "src/app/(teacher)/settings/profile/page.tsx" "src/app/(teacher)/settings/profile/page.test.tsx" tests/integration/teachers-api.test.ts
git commit -m "feat: Settings → Profile edits the default VAT percent (#833)"
```
