# Fire-and-Forget Return Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `deliverInvitation` structurally impossible to await into the #166 account-enumeration oracle, by returning `void` instead of `Promise<void>` and owning its own rejection path.

**Architecture:** A new `FireAndForget` type alias (`= void`) names the contract in the signature, where a reader meets it at the moment they would otherwise reach for `await`. Because the function returns no promise, `.then()`/`.catch()` on its result are compile errors under the `tsc --noEmit` gate CI already runs, and a bare `await` is inert rather than harmful. Two compile-time pins keep both halves honest: one on the alias (it must stay `void`), one on `deliverInvitation`'s own use of it (it must not drift back to `Promise<void>`).

**Tech Stack:** TypeScript 5.9 strict, Next.js 14 App Router, Prisma, Vitest (`unit` project), pino (`@/lib/log`), ESLint 9 flat config.

**Spec:** None. Direction was agreed at the brainstorming gate rather than in a spec document — this is one service function, two call sites, one type alias and two doc edits, with a single settled approach. The source of record is GitHub issue #391, plus the correction to its premise stated below.

## Global Constraints

- **The issue's premise is corrected, not implemented as written.** #391 asks for an ESLint rule. This plan ships no lint rule, no restricted-name list, and does not enable type-aware linting. The reasoning must appear in the PR body: a lint rule is a policy (disableable, enumerates only the syntactic shapes it thought of, needs a registration list that can go stale); a signature that returns no promise is a constraint. Issue #391's acceptance criteria are met in substance — the build fails on `.then()`/`.catch()` — but not in the literal form it proposed, and the PR body must say so plainly.
- **No renaming of `deliverInvitation`.** The contract is carried by the return type, not by the identifier.
- **`await deliverInvitation(...)` remains legal and harmless.** It awaits `undefined` — one microtask, no coupling to delivery. This is deliberate and must be stated in the docblock; do not add machinery to forbid it.
- **Both existing log messages survive verbatim:** `'failed to notify invitee'` (create path) and `'failed to resend invitation'` (resend path). Both log lines must keep `teacherId` and `invitationId`, and must keep the email address OUT of the logs (#166 review, F4).
- **TypeScript strict, no `any`.** Rejection parameters are typed `unknown`.
- **Never edit an applied migration.** This plan touches no migrations and no schema.
- **In this worktree, integration and e2e cannot run locally** — both need the app live on `:3000` and the shared dev database. Local verification is scoped to typecheck, lint, `unit`, and `components`. CI is the signal for integration/e2e, and the PR body must cite the CI run for those tiers rather than a local run.
- **Never `git add -A` or `git add .`** — stage exact paths.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/fire-and-forget.ts` | **Create.** The `FireAndForget` alias, its docblock (the contract, stated where a reader meets it), and the fixture pinning it to `void`. | 1 |
| `src/lib/type-pins.ts` | **Modify.** Export the existing private `Equals` / `Assert` helpers so the new fixture shares them rather than copying them. Additive — the `NoneOf` prose is not touched. | 1 |
| `src/services/invitations.ts` | **Modify.** `deliverInvitation` returns `FireAndForget`, owns its `.catch`, takes an object input carrying `invitationId` and `source`. Adds the `DeliverySource` type, the message table, and the return-type pin. Corrects `notifyInvitee`'s docblock. | 2 |
| `src/app/api/students/route.ts` | **Modify.** Call site loses its `void`/`.catch` wrapper; its two comment blocks are corrected. | 2 |
| `src/app/api/invitations/[id]/resend/route.ts` | **Modify.** Same. | 2 |
| `src/services/invitations.deliver.test.ts` | **Create.** Behavioural cover: returns nothing awaitable; a failure is logged and swallowed rather than escaping as an unhandled rejection; the message differs per `source`. Runs in the `unit` project (`src/**/*.test.ts`, not in `SERIAL_TESTS`). | 2 |
| `docs/technical-architecture.md` | **Modify.** The human-facing home for the convention, in The Services Layer section. | 2 |
| `CLAUDE.md` | **Modify.** One line, secondary to the doc above. | 2 |

---

### Task 1: The `FireAndForget` type and its pin

**Files:**
- Create: `src/lib/fire-and-forget.ts`
- Modify: `src/lib/type-pins.ts:73-75` (add `export` to two aliases, add one comment)

**Interfaces:**
- Consumes: nothing.
- Produces: `export type FireAndForget = void` from `@/lib/fire-and-forget`; `export type Equals<A, B>` and `export type Assert<T extends true>` from `@/lib/type-pins`. Task 2 imports all three.

- [ ] **Step 1: Export the shared fixture helpers**

In `src/lib/type-pins.ts`, the aliases currently read:

```ts
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
```

Replace with — note the added comment annotates only these two lines, and the surrounding `NoneOf` prose is left exactly as it is:

```ts
// Exported because `fire-and-forget.ts` asserts its own alias with these too.
// Shared rather than copied: two fixtures that each defined "the same type"
// for themselves could drift into disagreeing about it, which is the class of
// problem pins exist to catch.
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type Assert<T extends true> = T;
```

- [ ] **Step 2: Write the new module with its pin**

Create `src/lib/fire-and-forget.ts`:

```ts
import type { Assert, Equals } from './type-pins';

/**
 * The return type of work that must never be awaited.
 *
 * `void`, deliberately. A function returning no promise cannot couple its
 * caller's response — status or latency — to work the caller must not wait
 * for, and `.then()` / `.catch()` on the result are compile errors rather
 * than review findings. That is a constraint the compiler applies at every
 * call site, present and future, instead of a discipline each caller has to
 * have read about first.
 *
 * The alias exists for what a bare `void` does not say: it names the contract
 * in the signature, where a reader meets it at the moment they would
 * otherwise reach for `await`. A function returning this owns its own
 * rejection path — there is no promise left for a caller to attach a `.catch`
 * to, so the logging belongs inside.
 *
 * Awaiting one is legal and inert: `await` on a non-promise yields a
 * microtask and nothing else, so the mistake costs a tick rather than
 * reopening anything. That is the point — the harmful version is
 * unrepresentable, so the harmless one needs no rule.
 *
 * `grep -rn '): FireAndForget' src/` enumerates every function carrying the
 * contract. Deliberately not a count: a number written here would be accurate
 * for one branch, the same argument `type-pins.ts` makes about its own
 * dependants.
 */
export type FireAndForget = void;

/**
 * The alias's own pin. The realistic regression is not a caller doing
 * something exotic — it is someone widening this alias back to
 * `Promise<void>` while refactoring, which silently restores the awaitable
 * shape every call site was protected by. That rewrite fails here.
 *
 * Honest about the limit, as `type-pins.ts` is about its own: this pins the
 * ALIAS. A function that stops using the alias and declares `Promise<void>`
 * directly is a separate hole, pinned separately at `deliverInvitation`
 * itself (`services/invitations.ts`).
 */
type _fireAndForgetIsVoid = Assert<Equals<FireAndForget, void>>;
void 0 as unknown as [_fireAndForgetIsVoid];
```

- [ ] **Step 3: Verify the build is green**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 4: Prove the alias pin bites (mutation)**

Temporarily change the alias to the exact regression it guards:

```ts
export type FireAndForget = Promise<void>;
```

Run: `npm run typecheck`
Expected: FAIL at `_fireAndForgetIsVoid`, shape `Type 'false' does not satisfy the constraint 'true'` (TS2344). **Record the actual error text verbatim** — it goes in the PR body.

- [ ] **Step 5: Restore and re-verify**

Restore `export type FireAndForget = void;`.

Run: `npm run typecheck`
Expected: exit 0. A mutation that is not restored and re-verified proves nothing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fire-and-forget.ts src/lib/type-pins.ts
git commit -m "$(cat <<'EOF'
feat(types): add FireAndForget, the return type that cannot be awaited harmfully

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `deliverInvitation` returns it, and every claim about the old shape is corrected

**Files:**
- Modify: `src/services/invitations.ts` (the `deliverInvitation` function ~585-619, `notifyInvitee`'s docblock ~473-486)
- Modify: `src/app/api/students/route.ts:137-158`
- Modify: `src/app/api/invitations/[id]/resend/route.ts:89-97`
- Create: `src/services/invitations.deliver.test.ts`
- Modify: `docs/technical-architecture.md` (The Services Layer, after the intro at line 111-115)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `FireAndForget` from `@/lib/fire-and-forget`; `Assert`, `Equals` from `@/lib/type-pins` (Task 1).
- Produces: `export type DeliverySource = 'create' | 'resend'` and the new signature
  `deliverInvitation(db: PrismaClient, input: { teacherId: string; email: string; invitationId: string; source: DeliverySource }): FireAndForget`
  from `@/services/invitations`. Nothing later depends on this task.

- [ ] **Step 1: Write the failing test**

Create `src/services/invitations.deliver.test.ts`. A nonexistent teacher id makes the internal `findUniqueOrThrow` reject, which is the realistic failure — a delivery that blows up after the response is already decided:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { deliverInvitation } from './invitations';
import { log } from '@/lib/log';

const prisma = new PrismaClient();

/**
 * `deliverInvitation` is the one function in this file a caller must not be
 * able to wait for: awaited, it turns a Resend outage into a 500 for an
 * unregistered address while a registered one still answers normally, and
 * even healthy it is a timing channel (#166). The compiler holds the shape
 * (`FireAndForget`, plus the pin beside the function); these hold the
 * behaviour that shape depends on — that the rejection path is owned inside,
 * because there is no longer a caller `.catch` to own it.
 */
describe('deliverInvitation — fire-and-forget by construction (#391)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns nothing a caller could await on', async () => {
    // Spied because this call is going to fail (no such teacher) and log. The
    // assertion here is only about the return value, but an unspied failure
    // would print after the test ended, once `restoreAllMocks` had put the
    // real logger back.
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const result = deliverInvitation(prisma, {
      teacherId: 'no-such-teacher-391a',
      email: 'nobody-391a@test.local',
      invitationId: 'inv-391a',
      source: 'create',
    });

    expect(result).toBeUndefined();

    // Let the internal rejection settle inside the test, not after it.
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  });

  it('logs a failure and swallows it, instead of rejecting into the caller', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      deliverInvitation(prisma, {
        teacherId: 'no-such-teacher-391b',
        email: 'nobody-391b@test.local',
        invitationId: 'inv-391b',
        source: 'create',
      });

      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));

      expect(error.mock.calls[0][1]).toBe('failed to notify invitee');
      const context = error.mock.calls[0][0] as Record<string, unknown>;
      expect(context.teacherId).toBe('no-such-teacher-391b');
      expect(context.invitationId).toBe('inv-391b');
      // The address is the one field on this pair worth keeping out of the
      // logs (#166 review, F4) — the id pair is what finds the row.
      expect(JSON.stringify(context)).not.toContain('nobody-391b@test.local');

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('names the resend path in its own log line', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    deliverInvitation(prisma, {
      teacherId: 'no-such-teacher-391c',
      email: 'nobody-391c@test.local',
      invitationId: 'inv-391c',
      source: 'resend',
    });

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0][1]).toBe('failed to resend invitation');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project unit src/services/invitations.deliver.test.ts`
Expected: FAIL — the current signature is positional (`db, teacherId, email`), so the object argument is a type error and `result` is a Promise, not `undefined`.

- [ ] **Step 3: Refactor the function**

In `src/services/invitations.ts`, add to the imports at the top:

```ts
import type { FireAndForget } from '@/lib/fire-and-forget';
import type { Assert, Equals } from '@/lib/type-pins';
```

Replace the whole `deliverInvitation` docblock and function (currently `export async function deliverInvitation(...)` returning `Promise<void>`) with:

```ts
/** Which caller a failed delivery came from — chooses the log line below. */
export type DeliverySource = 'create' | 'resend';

/**
 * One message per source, tethered: adding a `DeliverySource` member without
 * a message here is a compile error rather than a log line reading
 * `undefined`.
 */
const DELIVERY_FAILURE_MESSAGE = {
  create: 'failed to notify invitee',
  resend: 'failed to resend invitation',
} satisfies Record<DeliverySource, string>;

/**
 * Loads the inviting teacher's display name and notifies the invitee — the
 * whole "decide + deliver" tail of a successful, unblocked invite.
 *
 * Returns `FireAndForget` (`= void`), which is the guard, not a decoration:
 * whatever this function reads, or how long it takes, must never become the
 * caller's response status or its latency, and a function that hands back no
 * promise gives a caller nothing to wait for. Awaited, an earlier version of
 * this turned a Resend outage into a 500 for an unregistered address while a
 * registered one still answered 201 — and even with Resend healthy, "no
 * work" (blocked) vs. "one query" (registered) vs. "one HTTPS round trip"
 * (stranger) is a timing channel carrying the same bit. That is the oracle
 * #166 closed, and #391 is why it is now shut by the signature instead of by
 * a MUST every caller had to read.
 *
 * The rejection path lives here for the same reason: there is no promise for
 * a caller to attach a `.catch` to, so an unhandled rejection would be the
 * default if this function did not handle its own. `invitationId` and
 * `source` are parameters rather than anything this function could derive —
 * they are what makes the log line name WHICH delivery failed, and from
 * which route (#166 review, F4). The invitee's address is deliberately not
 * logged.
 *
 * Fire-and-forget is safe here specifically: this is a long-lived Node
 * process on a single VPS, not a serverless function that could be frozen
 * mid-request.
 */
export function deliverInvitation(
  db: PrismaClient,
  input: { teacherId: string; email: string; invitationId: string; source: DeliverySource },
): FireAndForget {
  void (async () => {
    const teacher = await db.teacher.findUniqueOrThrow({
      where: { id: input.teacherId },
      select: { firstName: true, lastName: true },
    });
    await notifyInvitee(db, {
      teacherId: input.teacherId,
      email: input.email,
      teacherName: `${teacher.firstName} ${teacher.lastName}`,
    });
  })().catch((err: unknown) => {
    log.error(
      { err, teacherId: input.teacherId, invitationId: input.invitationId },
      DELIVERY_FAILURE_MESSAGE[input.source],
    );
  });
}

/**
 * This function's own use of the alias, pinned. `fire-and-forget.ts` pins the
 * alias to `void`; this pins that THIS function still returns it, so a
 * signature quietly restored to `Promise<void>` — the change that reopens the
 * #166 oracle — fails the build instead of merely outdating a docblock.
 */
type _deliverInvitationReturnsVoid = Assert<Equals<ReturnType<typeof deliverInvitation>, void>>;
void 0 as unknown as [_deliverInvitationReturnsVoid];
```

- [ ] **Step 4: Update the create call site**

In `src/app/api/students/route.ts`, the block currently starting `// Fire-and-forget, on purpose — see \`deliverInvitation\`'s docblock` through the closing `});` of the `.catch` becomes:

```ts
  // Fire-and-forget by signature, not by discipline: `deliverInvitation`
  // returns `FireAndForget` (`= void`), so this response's status and latency
  // cannot be coupled to a delivery that may take an HTTPS round trip — the
  // #166 oracle, shut by the type (#391). The failure path and its log line
  // live inside that function, since there is no promise here to catch on.
  if (result.value.delivered) {
    deliverInvitation(prisma, {
      teacherId: session.teacherId,
      email: parsed.data.email,
      invitationId: result.value.id,
      source: 'create',
    });
  }
```

Leave the preceding `result.value.delivered` paragraph (the `TeacherBlock` / already-linked gate) exactly as it is — it is still true and is about a different thing.

- [ ] **Step 5: Update the resend call site**

In `src/app/api/invitations/[id]/resend/route.ts`, replace the `// Fire-and-forget, same shape as ...` comment and the `void deliverInvitation(...).catch(...)` block with:

```ts
  // Fire-and-forget by signature, same as `POST /api/students` — this route's
  // response must not vary in status or latency with whether the address is
  // registered, blocked, or unknown, and `FireAndForget` is what stops a
  // future edit here from coupling them (#391).
  deliverInvitation(prisma, {
    teacherId: session.teacherId,
    email: invitation.email,
    invitationId: id,
    source: 'resend',
  });
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run --project unit src/services/invitations.deliver.test.ts`
Expected: 3 passed.

- [ ] **Step 7: Prove the internal catch bites (mutation)**

Delete the `.catch((err: unknown) => { ... });` from `deliverInvitation`, leaving the bare `void (async () => { ... })();`.

Run: `npx vitest run --project unit src/services/invitations.deliver.test.ts`
Expected: FAIL — "logs a failure and swallows it" times out in `vi.waitFor` because nothing logs, and `unhandled` fires. **Record the actual failure output.** Restore the `.catch`, re-run, confirm 3 passed.

- [ ] **Step 8: Prove the compile guard bites (mutation)**

At the resend call site, append `.catch(() => {})` to the `deliverInvitation(...)` call.

Run: `npm run typecheck`
Expected: FAIL, shape `Property 'catch' does not exist on type 'void'` (TS2339). **Record the actual error text verbatim** — with Task 1 Step 4's text, this is the pair that proves #391's acceptance criterion is met by the type rather than by a lint rule. Restore, re-run, confirm exit 0.

- [ ] **Step 9: Prove the function-level pin bites (mutation)**

Change `deliverInvitation`'s declared return type from `FireAndForget` to `Promise<void>` and make the function `async` again (leaving the body otherwise intact).

Run: `npm run typecheck`
Expected: FAIL at `_deliverInvitationReturnsVoid`. **Record the error text.** This is the mutation the alias pin alone cannot catch, which is why both pins exist. Restore, re-run, confirm exit 0.

- [ ] **Step 10: Answer the alias-display question, then write the docs to match**

The discoverability claim — that a reader hovering `deliverInvitation` sees `FireAndForget` rather than an expanded `void` — is **unverified and must not be shipped as fact until checked.** TypeScript sometimes eagerly expands aliases to primitives.

Check it: run `npx tsc --noEmit --declaration --emitDeclarationOnly --outDir /tmp/fyd-391 2>/dev/null` and read the emitted signature in `/tmp/fyd-391/services/invitations.d.ts`, or hover the symbol in an editor.

- If the alias **survives**: the docs and PR body may state the hover/discoverability benefit.
- If it **expands to `void`**: strike that claim from the docs and the PR body, and say so — the compile-error guard and the greppability are unaffected, and remain the real justification. Do not invent a workaround for it in this task.

Record which of the two happened.

- [ ] **Step 11: Sweep every claim about the old shape — a verdict per location**

The old arrangement ("both callers await nothing, each with its own `.catch`") is asserted in more places than the two edited above. Visit each and record a verdict — corrected, or still true and why. **Correct by replacing the sentence, never by annotating it with what it used to say** (that belongs in the PR body).

1. `src/services/invitations.ts` — `notifyInvitee`'s docblock, the paragraph beginning "Neither `POST /api/students` ... nor `POST /api/invitations/[id]/resend` awaits this function — both call it fire-and-forget ... each with its own `.catch` for the rejection path." **Expected: correct it** — the `.catch` is no longer each caller's, and "awaits nothing" is now enforced rather than observed.
2. `src/services/invitations.ts` — the `// and \`not pending\` before calling \`deliverInvitation\`` comment inside `notifyInvitee` (~line 552). Expected: still true (it is about gating, not awaiting) — confirm and leave.
3. `src/app/api/invitations/[id]/resend/route.ts` — the route docblock's "written before `deliverInvitation` is even called" (~line 23). Expected: still true — confirm and leave.
4. `src/services/invitations.notify.test.ts:199` — comment mentioning `deliverInvitation` and resend's gating. Expected: still true — confirm and leave.
5. `src/services/invitations.gate.test.ts:28` — "the route answers 409 before both the `lastNotifiedAt` write and `deliverInvitation`". Expected: still true — confirm and leave.
6. Re-derive the list rather than trusting it: `grep -rn "deliverInvitation" src/ docs/ CLAUDE.md` and give every hit not already covered above a verdict.

- [ ] **Step 12: Write the human-facing convention note**

In `docs/technical-architecture.md`, immediately after The Services Layer intro (the paragraph ending "...if mobile apps require it.", line ~115), add:

```markdown
### Work that must not be awaited

A few service functions must never sit on a request's critical path — their
duration or failure would leak something the response is meant to withhold.
`deliverInvitation` (`services/invitations.ts`) is the case that named the
rule: awaited, it turns an email-provider outage into a 500 for an
unregistered address while a registered one still answers normally, which is
the account-enumeration oracle #166 closed.

These functions return `FireAndForget` (`src/lib/fire-and-forget.ts`), an
alias for `void`. Returning no promise is what enforces the contract —
`.then()` and `.catch()` on the result are compile errors, so a caller cannot
couple its response to the work even without knowing why they shouldn't.
A bare `await` on one is legal and inert: it yields a microtask and nothing
else.

**Writing a new one:** return `FireAndForget`, start the work in a
`void (async () => { … })().catch(…)`, and handle the rejection inside — there
is no promise left for a caller to attach a handler to, so an unhandled
rejection is the default if the function does not own its own. Take whatever
context the log line needs (an id, which caller) as parameters.

`grep -rn '): FireAndForget' src/` lists every function under this rule.
```

- [ ] **Step 13: Add the CLAUDE.md line**

In `CLAUDE.md`, under **Development Principles**, after the "Services are framework-agnostic" paragraph, add:

```markdown
**Work that must not be awaited returns `FireAndForget`, not `Promise<void>`.**
A function whose duration or failure would leak something its caller's
response withholds hands back no promise, so `.then()`/`.catch()` on it are
compile errors and the contract survives a caller who never read this file.
`deliverInvitation` (#166, #391) is the case that named it; the rule and how
to write a new one are in `docs/technical-architecture.md` (The Services
Layer → Work that must not be awaited).
```

- [ ] **Step 14: Verify everything that can run in a worktree**

Run: `npm run typecheck && npm run lint && npx vitest run --project unit --project components`
Expected: all green. Record the test counts — the PR body needs the arithmetic.

Integration and e2e are **not** run here (no app on `:3000`, no shared dev database in a worktree). They are CI's job, and the PR body cites the CI run for those tiers.

- [ ] **Step 15: Commit**

```bash
git add src/services/invitations.ts src/services/invitations.deliver.test.ts \
  src/app/api/students/route.ts 'src/app/api/invitations/[id]/resend/route.ts' \
  docs/technical-architecture.md CLAUDE.md
git commit -m "$(cat <<'EOF'
refactor(invitations): make deliverInvitation unawaitable by signature (#391)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

Note the quoting on the bracketed path — an unquoted `[id]` is a glob that silently matches nothing.

---

## What this plan does not do

- **No ESLint rule, no restricted-name list, no type-aware linting.** #391 proposed one; the correction and its reasoning belong in the PR body.
- **No rename of `deliverInvitation`,** and no `@fireAndForget` JSDoc tag convention.
- **No change to what either route returns, to delivery behaviour, or to any gate** — `inviteContact`'s `delivered`, the `TeacherBlock` re-check and the already-linked check are untouched. **#166 and #412 are unaffected.**
- **No migration, no schema change.**
- It does not force a future contributor to *recognise* that a new function has this contract. Nothing can — the issue's own proposals share that gap. What changes is that the concept is visible from the code (a type in the signature) rather than only from a config file or a doc.
