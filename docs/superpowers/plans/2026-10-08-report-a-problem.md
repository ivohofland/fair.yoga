# Report a problem from inside the app (#791) — implementation plan

**Goal:** a signed-in teacher or student can reach the place fair.yoga takes problem
reports from their settings directory, without already having a GitHub account.

## Direction (agreed), and the premise correction it needed

The issue offered A (a `mailto:` row), B (a row linking the GitHub issue chooser
`/issues/new/choose`) and C (an in-app form). The user chose **B**, on the grounds that
the chooser also offers email as an alternative (`.github/ISSUE_TEMPLATE/config.yml`'s
*No GitHub account? Email us* contact link).

Measured on 2026-10-08, signed out:

```
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://github.com/ivohofland/fair.yoga/issues/new/choose
302 https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fivohofland%2Ffair.yoga%2Fissues%2Fnew%2Fchoose
curl -s -o /dev/null -w '%{http_code}\n' https://github.com/ivohofland/fair.yoga/blob/main/CONTRIBUTING.md
200
```

The chooser's email link is only visible after signing in to GitHub, so someone with no
account is stopped at the login page and never sees it. That's the sign-in wall the issue
describes for B. The chooser's email link points at `CONTRIBUTING.md#teachers-and-students`,
which is public. It links to the chooser (*Open an issue*), gives **hello@fair.yoga** for
anyone without an account, and warns that issues are public. The row therefore links
**there**. It's still B, a GitHub destination with email beside it, and the email route is
reachable for everyone. The section's "Please keep it private" paragraph handles the
privacy concern the issue raised against a public tracker.

The issue's acceptance criteria were written for A. Restated for this direction:

- [ ] The teacher settings directory and the student account directory each have a
      *Report a problem* row linking
      `https://github.com/ivohofland/fair.yoga/blob/main/CONTRIBUTING.md#teachers-and-students`.
- [ ] The link carries no personal or account data. The URL is a constant, and the
      component takes no props, so nothing can be interpolated into it.
      `rel="noopener noreferrer"` also keeps the app's URL out of GitHub's `Referer`.
- [ ] It opens in a new tab (`target="_blank"`, plus an sr-only "(opens in a new tab)",
      the same as `PaymentLinkPanel`). It uses the directory-row frame, and says in words
      where it goes. The design brief has no external-link icon, and "words come first"
      (CLAUDE.md, *Icons narrowly*), so it gets a caption line, not a chevron and not a
      new icon.
- [ ] Component tests pin the row's exact `href`, `target` and `rel`. Each directory's
      page test pins that the row is present with that `href`.

## Task 1 — `ReportProblemRow` component

**Files:** create `src/components/account/report-problem-row.tsx` and
`src/components/account/report-problem-row.test.tsx`.

**Behaviour:**
- A props-less server-safe component (no `'use client'`) rendering one `<a>`.
- `href` is a module constant equal to the URL above. `target="_blank"`,
  `rel="noopener noreferrer"`.
- Frame: `listRowClass({ className: 'flex flex-col justify-center gap-0.5 no-underline focus:outline-none focus-visible:shadow-focus' })`
  imported from `@/components/ui/list-row`. `ListRow` renders a `next/link` and doesn't
  pass through `target`/`rel`; its docblock directs such rows to `listRowClass`. Do not
  write the `min-h-14` literal: `src/lib/list-row-recipe.test.ts` fails on any file
  outside `list-row.tsx` that does.
- Content: title line `Report a problem` (`text-base text-ink`, same as the sibling
  rows), then a caption line (`type-caption`):
  `Opens a GitHub page with our forms and email address`, then
  `<span className="sr-only">(opens in a new tab)</span>`.
- A one-line comment above the constant saying why it is the CONTRIBUTING section and not
  the chooser (the chooser asks a signed-out visitor to sign in). It must not claim
  anything about other files beyond the section it links.

**Tests (write first, see them fail, then implement):**
- The link, found by role and accessible name `/Report a problem/`, has `href` exactly
  equal to the URL string written literally in the test (not imported from the
  component), `target="_blank"`, `rel="noopener noreferrer"`.
- The accessible name includes "opens in a new tab".

**Prove the pins bite:** mutate the href (e.g. `/issues/new/choose`) → the href assertion
fails; drop `noreferrer` → the rel assertion fails. Record the error text, then restore.

## Task 2 — place the row in both directories; regenerate the settings baseline

**Files:**
- `src/app/(teacher)/settings/(overview)/page.tsx`: render `<ReportProblemRow />` as
  the last row of the `data-layout-anchor="first-item"` list, after `<InstallAppRow />`.
- `src/app/(student)/account/page.tsx`: render `<ReportProblemRow />` as the last row of
  the settings-items list, after `<InstallAppRow />`.
- `src/app/(teacher)/settings/(overview)/page.test.tsx` and
  `src/app/(student)/account/page.test.tsx`: add a test to each asserting the
  *Report a problem* link is present with the literal URL as `href`.
- `tests/e2e/visual.spec.ts-snapshots/settings-*-darwin.png`: the settings index has a
  visual baseline (`ROUTE_BASELINES` in `src/lib/visual-baseline-freshness.ts`) and its
  pixels change. Regenerate it against the worktree's own app
  (`pnpm run worktree:up`, then `pnpm exec playwright test tests/e2e/visual.spec.ts -g "settings index" --update-snapshots`),
  look at the new PNGs at 100% to confirm only the new row differs, and commit both. The
  student account page has no visual baseline.
- `tests/e2e/account.spec.ts` checks the student directory's rows by name. Leave it
  alone unless it asserts an exact row count (check).

The teacher `loading.tsx` skeleton count isn't tied to the row count (it already shows
fewer skeleton rows than the page has), so it stays as is.

**Prove the pins bite:** remove the row from each page in turn → that page's new test
fails; restore.

## Verification

`pnpm run typecheck`, `pnpm run lint`, the component and page tests, `list-row-recipe.test.ts`,
then `pnpm run verify` against the worktree app (`pnpm run check-visual-baseline-freshness`
must pass with the regenerated baseline committed).
