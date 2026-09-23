# Converge hand-parsed error bodies onto `readError` — Implementation Plan (#307)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No client component parses a failed response's body itself; every error branch reads it through `readErrorMessage` (`src/lib/client-errors.ts`), so an unreadable body (a proxy's HTML 502, a truncated response) shows the component's own fallback copy and leaves a `console.error` record, instead of being reported as a network failure and logged nowhere.

**Architecture:** `readError`/`readErrorMessage` already exist, are tested (`src/lib/client-errors.test.ts`), and log an unreadable body with its status and URL. This plan changes only call sites: replace each inline `await res.json()` + `json.error?.message` in an error branch with `await readErrorMessage(res, <that site's existing fallback>)`, then bind and log each bare outer `catch` so a `fetch` failure is recorded too.

**Tech Stack:** Next.js 16 client components, React 19, Vitest `components` project with Testing Library.

**Spec:** none — the spec gate was declined (one subsystem, one obvious approach, no data model or money/auth logic change). The design authority is issue #307 and its narrowing comment; this plan records where that comment's premise was incomplete.

## Premise, as measured

The issue comment (narrowing #307 after #197) says two components still parse error bodies themselves. A shape sweep says ten error branches in nine files do:

```
grep -rnE 'json\.error|\.error\?\.message|error\?: \{ message' src --include='*.tsx' --include='*.ts' \
  | grep -v '\.test\.' | grep -v 'src/app/api/'
```

| File | Branches | Outer catch today |
|---|---|---|
| `src/components/class/class-edit-form.tsx` | 1 | bound + logged, copy claims "or it sent something unreadable" |
| `src/components/class/send-announcement.tsx` | 1 | bare, "Network error. Try again." |
| `src/app/(teacher)/class/new/page.tsx` | 1 | bound + logged (`'class create failed'`) |
| `src/app/(teacher)/studio-class/new/page.tsx` | 1 | bare, "Network error. Please try again." |
| `src/components/settings/edit-room-form.tsx` | 2 | bare |
| `src/components/settings/edit-teacher-room-form.tsx` | 1 | bare |
| `src/components/settings/room-settings-step.tsx` | 1 | bare |
| `src/components/settings/room-create-step.tsx` | 1 | bare |
| `src/components/booking/passkey-sign-in.tsx` | 1 (the 429 branch, `.json().catch(() => null)`) | swallowed, no log |

1+1+1+1+2+1+1+1+1 = 10 branches in 9 files. Every one with a bare catch carries the issue's original defect verbatim. Decision: converge all ten here — leaving seven would mean filing a twin of this issue.

## Global Constraints

- TypeScript `strict: true`, no `any`.
- Each site keeps its **existing fallback string** as `readErrorMessage`'s second argument — this is not a copy pass (the issue explicitly excludes "changing the fallback copy at every call site").
- Success-branch `res.json()` reads stay where they are (e.g. `send-announcement`'s `duplicateSuppressed`, #196; the create pages' `data.id`, #40). Only error branches move — except `send-announcement`'s success read, which Task 1 guards separately.
- `class-edit-form` keeps `router.refresh()` on a refusal (#247).
- Comment Discipline (CLAUDE.md): a comment describes the code it sits on; no counts or rosters in comments.
- Stage exact paths; quote paths containing parentheses.

## Review Focus

1. **A test that passes for the wrong reason.** After conversion the outer catch also logs, so "`console.error` was called" is not evidence the helper ran. Every unreadable-body test asserts the helper's own message `'API error response body could not be read'` *and* the site's fallback copy (which differs from the network copy everywhere except `passkey-sign-in`, where the log assertion alone discriminates).
2. **String-shaped `{ error: "…" }` bodies** are now shown where the settings forms previously showed the fallback. Intended (the helper's contract); `client-errors.test.ts` pins it.
3. **`class-edit-form` refresh on refusal** must survive — assert `router.refresh` is called after an unreadable refusal.
4. **`send-announcement` success path** (`duplicateSuppressed`) must be untouched — existing #196 tests pin it.
5. **`passkey-sign-in` 429 with a readable body** must still show the server's message — existing tests pin it; confirm they still pass.

## Shared test idiom

An unreadable body is a real `Response` with an HTML body, whose `json()` genuinely throws:

```ts
function htmlResponse(status = 502): Response {
  return new Response('<html><body>502 Bad Gateway</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}
```

and the assertion pair:

```ts
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
// … stub fetch with mockResolvedValue(htmlResponse()), trigger the submit …
expect(await screen.findByText('<the site fallback copy>')).toBeInTheDocument();
expect(consoleError).toHaveBeenCalledWith(
  'API error response body could not be read',
  expect.objectContaining({ status: 502 }),
);
```

Restore the spy (`vi.restoreAllMocks()` in `afterEach`, or match the file's existing cleanup).

---

### Task 1: The two components the issue names

**Files:**
- Modify: `src/components/class/send-announcement.tsx` (`handleSend`)
- Modify: `src/components/class/class-edit-form.tsx` (the save handler's error branch and outer `catch`)
- Test: `src/components/class/send-announcement.test.tsx`, `src/components/class/class-edit-form.test.tsx`

**Interfaces:**
- Consumes: `readErrorMessage(res: Response, fallback: string): Promise<string>` from `@/lib/client-errors`.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests.** In each test file:
  - *unreadable error body* → shows the fallback (`'Could not send the announcement. Try again.'` / `'Could not save the class. Try again.'`) and logs `'API error response body could not be read'` with `status: 502`. For `class-edit-form` also assert `router.refresh` was called (the #247 refresh-on-refusal must cover an unreadable refusal too; use the file's existing `next/navigation` mock).
  - *fetch rejects* (`mockRejectedValue(new TypeError('Failed to fetch'))`) → shows the network copy (below) and `console.error` was called with the component's catch label (below).
  - `send-announcement` only: *unreadable success body* (`htmlResponse(201)`) → shows `'Announcement sent — reload to confirm before sending again.'` and logs `'[send-announcement] sent, but the response was unreadable'`.
- [ ] **Step 2: Run and see them fail.** `pnpm exec vitest run --project components src/components/class/send-announcement.test.tsx src/components/class/class-edit-form.test.tsx`. Expected: the unreadable tests fail (today the body's `SyntaxError` lands in the outer catch, showing network copy); `send-announcement`'s fetch-rejects test fails on the log assertion.
- [ ] **Step 3: Implement.**
  - `send-announcement.tsx`, following `send-reminder-button.tsx` in the same folder:
    ```ts
    let res: Response;
    try {
      res = await fetch(/* unchanged */);
    } catch (err) {
      console.error('[send-announcement] request failed', { classId, err });
      setError('Network error. Try again.');
      setSending(false);
      return;
    }
    if (!res.ok) {
      setError(await readErrorMessage(res, 'Could not send the announcement. Try again.'));
      setSending(false);
      return;
    }
    ```
    then the success read in its own `try/catch/finally`: on success the existing `setSentCount`/`setSuppressed`/`setMessage('')`/`setOpen(false)`; in the catch, log `'[send-announcement] sent, but the response was unreadable'` with `{ classId, err }` and `setError('Announcement sent — reload to confirm before sending again.')` — past a 2xx the server has created (or suppressed) the announcement, so an unreadable success body must not read as a failure that invites a resend; `finally` → `setSending(false)`. Keep the #196 comment on the success read.
  - `class-edit-form.tsx`: replace the two parse lines + `setError(message ?? …)` with
    ```ts
    setError(await readErrorMessage(res, 'Could not save the class. Try again.'));
    ```
    keeping the refresh-on-refusal comment and `router.refresh()` directly after it. The outer `catch` now sees only `fetch` failures: change its copy to `'Could not reach the server. Try again.'` and replace its comment with one true now — bound and logged so a network failure leaves a record; an unreadable refusal body is `readErrorMessage`'s case. Keep the `console.error('class edit save failed', err)` label.
- [ ] **Step 4: Run and see them pass**, plus the rest of both files.
- [ ] **Step 5: Prove the guards bite.** Commit first (never `git checkout` a file with uncommitted work). For each component, revert only the error branch to an inline `await res.json()` parse, run the file, record which test fails and its exact failure text, restore with `git checkout -- <file>`, re-run green, and confirm `git status` is clean. Record the results in the task report.
- [ ] **Step 6: Commit.** `fix(client-errors): read send-announcement and class-edit-form refusals through readErrorMessage (#307)`

### Task 2: The seven other hand-parsed sites

**Files:**
- Modify: `src/app/(teacher)/class/new/page.tsx`, `src/app/(teacher)/studio-class/new/page.tsx`, `src/components/settings/edit-room-form.tsx` (both branches), `src/components/settings/edit-teacher-room-form.tsx`, `src/components/settings/room-settings-step.tsx`, `src/components/settings/room-create-step.tsx`, `src/components/booking/passkey-sign-in.tsx` (the 429 branch only)
- Test: the existing sibling test for each (`page.test.tsx` ×2, `edit-teacher-room-form.test.tsx`, `room-settings-step.test.tsx`, `passkey-sign-in.test.tsx`); `add-room-flow.test.tsx` if it already drives `room-create-step`, else a new `room-create-step.test.tsx`; a new `src/components/settings/edit-room-form.test.tsx` (none exists).

**Interfaces:**
- Consumes: `readErrorMessage` as in Task 1.

- [ ] **Step 1: Write the failing tests.** One unreadable-body test per converted branch (edit-room-form gets two: the room PUT and the teacher-room PUT), each asserting that site's existing fallback copy and the `'API error response body could not be read'` log with its status. One fetch-rejects test per file whose catch was bare, asserting the existing network copy and a `console.error` with the file's catch label. For `passkey-sign-in`, the unreadable 429 test asserts `DEFAULT_ERROR_MESSAGE`'s text *and* the helper's log — the log is what discriminates, since the outer catch shows the same text.
- [ ] **Step 2: Run and see them fail** (`pnpm exec vitest run --project components <files>`).
- [ ] **Step 3: Implement.** In each branch, `set…Error(await readErrorMessage(res, '<existing fallback>'))`. In `passkey-sign-in`, `setErrorMessage(await readErrorMessage(optionsRes, DEFAULT_ERROR_MESSAGE))`. Bind and log every bare outer catch: `catch (err) { console.error('[<file-stem>] request failed', err); set…('<existing network copy>'); }`. `class/new/page.tsx` already logs — leave its catch alone. `passkey-sign-in`'s outer catch handles WebAuthn outcomes and is out of scope.
- [ ] **Step 4: Run and see them pass**, plus the full `components` project.
- [ ] **Step 5: Prove the guards bite** — same procedure as Task 1, one mutation per converted branch (revert that branch to its inline parse), exact failure text recorded, `git status` clean at the end.
- [ ] **Step 6: Verify the sweep is empty.** The grep in *Premise, as measured* returns no hit outside `src/app/api/`.
- [ ] **Step 7: Commit.** `fix(client-errors): route the remaining hand-parsed refusals through readErrorMessage (#307)`

## After both tasks

- `pnpm run typecheck`, `pnpm run lint`, and `pnpm exec vitest run --project components` green; `pnpm run verify` against the worktree app (`pnpm run worktree:up`).
- Whole-branch review (two tasks), one fix wave, one scoped re-review.
