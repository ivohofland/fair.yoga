# Log the discarded transport error; lint against new bare catches — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every client transport-failure catch binds its error and logs it through one helper, and a lint rule stops new bare catches in `src/components` and `src/app` (#692).

**Architecture:** A `logRequestFailure(tag, context, err)` helper in `src/lib/client-errors.ts` produces the exact `console.error` line the codebase already hand-writes 21 times; those, six other-format transport logs, 49 bare transport catches and three `.catch(() => …)` handlers convert to it. Four server fallbacks bind `err` into their pino object; two payload-shape probes lose their `try` to a guard. Last, two ESLint `no-restricted-syntax` selectors (`CatchClause[param=null]` and a zero-parameter `.catch` handler) land over `src/components` and `src/app`, with a reasoned disable on each catch that is correct as bare.

**Tech Stack:** Next.js 16 client components, TypeScript strict, Vitest + Testing Library, ESLint flat config.

**Spec:** `docs/superpowers/specs/2026-09-29-bare-catch-logging-design.md`; per-site census `docs/superpowers/specs/2026-09-29-bare-catch-census.md` (rows referenced below as "census #N"; line numbers there are as of `347221df`, re-find by content).

**What this document is.** A record of the plan as issued, not a maintained specification. The shipped files are authoritative for what the code says.

## Global Constraints

- **Log line format is fixed:** `console.error(\`[${tag}] request failed\`, { ...context, err })` — produced only by `logRequestFailure`. No other wording, no positional `err`.
- **Never log PII in `context`:** no email, names, the magic-link `code`, privacy choices, IBAN, free-text body fields. IDs, enums, booleans, counts only. Census "Ctx vars" column names the safe identifiers per site.
- **Tags:** kebab-case from the file name (`cancel-class-button`); in a file with more than one transport log, every *new* tag suffixes the action (`booking-name-step-resend`), and a tag already in the file keeps its spelling (so `template-form`'s existing tag stays and #31 becomes `template-form-rooms`). A file holding several components (`contact-form.tsx`) tags each by its component name. The tags are dictated per task below; use them verbatim.
- **User-facing copy does not change.** Every "Network error. Try again." and every other string stays byte-identical.
- **No `router.push`/`router.refresh` moves** (spec decision 4). The only `try` restructurings in this plan are census #6 (Task 2) and census #30/#32 (Task 4). Census #10 (`handoff-code-entry.tsx`) is converted, not narrowed — a stated exception in spec decision 4.
- **TypeScript strict, no `any`.** A catch binding is `unknown`; pass it through untouched.
- **Test idiom for a log assertion:** `const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});` … `expect(consoleError).toHaveBeenCalledWith('[tag] request failed', { …, err: <the rejected Error instance> })`. Hold the rejected error in a `const` so the assertion checks identity. Follow the test file's existing spy-restore arrangement (`afterEach(() => vi.restoreAllMocks())` or `mockRestore()`); add `consoleError.mockRestore()` at the end of the test if the file has neither.
- **Stage exact paths** (quote paths containing parentheses), never `git add -A`/`.`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test commands: a single file `pnpm exec vitest run <path>`; the whole local gate `pnpm run typecheck && pnpm run lint`.

## Review Focus

1. **A context object leaking PII** (e.g. `{ email }` in a sign-in form) — a reviewer must read each converted context against the census PII column; no test can see it.
2. **A converted catch whose tag duplicates another site's tag** — two catches logging the same tag defeat the point; Task 5 Step 1 greps tags for duplicates.
3. **The new lint block switching off the `teacherStudent`/`ClassLock` guards in `src/components`/`src/app`** — pinned by Task 5's guard proofs 2 and 3.
4. **A disable comment that suppresses more than the catch** — a line-scoped disable on the catch line (or directly above it), never a file-level or block disable. Task 5 Step 1 greps for `eslint-disable no-restricted-syntax` (block form) and expects zero.
5. **The O-site guard changing which path a `null` (or number, string, array) 201 payload takes** — pinned by the existing `studio-template-form.test.tsx`/`template-form.test.tsx` assertions (`console.warn(msg, null)`, `console.error` not called), which must stay green unedited; Task 4 adds nothing that loosens them.

---

### Task 1: `logRequestFailure` helper; convert the existing transport logs

**Files:**
- Modify: `src/lib/client-errors.ts`, `src/lib/client-errors.test.ts`
- Modify (convert): every file matched by `grep -rnE "console\.error\('\[[a-z-]+\] request failed', \{" src --include='*.ts' --include='*.tsx' --exclude='*.test.*'` (21 lines at plan time).
- Modify (convert, other format): `src/components/student/notifications-form.tsx`, `src/components/student/tier-form.tsx`, `src/components/student/name-form.tsx`, `src/components/class/class-edit-form.tsx`, `src/components/studio-class/studio-class-edit-form.tsx`, `src/components/students/student-directory.tsx`, and their colocated tests.
- Modify: `src/components/schedule/onboarding-skip-button.tsx` (+ its test if it asserts the refusal line).

**Interfaces:**
- Produces, in `src/lib/client-errors.ts`:
  ```ts
  export type RequestFailureContext = Readonly<Record<string, string | number | boolean | null | undefined>> & { err?: never };
  export function logRequestFailure(tag: string, context: RequestFailureContext, err: unknown): void
  ```

- [ ] **Step 1: Write the failing test** — append to `src/lib/client-errors.test.ts` (add `logRequestFailure` to the existing import from `./client-errors`):

```ts
describe('logRequestFailure', () => {
  it('logs the tag, the context and the error in one console.error call', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new TypeError('Failed to fetch');

    logRequestFailure('cancel-class-button', { classId: 'c-7' }, err);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('[cancel-class-button] request failed', {
      classId: 'c-7',
      err,
    });
    consoleError.mockRestore();
  });

  it('logs an empty context as just the error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('offline');

    logRequestFailure('login', {}, err);

    expect(consoleError).toHaveBeenCalledWith('[login] request failed', { err });
  });
});

/**
 * Typecheck only, invisible to Vitest: the context admits identifiers, not
 * objects, and never a caller's own `err` — the real one is the third argument.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _contextRefusesObjectsAndErr(): void {
  // @ts-expect-error — an object value is refused
  logRequestFailure('x', { payload: { email: 'a@b.c' } }, null);
  // @ts-expect-error — a caller-supplied err key is refused
  logRequestFailure('x', { err: 'shadow' }, null);
}
```

`client-errors.test.ts` already has `afterEach(() => vi.restoreAllMocks())`, which is why the snippet has no `mockRestore()`. The `_fn` + `@ts-expect-error` shape is the repo's idiom for compile-only pins (`timezone.test.ts`, `db-locks.test.ts`).

(If the file already has an `afterEach(() => vi.restoreAllMocks())`, drop the `mockRestore()` lines.)

- [ ] **Step 2: Run it, see it fail** — `pnpm exec vitest run src/lib/client-errors.test.ts`. Expected: FAIL, `logRequestFailure` is not exported / not a function.

- [ ] **Step 3: Implement** — in `src/lib/client-errors.ts`:

```ts
/**
 * The one line a client writes when a request never produced a response it
 * could read — a rejected `fetch`, an unreadable body, or a bug thrown inside
 * the same `try`. The user sees the caller's own message; this is what leaves
 * a trace of why. `context` carries identifiers only — never an email, a
 * name, a sign-in code or anything the user typed.
 */
export type RequestFailureContext = Readonly<
  Record<string, string | number | boolean | null | undefined>
> & { err?: never };

export function logRequestFailure(tag: string, context: RequestFailureContext, err: unknown): void {
  console.error(`[${tag}] request failed`, { ...context, err });
}
```

Run `pnpm run typecheck` too: the two `@ts-expect-error` lines must compile (an unused directive is itself an error, which is what makes them pins).

- [ ] **Step 4: Run it, see it pass** — same command. Expected: PASS.

- [ ] **Step 5: Convert the 21 hand-written lines.** Each `console.error('[TAG] request failed', { A, B, err });` becomes `logRequestFailure('TAG', { A, B }, err);` with `import { logRequestFailure } from '@/lib/client-errors';` (merge into an existing import from that module where present; `src/lib/*` files use the relative `./client-errors`). Keep `TAG` and the context keys exactly. If a context value is not a primitive (the type will refuse it), report it rather than casting. Do NOT convert `src/app/(public)/verify/page.tsx`'s positional line. In `onboarding-skip-button.tsx`, convert the `{ step, err }` line and change the `{ step, status: res.status }` refusal line's message to `'[onboarding-skip] refused'` (it stays a plain `console.error` — it is not a transport failure); update its test if one asserts the old string.

- [ ] **Step 6: Prove the conversion is byte-identical** — `pnpm exec vitest run` on each converted file's colocated test (list them with `grep -rlE "request failed" src --include='*.test.*'`). Expected: all PASS unedited — they assert the exact `console.error` arguments, so a pass certifies the helper's output matches the hand-written line. Then re-run the Step 5 grep: expected 0 lines.

- [ ] **Step 7: The six other-format logs — RED then GREEN.** First read each site and confirm its catch is a transport failure (a `fetch` rejection or unreadable body); if one is not, leave it and report why. Tags: `notifications-form`, `tier-form`, `name-form`, `class-edit-form`, `studio-class-edit-form`, `student-directory`; context: the IDs in scope that the census PII rule allows (often `{}`). First change the four existing transport assertions — `tier-form.test.tsx` (`'student tier save failed', expect.any(Error)`), `name-form.test.tsx`, `notifications-form.test.tsx`, `class-edit-form.test.tsx` — to the helper's line, e.g. `expect(logged).toHaveBeenCalledWith('[tier-form] request failed', { err: expect.any(Error) })`. Run them: FAIL. Convert all six `console.error` transport calls. Run: PASS. `student-directory.test.tsx`'s only log assertion is its `{ status: 500 }` refusal line, and `studio-class-edit-form` has no transport assertion: those two convert with no test edit (spec decision 6 — no new rejection tests). The refusal lines (`'… save failed (HTTP)', status`, student-directory's status line) and their assertions stay untouched.

- [ ] **Step 8: Guard proof** — change the helper's template to `` `[${tag}] request  failed` `` (two spaces). Run `pnpm exec vitest run src/lib/client-errors.test.ts src/components/settings/delete-room-button.test.tsx`. Record the failing assertion text in the task report. Restore; re-run; PASS. `git diff src/lib/client-errors.ts` must show only the intended change.

- [ ] **Step 9: Typecheck + lint + commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/lib/client-errors.ts src/lib/client-errors.test.ts <each converted path, quoted>
git commit -m "feat(client-errors): logRequestFailure, and the existing transport logs use it (#692)"
```

---

### Task 2: Convert transport catches — `src/app`, account, auth, booking, class, layout

**Files (census rows):** #1 `src/app/(public)/login/page.tsx`, #2 `src/app/(teacher)/class/new/page.tsx` (rooms load), #6 & #7 `src/components/account/data-and-deletion.tsx`, #8 `account/set-up-student-side.tsx`, #9 `account/sign-out-button.tsx`, #10 `auth/handoff-code-entry.tsx`, #11 `booking/booking-flow.tsx`, #12 #13 #14 `booking/booking-name-step.tsx` (#14 — the resend 200's unreadable body — is T by spec reclassification, tag `booking-name-step-resend-body`; its behaviour of treating the body as not-delivered stays), #15 `booking/booking-sign-in.tsx`, #16 `booking/join-as-student.tsx`, #17 `class/add-walk-in.tsx`, #18 `class/attendance-list.tsx`, #19 `class/cancel-class-button.tsx`, #20 `class/complete-class-button.tsx`, #21 `class/mark-unpaid-button.tsx`, #22 `class/publish-class-button.tsx`, #25 `layout/notification-list.tsx` (show older). Plus their colocated tests.

**Interfaces:** Consumes `logRequestFailure` (Task 1).

Per site the change is: `} catch {` → `} catch (err) {`, and as the catch's first statement `logRequestFailure('<tag>', { <census ctx vars> }, err);`. Context per the census "Ctx vars" column. Tags (verbatim): #1 `login`, #2 `class-new-rooms`, #6 `data-and-deletion-export`, #7 `data-and-deletion-delete`, #8 `set-up-student-side`, #9 `sign-out-button`, #10 `handoff-code-entry`, #11 `booking-flow`, #12 `booking-name-step-profile`, #13 `booking-name-step-resend`, #14 `booking-name-step-resend-body`, #15 `booking-sign-in`, #16 `join-as-student`, #17 `add-walk-in-register`, #18 `attendance-list`, #19 `cancel-class-button`, #20 `complete-class-button`, #21 `mark-unpaid-button`, #22 `publish-class-button`, #25 `notification-list-older`; promise handlers `add-walk-in-students`, `add-walk-in-invitations`. PII sites (#1, #10, #12, #15, #17) log `{}` or only the safe identifiers named in the census.

- [ ] **Step 1: RED — add the log assertion to each existing test that reaches one of these catches.** Census "Tests" column rows marked "no spy" in this task: #2 (`class/new/page.test.tsx` "distinguishes a thrown fetch…"), #9, #12, #16, #19, #20, #22, #25 (`notification-list.test.tsx`'s two show-older HTTP-failure cases — there is no rejection case; the second goes through the catch twice, HTTP 500 then 401, so use `toHaveBeenCalledWith`, never `toHaveBeenCalledTimes(1)`). In each, hold the rejected error in a `const`, spy on `console.error`, and assert the tagged call — for #19:

```ts
it('says something when the request never reaches the server', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const offline = new Error('offline');
  fetchMock.mockRejectedValue(offline);
  vi.stubGlobal('fetch', fetchMock);
  render(<CancelClassButton classId="c-7" registrationCount={0} />);

  confirm();

  expect(await screen.findByText('Network error. Try again.')).toBeInTheDocument();
  expect(consoleError).toHaveBeenCalledWith('[cancel-class-button] request failed', {
    classId: 'c-7',
    err: offline,
  });
  consoleError.mockRestore(); // this file's afterEach does not restore spies
});
```

For #25's HTTP-500 case the logged `err` is the component's own `Error('HTTP 500')` — assert with `err: expect.objectContaining({ message: 'HTTP 500' })`.

- [ ] **Step 2: Run them, see each fail** — `pnpm exec vitest run <the edited test files>`. Expected: each new assertion FAILS with `expected "error" to be called with arguments` (spy called 0 times). Record which ones.

- [ ] **Step 3: Convert all 20 catches in this task** (including those with no test), **plus `add-walk-in.tsx`'s two promise-method handlers** — the students and invitations loads, each `.catch(() => …)`: make them `.catch((err: unknown) => { logRequestFailure('add-walk-in-students' | 'add-walk-in-invitations', { classId }, err); …existing body… })`. Their `.then` throws `new Error('students 500')`-style errors into the same handler; that is logged too, which is intended. `add-walk-in.test.tsx`'s mocks throw `new Error('unexpected fetch …')` from unexpected calls — those now log instead of being silently swallowed; if a test in that file thereby starts failing, report it (it has found a real unexpected fetch), don't silence it.

- [ ] **Step 4: Narrow census #6** — in `data-and-deletion.tsx`'s export handler, keep only `fetch` and `res.blob()` (and the `!res.ok` handling) inside the `try`; perform `URL.createObjectURL`, the anchor create/click and `revokeObjectURL` after the `try`/`catch`, reached only when a blob was obtained. Busy/`finally` behaviour and all copy unchanged.

- [ ] **Step 5: GREEN** — re-run Step 2's files plus every colocated test of a converted file. Expected: all PASS.

- [ ] **Step 6: Guard proof** — in `cancel-class-button.tsx`, change the tag to `cancel-class-btn`; run its test; record the failure; restore; PASS.

- [ ] **Step 7: typecheck + lint + commit** — `pnpm run typecheck && pnpm run lint`; stage exact paths; commit `fix(client): log the transport error in app, account, auth, booking, class and layout catches (#692)`.

---

### Task 3: Convert transport catches — settings, signup, student, students, studio-class, room-search

**Files (census rows):** #26 `settings/archive-room-button.tsx`, #27 `settings/profile-form.tsx`, #28 & #29 `settings/share-room-button.tsx`, #31 `settings/template-form.tsx` (rooms load), #33 `settings/unlink-room-button.tsx`, #34 `signup/page-address-field.tsx`, #39 `signup/profile-setup-form.tsx` (submit), #40 `signup/signup-form.tsx`, #41 `student/cancel-booking-button.tsx`, #42 `student/pending-invitation-card.tsx`, #43 & #44 `student/teacher-privacy-card.tsx`, #45 & #46 `student/waitlist-entry-actions.tsx`, #47 & #48 `students/archive-student-button.tsx`, #49 #50 #51 `students/contact-form.tsx` (three components — tags `contact-form`, `archive-contact-button`, `resend-invitation-button`), #52 `students/contact-list.tsx`, #53 `students/create-student-form.tsx`, #54 `students/remove-student-button.tsx`, #55 `studio-class/cancel-studio-class-button.tsx`, #56 `studio-class/delete-studio-class-button.tsx`, #57 `studio-class/restore-studio-class-button.tsx`, #58 `studio-class/student-count-editor.tsx`, #66 & #67 `src/lib/room-search.ts`. Plus colocated tests (and `src/lib/room-search.test.ts`).

**Interfaces:** Consumes `logRequestFailure` (Task 1).

Same per-site change as Task 2. Tags (verbatim): #26 `archive-room-button`, #27 `profile-form`, #28 `share-room-button-share`, #29 `share-room-button-switch`, #31 `template-form-rooms`, #33 `unlink-room-button`, #34 `page-address-field`, #39 `profile-setup-form-submit`, #40 `signup-form`, #41 `cancel-booking-button`, #42 `pending-invitation-card`, #43 `teacher-privacy-card-save`, #44 `teacher-privacy-card-unlink`, #45 `waitlist-entry-actions-claim`, #46 `waitlist-entry-actions-leave`, #47 `archive-student-button-unarchive`, #48 `archive-student-button-archive`, #49 `contact-form`, #50 `archive-contact-button`, #51 `resend-invitation-button`, #52 `contact-list`, #53 `create-student-form`, #54 `remove-student-button`, #55 `cancel-studio-class-button`, #56 `delete-studio-class-button`, #57 `restore-studio-class-button`, #58 `student-count-editor`, #66 `room-search-request`, #67 `room-search-body`; promise handler `profile-setup-form-resend`. PII sites (#27 — IBAN/body fields, #39, #40, #43 `values`, #49 payload, #53 payload) log only the census's safe identifiers. #31's catch comment is history ("There was no `catch` here at all…") — replace it with one line stating what the catch does now. #52's comment is partly history — same treatment. #66/#67 log inside `room-search.ts`, not in its callers.

- [ ] **Step 1: RED** — add the log assertion (Task 2 Step 1 idiom) to each existing test reaching these catches: #26, #27, #33, #39, #40, #41, #48 (both `:232`-area and `:396`-area cases), #50, #51, #52, #55, #56, #57, #58, #66 (`room-search.test.ts` rejection case), #67 (`room-search.test.ts`'s unreadable-body table: only its `SyntaxError` row reaches the catch — assert the `[room-search-body]` log for that row alone, via a separate `it` or a row flag, and assert `console.error` not called for the shape-mismatch rows, which pins that a wrong shape is not logged as a transport failure).
- [ ] **Step 2: Run, see each fail**; record.
- [ ] **Step 3: Convert all 29 catches in this task, plus `profile-setup-form.tsx`'s resend promise handler** (`.catch(() => false)` → `.catch((err: unknown) => { logRequestFailure('profile-setup-form-resend', {}, err); return false; })`).
- [ ] **Step 4: GREEN** — edited tests plus every colocated test of a converted file, plus `share-room-button.test.tsx` and `add-room-flow.test.tsx` (they reach #66). All PASS.
- [ ] **Step 5: Guard proof** — in `room-search.ts` change `{ …, err }` usage to drop `err` (pass `undefined`); run `room-search.test.ts`; record failure; restore; PASS.
- [ ] **Step 6: typecheck + lint + commit** — `fix(client): log the transport error in settings, signup, student, students, studio-class and room-search catches (#692)`.

---

### Task 4: Replace the two shape-probe `try`s with a guard; bind `err` in the four server fallbacks

**Files:** `src/components/settings/studio-template-form.tsx` (census #30), `src/components/settings/template-form.tsx` (#32), `src/lib/timezone.ts` (#68, #69, #70), `src/lib/finish-window.ts` (#60), `src/lib/finish-window.test.ts`, `src/lib/timezone.test.ts`.

- [ ] **Step 1: #30/#32 — replace the `try` with a guard.** Today a `try` around the 201-body shape read also calls `anyBlocked`, the message builder, `setSuccess` and `router.push`, and its bare catch leaves `handled` false. On `JSON.parse` output the only throwing expression inside is `.data` on `null`. Remove the `try`/`catch`: read `data` behind the guard `typeof rawJson === 'object' && rawJson !== null ? (rawJson as <the cast the existing code already uses>).data : undefined` — keep the existing cast's shape (in `studio-template-form.tsx` it types `data` with `added` and `counts`, which the following code reads; `template-form.tsx` has its equivalent), so the rest compiles unchanged; and keep the rest of the logic (the `hasIntegerCounts` check, `anyBlocked`, builders, `setSuccess`, `router.push`, `handled = true`) exactly as it is, now outside any `try`. A `null`, number, string or array payload must still reach the existing `!handled` → `console.warn(msg, rawJson)` and never `console.error`. No `any`.
- [ ] **Step 2: Run the forms' tests unedited** — `pnpm exec vitest run src/components/settings/studio-template-form.test.tsx src/components/settings/template-form.test.tsx`. Expected: PASS with no test edits (they pin `warn(msg, null)` and `console.error` not called).
- [ ] **Step 3: Guard proof that a bug is no longer swallowed** — temporarily insert `throw new Error('boom');` as the first statement of the success branch (just before `setSuccess`) in `studio-template-form.tsx`; run its success-path test; expected: it now fails with `boom` surfacing — the submit handler's outer `try` has only a `finally`, so Vitest may report it as an unhandled rejection (a run-level error) alongside the test's own `waitFor` failing; either counts. Before this task the same insertion was swallowed into the warn path; state that reasoning rather than re-running the old code. Record the failure. Restore; PASS. Then insert the guard's mutation `(rawJson as { data?: unknown }).data` with no null check; run the null-payload test; expected: FAIL with `Cannot read properties of null` — record; restore; PASS.
- [ ] **Step 4: RED for the L group** — in `finish-window.test.ts:75`-area, change the exact-object assertion to `expect.objectContaining({ timeZone: 'Not/AZone', err: expect.any(Error) })`; in `timezone.test.ts`, extend each existing `objectContaining({ timeZone … })` for the three fallbacks with `err: expect.any(Error)` (the `toHaveBeenCalled()` at the `formatInstantInZone` case becomes `toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.any(String))`). Run; expected FAIL (no `err` key).
- [ ] **Step 5: GREEN** — at the four sites, `} catch {` → `} catch (err) {` and `log.error({ timeZone }, …)` → `log.error({ timeZone, err }, …)`. Run both test files; PASS.
- [ ] **Step 6: typecheck + lint + commit** — `fix: the template-form shape probes guard instead of catching; server timezone fallbacks log their error (#692)`.

---

### Task 5: The lint tether, the reasoned disables, the guard proofs

**Files:** `eslint.config.mjs`; the 9 in-scope B sites (census #3, #4, #5, #23, #24, #35, #36, #37, #38); `src/app/api/registrations/[id]/route.ts` (its `.catch(() => -1)`); `vitest.config.ts` (a stale comment); `docs/technical-architecture.md`.

**Order is load-bearing:** this task must land after Tasks 2–4 — before them the rule would fail lint on every unconverted catch.

- [ ] **Step 1: Pre-check** — duplicate tags, multiline-aware (Prettier wraps long calls, so the tag may sit on the line after `logRequestFailure(`): `grep -rhozP "logRequestFailure\(\s*'[a-z0-9-]+'" src --include='*.ts' --include='*.tsx' --exclude='*.test.*' | tr '\0' '\n' | grep -oE "'[a-z0-9-]+'" | sort | uniq -d` → expect no output. Prove the command can fail: pipe in a scratch copy containing a wrapped duplicate (`logRequestFailure(\n  'login',`) alongside `'login'` and confirm it prints `'login'`; record. `grep -rn "eslint-disable no-restricted-syntax" src` → expect none.
- [ ] **Step 2: Config.** In `eslint.config.mjs`:
  - Hoist the `teacherStudent` create/upsert selector object into a named constant beside `classLockCastSelector` (`teacherStudentWriteSelector`), used by the existing `src/**` block.
  - Add `bareCatchSelector = { selector: 'CatchClause[param=null]', message: 'Bind the error — catch (err) — and log it: logRequestFailure (src/lib/client-errors.ts) in client code, log.error({ err }) on the server. A catch that is correct as bare says why in an eslint-disable-next-line as the last line of the try block (#692).' }`.
  - Add `discardedRejectionSelector = { selector: "CallExpression[callee.property.name='catch'] > :function:matches([params.length=0], [params.0.name=/^_/])", message: 'A .catch handler that takes no parameter (or an _-named one) drops the rejection — take (err: unknown) and log it: logRequestFailure (src/lib/client-errors.ts) in client code, log.error({ err }) on the server (#692).' }`.
  - Add a block after the `src/**` block and before the `roster-link.ts` override: `files: ['src/components/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}']`, `ignores` the test globs, `'no-restricted-syntax': ['error', teacherStudentWriteSelector, classLockCastSelector, bareCatchSelector, discardedRejectionSelector]`. Its comment says why it repeats the two shared selectors (a later block replaces the rule's options — pointing at the explanation above rather than re-stating it) and why `src/lib` is outside it (its bare catches are tooling and server probes, correct as bare).
  - Rewrite the existing block comment that opens "Two unrelated `no-restricted-syntax` protections share this one block…": no prose count, name the hoisted constants, state the replacement rule once. Keep its `teacherStudent`/`ClassLock` explanations.
- [ ] **Step 3: Run lint, see the expected errors** — `pnpm run lint`. Expected: exactly the 9 in-scope B sites (#3, #4, #5, #23, #24, #35, #36, #37, #38) from `bareCatchSelector`, plus `discardedRejectionSelector` hits. Expected `discardedRejectionSelector` hit: `src/app/api/registrations/[id]/route.ts` (`.catch(() => -1)`). Any other hit of either selector: if it is a client transport failure, convert it with `logRequestFailure` (tag per the Global Constraints) and list it in the report; if it is server code, bind `err` and log via the file's pino `log`; if it is genuinely correct as bare, disable it with a reason and list it in the report. Record the full hit list.
- [ ] **Step 4: Disables.** For each B site, as the last line inside the `try` block, immediately above `} catch {`: `// eslint-disable-next-line no-restricted-syntax -- <reason>`. (A trailing `} catch { // eslint-disable-line …` does not work: Prettier moves that comment into the catch block, off the catch line.) Reasons state why the error carries no information: e.g. `-- enqueue after the client disconnected throws; the stream is already gone`, `-- a body that isn't JSON is a 400, not a fault`, `-- the share sheet was dismissed; fall back to the clipboard`, `-- storage is unavailable in private mode; the draft is a convenience`. Where the catch already carries a comment saying the same thing, fold it into the reason and delete the duplicate. For `registrations/[id]/route.ts`'s `.catch(() => -1)`: its existing comment already names the dropped error as a known gap — the disable's reason points at that comment in a few words. Then `pnpm run lint` → clean, and `pnpm exec prettier --check` on every touched file → clean.
- [ ] **Step 4b: Stale comment** — `vitest.config.ts`'s comment saying an unstubbed fetch's failure is swallowed into "Network error" rather than failing visibly: rewrite to what is true now (the component logs it via `logRequestFailure` and still shows "Network error"; the test does not fail). One or two lines.
- [ ] **Step 5: Guard proofs** (each: apply, run the command, paste the exact error line in the task report, restore, re-run clean. Prefer `pnpm exec eslint --stdin --stdin-filename <repo path> < <scratch probe file>` so nothing tracked is edited; finish with `git status --short` showing no changes from the proofs):
  1. Add `try { JSON.parse('x'); } catch { /* */ }` inside a function in `src/components/class/cancel-class-button.tsx` → `pnpm exec eslint src/components/class/cancel-class-button.tsx` → `no-restricted-syntax` with the #692 message.
  2. Add `void prisma.teacherStudent.create({ data: {} as never });` (import as needed, or any expression of that call shape) in `src/app/(teacher)/class/new/page.tsx` → eslint that file → the #181 message.
  3. Add `const _x = null as unknown as ClassLock;` with a type import in `src/components/class/cancel-class-button.tsx` → the #219 message.
  4. Delete the disable at census #23 (`share-booking-link.tsx`) → eslint that file → `no-restricted-syntax` at that line.
  5. Change census #19's `logRequestFailure(...)` call to nothing, leaving `catch (err)` → `@typescript-eslint/no-unused-vars` "'err' is defined but never used".
  6. A bare catch in a `src/lib/` path → no `no-restricted-syntax` error (the scope boundary is where the spec says).
  7. `fetch('/x').catch(() => null);` in a `src/components/` path → `discardedRejectionSelector`'s message; `fetch('/x').catch((_err) => null);` → same; `fetch('/x').catch((err: unknown) => { console.error(err); });` → no error.
  8. A bare catch in a `src/components/…/x.test.tsx` path → no error (the test ignore works).
  9. In `src/services/roster-link.ts`'s path: a `teacherStudent.create(...)` call → no error; `null as unknown as ClassLock` → the #219 message (the override survives).
- [ ] **Step 6: Docs** — in `docs/technical-architecture.md`, beside the paragraph describing `readError` (The Services Layer → Error responses), add a short paragraph: a client catch binds its error and a failed request logs via `logRequestFailure` (`src/lib/client-errors.ts`); its `context` carries identifiers only — never an email, name, sign-in code or anything the user typed, which the type cannot tell from an ID; `err` can itself quote a response body's start, which matters if a client error sink is ever plugged in; `src/components`/`src/app` refuse a bare catch and a parameterless `.catch` handler by lint, and one correct as bare says why in its disable. Link the spec.
- [ ] **Step 7: Order, gate, commit.** Do Steps 1–4b and 6, run `pnpm run typecheck && pnpm run lint && pnpm exec vitest run --project unit --project components`, stage exact paths, and commit `chore(lint): refuse a bare catch in components and app; the ones correct as bare say why (#692)`. Then run Step 5's proofs, via `--stdin` only, so no tracked file is edited; finish with `git status --short` clean. Commit again only if a proof exposed something that needed changing.
