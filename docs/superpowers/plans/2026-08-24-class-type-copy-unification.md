# classType Copy Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One refusal voice across the studio class family — every field refusal a
punctuated sentence — by punctuating the five banner literals in the two studio
banner forms, leaving the studio edit form (already the reference voice) and the
class-family `template-form.tsx` untouched.

**Revised 2026-08-24 after PR #316 review.** The first draft punctuated only the
`classType` line in each of four forms, including the class-family twin. Review
showed that trades cross-form agreement on one string for intra-form mixing in
three previously-uniform forms, on a premise (`the edit form is the only
simultaneous surface`) that two other files falsify. Tasks below are the revised
set; the spec's §1 records what was re-measured.

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
- **Test-first, every literal.** Each string gets its pin written or edited
  first, observed red against the bare source, then the source is flipped. The
  `location` and `date` refusals had no pin at all, so theirs are new tests —
  which is what makes a red step available for them.
- **Scope freeze:** five source literals in two studio banner forms. No mechanism
  work, no wizard change, no CRM change, no class-family change, no server-side
  Zod change (spec §5).
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

**Prediction: 146 files / 1877 tests** — the branch creates no test file, but adds
two test cases (the `location` and `date` pins). Re-measure at execution time
anyway; do not trust the prediction (#212's was off by two).

---

## Task 1 — `studio-template-form`: classType pin, then the location pin it never had

- [ ] Edit the first `classType` assertion in
      `src/components/settings/studio-template-form.test.tsx` to
      `'Class type is required.'`. **Delete the second copy assertion** (after the
      whitespace resubmit) and comment why: `handleSubmit` clears `error` only
      after its guards pass, so the first submit's banner is still mounted and
      that assertion passes on stale state — deleting the intervening click
      leaves the file green. The request-count assertion there stays; it is the
      real pin for the whitespace boundary.
- [ ] Add a new test pinning the `location` refusal — fill `Class type`, submit,
      assert `fetchMock` uncalled and `'Location is required.'` on screen. The
      guards run classType then location, so the first to fire wins.
- [ ] Run `npx vitest run --project components src/components/settings/studio-template-form.test.tsx`.
      **Expected red:** `Unable to find … "Class type is required."` and
      `… "Location is required."`; `fetchMock` uncalled throughout — the red names
      copy drift, not guard breakage.
- [ ] Flip `src/components/settings/studio-template-form.tsx:102,106` to
      `'Class type is required.'` and `'Location is required.'`. Re-run green.
- [ ] **Bite-proof:** revert `:102`, re-run, confirm red on the copy assertion
      while the fetch-count assertion stays satisfied. Restore, re-run green.
- [ ] Commit, staging exactly:
      `src/components/settings/studio-template-form.tsx` and
      `src/components/settings/studio-template-form.test.tsx`.
      Message: `copy+test: punctuate the studio template form's refusals (#309)`

## Task 2 — `studio-class/new` page: same shape, three literals

- [ ] Edit the first `classType` assertion in
      `"src/app/(teacher)/studio-class/new/page.test.tsx"` to take the period, and
      delete the second copy assertion with the same comment as Task 1.
- [ ] Add a new test pinning `location` then `date` in one walk: fill `Class type`,
      submit, assert `'Location is required.'`; fill `Location`, submit, assert
      `'Date is required.'`. Both copy assertions are falsifiable here because the
      two submits raise *different* strings — stale state cannot satisfy them.
- [ ] Run the file. **Expected red** on all three new/edited copy assertions.
- [ ] Flip `"src/app/(teacher)/studio-class/new/page.tsx:93,97,101"`. Re-run green.
- [ ] **Bite-proof the `date` literal specifically** — the `location` assertion
      fails first in the same test, so the `date` pin needs its own mutant: drop
      the period at `:101` alone, re-run, confirm red naming `"Date is required."`.
      Restore.
- [ ] Commit, staging exactly the two paths above (quote the parentheses):
      `copy+test: punctuate the studio-class/new refusals (#309)`

## Task 3 — leave the class family alone

`template-form.tsx` is the recurring-template form of the **class** family. Its
five refusals are uniformly bare and stay that way; the directory it shares with
`studio-template-form.tsx` is a code-reading adjacency, not a screen the teacher
sees. No edit, no commit.

- [ ] Tether: `git diff main -- src/components/settings/template-form.tsx` → empty.
- [ ] Family tether (spec §6 command 1) → zero hits.
- [ ] Copy census: `rg -n 'Class type is required' src/` → 7 lines (three sources,
      four assertions), every one ending in a period.

## Task 4 — branch close-out

- [ ] Re-measure the suite: `npx vitest run` → predict 146 files / 1877 tests;
      record actuals in the PR body with the arithmetic.
- [ ] `npm run verify` (typecheck → lint → all three projects). Needs :3000 live.
      This branch touches zero `tests/integration/` files, but verify runs all 33 of
      them anyway — the PR body must claim the run, not their absence.
- [ ] Update the PR body. It must carry:
      - the before/after census with the commands that re-derive it;
      - why the studio family is punctuated entire rather than one line per form,
        including the falsified premise the first draft used;
      - baseline vs after-figure with arithmetic;
      - touched files by path — all component layer;
      - what the branch leaves alone: `template-form.tsx`, the wizard's
        `'Enter a class type'`, `create-student-form.tsx`, both mechanisms, and
        server-side Zod copy;
      - the bite-proof results (which mutants, observed behaviour).
- [ ] File the follow-ups spec §5 records: `template-form.tsx:248`'s wholly
      unpinned guard, the wizard's ten unpinned `validateStep` messages, and the
      banner-clears-on-edit behaviour change. Close the edit form's empty-`''`
      case as WONTFIX with the reasoning in spec §5.
