# classType Copy Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One refusal string across the four studio-family classType sites —
`Class type is required.` — by adding a period to the three banner sites and
updating the four assertions that pin the old literal.

**Tech Stack:** Next.js App Router, TypeScript `strict`, vitest (`components`
project only — no schema, service, API, or migration change).

**Spec:** `docs/superpowers/specs/2026-08-24-class-type-copy-unification-design.md`

---

## Global Constraints

- **Stage exact paths; never `git add -A` / `git add .`.** Two of the touched
  paths contain parentheses — quote them: `"src/app/(teacher)/studio-class/new/page.tsx"`.
- **Commit per task.** The PR is rebase-merged, never squashed.
- **Never start or restart the dev server on :3000.** The user runs it. Component
  tests do not touch it; only the final `npm run verify` needs it live (the
  `integration` project speaks HTTP to it).
- **Test-first where a pin exists.** Tasks 1–2 edit the assertions *first*, observe
  red against the current source, then flip the source. Task 3 has no copy pin —
  its honest verification is the tether plus the suite, stated as such rather than
  dressed up as red/green.
- **Scope freeze:** three source literals + four assertions. No new pins, no
  mechanism work, no wizard change, no server-side Zod change (spec §5).
- **Warm-route rule:** not applicable to the component runs (jsdom, no server);
  applies to the final verify only if a route were touched — none is.

## Measured baseline (2026-08-24, on `main` at `0a33e71`)

| Project | Files | Tests |
|---|---|---|
| `unit` | 68 | 1068 |
| `components` | 45 | 294 |
| `integration` | 33 | 513 |
| **Total** | **146** | **1875** |

`68 + 45 + 33 = 146`. `1068 + 294 + 513 = 1875`. All passing, measured by running
each project separately this session (aggregate run agrees: 146 / 1875).

**Prediction: unchanged after this branch** — it edits string literals inside
existing assertions; it creates no test file and no test case. Re-measure at
execution time anyway; do not trust the prediction (#212's was off by two).

---

## Task 1 — `studio-template-form`: assertions first, then source, then the bite-proof

The demonstration mutation from spec §4 lives here; tasks 2 shares its assertion
shape and gets none.

- [ ] Edit both assertions in `src/components/settings/studio-template-form.test.tsx`
      (`:147` and `:153`) from `'Class type is required'` to `'Class type is required.'`.
- [ ] Run `npx vitest run --project components src/components/settings/studio-template-form.test.tsx`.
      **Expected red:** exactly two failures, both `Unable to find … "Class type is required."`
      (the rendered banner still lacks the period); `fetchMock` uncalled throughout.
      Record the exact failure text in the commit message body? No — record it in the
      task report; the commit message carries what is true now.
- [ ] Flip `src/components/settings/studio-template-form.tsx:102` to
      `'Class type is required.'`. Re-run the file. Expected green (11 tests).
- [ ] **Bite-proof:** revert `:102` to `'Class type is required'` (drop the period),
      re-run. Expected red again on the same two copy assertions while the fetch-count
      assertion stays satisfied — proving the pin tracks copy drift, not guard breakage.
      Restore the period, re-run green.
- [ ] Commit, staging exactly:
      `src/components/settings/studio-template-form.tsx` and
      `src/components/settings/studio-template-form.test.tsx`.
      Message: `copy+test: punctuate the classType refusal banner in studio-template-form (#309)`

## Task 2 — `studio-class/new` page: same shape

- [ ] Edit both assertions in `"src/app/(teacher)/studio-class/new/page.test.tsx"`
      (`:149` and `:155`) to `'Class type is required.'`.
- [ ] Run `npx vitest run --project components "src/app/(teacher)/studio-class/new/page.test.tsx"`.
      **Expected red:** two failures naming the missing period; `fetch` spy uncalled.
- [ ] Flip `"src/app/(teacher)/studio-class/new/page.tsx:93"` to
      `'Class type is required.'`. Re-run green (6 tests).
- [ ] Commit, staging exactly the two paths above (quote the parentheses):
      `copy+test: punctuate the classType refusal banner on studio-class/new (#309)`

## Task 3 — `template-form`: the unpinned twin

No copy pin exists for this site (`template-form.test.tsx` asserts fetch-counts only,
per its own comment at `:220`) — that gap is recorded in spec §5 and deliberately not
filled here. There is no red step available; say so in the report instead of inventing one.

- [ ] Flip `src/components/settings/template-form.tsx:248` to `'Class type is required.'`.
- [ ] Run `npx vitest run --project components src/components/settings/template-form.test.tsx`.
      Expected green throughout — its pins never read the copy. A red here would mean
      something else drifted; investigate, don't force-push past it.
- [ ] Tether: `rg -n 'Class type is required[^.]' src/` → **zero hits**, and
      `rg -n 'Class type is required' src/` → exactly nine hits (four sources,
      five assertions), every one ending in a period.
- [ ] Commit, staging exactly `src/components/settings/template-form.tsx`:
      `copy: punctuate the classType refusal banner in template-form (#309)`

## Task 4 — branch close-out

- [ ] Re-measure the suite: `npx vitest run` → predict 146 files / 1875 tests;
      record actuals in the PR body with the arithmetic.
- [ ] `npm run verify` (typecheck → lint → all three projects). Needs :3000 live.
      This branch touches zero `tests/integration/` files, but verify runs all 33 of
      them anyway — the PR body must claim the run, not their absence.
- [ ] Push, open PR with `Closes #309`. Body must carry:
      - the before/after census (nine lines, which nine);
      - the visibility argument for B over A in one paragraph (why the period wins);
      - baseline vs after-figure with arithmetic;
      - touched files by path — all component layer;
      - what the branch leaves alone: the wizard's `'Enter a class type'`, both
        mechanisms, server-side Zod copy, and the three pre-existing pin gaps
        (template-form copy pin, wizard pin, edit-form empty-string pin) — recorded
        as observations for fold/file triage, not fixed here;
      - the bite-proof result from Task 1 (mutant observed red, exact behaviour).
