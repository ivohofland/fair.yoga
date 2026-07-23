# Waitlist Promote Deletion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the manual waitlist-promote path so promotion is FIFO-only (issue #45).

**Architecture:** Delete the `POST /api/waitlist/[id]/promote` route, then simplify `promoteNext` to the queue-head path only (drop its `entryId` option and branch). This is a pure deletion of untested dead code — inverted-TDD: the gate is that the existing suite stays green after each removal, not a new failing test. Order matters: the route must go first, because it is the only caller passing `entryId`, so the signature change would otherwise break `tsc`.

**Tech Stack:** Next.js 14 App Router route handlers, TypeScript strict, Prisma, Vitest + Playwright.

## Global Constraints

- TypeScript `strict: true` — no `any`, no implicit types. `npx tsc --noEmit` must stay clean.
- Services are framework-agnostic; `promoteNext` keeps taking `(db, classId, opts)` and returning `WaitlistEntry | null`.
- No schema change, no migration.
- No doc change — product-concept §2's automation story is already correct; this makes the build match it.
- Keep untouched: `DELETE /api/waitlist/[id]` (both branches), `WaitlistPromotionError` (incl. the `'entry_not_waiting'` reason — still thrown by `claimSpot`), the `WaitlistEntryActions` student component, and every waitlist test.
- Verify against the running app on `localhost:3000` for integration/e2e (see [[local-dev-test-quirks]]).

---

### Task 1: Delete the promote route

**Files:**
- Delete: `src/app/api/waitlist/[id]/promote/route.ts` (and its now-empty `promote/` directory)

**Interfaces:**
- Consumes: nothing (this route is a leaf; no code imports it).
- Produces: nothing. Removing it drops one import each of `promoteNext` and `WaitlistPromotionError` from `@/services/waitlist`; both remain exported and used elsewhere (the claim route imports `WaitlistPromotionError`; the auto-promote sweep calls `promoteNext`).

- [ ] **Step 1: Confirm the route is a leaf (nothing imports it)**

Run: `grep -rn "waitlist/\[id\]/promote\|/promote'" src tests`
Expected: only matches inside `src/app/api/waitlist/[id]/promote/route.ts` itself. No importer anywhere else (the student UI hits `DELETE /api/waitlist/[id]`, not promote).

- [ ] **Step 2: Delete the route file and its directory**

Run:
```bash
git rm src/app/api/waitlist/[id]/promote/route.ts
rmdir "src/app/api/waitlist/[id]/promote" 2>/dev/null || true
```
Expected: the file is staged for deletion; the empty `promote/` dir is gone.

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: both exit 0. `promoteNext`'s `entryId` branch is now dead but still compiles — that is fine; Task 2 removes it.

- [ ] **Step 4: Run the waitlist + registrations tests (nothing referenced the promote route)**

Run: `npx vitest run --project unit src/services/waitlist.test.ts --project integration tests/integration/registrations-api.test.ts`
Expected: all pass. The `promoteNext (DB)` service tests use the queue-head path only; the `DELETE /api/waitlist/[id]` authorization tests are untouched.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: delete the manual waitlist-promote route (#45)

FIFO-only — a teacher promoting a chosen entry is a queue-jump the docs
never promised. Automation (auto-promote the head, claim-broadcast in the
final hour) is the whole story. The route was UI-less and untested; it was
the only caller of promoteNext's entryId path (removed next).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Simplify `promoteNext` to the queue-head path only

**Files:**
- Modify: `src/services/waitlist.ts` (the `promoteNext` JSDoc + signature + the entry-selection block; roughly lines 259–360)

**Interfaces:**
- Consumes: the queue-head selection loop, `hasActiveRegistration`, `reorderWaitingEntries`, `WaitlistPromotionError` — all already present and still used after the edit.
- Produces: `promoteNext(db: PrismaClient, classId: string, opts?: { now?: Date }): Promise<WaitlistEntry | null>` — the `entryId` option is gone. The only remaining caller is the auto-promote sweep (`waitlist.ts`, `promoteNext(db, classId, { now })`), which is unaffected.

- [ ] **Step 1: Replace the JSDoc above `promoteNext`**

Old:
```ts
/**
 * Promotes a waiting student: creates a Registration, links it to the
 * waitlist entry, notifies the student, and reorders remaining positions.
 *
 * Without `entryId`, the queue head is promoted; with `entryId`, that
 * specific entry is promoted (teacher's explicit choice).
 *
 * Guards (all inside the transaction, serialized by a FOR UPDATE lock on
 * the class row shared with the registration route):
```
New:
```ts
/**
 * Promotes the head of the waitlist queue: creates a Registration, links it
 * to the waitlist entry, notifies the student, and reorders remaining
 * positions. Stale heads (a student who booked directly but whose `waiting`
 * row survives) are dropped and skipped rather than promoted.
 *
 * Guards (all inside the transaction, serialized by a FOR UPDATE lock on
 * the class row shared with the registration route):
```

- [ ] **Step 2: Narrow the signature — drop `entryId`**

Old:
```ts
export async function promoteNext(
  db: PrismaClient,
  classId: string,
  opts: { entryId?: string; now?: Date } = {},
): Promise<WaitlistEntry | null> {
```
New:
```ts
export async function promoteNext(
  db: PrismaClient,
  classId: string,
  opts: { now?: Date } = {},
): Promise<WaitlistEntry | null> {
```

- [ ] **Step 3: Replace the entry-selection block with the queue-head loop only**

Old (the comment + the `if (opts.entryId) { … } else { for (;;) { … } }` selector, and the `if (!nextEntry)` block below it):
```ts
    // Find the entry to promote. Entries can go stale — a student books the
    // class directly and their `waiting` row survives. A stale head must be
    // dropped, not promoted: promoting it would violate the unique
    // (classId, studentId) registration constraint and wedge the queue.
    let nextEntry: WaitlistEntry | null = null;
    if (opts.entryId) {
      const candidate = await tx.waitlistEntry.findFirst({
        where: { id: opts.entryId, classId, status: 'waiting' },
      });
      if (candidate && (await hasActiveRegistration(tx, classId, candidate.studentId))) {
        await tx.waitlistEntry.update({
          where: { id: candidate.id },
          data: { status: 'removed' },
        });
        await reorderWaitingEntries(tx, classId);
        throw new WaitlistPromotionError(
          'This student already has a registration for the class',
          'entry_not_waiting',
        );
      }
      nextEntry = candidate;
    } else {
      for (;;) {
        const candidate = await tx.waitlistEntry.findFirst({
          where: { classId, status: 'waiting' },
          orderBy: { position: 'asc' },
        });
        if (!candidate) break;
        if (!(await hasActiveRegistration(tx, classId, candidate.studentId))) {
          nextEntry = candidate;
          break;
        }
        await tx.waitlistEntry.update({
          where: { id: candidate.id },
          data: { status: 'removed' },
        });
      }
    }

    if (!nextEntry) {
      if (opts.entryId) {
        throw new WaitlistPromotionError('Waitlist entry is not waiting', 'entry_not_waiting');
      }
      return null;
    }
```
New:
```ts
    // Find the queue head to promote. Entries can go stale — a student books
    // the class directly and their `waiting` row survives. A stale head must
    // be dropped, not promoted: promoting it would violate the unique
    // (classId, studentId) registration constraint and wedge the queue.
    let nextEntry: WaitlistEntry | null = null;
    for (;;) {
      const candidate = await tx.waitlistEntry.findFirst({
        where: { classId, status: 'waiting' },
        orderBy: { position: 'asc' },
      });
      if (!candidate) break;
      if (!(await hasActiveRegistration(tx, classId, candidate.studentId))) {
        nextEntry = candidate;
        break;
      }
      await tx.waitlistEntry.update({
        where: { id: candidate.id },
        data: { status: 'removed' },
      });
    }

    if (!nextEntry) return null;
```

- [ ] **Step 4: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: both exit 0. Confirms no other caller passed `entryId`, and that `hasActiveRegistration` / `reorderWaitingEntries` / the `'entry_not_waiting'` reason are still used (lines 189/344, 255/396/489, and `claimSpot` respectively) — no unused-symbol errors.

- [ ] **Step 5: Run the waitlist service tests**

Run: `npx vitest run --project unit src/services/waitlist.test.ts`
Expected: all pass — `promoteNext (DB)` ("promotes the first waiting student", "promotes the second student when another spot frees", "returns null when no waiting students remain") exercise exactly the retained queue-head path.

- [ ] **Step 6: Full-suite verification (the deletion gate)**

Run (dev server on :3000 must be up — `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health` → 200):
```bash
npx tsc --noEmit && npx eslint src tests && npx vitest run && npx playwright test student-journey teacher-journey
```
Expected: `tsc`/`eslint` clean; full vitest green; the auto-promote e2e (`student-journey.spec.ts` "a freed seat auto-promotes the waiting student") and the teacher journey pass. (If `signup-api.test.ts` shows 429s, that's the known 3/hour local rate limiter, not this change — a fresh `:3000` clears it; CI runs fresh.)

- [ ] **Step 7: Confirm the route is gone at runtime**

Run: `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/waitlist/whatever/promote`
Expected: `405` (Next.js — no handler for that path/method).

- [ ] **Step 8: Commit**

```bash
git commit -am "refactor: promoteNext is queue-head only (#45)

Drop the entryId option and its branch — the manual-promote route (removed)
was its only caller. Signature narrows to { now?: Date }; the queue-head
loop (the automation) and its stale-entry skipping are unchanged. No test
touched: the promoteNext service tests already exercise only this path.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Open the PR

**Files:** none (git/gh only).

- [ ] **Step 1: Push the branch**

Run: `git push -u origin refactor/remove-waitlist-promote`

- [ ] **Step 2: Open the PR** (closes #45)

```bash
gh pr create --title "refactor: FIFO-only waitlist — delete the manual promote path (#45)" --body "$(cat <<'BODY'
Closes #45. Spec: docs/superpowers/specs/2026-07-23-waitlist-promote-deletion-design.md

## Summary
FIFO-only. Deletes POST /api/waitlist/[id]/promote (UI-less, untested, a manual queue-jump the docs never promised) and narrows promoteNext to the queue-head path (drops its entryId option — the route was its only caller). Automation is unchanged.

## Kept deliberately
- DELETE /api/waitlist/[id] — both branches, incl. the tested API-only teacher-moderation path (Ivo's call).
- WaitlistPromotionError (still thrown by claimSpot and the auto-promote sweep).
- All waitlist tests — the promoteNext service tests already use only the queue-head path.

## Verification
tsc + eslint clean; full vitest green; student-journey auto-promote e2e + teacher-journey pass; POST to the old route now 405s. Pure deletion of untested code — no test changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 3: Report the PR URL and hand off for review** (the `/pr-review-toolkit:review-pr` flow, then merge on Ivo's word).

---

## Self-Review

**Spec coverage:** every spec item maps to a task — delete promote route (Task 1); simplify `promoteNext` signature + branch + JSDoc (Task 2); keep DELETE/`WaitlistPromotionError`/tests (Global Constraints + verification steps); no docs change (Global Constraints); green-suite gate (Task 2 Step 6); route-gone check (Task 2 Step 7). PR (Task 3).

**Placeholder scan:** none — every edit shows exact old→new code and exact commands with expected output.

**Type consistency:** `promoteNext(db, classId, opts?: { now?: Date }): Promise<WaitlistEntry | null>` is used identically in the signature (Task 2 Step 2) and the Interfaces block; the sole surviving caller `promoteNext(db, classId, { now })` matches. `WaitlistPromotionError` and its `'entry_not_waiting'` reason are retained, consistent with `claimSpot`'s continued use.
