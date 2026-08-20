# Class Resume CAS + Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `pauseOrResumeTemplate` the compare-and-swap and the generation claim its studio twin already has, closing a measured race that leaves an archived template marked active with four publicly bookable classes.

**Architecture:** The resume transaction becomes CAS → claim → generate, mirroring `pauseOrResumeStudioTemplate` statement for statement. The CAS (`FOR NO KEY UPDATE`) makes archiving-during-resume unrepresentable; the claim (`FOR UPDATE`) makes a concurrent `Class` insert impossible rather than leaving it to `ON CONFLICT DO NOTHING`. Because `updateMany` returns a count where `update` threw, `P2025` becomes unreachable under the transaction and its catch branch is removed — `not_found` is answered by the CAS's miss classification instead. Four comment corrections ride along, three of which this change makes mandatory rather than optional.

**Tech Stack:** TypeScript strict, Prisma 6, PostgreSQL, Vitest (3 projects: `unit`, `components`, `integration`), Next.js 14 App Router.

**Spec:** `docs/superpowers/specs/2026-08-20-class-resume-cas-claim-design.md`

## Global Constraints

- **TypeScript `strict: true`** — no `any`, no implicit types. `noUncheckedIndexedAccess` is on: indexing is `T | undefined`.
- **Services are framework-agnostic** — no HTTP concerns in `src/services/`.
- **Never edit an applied migration.** This branch adds none.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses.
- **Never start or restart the dev server on :3000.** The user runs it; integration tests need it live.
- **Never write `close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved` immediately before `#N`** in a commit message or PR body — GitHub's parser matches it and does not understand a negation in front. Write "**#N is unaffected**". When *explaining* the trap, break the token (`[keyword] #113`) rather than quoting it.
- **`@/lib/log` is pino and server-only** — safe here; nothing in this branch imports it into a client component.
- **Commit per task** — the PR is rebase-merged, never squashed; the commit-per-task history is the record.
- **Every guard gets a mutation** that uses a value the code under test cannot produce. Record the exact error text, restore, re-verify. Mutations are deliverables: append each one to `docs/superpowers/plans/2026-08-20-class-resume-cas-claim-mutations.md` as you go — **create that file in Task 2 Step 12, the first mutation** — one section per mutation with the diff applied, the command run, and the verbatim failure output. A mutation you did not record did not happen.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/services/class-template-lifecycle.ts` | Class template pause/resume/archive/update services | Modify — the CAS, the claim, the outcome union, two comment corrections |
| `src/services/class-template-lifecycle.test.ts` | DB-backed tests for the above | Modify — four new race tests |
| `src/services/studio-class-template-lifecycle.ts` | Studio twin | Modify — one stale pointer (comment only) |
| `src/services/class-generator.ts` | Generator + `claimTemplateForGeneration` | Modify — correct the "LATENT, not live" note (comment only) |
| `src/services/gdpr.ts` | Account erasure | Modify — lock-mode conflation (comment only) |
| `src/components/settings/template-action-messages.ts` | Pure resolver for button confirmations | Modify — class un-archive message, switch conversion |
| `src/components/settings/template-action-messages.test.ts` | Resolver tests | Modify — two new cases |

---

### Task 1: Correct the zero-count CAS lock claim (#117)

Comment-only, no behaviour change. **First, deliberately** — Task 2 adds a *second* zero-count CAS branch to this same file, and it must be born carrying the corrected reasoning rather than copying the wrong sentence next door.

**Files:**
- Modify: `src/services/class-template-lifecycle.ts:1199-1200`
- Modify: `src/services/studio-class-template-lifecycle.ts:805-815`

**Interfaces:**
- Consumes: nothing.
- Produces: the corrected wording Task 2 will cite.

- [ ] **Step 1: Read the current claim**

Run: `sed -n '1195,1215p' src/services/class-template-lifecycle.ts`

It currently asserts, in `archiveOrUnarchiveTemplate`'s `count === 0` branch:

```
// This read takes a fresh READ COMMITTED snapshot and holds no lock:
// the CAS matched nothing, so it acquired none. With three concurrent
```

The second clause is false in one of the two interleavings.

- [ ] **Step 2: Replace the wrong clause**

Replace the "holds no lock: the CAS matched nothing, so it acquired none" assertion with:

```ts
          // This read takes a fresh READ COMMITTED snapshot. Whether it also
          // runs under a lock this transaction already holds depends on which
          // interleaving produced the miss, and the re-read is correct either
          // way — which is the point, because the two differ:
          //
          //   - the conflicting change committed BEFORE this statement's own
          //     snapshot → the `where` evaluated against, and was rejected by,
          //     that already-committed version, and nothing was locked;
          //   - the conflicting change committed WHILE this statement was
          //     already blocked waiting on it → Postgres takes
          //     `LockTupleExclusive` on the newest row version *before*
          //     running the EvalPlanQual re-check, so a rejection at that
          //     point still leaves the lock held to commit.
          //
          // Settled by experiment during #94 — three Prisma connections and a
          // `FOR UPDATE NOWAIT` probe — not from the docs. The second row is
          // not exotic: it is the interleaving this repo's own three-
          // transaction race tests construct. The sentence this replaces said
          // flatly that a missed CAS "holds no lock: the CAS matched nothing,
          // so it acquired none" (#117), which invites a contributor to add a
          // read-then-write here believing the row is pinned. The reasoning
          // about whether to lock on purpose survives that correction; the
          // claim about what is already held does not.
```

- [ ] **Step 3: Fix the studio pointer that quotes the old sentence**

`studio-class-template-lifecycle.ts:805-815` currently forwards readers here and says the class version "asserts flatly that a missed CAS 'holds no lock: the CAS matched nothing, so it acquired none' … and #117 owns correcting it." That pointer goes stale the moment Step 2 lands.

Replace the forwarding paragraph's last sentences with:

```ts
          // Follow that hop knowing the class family now carries this same
          // correction rather than the flat "holds no lock" claim it asserted
          // until #117 — the two families agree about this mechanism again,
          // and a future edit to either owes the other the same visit.
```

- [ ] **Step 4: Verify nothing else repeats the wrong claim**

Run:
```bash
grep -rn "acquired none\|holds no lock" src/ docs/superpowers/
```
Expected: no hits in `src/`. If a hit appears in a spec or plan under `docs/superpowers/`, correct it there too and say so in the task report — a claim corrected in one artifact and left standing in another is this project's most-repeated failure.

- [ ] **Step 5: Verify the build is clean**

Run: `npm run typecheck && npm run lint`
Expected: both pass. No test runs — this task changes no behaviour, and saying so is more honest than inventing a test that cannot fail.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts
git commit -m "docs: a zero-count CAS may hold a lock after all (issue 117)"
```

---

### Task 2: Replace the plain update with a compare-and-swap

The core of the branch. Closes the measured archive race and removes the now-unreachable `P2025` branch.

**Files:**
- Modify: `src/services/class-template-lifecycle.ts:858-1000` (the `pauseOrResumeTemplate` transaction and its result mapping)
- Test: `src/services/class-template-lifecycle.test.ts` (the `pauseOrResumeTemplate (DB)` describe block, ends at line 1951)

**Interfaces:**
- Consumes: `setLockTimeout` (`@/lib/db-locks`), `scheduledWhere`, `startOfLocalDay`, `isTransientDbError`.
- Produces: an internal `ResumeTransactionOutcome` union that Task 3 extends with the claim. Exact shape:

```ts
type ResumeTransactionOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'archived' }
  | { outcome: 'unchanged'; template: ClassTemplate }
  | { outcome: 'paused'; template: ClassTemplate }
  | {
      outcome: 'active';
      template: ClassTemplate;
      scheduled: number;
      added: number;
      blockedByCancelled: number;
      slotTaken: number;
    };
```

`PauseTemplateResult` (the public type, line 628) is **unchanged** — `not_found`, `archived`, `unchanged` and `busy` all already exist on it. Only which code path produces them changes.

- [ ] **Step 1: Write the failing test — an archive landing between the read and the write**

Add to the `pauseOrResumeTemplate (DB)` describe block, immediately after the existing "maps a delete landing between the read and the write to not_found" test (line 1921). It uses the same interposing-`$extends` lever, archiving instead of deleting:

```ts
  /**
   * The window this test drives is the one the pre-transaction guards cannot
   * cover: the `findUnique` at the top of the function and the transaction's
   * first write are not one statement, so an archive committing in between is
   * invisible to the guard that already passed. Before the CAS, the write's
   * `where` was `{ id }` alone and simply did not notice — it set
   * `isActive: true` on a row that had just been archived and then generated a
   * four-week window onto it. `pauseOrResumeStudioTemplate`'s docblock
   * describes exactly this failure for its own family, which is why the fix is
   * a port rather than an invention.
   */
  it('answers archived when an archive lands between the read and the write', async () => {
    const t = await makeTemplate('Archive Race');
    await prisma.classTemplate.update({ where: { id: t.id }, data: { isActive: false } });

    let archived = false;
    // Cast for the same reason the sibling tests' `interposing` clients need
    // one: the extended client is missing `$on`, so it is not assignable to
    // `pauseOrResumeTemplate`'s `PrismaClient`-typed `db` parameter.
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!archived) {
              archived = true;
              await prisma.classTemplate.update({
                where: { id: t.id },
                data: { isArchived: true, isActive: false, archivedAt: new Date() },
              });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'archived' });

    // The refusal is not the whole guarantee: assert the two states the old
    // code actually corrupted. Without these, dropping `isArchived: false`
    // from the CAS and answering `archived` from a stale read would pass.
    const after = await prisma.classTemplate.findUnique({ where: { id: t.id } });
    expect(after?.isActive).toBe(false);
    expect(await prisma.class.count({ where: { templateId: t.id } })).toBe(0);
  });
```

- [ ] **Step 2: Run it and watch it fail against the bug**

Run: `npx vitest run src/services/class-template-lifecycle.test.ts -t 'answers archived when an archive lands'`

Expected: **FAIL**. The measured pre-fix behaviour is
`{ ok: true, action: 'active', … }` with `isActive: true` and 4 classes, so the
first assertion fails with a received value of `{ ok: true, action: 'active', … }`.
If it passes here, stop — the test is not driving the window, and nothing below is worth building.

- [ ] **Step 3: Write the failing test — a pause landing in the same window**

```ts
  it('answers unchanged when a pause lands between the read and the write', async () => {
    const t = await makeTemplate('Pause Race');

    let paused = false;
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!paused) {
              paused = true;
              await prisma.classTemplate.update({
                where: { id: t.id },
                data: { isActive: false },
              });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe('unchanged');
  });
```

- [ ] **Step 4: Write the failing test — guard order inside the miss branch**

This is the one a careless implementation gets wrong, and it pins the *order* of two checks rather than their presence.

```ts
  /**
   * An archived row racing a *pause* is simultaneously "already the desired
   * state" (archiving forces `isActive: false`) and "archived". The miss
   * branch must answer `unchanged`, matching the fast path above it — checking
   * `isArchived` first would answer a plain pause with a 409 meant for
   * resuming an archived template. A racing *resume* is not already-desired,
   * so it falls through to `isArchived` regardless of order; only this
   * direction can tell the two orderings apart.
   */
  it('answers unchanged, not archived, when an archive races a pause', async () => {
    const t = await makeTemplate('Order Race');

    let archived = false;
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!archived) {
              archived = true;
              await prisma.classTemplate.update({
                where: { id: t.id },
                data: { isArchived: true, isActive: false, archivedAt: new Date() },
              });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe('unchanged');
  });
```

- [ ] **Step 5: Run all three and confirm they fail for the right reasons**

Run: `npx vitest run src/services/class-template-lifecycle.test.ts -t 'lands between the read and the write'` then `-t 'races a pause'`

Expected: the archive test fails as in Step 2. Record what the other two actually do before the fix in the task report — a test that already passes is not evidence for this change and must be said so plainly rather than counted.

- [ ] **Step 6: Add the internal outcome union**

Insert above `pauseOrResumeTemplate` (near line 790, after `scheduledWhere`), with the docblock:

```ts
/**
 * One arm per way `pauseOrResumeTemplate`'s transaction can resolve. Internal
 * only — mapped to the public `PauseTemplateResult` after the transaction
 * commits. Mirrors `ResumeTransactionOutcome` in
 * `studio-class-template-lifecycle.ts`; the two families are meant to be read
 * side by side.
 *
 * None of these carries the stale pre-transaction snapshot the CAS exists to
 * stop being trusted, but they reach that differently: `paused` and `active`
 * are read back under a lock the successful CAS is still holding, while
 * `unchanged` comes from a plain re-read in the miss branch that may or may
 * not run under a lock this transaction already holds — see that branch, and
 * `archiveOrUnarchiveTemplate`'s, for why the re-read is correct either way.
 */
type ResumeTransactionOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'archived' }
  | { outcome: 'unchanged'; template: ClassTemplate }
  | { outcome: 'paused'; template: ClassTemplate }
  | {
      outcome: 'active';
      template: ClassTemplate;
      scheduled: number;
      added: number;
      blockedByCancelled: number;
      slotTaken: number;
    };
```

- [ ] **Step 7: Replace the plain update with the CAS**

Replace lines 871-875 (`const t = await tx.classTemplate.update({ … })`) with:

```ts
        // A compare-and-swap, not a plain `update`. The two guards at the top
        // of this function are read outside any lock and are fast paths only,
        // not the guarantee: an archive can commit between those reads and
        // this write. Keyed on `{ id }` alone — which is what stood here until
        // #116 — this statement would not notice. It would re-read the new row
        // version and set `isActive: true` on a template that had just been
        // archived, then generate a four-week window onto it: measured, four
        // `open` classes on an archived template, which is precisely the
        // shelved-but-bookable state #86 exists to prevent. Constraining the
        // write to the exact `isArchived`/`isActive` values the guards saw
        // makes that transition impossible rather than merely unlikely.
        //
        // `updateMany`, not `update`, because `update` throws P2025 when
        // nothing matches and a CAS miss is an ordinary outcome here, not an
        // exception — see the miss branch below for the three things it can
        // mean. That choice is also why this transaction no longer has a
        // P2025 source at all; the `catch` below records the full enumeration.
        const swapped = await tx.classTemplate.updateMany({
          where: { id: templateId, isArchived: false, isActive: !desiredActive },
          data: { isActive: desiredActive },
        });

        if (swapped.count === 0) {
          // [Task 1's corrected wording applies here too — a miss may or may
          // not leave this transaction holding a lock, and this plain re-read
          // is correct either way. See `archiveOrUnarchiveTemplate`'s own miss
          // branch for the full account rather than repeating it.]
          const current = await tx.classTemplate.findUnique({ where: { id: templateId } });
          if (!current) return { outcome: 'not_found' };
          // `isActive === desiredActive` before `isArchived`, deliberately —
          // the same order as the fast paths above, and for the same reason:
          // archiving forces `isActive: false`, so an archived row racing a
          // *pause* is simultaneously "already the desired state" and
          // "archived". Checking already-desired first answers that case
          // `unchanged`, matching the fast path; checking `isArchived` first
          // would answer a plain pause with a 409 meant for resuming an
          // archived template. A racing *resume* is not already-desired, so it
          // falls through regardless of order.
          if (current.isActive === desiredActive) {
            return { outcome: 'unchanged', template: current };
          }
          if (current.isArchived) return { outcome: 'archived' };
          // Residual, not provably unreachable. This CAS's `where` is
          // `isArchived: false AND isActive: !desiredActive`; a miss means one
          // of those held *when the CAS ran*, and both are checked above
          // against a second, later read. Under READ COMMITTED each statement
          // takes its own snapshot, so a row that changed back in between — a
          // second race stacked on the first — could in principle reach here.
          throw new Error(
            `pauseOrResumeTemplate: CAS matched no row for template ${templateId} ` +
              'and a later read found it neither already in the desired state nor ' +
              'archived — a second race stacked on the first, or the CAS predicate ' +
              'and this classification have diverged',
          );
        }
```

- [ ] **Step 8: Replace the paused short-circuit and the active arm**

Replace lines 876-913 (from `if (!t.isActive) {` through `return { template: t, generation, scheduled };`) with:

```ts
        if (!desiredActive) {
          // `updateMany` returns a count, not a row. Safe to read back without
          // a lock re-check: the CAS above matched, so this transaction holds
          // `FOR NO KEY UPDATE` on the row and nothing can change or delete it
          // before we commit. `OrThrow` for that reason — a `| null` here
          // would be an impossible branch every caller had to pretend to
          // handle.
          const paused = await tx.classTemplate.findUniqueOrThrow({
            where: { id: templateId },
          });
          return { outcome: 'paused', template: paused };
        }

        // [Task 3 inserts the claim here.]
        const t = await tx.classTemplate.findUniqueOrThrow({
          where: { id: templateId },
          include: { teacher: { select: { defaultTimezone: true } } },
        });
        const generation = await generateInstancesForTemplate(tx, t);

        const today = startOfLocalDay(new Date(), t.teacher.defaultTimezone);
        const scheduled = await tx.class.count({
          where: scheduledWhere(templateId, { gte: today }),
        });
        const { teacher: _gen, ...bareT } = t;
        void _gen;
        return {
          outcome: 'active',
          template: bareT,
          scheduled,
          added: generation.created,
          ...countSkipReasons(generation.skipped),
        };
```

**Preserve the long `defaultTimezone` comment currently at lines 881-909 verbatim**, moved to sit above the `startOfLocalDay` call, with one change: it says "`t.teacher.defaultTimezone`, not the `template.teacher` read at the top of this function" and that stays true — but Task 3 rebinds `t` to the claim's return, so the comment's referent changes and must be re-pointed then, not now. Note it in the task report.

- [ ] **Step 9: Remove the dead P2025 branch and rewrite the catch's enumeration**

Delete lines 989-991 (`if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') { return null; }`) and rewrite the enumeration comment above it. Nothing under this transaction can now raise P2025:

- the CAS returns a count;
- the paused arm's `findUniqueOrThrow` runs after the CAS matched, under the `FOR NO KEY UPDATE` it took;
- `generateInstancesForTemplate` issues a `findMany` and a `createManyAndReturn`, and the insert absorbs P2002 rather than raising it;
- `class.count` cannot produce it.

`pauseOrResumeStudioTemplate`'s catch already carries only the transient branch and a rethrow; this converges on it. Keep the transient branch and its `log.warn` exactly as they are.

- [ ] **Step 10: Rewrite the post-transaction mapping**

Replace lines 995-996 and the arm handling below with a `switch` over `ResumeTransactionOutcome`, ending in a `never` default — an if-chain here would be accidentally exhaustive, the same failure the route's own switches record:

```ts
  if (result === 'busy') return { ok: false, reason: 'busy' };

  switch (result.outcome) {
    case 'not_found':
      return { ok: false, reason: 'not_found' };
    case 'archived':
      return { ok: false, reason: 'archived' };
    case 'unchanged':
      return { ok: true, action: 'unchanged', template: result.template };
    case 'paused': {
      // `gte` today, not `gt`: this reports what is still on the schedule, and
      // today's class is still on it. Pause deletes nothing, so there is no
      // spare-today carve-out here to mirror.
      const today = startOfLocalDay(new Date(), template.teacher.defaultTimezone);
      const lastScheduled = await db.class.findFirst({
        where: scheduledWhere(templateId, { gte: today }),
        orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
        select: { date: true, startTime: true },
      });
      return { ok: true, action: 'paused', template: result.template, lastScheduled };
    }
    case 'active':
      return {
        ok: true,
        action: 'active',
        template: result.template,
        scheduled: result.scheduled,
        added: result.added,
        blockedByCancelled: result.blockedByCancelled,
        slotTaken: result.slotTaken,
      };
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
```

Note the `teacher`-stripping destructure that stood after the transaction is gone: the outcome union already carries a bare `ClassTemplate`, so there is nothing left to strip. The early-return destructure at the top of the function (`const { teacher: _t, teacherRoom: _tr, ...bare }`) stays — it serves the pre-transaction paths.

- [ ] **Step 11: Run the three new tests and the whole file**

Run: `npx vitest run src/services/class-template-lifecycle.test.ts`
Expected: all pass, including the pre-existing "maps a delete landing between the read and the write to not_found" — which now reaches `not_found` through the CAS miss classification rather than through P2025. **Confirm that test still passes and say in the report which path it now takes**; if it fails, the miss branch's `!current` arm is wrong, not the test.

- [ ] **Step 12: Mutation — drop the archive predicate**

Remove `isArchived: false` from the CAS `where`. Run the archive-race test.
Expected: FAIL. Record the exact message. Restore, re-run, confirm green.

- [ ] **Step 13: Mutation — drop the already-in-state predicate**

Remove `isActive: !desiredActive` from the CAS `where`. Run the pause-race test.
Expected: FAIL. Record the exact message. Restore, re-run, confirm green.

- [ ] **Step 14: Mutation — swap the guard order**

Move `if (current.isArchived) return { outcome: 'archived' };` above the `isActive === desiredActive` check. Run the order test.
Expected: FAIL — a plain pause answered `archived`. Record the message. Restore, re-run.

- [ ] **Step 15: Commit**

```bash
git add src/services/class-template-lifecycle.ts src/services/class-template-lifecycle.test.ts
git commit -m "fix: resume takes a compare-and-swap, and the P2025 branch it makes dead (issue 116)"
```

---

### Task 3: Take the generation claim before generating

**Files:**
- Modify: `src/services/class-template-lifecycle.ts` (the active arm added in Task 2, Step 8)
- Test: `src/services/class-template-lifecycle.test.ts`

**Interfaces:**
- Consumes: `claimTemplateForGeneration(tx: TransactionClientOnly, templateId: string): Promise<TemplateWithTimezone | null>` from `./class-generator`. **Measured 2026-08-20: line 43 imports `generateInstancesForTemplate` from that module and nothing else, so add `claimTemplateForGeneration` to the existing named import — do not add a second import statement.**
- Produces: no new types.

- [ ] **Step 1: Replace the active arm's read-back with the claim**

Replace the `findUniqueOrThrow` placeholder from Task 2 Step 8 with:

```ts
        // Take the row lock before generating. The CAS above only flipped
        // `isActive`, a non-key column, so Postgres granted it `FOR NO KEY
        // UPDATE` — which does not conflict with the `FOR KEY SHARE` a
        // concurrent `Class` insert takes on this template for FK integrity.
        // Without this claim that race is live; `FOR UPDATE` makes the
        // collision impossible instead of leaving it to the generator's
        // `ON CONFLICT DO NOTHING`, which would cost that date's class with no
        // error (#116, mirroring what #94 did for the studio family).
        //
        // It also returns the row, so the generation below runs off a value
        // read under the lock rather than off the CAS's own count (#102).
        const claimed = await claimTemplateForGeneration(tx, templateId);
        if (!claimed) {
          // Genuinely unreachable, not merely believed to be. The CAS above
          // proved `isArchived: false` and set `isActive: true` in the same
          // statement that took this row's write lock, and that lock is still
          // held here — nothing can have archived, paused or deleted it since.
          // A null here would mean the claim's eligibility predicate and the
          // CAS's have drifted apart, not that a race slipped past either.
          //
          // This is the detail #116 got right for the wrong reason: it called
          // a null "a logic error rather than a race" while proposing to keep
          // the plain `update`, under which a raced archive makes null
          // legitimately reachable and this throw a 500. The CAS is what earns
          // the throw.
          throw new Error(
            `pauseOrResumeTemplate: claim returned null for template ${templateId} ` +
              "right after this transaction's own CAS confirmed it eligible — " +
              'the claim predicate and the CAS predicate have diverged',
          );
        }
```

Then use `claimed` where Task 2 used `t`: `generateInstancesForTemplate(tx, claimed)`, `startOfLocalDay(new Date(), claimed.teacher.defaultTimezone)`, and the destructure `const { teacher: _gen, ...bareT } = claimed;`.

- [ ] **Step 2: Re-point the `defaultTimezone` comment**

The long comment preserved in Task 2 Step 8 says "`t.teacher.defaultTimezone`, not the `template.teacher` read at the top of this function". Its referent is now `claimed.teacher`. Update every mention of `t.teacher` in it to `claimed.teacher`, and add:

```ts
        // `claimed.teacher`, not the CAS's own read either: the claim's
        // `findUniqueOrThrow` runs under `FOR UPDATE`, so this is the one read
        // of that column that cannot be stale, and `generateInstancesForTemplate`
        // filtered its candidate dates off this same object.
```

Keep the paragraph beginning "**No test pins this, deliberately**" verbatim — it is still true, and it is the honest record of why.

- [ ] **Step 3: Verify the claim's `findUniqueOrThrow` cannot reintroduce P2025**

The catch rewritten in Task 2 Step 9 asserts nothing under the transaction raises P2025. The claim adds a `findUniqueOrThrow`. It runs under the `FOR UPDATE` its own raw `SELECT` just took, on a transaction client, so the row provably exists — #116's body says so and it is correct. **Add that statement to the catch's enumeration** rather than leaving the list silently incomplete; the enumeration's own comment demands it of whoever adds a statement.

- [ ] **Step 4: Write the test — the claim is actually taken**

> **SUPERSEDED (PR review).** The `FOR KEY SHARE NOWAIT` probe specified below
> was not a usable harness: `generateInstancesForTemplate` skips
> `createManyAndReturn` entirely when `free.length === 0`, so a hook on the
> insert may never fire. The shipped guard is a race instead — a holder takes
> `FOR KEY SHARE` via a `Class` insert on a date outside the generator's
> window, and the resume must fail to get its `FOR UPDATE` inside the 2s bound
> and answer `busy`. See `class-template-lifecycle.test.ts`, "blocks a
> concurrent Class insert while generating, and answers busy", and the mutation
> ledger's Task 3 section. The conflict table below is still correct.


The claim's observable effect is that a concurrent `Class` insert for this template cannot interleave. The probe must be **`FOR KEY SHARE NOWAIT`**, and the mode is the whole point:

| Probe mode | With the claim (`FOR UPDATE` held) | Without it (CAS's `FOR NO KEY UPDATE` only) |
|---|---|---|
| `FOR UPDATE NOWAIT` | refused | **also refused** — cannot discriminate |
| `FOR KEY SHARE NOWAIT` | refused (`55P03`) | **granted** — discriminates |

Measured 2026-08-20 against `ethical_yoga_test`, two connections, all four cells —
not read off the conflict matrix in the manual. Reproduce it with
`docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test` if you want to see
it before trusting it.

`FOR KEY SHARE` is exactly what an inserting `Class` row's FK check takes, so this probe stands in for the real racing writer rather than for an arbitrary one. An earlier draft of this plan specified `FOR UPDATE NOWAIT`; that test would have passed against the bug, because the CAS's own `FOR NO KEY UPDATE` already conflicts with `FOR UPDATE`. Recorded rather than silently corrected — a guard that cannot fail is the failure #39 shipped three of.

```ts
  it('holds FOR UPDATE on the template row while generating', async () => {
    const t = await makeTemplate('Claim Held');
    await prisma.classTemplate.update({ where: { id: t.id }, data: { isActive: false } });

    let probeError: unknown = null;
    const interposing = prisma.$extends({
      query: {
        class: {
          async createManyAndReturn({ args, query }) {
            // Mid-transaction: the claim is held and generation is inserting.
            // A separate connection asking for the same row NOWAIT must be
            // refused (55P03), which is what proves FOR UPDATE is held.
            const probe = new PrismaClient();
            try {
              // FOR KEY SHARE, not FOR UPDATE — see the table above. This is
              // the mode a concurrent `Class` insert's FK check takes, and the
              // only one that tells "claim held" apart from "CAS held".
              await probe.$queryRawUnsafe(
                `SELECT "id" FROM "ClassTemplate" WHERE "id" = $1 FOR KEY SHARE NOWAIT`,
                t.id,
              );
            } catch (err) {
              probeError = err;
            } finally {
              await probe.$disconnect();
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'active');

    expect(result.ok).toBe(true);
    expect(probeError).not.toBeNull();
    expect(String(probeError)).toContain('55P03');
  });
```

- [ ] **Step 5: Run it, then mutate**

Run: `npx vitest run src/services/class-template-lifecycle.test.ts -t 'holds FOR UPDATE'`
Expected: PASS.

Then **remove the `claimTemplateForGeneration` call** (reverting to the `findUniqueOrThrow` of Task 2) and re-run.
Expected: **FAIL** — with only the CAS's `FOR NO KEY UPDATE` held, a `FOR KEY SHARE` probe is granted, so `probeError` stays `null` and the assertion fails. Record the exact message.

If it does **not** fail, stop and report rather than proceeding: the test does not pin what it claims, and a guard that cannot fail certifies nothing. Do not paper over it by weakening the assertion.

- [ ] **Step 6: Run the whole file**

Run: `npx vitest run src/services/class-template-lifecycle.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/class-template-lifecycle.ts src/services/class-template-lifecycle.test.ts
git commit -m "fix: resume takes the generation claim, and the throw the CAS earns (issue 116)"
```

---

### Task 4: The class family's un-archive says something

**Files:**
- Modify: `src/components/settings/template-action-messages.ts`
- Test: `src/components/settings/template-action-messages.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-3.
- Produces: `UNARCHIVE_MESSAGE` (exported const).

**No type change.** An earlier spec draft called for splitting `unarchived` from `unchanged` on `TemplateToggleResponse`; that is wrong. `StudioTemplateToggleResponse` carries the same collapsed `{ action: 'unarchived' | 'unchanged' }` arm and `resolveStudioConfirmation` still gives the two their own `case`s — TypeScript narrows a literal-union property inside a single arm.

- [ ] **Step 1: Write the failing tests**

```ts
  it('speaks on un-archive for the class family', () => {
    expect(resolveTemplateConfirmation({ action: 'unarchived' })).toBe(UNARCHIVE_MESSAGE);
  });

  it('still says nothing on unchanged for the class family', () => {
    expect(resolveTemplateConfirmation({ action: 'unchanged' })).toBeNull();
  });
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/components/settings/template-action-messages.test.ts -t 'un-archive'`
Expected: FAIL — `UNARCHIVE_MESSAGE` is not exported, so this is a compile error before it is an assertion failure.

- [ ] **Step 3: Add the message**

Beside `UNARCHIVE_STUDIO_MESSAGE` (line 227):

```ts
/**
 * The class family's twin of `UNARCHIVE_STUDIO_MESSAGE`, and the same failure
 * one arm over: `archiveOrUnarchiveTemplate` forces `isActive: false` on both
 * directions — its own comment says so — and the archive has already deleted
 * the future classes. So a teacher who un-archives to get their weekly class
 * back lands on a paused template with an empty window, and until #116 the
 * only signal was that a differently-labelled button appeared.
 *
 * "recurring class" rather than the studio wording's "template": that is what
 * this family calls the thing throughout its own copy.
 */
export const UNARCHIVE_MESSAGE =
  'Un-archived. This recurring class is paused — resume it to put classes back on your schedule.';
```

- [ ] **Step 4: Convert the resolver to a switch**

Replace `resolveTemplateConfirmation`'s if-chain (line 302) with a `switch` on `data.action`, arms in the same order as `resolveStudioConfirmation`: `paused`, `archived`, `active` (keeping the `Number.isInteger` wire checks exactly as they are), `unarchived` → `UNARCHIVE_MESSAGE`, `unchanged` → `null`, then:

```ts
    default: {
      const unhandled: never = data;
      void unhandled;
      return null;
    }
```

- [ ] **Step 5: Correct the two docblock twins**

Both now assert something false:

1. `resolveTemplateConfirmation`'s own docblock says `null` "is the correct answer for two of the five actions". It is now one — `unchanged`. Rewrite it on the model of `resolveStudioConfirmation`'s, which already says exactly that for its family.
2. `UNARCHIVE_STUDIO_MESSAGE`'s docblock says the class family's gap is "Deliberately not fixed alongside this; tracked with the rest of the class-family reporting work on #116." Replace with a note that the class family now has `UNARCHIVE_MESSAGE` and that the two differ only in the noun.

- [ ] **Step 6: Run the file, then mutate**

Run: `npx vitest run src/components/settings/template-action-messages.test.ts`
Expected: all pass.

Mutation: make `case 'unarchived'` return `null`. Expected: FAIL, recorded.
Mutation: add a sixth action to `TemplateToggleResponse` (`| { action: 'vanished' }`) without a case. Expected: **typecheck** fails at the `never` default — this is the guard the switch conversion exists for, and an if-chain would have compiled clean. Record the error, restore.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/template-action-messages.ts src/components/settings/template-action-messages.test.ts
git commit -m "fix: un-archiving a recurring class says what happened (issue 116)"
```

---

### Task 5: Correct the last lock-mode conflation (#126)

Comment-only. **After Task 3**, because the sentence being corrected also names which resumes take the claim, and Task 3 changes that answer.

**Files:**
- Modify: `src/services/gdpr.ts:1239-1245`

- [ ] **Step 1: Read the claim**

Run: `sed -n '1236,1250p' src/services/gdpr.ts`

It says the `updateMany`s "take the same row locks `claimTemplateForGeneration` / `claimStudioTemplateForGeneration` … hold". They do not: an `updateMany` takes `FOR NO KEY UPDATE`, the claims take `FOR UPDATE`. Different modes, different conflict sets — `FOR NO KEY UPDATE` does not conflict with the `FOR KEY SHARE` an FK check takes, and `FOR UPDATE` does. #125 corrected this at six sites across four files; this is the last one.

- [ ] **Step 2: Replace it**

```ts
    // The `classTemplate.updateMany`/`studioClassTemplate.updateMany` below
    // contend for the same ROWS that `claimTemplateForGeneration` /
    // `claimStudioTemplateForGeneration` (class-generator.ts,
    // studio-class-generator.ts) lock for the duration of their own
    // per-template transactions (#95) — not in the same MODE, which is the
    // distinction #126 corrects here last of seven sites (#125 did the other
    // six). An `updateMany` takes `FOR NO KEY UPDATE`; the claims take `FOR
    // UPDATE`. The two conflict with each other, which is all this paragraph
    // needs — but they differ against a third party: an inserting row's FK
    // check takes `FOR KEY SHARE`, which `FOR UPDATE` blocks and `FOR NO KEY
    // UPDATE` does not.
    //
    // Those claims are held by the sweep for both families, and by both
    // families' resume — the studio family's since #94, the class family's
    // since #116 — so account erasure can block on a sweep or a resume in
    // progress the same way an archive or pause click can.
```

Keep everything from "This site needs the matching 10s budget…" onward verbatim.

- [ ] **Step 3: Verify no other file still conflates the two**

Run: `grep -rn "same row lock" src/`
Expected: no hits.

- [ ] **Step 4: Verify the build**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/gdpr.ts
git commit -m "docs: the last file conflating FOR NO KEY UPDATE with FOR UPDATE (issue 126)"
```

---

### Task 6: Door 3 is reachable — mark it, and correct the note that says otherwise

Comment-only, and the most important comment in the branch: it corrects a live claim that this branch's own measurement falsified.

**Files:**
- Modify: `src/services/class-generator.ts:365` (the `LATENT, not live` note in `generateClassInstances`)
- Modify: `src/services/class-template-lifecycle.ts:850` (beside the door-3 guard)

- [ ] **Step 1: Correct the generator's note**

It currently says the active-template-on-archived-room state is "**LATENT, not live**" because "after this branch no teacher action produces that state: door 1 refuses to archive a room an active template uses, and doors 3, 4 and 5 refuse to resume, create or move an active template onto an archived room."

Measured on this branch, that is false. Door 3 refuses only in a non-transactional pre-read, so a room archive landing between that read and the write produces exactly the state — four classes generated into a just-archived room:

```
{"outcome":"active","roomArchived":true,"generated":4}
```

Rewrite the "LATENT, not live" paragraph to say the state is **reachable and measured**, name the race, and point at issue #272, which carries the reproduction and the three options. Keep the rest of the note — the reasoning about why this query is safe, and about future writers of `isArchived`, still stands.

- [ ] **Step 2: Mark door 3 known-open**

Beside the `if (desiredActive && template.teacherRoom.isArchived)` guard (line 850 on `main`):

```ts
  // KNOWN-OPEN (issue 116). This guard reads `teacherRoom.isArchived` from the
  // non-transactional `findUnique` at the top of this function, so a room
  // archive committing between that read and the CAS below is invisible to it:
  // measured on #116's branch, four classes generated into a just-archived
  // room. The template's own archive race IS closed, by the CAS — but a CAS on
  // `ClassTemplate` cannot carry a predicate on the related room's column.
  //
  // Not closed here, deliberately, and not by oversight: `room-archive.ts`
  // (see its own KNOWN-OPEN, spec section 8) accepts this same race class from
  // the other side rather than locking, because the alternative is a new
  // `FOR UPDATE` node in the ordering `template-lock-order.test.ts` exists to
  // defend. A re-read after the CAS would close the interleaving measured
  // above and leave its mirror open — a half-guard whose residue would need
  // documenting forever.
  //
  // The invariant "an active template may not sit on an archived room" is
  // currently enforced by five application doors, every one a non-transactional
  // read. Enforcing it once in Postgres is the structural answer and a
  // product-and-schema decision, filed as such: issue #272, which carries the
  // reproduction above and three options.
```

- [ ] **Step 3: Verify the build**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/class-generator.ts src/services/class-template-lifecycle.ts
git commit -m "docs: door 3 is reachable, and the note that called it latent (issue 116)"
```

---

### Task 7: Whole-branch verification

- [ ] **Step 1: Run the full suite**

Run: `npm run verify`
Expected: typecheck, lint, and all three vitest projects green. Requires the app on :3000 — **do not start it**; if it is down, say so and stop.

- [ ] **Step 2: Reconcile the test count against the baseline**

The baseline is recorded in the handover. Report files and tests per project with totals that reconcile, and account for the delta: Task 2 adds 3, Task 3 adds 1 (or 0 if its test could not be made to fail — see Task 3 Step 5), Task 4 adds 2.

**Measure the after-figure; do not predict it.** A branch's own review routinely adds tests a prediction could not have known about.

- [ ] **Step 3: Verify every claim moved in every artifact**

For each of the four corrected claims, list the locations and give each its own verdict:

| Claim | Locations that must all move |
|---|---|
| zero-count CAS holds no lock (#117) | `class-template-lifecycle.ts:1199`, `studio-class-template-lifecycle.ts:805-815`, the new miss branch from Task 2 |
| `updateMany` takes the claim's lock (#126) | `gdpr.ts:1239` |
| class un-archive is unfixed | `resolveTemplateConfirmation` docblock, `UNARCHIVE_STUDIO_MESSAGE` docblock |
| archived-room state is latent | `class-generator.ts`'s note, door 3's new known-open |

**Not your job, and listed so you do not do it:** correcting issue 116's own stale text on GitHub (its `P2002`/`25P02` premise and its count census, spec §1.1-1.2) is the maintainer's, done when the PR is opened. Do not edit GitHub issues from the build.

**Derive this sweep from the diff, not from a keyword.** Run `git diff --stat main...HEAD`, list the files the branch changed, list the files it was *supposed* to change per this plan, and reconcile the two. A keyword sweep scoped to one claim cannot see another claim's twin.
