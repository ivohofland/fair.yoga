# Plan: fix flaky "payment marked not charged and put back" e2e test (#553)

## Premise verification

Issue #553 reports `tests/e2e/teacher-journey.spec.ts:471` ("a payment can be
marked not charged and put back", chromium) failing intermittently in CI,
reproduced on unmodified `main` twice and on an unrelated Docker/CI-only PR
once — all three at the same assertion:

```
Error: expect(locator).toBeHidden() failed
Locator:  getByRole('heading', { name: 'Not charged' })
Expected: hidden
Received: visible
```

Confirmed by reading the test and its dependencies:

- The failing test (`teacher-journey.spec.ts:471-491`) clicks "Mark unpaid",
  then "Confirm unpaid", then calls `page.reload()` immediately — no wait
  between the click and the reload.
- `MarkUnpaidButton` (`src/components/class/mark-unpaid-button.tsx:35`) fires
  `POST /api/payments/${paymentId}/unpaid` on that confirm click. The
  server write (payment status `not_charged → pending`) is what makes the
  "Not charged" heading disappear on reload.
- The test *immediately above it in the same file*
  (`teacher-journey.spec.ts:412-469`, "the payments overview offers the
  permanent correction") performs the identical
  click-Mark-unpaid-then-Confirm-unpaid-then-reload sequence, and does not
  have this problem — because it waits for the mutation's response before
  reloading:

  ```ts
  const unpaid = page.waitForResponse(
    (resp) => resp.url().includes('/unpaid') && resp.ok(),
  );
  await page.getByRole('button', { name: 'Confirm unpaid' }).click();
  await unpaid;
  await page.reload();
  ```

  with the comment: "Wait for the POST, then reload (see the publish
  test): the row's 'Updating...' state clears only via the refresh the
  router can drop."

The flaky test is missing this wait. `page.reload()` races the `/unpaid`
POST: when the reload wins the race, the page re-renders with the payment
still `not_charged`, and the "Not charged" heading is still visible —
exactly the observed failure. This is not a new bug in application code; the
sibling test already established the correct pattern, and this test just
didn't follow it. The issue's own "suggested next step" independently arrives
at the same diagnosis.

**Premise holds.** Single file, one obvious fix, mirrors an existing
in-file precedent exactly — no spec needed per `solve-issue`'s spec gate.

## Direction

Apply the same `waitForResponse` pattern to the second `page.reload()` call
in "a payment can be marked not charged and put back"
(`teacher-journey.spec.ts:481-489`), keyed on the same `/unpaid` URL
substring and `resp.ok()`, matching the sibling test's style (including its
short explanatory comment, adapted to point at the sibling rather than
duplicate prose).

No other approach considered — the fix is dictated by the working precedent
twelve lines above the bug, not a design choice.

## Task 1 (only task): fix the race

**File:** `tests/e2e/teacher-journey.spec.ts`

Change:

```ts
await page.getByRole('button', { name: /Mark unpaid — Walkin g\./ }).click();
await page.getByRole('button', { name: /Confirm unpaid — Walkin g\./ }).click();
await page.reload();
await expect(page.getByRole('heading', { name: 'Not charged' })).toBeHidden();
```

to:

```ts
await page.getByRole('button', { name: /Mark unpaid — Walkin g\./ }).click();
// Wait for the POST, then reload (see the previous test): the row's
// "Updating..." state clears only via the refresh the router can drop.
const unpaid = page.waitForResponse(
  (resp) => resp.url().includes('/unpaid') && resp.ok(),
);
await page.getByRole('button', { name: /Confirm unpaid — Walkin g\./ }).click();
await unpaid;
await page.reload();
await expect(page.getByRole('heading', { name: 'Not charged' })).toBeHidden();
```

**Verification (prove the guard bites):** this is a test-only change, so
"breaking the guard" means confirming the *old* code actually races and the
*new* code doesn't, not a code mutation:

1. Run the full `teacher-journey.spec.ts` file against the worktree's
   isolated app (`npm run worktree:up` first) with Playwright's
   `--repeat-each` a handful of times to raise the odds of hitting the race,
   both before and after the fix, e.g.:
   `npx playwright test tests/e2e/teacher-journey.spec.ts --repeat-each=5`
   Pre-fix is expected to be flaky-ish (may not reproduce every run — it's a
   race, not a deterministic failure); post-fix must be consistently green.
2. This can't be proven deterministically flaky-then-fixed in one shot (it's
   a timing race, same class as the CI flake), so the bar is: the new code
   removes the exact unguarded `reload()` the issue and the sibling-test
   precedent both point at, and passes repeated local runs.

No application code changes, no new test coverage needed (existing test
already covers the behavior — it's just unreliable), no migration.

## Out of scope

- Any other flaky test.
- Any application code change — this is purely a test synchronization fix.
