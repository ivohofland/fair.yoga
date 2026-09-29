# Class-family start-time guard (#700) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The class-template form and the class edit form refuse a cleared text/date/time field before any request, in the class family's product copy, instead of letting `parseBody` (`src/lib/api-utils.ts`) print `startTime: Must be HH:mm (00:00-23:59)` and its siblings.

**Architecture:** One client-side guard per field in each form's submit handler, in field order, same shape as the guards already beside it. No new helpers.

**Tech Stack:** Next.js 16 client components, Vitest + Testing Library (`components` project).

**Spec:** none — one subsystem, one obvious approach (solve-issue spec gate: not difficult). The issue is the requirement: https://github.com/ivohofland/fair.yoga/issues/700. The studio twin is #699 (`docs/superpowers/plans/2026-09-29-studio-start-time-guard.md`).

## Premise check (measured on `origin/main` at `f0145cd1`)

- `rg -n 'type="time"' src/` lists six inputs. Four are guarded: the class wizard (`class/new/page.tsx` `validateStep`, `'Enter a start time'`), and the three studio forms (#699, `'Pick a start time.'`). That leaves the two the issue names. **Holds.**
- `template-form.tsx` `handleSubmit` guards room, class type, economics — not `startTime`. **Holds.** It serves `mode="create"` (POST `/api/class-templates`) and `mode="edit"` (PUT `/api/class-templates/[id]`); both schemas use `timeHHmm`.
- `class-edit-form.tsx` `handleSave` guards only economics (and only while unlocked). **Holds** for `startTime` — and **the issue is incomplete**: the same form sends a cleared `classType` (`z.string().trim().min(1).optional()`) and a cleared `date` (`isoDate.optional()`) the same way, with the key present as `''`, so `.optional()` does not help either. Both reach the screen as `path: zod message`. Folded in: same mechanism, same form, same one-line guard.
- The raw copy is slightly worse than the issue quotes: `parseBody` prefixes the path, so the screen reads `startTime: Must be HH:mm (00:00-23:59)`.
- **Out of scope, filed separately:** the number inputs in both forms (`Duration`, and the five economics) store `Number(e.target.value)`, so a cleared field becomes `0` and React renders it back as `0` (measured in jsdom: clearing Duration leaves the input reading `"0"`) — a different mechanism (value coercion, not an empty string). The teacher sees the zero, so nothing saves unseen; the defect is that a zero `durationMinutes`, `minStudents` or `maxStudents` (`positive()`) answers raw Zod copy, where the class wizard already guards all three. Filed as #702.

## Global Constraints

- Copy (decided autonomously at the brainstorming gate — the user asked for a run without interaction):
  - start time: `Enter a start time` in both forms — the wizard's string, as the issue directs.
  - date (edit form): `Select a date` — the wizard's string.
  - class type (edit form): `Class type is required` — `template-form.tsx`'s string, the class family's other settings-side form, rather than the wizard's `Enter a class type`. Within-family class-type copy is already split two ways; this adds no third.
  - Unpunctuated, like both forms' neighbours (`ECONOMICS_COPY`, `'Select a room'`).
- Guard conditions: `!form.startTime`, `!form.date`, `!form.classType.trim()`. A `type="time"`/`type="date"` input reports `''` when cleared or partly filled and otherwise a valid value; no regex duplicate of the schema.
- `class-edit-form.tsx`: the new guards run **before** the economics check and **regardless of `settingsLocked`** — details are always editable and always sent.
- Tests assert the copy as `getByRole('alert')` with an anchored full-string match (`/^…$/`, the #317 shape) **and** that no request left. `template-form.tsx` fetches `/api/teacher-rooms` on mount, so use the file's `callsBeforeSubmit` delta shape there; `class-edit-form.tsx` makes no mount fetch, so `expect(fetchMock).not.toHaveBeenCalled()` works.
- Every guard is proven by mutation: remove it, run, record the exact failing assertion text, restore, re-run green, `git status` shows only intended files before committing.
- Test runs: `pnpm exec vitest run --project components <file>`.

---

### Task 1: Guard start time in the class-template form (create and edit)

**Files:**
- Modify: `src/components/settings/template-form.tsx` (`handleSubmit`, after the class-type guard, before economics)
- Test: `src/components/settings/template-form.test.tsx` (beside the #317 class-type test)

- [ ] **Step 1: Write the failing test** — parameterised over both modes. In create mode, pick the room (`11111111-…`, from `stubFetch()`) and fill class type so start time is the only field missing; in edit mode render `<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />` (the file's `initial`), wait for the Room field, and clear only start time. Then: record `callsBeforeSubmit`, click the submit button (`/save|create/i`), assert the call count unchanged and `getByRole('alert')` has text `/^Enter a start time$/`.
- [ ] **Step 2: Run, expect FAIL** in both cases.
- [ ] **Step 3: Implement** — after the class-type guard: `if (!form.startTime) { setError('Enter a start time'); return; }`
- [ ] **Step 4: Run the file, expect PASS.**
- [ ] **Step 5: Mutation** — delete the guard, record the failure for **both** parameterised cases, restore, re-run green.
- [ ] **Step 6: Commit** `fix(class): refuse a cleared start time in the template form (#700)`.

### Task 2: Guard class type, date and start time in the class edit form

**Files:**
- Modify: `src/components/class/class-edit-form.tsx` (`handleSave`, first thing, before the economics check; in field order class type → date → start time)
- Test: `src/components/class/class-edit-form.test.tsx` (beside the economics refusal tests)

- [ ] **Step 1: Write the failing tests** — one per field, parameterised is fine: render `<ClassEditForm classId="cls-1" settingsLocked={false} initial={initial} />` with `fetch` stubbed, clear the one field (`Class type` to `'   '` for the trim, `Date` to `''`, `Start time` to `''`), click Save, assert `fetchMock` not called and `getByRole('alert')` matches the anchored copy. Add one case with `settingsLocked={true}` clearing start time, to pin that the guard does not sit inside the unlocked branch.
- [ ] **Step 2: Run, expect FAIL** for every case.
- [ ] **Step 3: Implement** the three guards at the top of `handleSave`, before the `if (!settingsLocked)` economics block, and extend the comment above them in this file's register (what they guard and why: a cleared input reaches the route as `''`, which `.optional()` does not skip).
- [ ] **Step 4: Run the file, expect PASS.**
- [ ] **Step 5: Mutation** — delete each guard in turn, record the exact failure for each (and for the locked case when start time's guard is moved inside the unlocked branch), restore, re-run green.
- [ ] **Step 6: Commit** `fix(class): refuse cleared details in the class edit form (#700)`.

## Order

Independent; any order. Run `pnpm exec vitest run --project components` over both files at the end, then `pnpm run verify`.
