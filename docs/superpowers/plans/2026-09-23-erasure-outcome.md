# Erasure Outcome Implementation Plan (#213)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An already-erased profile is reported by the erasure services as a returned value, never as an error that escapes them, so a caller that ignores it gets the correct behaviour (a completed erasure) by default.

**Architecture:** `deleteStudentAccount` and `deleteTeacherAccount` (`src/services/gdpr.ts`) keep their internal `throw new AlreadyErasedError(...)` — it is the only way to make a Prisma interactive transaction refuse to commit — but each catches it around its own `db.$transaction` and returns `ErasureOutcome`. The class becomes module-private. `DELETE /api/account` branches on the returned value per half, and answers `respondUnchanged` when every half it attempted was already erased (#197's "already done is not an error" rule, `docs/technical-architecture.md`, The Services Layer → Error responses).

**Tech Stack:** TypeScript strict, Prisma interactive transactions, Next.js route handlers, Vitest (unit / unit-sweeps / integration projects).

**Spec:** none — bounded issue; the design was agreed in-session and issue #213's body (option B) is the design record. Decision taken at the brainstorming gate: `respondUnchanged` when every attempted half was already erased; ordinary `respondOk` when any half erased now; behaviour for a session with no live profile is unchanged (`respondOk`).

## Global Constraints

- `strict: true`, no `any`.
- Comments state what is true now; no "this used to throw" prose (CLAUDE.md, Comment Discipline). The before/after goes in the PR body.
- No counts or rosters in comments.
- Stage exact paths; never `git add -A` / `git add .`.
- Integration tier in a worktree: `pnpm install --frozen-lockfile`, `pnpm run worktree:setup` (once), `pnpm run worktree:up` before any `--project integration` run; `pnpm run worktree:down` when done. Never touch the dev server on :3000.
- Every mutation below is applied, run, recorded (exact failing assertion text) and reverted; `git status` must be clean of mutations before each commit. Commit the task's real edits BEFORE applying a mutation (a `git checkout` restore would otherwise discard them).

---

### Task 1: Services return `ErasureOutcome`; route branches on it

Task order is load-bearing: Task 2 consumes the route shape this task writes.

**Files:**
- Modify: `src/services/gdpr.ts` — `AlreadyErasedError` (~line 300-325) and its docblock; `deleteStudentAccount` (~371, transaction at ~377-923, post-commit loop after); `deleteTeacherAccount` (~1043, transaction ending ~1516, post-commit diagnostics after).
- Modify: `src/app/api/account/route.ts` — imports (~14-16), the two `catch` blocks (~127-215).
- Modify: `src/services/gdpr.test.ts` — sites at ~1682-1684, ~2584-2632, and the comments at ~986-987 and ~1206-1207 naming the error.
- Modify: `src/services/gdpr-lock-order.test.ts` — import (~26), assertions ~1937-1940, comment ~1870-1874.
- Modify if typecheck requires: `src/app/api/registrations/route-lock-order.test.ts` (`settleErasure(erasure: Promise<void>)`, ~79; its local `type ErasureOutcome` at ~49 shares the new exported type's name — rename it `SettledErasure` whether or not typecheck forces the file open, so one name has one meaning in the repo).

**Interfaces:**
- Produces:
  ```ts
  // src/services/gdpr.ts
  export type ErasureOutcome = { erased: true } | { erased: false; reason: 'already-erased' };
  export async function deleteStudentAccount(db: PrismaClient, studentId: string): Promise<ErasureOutcome>;
  export async function deleteTeacherAccount(db: PrismaClient, teacherId: string): Promise<ErasureOutcome>;
  // AlreadyErasedError: no longer exported.
  ```

- [ ] **Step 1: Rewrite the service tests to the new contract (red)**

`src/services/gdpr.test.ts` ~1682 (the #407 staged-loser test):

```ts
    const outcome = await deleteTeacherAccount(prisma, teacherId);
    expect(outcome).toEqual({ erased: false, reason: 'already-erased' });
```

`src/services/gdpr.test.ts` ~2613 (rename the `it` to `'reports already-erased and leaves the first erasure untouched'`):

```ts
    await deleteTeacherAccount(prisma, teacherId);
    const first = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });

    const outcome = await deleteTeacherAccount(prisma, teacherId);

    // (keep the existing comment on why deletedAt is asserted first)
    const after = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(after.deletedAt).toEqual(first.deletedAt);

    expect(outcome).toEqual({ erased: false, reason: 'already-erased' });
```

Drop the `.half` assertion and its comment: the caller chose which function to call, so the half is no longer information the outcome carries.

`src/services/gdpr-lock-order.test.ts` ~1937:

```ts
      // One erases; the other finds the row already erased, rolls back whole,
      // and reports it rather than rejecting.
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const outcomes = results.map((r) => (r as PromiseFulfilledResult<ErasureOutcome>).value);
      expect(outcomes.filter((o) => !o.erased)).toEqual([{ erased: false, reason: 'already-erased' }]);
```

Import `type ErasureOutcome` in place of `AlreadyErasedError`; remove `AlreadyErasedError` from both test files' imports. Update the ~1870 comment so it names the already-erased count assertion (not "rejection-count and `AlreadyErasedError` assertions") as what pins the abort.

Update the prose at `gdpr.test.ts` ~986-987 and ~1206-1207 so it says a second erasure *reports already-erased* rather than *throws `AlreadyErasedError`* — read each whole comment, don't just swap the name.

- [ ] **Step 2: Run to verify red**

Run: `pnpm exec vitest run src/services/gdpr.test.ts src/services/gdpr-lock-order.test.ts`
Expected: FAIL. Vitest does not typecheck, so the not-yet-existing `type ErasureOutcome` import erases and the files run. The two sequential cases fail because `await deleteTeacherAccount(...)` rejects with `AlreadyErasedError: teacher profile is already erased`; the concurrent case fails on `expect(results.every(fulfilled)).toBe(true)` (received `false`). `pnpm run typecheck` fails too, on the missing export — expected until Step 3.

- [ ] **Step 3: Implement in `gdpr.ts`**

Remove `export` from `class AlreadyErasedError`. Add, beside `ErasureHalf`:

```ts
/**
 * What an erasure did. `erased: false` is not a failure: the profile was
 * already erased, by a concurrent request that won, and this call's own
 * transaction rolled back whole rather than commit a redundant second pass.
 * A caller that ignores the value is still correct — the goal holds either
 * way. Every genuine failure rejects.
 */
export type ErasureOutcome = { erased: true } | { erased: false; reason: 'already-erased' };
```

Rewrite `AlreadyErasedError`'s docblock to what is true now: private to this file; thrown inside each erasure's transaction solely so it aborts; caught by the same function around its `db.$transaction` and turned into `{ erased: false, reason: 'already-erased' }`; never escapes the module. Keep the paragraph about what does and does not prevent the doubled `spot_available` broadcast (it is still true). Replace the "`DELETE /api/account` maps this to the same 200" sentence — that route now reads the outcome.

Add one private helper beside the class, so neither transaction body is re-indented:

```ts
/**
 * `null` when `committing` aborted on `AlreadyErasedError`; the transaction
 * has rolled back whole. Every other rejection passes through unchanged.
 */
async function unlessAlreadyErased<T>(committing: Promise<T>): Promise<T | null> {
  try {
    return await committing;
  } catch (err) {
    if (err instanceof AlreadyErasedError) return null;
    throw err;
  }
}
```

In `deleteStudentAccount`:

```ts
  const freedClassIds = await unlessAlreadyErased(db.$transaction(async (tx) => {
    /* unchanged body */
  }, { /* unchanged options */ }));
  if (freedClassIds === null) return { erased: false, reason: 'already-erased' };
```

Neither transaction's callback can itself return `null` (`string[]` and the teacher's `skipped` value), so `null` is unambiguous. The compiler would NOT flag a callback that could return `null` (`T | null` absorbs it), so check the teacher's `skipped` type when applying; if it admits `null`, return a module-private `unique symbol` instead of `null`. The post-commit `handleSpotFreed` loop is unreachable on the already-erased path, which is correct: the transaction committed nothing. End the function with `return { erased: true };`.

Same shape in `deleteTeacherAccount` around its `db.$transaction(...)` that returns `skipped`; the post-commit diagnostic reads are skipped on the already-erased path (nothing committed, nothing to diagnose). End with `return { erased: true };`. Update the comment at ~1084 ("that loser now ends in a 200 (`AlreadyErasedError`)") to say the loser's erasure reports already-erased.

- [ ] **Step 4: Route — branch on the outcome**

`src/app/api/account/route.ts`: import `type ErasureOutcome` (used in Task 2) and drop `AlreadyErasedError`. In the student half:

```ts
  if (session.studentId) {
    let outcome: ErasureOutcome;
    try {
      outcome = await deleteStudentAccount(prisma, session.studentId);
    } catch (err) {
      if (err instanceof ErasureLockSetError) { /* unchanged */ }
      /* unchanged transient/else branch */
    }
    if (!outcome.erased) {
      log.info({ accountId: session.accountId, half: 'student' }, 'account erasure: half already erased');
    }
  }
```

Teacher half likewise, with `half: 'teacher'`. Both `catch` blocks keep every existing non-sentinel branch unchanged. Rewrite the two sentinel comments to what is true now: the service reports an already-erased half as a value; why it is a success (the caller's goal holds); why the student half still goes on to the teacher half; why it is only reachable concurrently (`validateSession` resolves only live profiles). Drop the "`err` in the payload" paragraphs — the sentinel no longer reaches the route, so there is no stack to keep. The `partial` comment in the teacher catch (~190) says the student half "can throw `AlreadyErasedError`, roll back whole" — reword to "can report already-erased, having rolled back whole"; its conclusion is unchanged.

Response at the end stays `respondOk({ deleted: true })` in this task.

- [ ] **Step 5: Typecheck and run**

Run: `pnpm run typecheck` — fix `route-lock-order.test.ts`'s `settleErasure` parameter if it errors (`Promise<unknown>`); rename its local `ErasureOutcome` type to `SettledErasure` regardless.
Run: `pnpm exec vitest run src/services/gdpr.test.ts src/services/gdpr-lock-order.test.ts src/app/api/registrations/route-lock-order.test.ts`
Expected: PASS.
Run (worktree app up): `pnpm exec vitest run --project integration tests/integration/account-api.test.ts`
Expected: PASS (route behaviour unchanged in this task).

- [ ] **Step 6: Commit**

```bash
git add src/services/gdpr.ts src/app/api/account/route.ts src/services/gdpr.test.ts src/services/gdpr-lock-order.test.ts src/app/api/registrations/route-lock-order.test.ts
git commit -m "fix(gdpr): erasures return an outcome; the already-erased sentinel stays private (#213)"
```

- [ ] **Step 7: Mutation proofs (after the commit)**

Each: apply, run the named test, record the exact failing assertion, `git checkout -- <file>`, confirm `git status` clean.

1. **The student abort bites.** Delete `if (erased.count === 0) throw new AlreadyErasedError('student');`. Run `gdpr-lock-order.test.ts -t "erases once"`. Expect the already-erased filter to be `[]` instead of one element.
2. **The teacher abort bites.** Delete the teacher's `throw new AlreadyErasedError('teacher')`. Run `gdpr.test.ts -t "already-erased"`. Expect `deletedAt` moved or outcome `{ erased: true }`.
3. **The service rethrows everything else.** In `deleteStudentAccount`'s catch, replace `throw err;` with `return { erased: false, reason: 'already-erased' };`. Run `gdpr-lock-order.test.ts` — the test asserting `toBeInstanceOf(ErasureLockSetError)` (~2433) must fail. If nothing fails, that is a finding: add a test that a non-sentinel failure rejects, before continuing.
4. **Same for the teacher catch.** Find (or add) a test in which `deleteTeacherAccount` must reject with a non-sentinel error; the mutation must turn it red.

---

### Task 2: `DELETE /api/account` answers `respondUnchanged` when nothing was left to erase

**Files:**
- Modify: `src/app/api/account/route.ts` — collect outcomes, choose the response at the end (~217-221).
- Test: `tests/integration/account-api.test.ts` — `'answers both halves of a concurrent erasure with success'` (~775) and `'finishes the teacher half when the student half was erased underneath it'` (~841); their docblocks (~751-773, ~826-860).

**Interfaces:**
- Consumes: `ErasureOutcome`, `deleteStudentAccount`, `deleteTeacherAccount` from Task 1; `respondUnchanged<T>(data)` from `src/lib/api-utils.ts` (200, body `{ data, outcome: 'unchanged' }`).

- [ ] **Step 1: Write the failing assertions**

In the concurrent test, after `expect([a.status, b.status]).toEqual([200, 200]);`:

```ts
    // The loser's erasure had nothing left to do — the winner did it — so it
    // is answered as already done; the winner as an ordinary deletion. Order
    // of the two responses is not fixed, so compare as a sorted pair.
    const bodies = (await Promise.all([a.json(), b.json()])) as { data: unknown; outcome?: string }[];
    expect(bodies.map((body) => body.outcome ?? 'applied').sort()).toEqual(['applied', 'unchanged']);
    expect(bodies.map((body) => body.data)).toEqual([{ deleted: true }, { deleted: true }]);
```

In the dual-role test, after its status assertion (`expectApplied` is in `tests/api-assertions.ts`, beside the already-imported `expectUnchanged`):

```ts
    // The student half was already erased; the teacher half was erased by
    // THIS request — so the request did work, and is not "unchanged".
    expect(await expectApplied(res)).toEqual({ deleted: true });
```

(If the dual test already reads `res.json()`, fold that read into this one — a body can be read once.)

A new test in the `DELETE /api/account` describe, beside the two above: a session on an `Account` with no live profile at all. `requireSession` admits it (it checks the session, not the profiles), so it reaches the handler, attempts neither half, and must keep the ordinary answer. Seed it the way the describe's other helpers do, tracking the id in `seededAccountIds` for teardown:

```ts
  /**
   * #213: "unchanged" means this request attempted a half and every half it
   * attempted had already been erased by someone else. A session holding no
   * live profile attempts nothing — so it is not that case, and keeps the
   * ordinary deletion answer (and the cookie clear) it had before.
   */
  it('answers an account with no live profile as an ordinary deletion', async () => {
    const mail = `accdel-noprofile-${suffix}@test.local`;
    const account = await prisma.account.create({ data: { email: mail } });
    seededAccountIds.push(account.id);
    const token = await seedSession(prisma, account.id);

    const res = await fetch(`${BASE_URL}/api/account`, { method: 'DELETE', headers: cookie(token) });

    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect(await expectApplied(res)).toEqual({ deleted: true });
  });
```

Before writing it, check the describe for an existing profile-less test and extend that one instead if there is one; check what `clearSessionCookie` actually emits and match the `set-cookie` assertion to it rather than to the regex above. Confirm the teardown order in the describe's `afterAll` deletes this account's `Session` rows before the `Account` (add it if sessions are only deleted for profile-bearing accounts).

- [ ] **Step 2: Run to verify red**

Run: `pnpm exec vitest run --project integration tests/integration/account-api.test.ts -t "concurrent erasure"`
Expected: FAIL — `['applied', 'applied']` vs `['applied', 'unchanged']`. The dual-role and no-profile assertions pass already (correct: they pin the other two directions, proven by mutations 2 and 3 below).

- [ ] **Step 3: Implement**

In the route, collect each half's outcome and choose at the end:

```ts
  const outcomes: ErasureOutcome[] = [];
  // … student half: outcomes.push(outcome) after the try …
  // … teacher half: outcomes.push(outcome) after the try …

  // Already done only when this request attempted something and every half
  // it attempted had been erased by someone else first: then it wrote
  // nothing. A session with no live profile attempts nothing and keeps the
  // ordinary answer.
  const response =
    outcomes.length > 0 && outcomes.every((o) => !o.erased)
      ? respondUnchanged<{ deleted: true }>({ deleted: true })
      : respondOk({ deleted: true });
  clearSessionCookie(response.headers);
  return response;
```

`clearSessionCookie` still runs on the unchanged path: the winner already deleted the sessions, and the caller's cookie now points at nothing.

Rewrite both test docblocks to what is true now: the service reports the loser's half as already erased (no `AlreadyErasedError` reaching the route), the route answers it as success and — for the all-already-erased case — as unchanged. Keep the lever explanations; they are still true.

- [ ] **Step 4: Run to verify green**

Run: `pnpm exec vitest run --project integration tests/integration/account-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/account/route.ts tests/integration/account-api.test.ts
git commit -m "fix(account): a deletion with nothing left to erase answers unchanged (#213)"
```

- [ ] **Step 6: Mutation proofs (after the commit)**

1. Replace the ternary with `respondOk({ deleted: true })` → concurrent test fails `['applied','applied']`.
2. Replace `every` with `some` → dual-role test fails (`outcome` is `'unchanged'`).
3. Drop `outcomes.length > 0 &&` → the no-profile test fails (`outcome` is `'unchanged'`: `[].every(...)` is `true`).

Restore after each; `git status` clean.

---

### Task 3 (controller, not a subagent): Sweep for what was invalidated

- [ ] `grep -rn "AlreadyErasedError" src tests docs --exclude-dir=superpowers` — every hit must be inside `src/services/gdpr.ts`. Plans and specs under `docs/superpowers/` are records and stay as written.
- [ ] `grep -rn "Promise<void>" src/services/gdpr.ts` — no hit on either erasure's signature.
- [ ] Read each whole docblock in the two erasure functions and the route handler for descriptions (not names) that still say the sentinel escapes, e.g. "rejects", "throws … to the caller", "maps this to".
- [ ] `pnpm run verify` (worktree app up). Record the per-project file arithmetic for the PR body.
