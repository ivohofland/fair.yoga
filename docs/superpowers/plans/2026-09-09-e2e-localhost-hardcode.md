# Plan: stop e2e specs from hardcoding `http://localhost:3000`

Issue #541. Premise verified 2026-09-09 against `origin/main` at `0e52c836`:
`grep -rn "localhost:3000" tests/e2e/` returns exactly the 5 lines the issue
names, in exactly the 4 files it names. Reproduced RED in a fresh worktree
(dev server on port 3100, `INTEGRATION_BASE_URL=http://localhost:3100`):
`npx playwright test tests/e2e/{studio,student-journey,teacher-journey,recurring}.spec.ts`
fails at all 4 files — `studio.spec.ts:517`'s `page.url()` assertion compares
against the literal and loses; `teacher-journey.spec.ts:290`'s raw `fetch()`
reached port 3000 (a different server entirely — in this run, the main
checkout's dev server) and got 401 rather than a connection error, which is
the "writes land somewhere real" risk the issue describes, observed rather
than triggered (this particular call 401'd instead of writing, because no
session for this worktree's DB exists on that other server).

No spec needed: one subsystem (e2e test fixtures), one reasonable design, no
data model or runtime behavior change. `tests/helpers.ts`'s `BASE_URL`
already exists and its own docblock says it's meant for exactly this
("usable from Playwright specs as-is, not just vitest's integration suite")
— none of the 5 sites currently import it.

## Task 1 — replace the 5 literals, add a regression guard

**Files:**
- `tests/e2e/studio.spec.ts` (2 sites: line 517 `page.url()` comparison,
  line 569 `page.waitForURL(...)`)
- `tests/e2e/student-journey.spec.ts` (1 site: line 33, `bookViaApi`'s raw
  `fetch()`)
- `tests/e2e/teacher-journey.spec.ts` (1 site: line 282, raw `fetch()`)
- `tests/e2e/recurring.spec.ts` (1 site: line 165, the cron `fire()` helper's
  raw `fetch()`)
- `eslint.config.mjs`

**Change:**
1. In each of the 4 spec files, import `BASE_URL` from `../helpers`
   (alongside the existing `uniqueSuffix`/`seedSession`/`sessionCookie`
   import already there) and interpolate it in place of the literal:
   - `studio.spec.ts:517`: `` `${BASE_URL}/studio-class/${created.id}` ``
   - `studio.spec.ts:569`: `` `${BASE_URL}/schedule` `` (or a bare relative
     `/schedule` — `page.waitForURL` resolves a relative string against the
     config's `baseURL` the same way `page.goto` does, so either is correct;
     prefer `BASE_URL` for consistency with the other 4 sites so one import
     covers all of them uniformly, per the issue's acceptance criterion that
     one mechanism serves all five sites)
   - `student-journey.spec.ts:33`, `teacher-journey.spec.ts:282`,
     `recurring.spec.ts:165`: `` `${BASE_URL}/api/...` `` in place of the
     `http://localhost:3000/api/...` literal, bare `fetch()` otherwise
     unchanged (headers, method, body stay exactly as they are — this is a
     URL fix, not a client-library change)
2. Add an ESLint rule in `eslint.config.mjs`, scoped to
   `files: ['tests/e2e/**/*.ts']`, using `no-restricted-syntax` (the existing
   pattern already in this file for the roster-link rule) to flag any string
   or template-literal segment containing `localhost:3000`. Two selectors
   (`Literal[value=/localhost:3000/]` and
   `TemplateElement[value.raw=/localhost:3000/]`) cover both literal forms.

**Tests / verification (per task):**
- Confirm each of the 4 specs passes in the worktree (port 3100,
  `INTEGRATION_BASE_URL` set) — this is the RED→GREEN pair for the app-facing
  half of the fix.
- Confirm the same 4 specs still pass unchanged against the CI shape: run
  them once with `INTEGRATION_BASE_URL` unset against a server actually on
  `:3000` if practical, or reason from the fact that `BASE_URL`'s fallback is
  byte-identical to the literal being replaced — no environment-dependent
  behavior change for the case `INTEGRATION_BASE_URL` is unset.
- Prove the ESLint guard bites: temporarily reintroduce one literal (e.g.
  revert one line), run `npx eslint tests/e2e/`, confirm it's flagged with
  the new rule's message, then restore the fix and re-run clean. Record the
  exact error text.
- `grep -rn "localhost:3000" tests/e2e/` returns nothing.

## Not doing

- Not switching the 3 `fetch()` call sites to `page.request`/the `request`
  fixture. The issue floats this as a way to remove the bare `fetch()`
  entirely, but it would require threading a fixture into `bookViaApi` (a
  plain helper function, not a test body) and into a cron test that
  currently takes no fixtures at all, and risks a `page.request`
  cookie-merging behavior change for two of the three sites that isn't
  needed to fix the bug. `BASE_URL` fixes the actual defect (wrong origin)
  with no change to calling convention.
- Not adding a helper function beside `freshIp()` — `BASE_URL` already is
  that helper, already documented as intended for e2e use, just unused by
  these 5 sites until now.
