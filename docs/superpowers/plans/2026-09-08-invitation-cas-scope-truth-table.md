# Invitation CAS-Scope Truth Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin `casMatchedNothing`'s (`src/app/api/invitations/[id]/route.ts`) full per-caller truth table with unit tests, closing GitHub issue #513.

**Architecture:** One new unit-tier test file, `src/app/api/invitations/[id]/cas-scope.test.ts`, mocking `@/lib/db`'s `prisma.invitation` (`findFirst`/`updateMany`/`deleteMany`) and `requireTeacher` (`@/lib/api-utils`), following the established pattern in `src/app/api/class-templates/[id]/unknown-slot-holder.test.ts`. No production code changes — `casMatchedNothing` and its `cas: InvitationCasScope` parameter already exist (landed in #500, PR #510 fix-wave commit `d2415f2b`). This plan only adds coverage.

**Tech Stack:** Vitest (`unit` project — `src/**/*.test.ts`, `environment: 'node'`), `vi.mock`, `NextRequest` from `next/server`.

**Spec:** None — classified "bounded" during brainstorming (single file, zero production-code change, one approach with direct precedent). Issue #513 itself carries the full rationale and suggested shape; this plan implements it with one adjustment (see Global Constraints).

## Global Constraints

- **Test file location and tier:** `src/app/api/invitations/[id]/cas-scope.test.ts` — matches the `unit` project's glob (`src/**/*.test.ts`) and needs no live database, no dev server.
- **Mocking shape:** Mock `@/lib/db` (`{ prisma: { invitation: { findFirst, updateMany, deleteMany } } }`, each a module-level `vi.fn()`) and `@/lib/api-utils` (spread `importOriginal()`, override only `requireTeacher`). Do NOT mock `@/lib/log` — pino runs unmocked in this tier already (see `unknown-slot-holder.test.ts`, `daily-cleanup/route.test.ts`), and its output does not affect assertions.
- **Coverage requirement (issue #513 acceptance criteria — the stricter of the issue's two statements):** all four previously-untested cells get their own test, not the three the issue's "Suggested shape" section enumerates. The issue's own suggested shape folds `PUT`+`unread` and `DELETE`+`unread` into a single "PUT or DELETE" test, reasoning that `cas` does not affect the `'unread'` branch's control flow. That reasoning is correct about `casMatchedNothing`'s internals, but the issue's **Acceptance Criteria** section separately states "All four previously-untested cells in the table above have a test" — a literal, checkable requirement that a 3-test file does not satisfy. This plan resolves the tension by writing 4 tests: it costs one extra near-duplicate test (PUT and DELETE differ only in HTTP method and request shape) and removes all ambiguity about whether the acceptance criteria are met. State this resolution in the PR body.
- **Mutation-test requirement (issue #513, rule "prove every guard bites"):** after the test file is green, revert the `cas === 'pending' &&` conjunct in `casMatchedNothing` (route.ts) to the pre-#500 unconditional form, confirm the DELETE+accepted test (and only that one, of the four new tests) fails, then restore the conjunct and re-run to confirm all four pass again. This is a manual verification step in Task 1, not a permanent test-suite fixture.
- **No changes to `tests/integration/invitations-api.test.ts`** — of the four gaps, only `DELETE`+accepted is actually untestable at the integration tier (its only cause, `resolveInvitationOnLink` flipping a `declined` row to `accepted` mid-request, is an unsynchronizable race with no lock to park a second request on; issue #513's "Why this wasn't closed in #500's own PR" section explains why, but that section is about this one cell, not all four). `PUT`+gone could reach that tier via the same lock-chokepoint harness already used for DELETE+gone ("404s a delete whose row vanished mid-request...", `tests/integration/invitations-api.test.ts:3474`); it's covered as a unit test instead purely because mocking makes it cheap to pin alongside the two cells that truly need a rejected re-read (a real database fault) rather than a timing race. This plan does not touch that file.

---

### Task 1: Add `cas-scope.test.ts` pinning the four untested truth-table cells

**Files:**
- Create: `src/app/api/invitations/[id]/cas-scope.test.ts`
- Read only (no edits in the normal path): `src/app/api/invitations/[id]/route.ts`, `src/app/api/invitations/[id]/shared.ts`

**Interfaces:**
- Consumes: `PUT`, `DELETE` named exports from `./route` (both `(request: NextRequest, { params }: { params: Promise<{ id: string }> }) => Promise<NextResponse>`); `ownedInvitation`/`NOT_FOUND`/`DECLINED`/`NOT_PENDING` are exercised indirectly through those exports, not imported directly.
- Produces: nothing consumed by later tasks — this is the only task in this plan.

The four scenarios, and the row of the issue's truth table each pins:

| # | Handler | `cas` | Re-read (`ownedInvitation`'s 2nd call) result | Expected response |
|---|---|---|---|---|
| 1 | `PUT` | `'pending'` | resolves `null` (row gone) | `404`, `error.message === 'Contact not found'` |
| 2 | `DELETE` | `'not-declined'` | resolves an `accepted` row | `409`, `error.code === undefined` (generic — proves the `cas === 'pending' &&` conjunct excludes DELETE) |
| 3 | `PUT` | `'pending'` | rejects (re-read throws) | `409`, `error.code === undefined` (the `'unread'` arm) |
| 4 | `DELETE` | `'not-declined'` | rejects (re-read throws) | `409`, `error.code === undefined` (the `'unread'` arm) |

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The four cells of `casMatchedNothing`'s per-caller truth table (route.ts)
 * that #500's PR review found untested (#513) — `PUT`+gone, `DELETE`+accepted,
 * and `'unread'` for both callers. The CAS-race and comparative-oracle
 * behavior itself is already proven at the integration tier
 * (`tests/integration/invitations-api.test.ts`); this file pins the
 * function's own branching instead.
 *
 * Of the four, only `DELETE`+accepted is actually unreachable at the
 * integration tier: DELETE's `not-declined` CAS admits `accepted` rows
 * outright, so the only way its re-read can still find one after a miss is
 * `resolveInvitationOnLink` flipping a `declined` row back to `accepted`
 * mid-request (see `casMatchedNothing`'s docblock above) — an
 * unsynchronizable race, not a lock a second request can park on. Issue
 * #513's "Why this wasn't closed in #500's own PR" section is about this one
 * cell, not all four.
 *
 * `PUT`+gone IS reachable there — the same lock-chokepoint harness the
 * integration suite already runs for DELETE+gone ("404s a delete whose row
 * vanished mid-request...", `tests/integration/invitations-api.test.ts:3474`)
 * would reach it too, since Postgres blocks an `UPDATE` on a row an
 * uncommitted `DELETE` holds the same way it blocks a second `DELETE`. It's
 * pinned here instead because mocking makes it cheap to cover alongside the
 * two cells that truly can't be reached by any race: the `'unread'` arm for
 * both callers, which needs the re-read itself to reject (a real database
 * fault), not a timing race.
 *
 * WHY THIS IS MOCKED, following `class-templates/[id]/unknown-slot-holder.test.ts`'s
 * reasoning for the same shape of problem: each scenario needs the re-read
 * inside `casMatchedNothing` to resolve to an exact scripted value (or
 * reject) independently of the pre-check read that runs earlier in the same
 * request — two calls to the same query, two different answers, on demand.
 * Mocking `@/lib/db` is also what keeps this file from opening a real
 * database connection at all.
 */

const findFirst = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    invitation: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
      deleteMany: (...args: unknown[]) => deleteMany(...args),
    },
  },
}));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return {
    ...actual,
    requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }),
  };
});

const { PUT, DELETE } = await import('./route');

const PENDING_ROW = { id: 'inv-1', status: 'pending', isArchived: false, email: 'contact@test.local' };
const ACCEPTED_ROW = { id: 'inv-1', status: 'accepted', isArchived: false, email: 'contact@test.local' };

function put(): NextRequest {
  return new NextRequest('http://localhost:3000/api/invitations/inv-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Updated' }),
  });
}

function del(): NextRequest {
  return new NextRequest('http://localhost:3000/api/invitations/inv-1', { method: 'DELETE' });
}

const params = () => Promise.resolve({ id: 'inv-1' });

beforeEach(() => {
  findFirst.mockReset();
  updateMany.mockReset();
  deleteMany.mockReset();
});

describe("casMatchedNothing's per-caller truth table (#513)", () => {
  it('PUT answers 404 when the post-CAS re-read finds the row gone', async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockResolvedValueOnce(null);
    updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await PUT(put(), { params: params() });

    expect(res.status).toBe(404);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.message).toBe('Contact not found');
  });

  it("DELETE falls through to the generic 409 when the re-read finds an accepted row, proving cas === 'pending' is what excludes it", async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockResolvedValueOnce(ACCEPTED_ROW);
    deleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await DELETE(del(), { params: params() });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.code).toBeUndefined();
  });

  it("PUT answers the generic 409 for the 'unread' arm when the re-read itself rejects", async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockRejectedValueOnce(new Error('connection lost'));
    updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await PUT(put(), { params: params() });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.code).toBeUndefined();
  });

  it("DELETE answers the generic 409 for the 'unread' arm when the re-read itself rejects", async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockRejectedValueOnce(new Error('connection lost'));
    deleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await DELETE(del(), { params: params() });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.code).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the new file to verify it currently passes against the existing code**

Run: `npx vitest run --project unit src/app/api/invitations/[id]/cas-scope.test.ts`
Expected: PASS, 4/4 — this pins EXISTING behavior (issue #513 is a coverage gap, not a bug), so this is a "verify it's already green" step rather than red/green TDD. If any of the 4 fail here, the scenario's setup is wrong (re-check the call-count ordering of `findFirst.mockResolvedValueOnce` — the pre-check inside `PUT`/`DELETE` and the re-read inside `casMatchedNothing` are two separate calls to the same mock) — do not weaken an assertion to make it pass.

- [ ] **Step 3: Mutation-test scenario 2 — confirm the conjunct is load-bearing**

Temporarily edit `src/app/api/invitations/[id]/route.ts` line 104 from:
```typescript
    if (cas === 'pending' && observed.status === 'accepted') {
```
to the pre-#500 unconditional form:
```typescript
    if (observed.status === 'accepted') {
```

Run: `npx vitest run --project unit src/app/api/invitations/[id]/cas-scope.test.ts`
Expected: exactly 1 failure — "DELETE falls through to the generic 409 when the re-read finds an accepted row..." — now returns `409` with `error.code === 'NOT_PENDING'` instead of `undefined`, because the un-scoped conjunct fires for DELETE too. The other 3 tests still pass (they don't reach this branch). Record the exact failure output (assertion diff) for the PR body — this is the evidence the new test is mutation-sensitive to the exact regression #513 exists to close.

Revert the edit (restore line 104 to `if (cas === 'pending' && observed.status === 'accepted') {`).

Run: `npx vitest run --project unit src/app/api/invitations/[id]/cas-scope.test.ts`
Expected: PASS, 4/4 again — confirms the revert is clean and the file's state matches Step 2.

- [ ] **Step 4: Run the full unit tier to confirm no collateral effect**

Run: `npx vitest run --project unit`
Expected: PASS, previous unit count + 4 (state the exact before/after numbers in the commit message or PR body, not as a comment in the test file).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/invitations/[id]/cas-scope.test.ts"
git commit -m "$(cat <<'EOF'
test(invitations): pin casMatchedNothing's per-caller truth table (#513)

Four cells of the CAS-miss truth table for PUT ('pending' scope) and
DELETE ('not-declined' scope) were untested after #500: PUT+gone,
DELETE+accepted, and the 'unread' re-read-failure arm for both callers.
Mutation-tested by reverting the `cas === 'pending' &&` conjunct to its
pre-#500 unconditional form — exactly the DELETE+accepted test fails.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
