# An empty class type gets product copy in both studio forms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both studio forms refuse an empty class type client-side with
"Class type is required" — the copy their class-family twin already uses — before any
request is sent, pinned by component tests proven to bite.

**Architecture:** One guard inserted into each form's `handleSubmit`, ahead of the
existing checks, matching field order (Class type renders first in both). No service,
API, schema or migration work. Coverage lands in the two existing component-test files.

**Tech Stack:** React client components, TypeScript strict, Vitest components project (jsdom).

**Spec:** `docs/superpowers/specs/2026-08-23-studio-class-type-validation-design.md` — read §1 (the measurements, including what the issue missed) and §4 (guard-biting steps) before starting.

**Branch:** `fix/282-studio-class-type-required` (create from current `main` before Task 1).

---

## Global Constraints

- **Never start or restart the dev server on :3000** — it serves this checkout; `npm run verify`'s integration project talks to it over HTTP. Component tests do not need it.
- **Quote paths containing parentheses**: `"src/app/(teacher)/studio-class/new/page.tsx"`.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Never write `close/closes/fixes/resolves #282` in any commit message.** Write "**leaves #282 open until merge**" or nothing. PR-body references are the orchestrator's job.
- **Commit per task**; the PR is rebase-merged.
- TypeScript strict, no `any`. Prettier/ESLint run in `npm run verify`.
- `tests/setup/components.ts` mocks `next/navigation` but **not** `fetch` — stub it per test (`vi.stubGlobal('fetch', …)`) whenever a click could trigger a request.

---

## Baseline (measured 2026-08-23 at merge base `9cf17ec`)

| Project | Files | Tests |
|---|---|---|
| unit | 67 | 1051 |
| components | 44 | 277 |
| integration | 33 | 487 |
| **total** | **144** | **1815** |

Arithmetic reconciles: `67+44+33 = 144`, `1051+277+487 = 1815`.

Predicted after this branch: components 279 (+2), total **1817**, file counts unchanged —
both additions are new `it()` blocks inside existing files. Measure it anyway; do not
trust the prediction.

Touched-file baselines: `studio-template-form.test.tsx` has 15 tests,
`(teacher)/studio-class/new/page.test.tsx` has 5. If either shifts unexpectedly before
your change, stop and report — that is shared-state leakage, not noise.

---

## File structure

| File | Change |
|---|---|
| `src/components/settings/studio-template-form.tsx` | Insert `classType` guard above the location check (~`:101`) |
| `src/app/(teacher)/studio-class/new/page.tsx` | Insert `classType` guard above the location check (~`:92`) |
| `src/components/settings/studio-template-form.test.tsx` | New `it()`: empty class type → banner, fetch never called |
| `"src/app/(teacher)/studio-class/new/page.test.tsx"` | Same |

Nothing else. If an implementer finds itself touching anything else, stop and report.

---

### Task 1: `StudioTemplateForm` (create **and** edit through one `handleSubmit`)

**Files:**
- Modify: `src/components/settings/studio-template-form.test.tsx`
- Modify: `src/components/settings/studio-template-form.tsx`

**Steps:**

- [ ] 1.1 Write the failing test first, mirroring the file's existing render-and-submit
      helpers. Leave `classType` empty, fill `location` (every other field ships a valid
      default: dayOfWeek 0, startTime '09:00', durationMinutes 60, hourlyRate 0), stub
      `fetch` with `vi.fn()`, submit. Assert both halves independently:

      ```tsx
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByText('Class type is required')).toBeInTheDocument();
      ```

      Run the file → **expected RED**: the banner assertion fails (no such element; the
      request goes out instead). Record the exact failure text in the task report.
- [ ] 1.2 Apply the guard in `handleSubmit`, above the location check at ~`:101`
      (field order — Class type renders first):

      ```tsx
      if (!form.classType.trim()) {
        setError('Class type is required');
        return;
      }
      ```

      Re-run → **GREEN, 16 passed**.
- [ ] 1.3 **Guard-biting proof:** comment out only the new `if` block → run → the spy
      assertion must fail (`fetch` called once; unstubbed it would instead surface as
      'Network error…' from the catch arm). Record the exact text. Restore → green.
- [ ] 1.4 Commit: `fix+test: studio template form refuses an empty class type with product copy (#282)`
      Stage exactly: `src/components/settings/studio-template-form.tsx` and
      `src/components/settings/studio-template-form.test.tsx`.

### Task 2: `NewStudioClassPage`

**Files:**
- Modify: `"src/app/(teacher)/studio-class/new/page.test.tsx"`
- Modify: `"src/app/(teacher)/studio-class/new/page.tsx"`

**Steps:**

- [ ] 2.1 Failing test first, same shape as 1.1 adapted to this page: leave `classType`
      empty, fill BOTH `location` and `date` (this form checks those too, and the new
      guard sits ahead of them), stub `fetch` with `vi.fn()`, submit. Assert spy-not-called
      and `'Class type is required'` present. Run → **expected RED** (5 existing + 1 new;
      the new one fails). Record text.
- [ ] 2.2 Apply the guard above the location check at ~`:92`:

      ```tsx
      if (!classType.trim()) {
        setError('Class type is required');
        return;
      }
      ```

      Re-run → **GREEN, 6 passed**.
- [ ] 2.3 Guard-biting proof exactly as 1.3: comment out the new block → spy RED → record → restore → green.
- [ ] 2.4 Commit: `fix+test: studio class log refuses an empty class type with product copy (#282)`
      Stage exactly: `"src/app/(teacher)/studio-class/new/page.tsx"` and its test file.

### Task 3: Whole-suite gate and claim sweep

- [ ] 3.1 `npm run verify` — all three vitest projects + typecheck + lint. Record the
      three per-project counts and show them reconciling for the PR body
      (predicted: `1051 + 279 + 487 = 1817`; measure, don't trust).
- [ ] 3.2 Re-derive the spec §6 claims:
      - `grep -rn "is required'" src/app src/components | grep -v test` → the nine
        client lines now include the two new ones; API state-guards unchanged.
      - `sed -n '445,483p' src/lib/schemas.ts` → untouched.
- [ ] 3.3 Confirm no doc claim went stale: nothing in `docs/` describes the studio forms'
      validation behaviour, so expected clean; report either way.
- [ ] 3.4 Commit anything the sweep corrected (expected: nothing), or report clean.

---

## Stop conditions

An implementer stops and reports rather than improvising when:

1. Any step's expected RED doesn't fail, or expected GREEN doesn't pass — do not raise
   timeouts; report the output.
2. The fix requires touching any file outside the four listed (in particular: any schema,
   API route, or service file means the design is being second-guessed — stop).
3. A touched file's baseline test count differs from the Baseline table before your own
   edit lands.

## Reporting back

Per task: files changed, exact failure text from each guard proof, test count
before/after, commit hash. Final: the reconciled verify arithmetic for the PR body.
