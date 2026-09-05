# `ClassLockSource` Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the parts of `lockClassRowsOrdered`'s 116-line docblock contract that a compiler or a parser can hold into places that hold them, and delete the prose they replace.

**Architecture:** Five changes to one lock helper and its four callers. A named exported `ClassLockSource` interface carries each parameter's rule on the parameter; two exported `Prisma.Sql` constants close the duplicated join literals; the caller's predicate is parenthesised before splicing and screened by one runtime assertion; two status lists gain a `satisfies Record<ClassStatus, boolean>` tether and share one SQL-rendering helper; two prose rosters in `gdpr.ts` become pointers to the `docs/lock-order.md` sections that own them.

**Tech Stack:** TypeScript strict, Prisma (`Prisma.Sql` / `Prisma.raw`), PostgreSQL, Vitest (`unit` project).

**Spec:** `docs/superpowers/specs/2026-09-05-lock-source-contract-design.md`

## Global Constraints

- **TypeScript strict.** No `any`. The one type assertion this plan introduces (Task 2) is narrow, justified in a docblock, and is the only one.
- **Comment Discipline (CLAUDE.md).** No count or member roster in prose; tether membership to the compiler where possible; a comment states what is true now — never "this previously read X". What a comment used to say goes in the PR body.
- **No migration.** `prisma/schema.prisma` is untouched. `ClassStatus` keeps its four members (`draft`, `open`, `in_progress`, `completed`).
- **`db-locks.ts`'s import surface is load-bearing.** It may import only `crypto` and `@prisma/client` — never `@/lib/log` (pino, server-only). `ClassStatus` enters as `import type`, which erases.
- **Test project:** `src/lib/db-locks.test.ts` runs in the `unit` project (`src/**/*.test.ts`), parallel tier. Do **not** add it to `LOCK_CONTENTION_TESTS` in `vitest.config.ts` — none of the new tests holds a lock across a signal.
- **Task order is load-bearing.** Task 1 before Task 2; Task 3 before Task 4. See each task's Interfaces block.
- **Prove every guard bites.** Each task that adds a guard ends with a mutation step: break it, record the exact error text in the ledger, restore, re-verify.

---

### Task 1: `statusInList` — one SQL renderer for frozen status lists

Extracts the character-identical `Prisma.raw(X.map((s) => "'" + s + "'").join(', '))` expression duplicated at `gdpr.ts:943` and `class-template-lifecycle.ts:497`. **Must land before Task 2**, or Task 2 edits those two expressions and Task 1 then deletes them.

**Files:**
- Modify: `src/lib/db-locks.ts` — add `import type { ClassStatus }`; add `statusInList` immediately above `lockClassRowsOrdered`'s docblock (currently line 289)
- Modify: `src/services/gdpr.ts:943`
- Modify: `src/services/class-template-lifecycle.ts:497`
- Test: `src/lib/db-locks.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function statusInList(statuses: readonly ClassStatus[]): Prisma.Sql` from `@/lib/db-locks`. Task 2 calls it with its re-shaped constants.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/db-locks.test.ts`. Put it in a new top-level `describe` placed after the `'the shared lock timeout'` block (which ends at line 145) and before `'the announcement advisory lock'`. Add `statusInList` to the existing `./db-locks` import list at the top of the file.

```ts
describe('statusInList', () => {
  it('renders a status list as the literal SQL text of an IN (…) list', () => {
    expect(statusInList(['draft', 'open', 'in_progress']).sql).toBe(
      "'draft', 'open', 'in_progress'",
    );
  });

  it('renders a single status without a separator', () => {
    expect(statusInList(['completed']).sql).toBe("'completed'");
  });

  // The `Prisma.raw`-not-`Prisma.join` decision, asserted rather than
  // described: `Prisma.join` would produce one bound parameter per status,
  // and a bound text parameter compared against the `status` column's enum
  // type needs a `::text` cast to resolve, which costs the index both
  // pre-locks' predicates rely on. A `Prisma.raw` fragment carries its text
  // in `.strings` and binds nothing.
  it('binds no parameters, so the enum comparison keeps its index', () => {
    const rendered = statusInList(['draft', 'open']);
    expect(rendered.values).toEqual([]);
    expect(rendered.strings).toEqual(["'draft', 'open'"]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx vitest run --project unit src/lib/db-locks.test.ts -t 'statusInList'
```

Expected: FAIL — TypeScript/import error, `statusInList` is not exported from `./db-locks`.

- [ ] **Step 3: Add `statusInList` to `src/lib/db-locks.ts`**

Change the import at line 2 from `import { Prisma } from '@prisma/client';` to two lines:

```ts
import { Prisma } from '@prisma/client';
import type { ClassStatus } from '@prisma/client';
```

Then insert immediately above `lockClassRowsOrdered`'s docblock:

```ts
/**
 * A frozen `ClassStatus` list, rendered as the literal SQL text of an
 * `IN (…)` list — `'draft', 'open'` — for a `ClassLockSource.where`.
 *
 * `Prisma.raw`, not `Prisma.join`. `Prisma.join` binds each status as its own
 * parameter, and a bound text parameter compared against the `status` column's
 * enum type needs an explicit `::text` cast to resolve, which costs the index
 * the pre-locks' predicates rely on — measured during issue 180 task 4.
 * `Prisma.raw` embeds the values as literal SQL text instead, so the plan is
 * the one the hand-written lists produced.
 *
 * Building SQL text by concatenation is defensible here for exactly one
 * reason, and the PARAMETER TYPE is what carries it: `ClassStatus` is a
 * generated enum union, so a caller cannot reach this with input. That used to
 * be an annotation repeated beside each of the two call sites; now it is the
 * signature.
 */
export function statusInList(statuses: readonly ClassStatus[]): Prisma.Sql {
  return Prisma.raw(statuses.map((s) => `'${s}'`).join(', '));
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run --project unit src/lib/db-locks.test.ts -t 'statusInList'
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Rewrite the two call sites to use it**

In `src/services/gdpr.ts`, replace line 943 with:

```ts
const CANCELLABLE_STATUSES_SQL = statusInList(CANCELLABLE_STATUSES);
```

and extend the existing import at line 20 to:

```ts
import { lockClassRowsOrdered, setLockTimeout, statusInList } from '@/lib/db-locks';
```

In `src/services/class-template-lifecycle.ts`, replace line 497 with:

```ts
const SCHEDULED_STATUSES_SQL = statusInList(SCHEDULED_STATUSES);
```

and extend the existing import at line 39 to:

```ts
import { lockClassRowsOrdered, setLockTimeout, statusInList } from '@/lib/db-locks';
```

- [ ] **Step 6: Collapse the two docblocks that now describe one function**

`CANCELLABLE_STATUSES_SQL`'s docblock (`gdpr.ts:929-942`) and `SCHEDULED_STATUSES_SQL`'s (`class-template-lifecycle.ts:470-496`) each spend a paragraph on the `Prisma.raw`-not-`Prisma.join` argument and a paragraph on the frozen-constant precondition. Both arguments now live once, on `statusInList`. Reduce each docblock to what is true about *that constant* and point at the helper for the rest.

`gdpr.ts` — replace lines 929-942 with:

```ts
/**
 * `CANCELLABLE_STATUSES` as SQL text, for the ordered pre-lock's predicate —
 * the one reader of that list which cannot go through a Prisma
 * `{ in: [...] }` filter, because `FOR UPDATE OF c` and `ORDER BY` have no
 * query-builder equivalent. Why the rendering is `Prisma.raw` and why that is
 * safe: `statusInList` (`db-locks.ts`).
 */
```

`class-template-lifecycle.ts` — replace lines 470-496 with:

```ts
/**
 * `SCHEDULED_STATUSES` as SQL text, for the ordered pre-lock's `$queryRaw`
 * further down — the one reader of that list which cannot go through
 * `scheduledWhere`'s Prisma `{ in: [...] }` filter, because `FOR UPDATE OF c`
 * and `ORDER BY` have no query-builder equivalent. Why the rendering is
 * `Prisma.raw` and why that is safe: `statusInList` (`db-locks.ts`).
 *
 * Derived, not retyped. This was a second hand-written `'draft', 'open'`
 * literal in the raw SQL with nothing tying the two lists together, and
 * issue 180 task 4's review measured what that cost: dropping `'draft'` from
 * the raw list left every test covering this function green, silently
 * re-opening the deadlock the pre-lock exists to close.
 */
```

The `gdpr.ts` docblock at 909-922 that cross-references `SCHEDULED_STATUSES_SQL`'s docblock by line number (`class-template-lifecycle.ts:480-482`) now points into deleted text. Replace that sentence's citation with a name-based one — `SCHEDULED_STATUSES`'s own docblock (`class-template-lifecycle.ts`) — per `docs/superpowers/specs/2026-09-01-name-based-citations-design.md`.

- [ ] **Step 7: Verify nothing else referenced the deleted prose**

```bash
grep -rn 'SCHEDULED_STATUSES_SQL\|CANCELLABLE_STATUSES_SQL' src/ docs/
grep -rn 'class-template-lifecycle.ts:4[5-9][0-9]' src/ docs/
```

Give every hit a verdict. Expect legitimate survivors (the two declarations and their two uses); expect zero surviving line-number citations into `class-template-lifecycle.ts:470-496`.

- [ ] **Step 8: Run the affected suites**

```bash
npx vitest run --project unit src/lib/db-locks.test.ts src/services/gdpr.test.ts src/services/class-template-lifecycle.test.ts
npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/db-locks.ts src/lib/db-locks.test.ts src/services/gdpr.ts src/services/class-template-lifecycle.ts
git commit -m "refactor(db-locks): one renderer for the two frozen status lists (#245)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Tether both status lists to `ClassStatus`

`const CANCELLABLE_STATUSES: readonly ClassStatus[]` erases the literal types. A fifth `ClassStatus` updates neither this list nor `SCHEDULED_STATUSES`, leaves those classes uncancelled on an Article 17 path, and keeps every test green.

The issue's proposed fix — a `const _partitionIsTotal: never = …` binding — does **not** compile clean in this repo: `eslint.config.mjs:13` sets `argsIgnorePattern: '^_'` only (arguments, not variables), so a `_`-prefixed unused top-level binding is still a `@typescript-eslint/no-unused-vars` error. Tether by construction instead, so the tether is a value the code already consumes.

**Files:**
- Modify: `src/services/gdpr.ts:923-927`
- Modify: `src/services/class-template-lifecycle.ts:464-468`
- Test: `src/services/gdpr.test.ts`, `src/services/class-template-lifecycle.test.ts`

**Interfaces:**
- Consumes: `statusInList` from Task 1 — both `*_SQL` constants already call it, and this task changes only the arrays they are called with.
- Produces: `CANCELLABLE_STATUSES` and `SCHEDULED_STATUSES` keep their names, module scope and `readonly ClassStatus[]` type. Nothing downstream changes; `[...CANCELLABLE_STATUSES]` at `gdpr.ts:1207` keeps working.

- [ ] **Step 1: Write the failing test**

Add to `src/services/gdpr.test.ts`, at the end of the file, in its own `describe`. Every symbol it uses (`vi`, `onTestFinished`, `beforeAll`, `afterAll`, `crypto`, `dbLocks`, `deleteTeacherAccount`) is already imported by that file; add nothing.

```ts
describe('the cancellable-status classification reaches the pre-lock (#245)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-cancellable-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Cancellable',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Status-partition fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  // The compiler holds MEMBERSHIP — `satisfies Record<ClassStatus, boolean>`
  // makes a fifth `ClassStatus` an error until someone classifies it. This
  // holds the DERIVATION: that the classification reaches the SQL the
  // pre-lock actually issues, so flipping a `true` cannot stay a local edit
  // that no test can see. The two together are the pin; neither alone is.
  //
  // Read off the fragment rather than a fixture's outcome because the
  // rendered `IN (…)` list is the thing that would go stale — a per-status
  // class fixture would assert the same fact through four times the setup,
  // and would still pass if the list and the record disagreed about a status
  // no fixture happened to cover.
  it('renders exactly the statuses classified cancellable', async () => {
    const original = dbLocks.lockClassRowsOrdered;
    const predicates: string[] = [];
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        predicates.push(source.where.strings.join(' ? '));
        return original(tx, source);
      });
    onTestFinished(() => spy.mockRestore());

    await deleteTeacherAccount(prisma, teacherId);

    expect(predicates).toHaveLength(1);
    expect(predicates[0]).toContain("c.status IN ('draft', 'open', 'in_progress')");
  });
});
```

`CANCELLABLE_STATUSES_SQL` is a `Prisma.raw` fragment spliced into that template, and a nested fragment's text is flattened into the outer fragment's `.strings` — so `.strings.join(' ? ')` is where the rendered list appears, not `.values`.

- [ ] **Step 2: Run the test and watch it fail or pass, and say which**

```bash
npx vitest run --project unit src/services/gdpr.test.ts -t 'classification reaches the pre-lock'
```

Expected: **PASS against the current code** — today's hand-written list renders the same three statuses; what is missing is the tether that keeps it correct. Record that in the ledger. This is a characterisation test, so it must be green before and after, and Step 6's mutations are what prove it can fail at all.

- [ ] **Step 3: Re-shape `CANCELLABLE_STATUSES`**

In `src/services/gdpr.ts`, replace lines 923-927 with:

```ts
const CLASS_STATUS_CANCELLABILITY = {
  draft: true,
  open: true,
  in_progress: true,
  completed: false,
} as const satisfies Record<ClassStatus, boolean>;

/**
 * The statuses a teacher erasure cancels, DERIVED from the classification
 * above rather than restated beside it.
 *
 * `satisfies Record<ClassStatus, boolean>` is the tether: a fifth
 * `ClassStatus` is a compile error on that literal until someone says whether
 * an erasure cancels it, and because this array is built from the record's
 * keys, the answer reaches this list without a second edit. The previous
 * shape — a hand-written array annotated `readonly ClassStatus[]` — erased
 * the literals, so a fifth member changed nothing here and left those classes
 * uncancelled on an Article 17 path with every test green.
 *
 * The `as ClassStatus[]` restores only what `Object.keys` erases: its return
 * type is `string[]` for soundness reasons that do not apply to a literal
 * whose keys the line above has just constrained to exactly `ClassStatus`.
 *
 * `Object.freeze` stays — it is what makes rendering this list into SQL text
 * by concatenation defensible at runtime (`statusInList`, `db-locks.ts`).
 * Prisma's `in` wants a mutable array, so call sites spread.
 */
const CANCELLABLE_STATUSES: readonly ClassStatus[] = Object.freeze(
  (Object.keys(CLASS_STATUS_CANCELLABILITY) as ClassStatus[]).filter(
    (s) => CLASS_STATUS_CANCELLABILITY[s],
  ),
);
```

The existing docblock above `CANCELLABLE_STATUSES` (lines 909-922) keeps its subject — the two readers that have to agree — and loses nothing; place the new docblock on the constant and leave that one where it is.

- [ ] **Step 4: Re-shape `SCHEDULED_STATUSES`**

In `src/services/class-template-lifecycle.ts`, replace lines 464-468 with:

```ts
const CLASS_STATUS_SCHEDULED = {
  draft: true,
  open: true,
  in_progress: false,
  completed: false,
} as const satisfies Record<ClassStatus, boolean>;

/**
 * Statuses a generated instance can still be withdrawn or regenerated from,
 * DERIVED from the classification above rather than restated beside it. Same
 * tether and same reasoning as `CANCELLABLE_STATUSES` (`gdpr.ts`): a fifth
 * `ClassStatus` is a compile error on that literal until it is classified,
 * and the classification reaches this list without a second edit.
 *
 * Frozen for the same reason as `CHARGED_STATUSES`: it gates a destructive
 * delete. Prisma's `in` wants a mutable array, so call sites spread.
 */
const SCHEDULED_STATUSES: readonly ClassStatus[] = Object.freeze(
  (Object.keys(CLASS_STATUS_SCHEDULED) as ClassStatus[]).filter(
    (s) => CLASS_STATUS_SCHEDULED[s],
  ),
);
```

- [ ] **Step 5: Run the suites**

```bash
npx vitest run --project unit src/services/gdpr.test.ts src/services/class-template-lifecycle.test.ts
npm run typecheck && npm run lint
```

Expected: PASS. `lint` matters here specifically — it is the check the issue's own proposal would have failed.

- [ ] **Step 6: Prove the tether bites (mutation)**

Two mutations, each applied alone, error text recorded verbatim in the ledger, then reverted:

1. **Delete `completed: false` from `CLASS_STATUS_CANCELLABILITY`.** Run `npm run typecheck`. Expected: an error on the `satisfies` clause naming `completed` as missing. This is the fifth-member regression in the only form testable without a migration — the record must name every `ClassStatus`.
2. **Flip `in_progress` to `false` in `CLASS_STATUS_CANCELLABILITY`.** Run `npx vitest run --project unit src/services/gdpr.test.ts -t 'classification reaches the pre-lock'`. Expected: FAIL, with the rendered list read back as `'draft', 'open'`. The derivation carries the classification all the way into the issued SQL, and this is what stops Step 1's test being a characterisation test that could never fail.

Restore both, re-run Step 5, confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/services/gdpr.ts src/services/gdpr.test.ts src/services/class-template-lifecycle.ts
git commit -m "fix(gdpr): a fifth ClassStatus is now a compile error, not a silent gap (#245)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `ClassLockSource` and the shared join constants

Names and exports the parameter object, moves each member's rule onto the member, and closes the two duplicated join literals over constants.

**Files:**
- Modify: `src/lib/db-locks.ts` — add `ClassLockSource`, `CLASS_TO_ENTRY_JOIN`, `CLASS_TO_WAITLIST_JOIN`; change `lockClassRowsOrdered`'s signature; shorten its docblock
- Modify: `src/services/gdpr.ts:434`, `src/services/gdpr.ts:1121`
- Modify: `src/services/class-template-lifecycle.ts:745`
- Modify: `src/services/waitlist.ts:1087-1088`
- Test: `src/lib/db-locks.test.ts`

**Interfaces:**
- Consumes: `statusInList` (Task 1) is already in use at two of the call sites this task rewrites; do not change those `where` fragments.
- Produces, for Task 4:
  - `export interface ClassLockSource { join?: Prisma.Sql; where: Prisma.Sql; entries?: boolean }`
  - `export const CLASS_TO_ENTRY_JOIN: Prisma.Sql`
  - `export const CLASS_TO_WAITLIST_JOIN: Prisma.Sql`
  - `lockClassRowsOrdered(tx: TransactionClientOnly, source: ClassLockSource): Promise<string[]>` — the signature Task 4's tests call.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('lockClassRowsOrdered', …)` block in `src/lib/db-locks.test.ts`. Add `CLASS_TO_ENTRY_JOIN` and `CLASS_TO_WAITLIST_JOIN` to the `./db-locks` import list.

```ts
it('exports the join literals its callers used to hand-type', () => {
  expect(CLASS_TO_ENTRY_JOIN.sql).toBe(
    'JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"',
  );
  expect(CLASS_TO_WAITLIST_JOIN.sql).toBe(
    'JOIN "WaitlistEntry" w ON w."classId" = c.id',
  );
});

// `waitlist.ts` needs both. Composition has to flatten to plain text rather
// than binding either fragment as a parameter, or the statement is not SQL.
it('composes into one join clause, as withdrawWaitingEntriesForTeacher needs', () => {
  const both = Prisma.sql`${CLASS_TO_WAITLIST_JOIN} ${CLASS_TO_ENTRY_JOIN}`;
  expect(both.sql).toBe(
    'JOIN "WaitlistEntry" w ON w."classId" = c.id JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"',
  );
  expect(both.values).toEqual([]);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx vitest run --project unit src/lib/db-locks.test.ts -t 'join literals'
```

Expected: FAIL — the constants are not exported from `./db-locks`.

- [ ] **Step 3: Add the constants and the interface**

In `src/lib/db-locks.ts`, immediately above `lockClassRowsOrdered`'s docblock (after `statusInList` from Task 1):

```ts
/**
 * `Class` to its `CalendarEntry`, for a `ClassLockSource.join`.
 *
 * A constant rather than three hand-typed copies: a join condition a caller
 * cannot mistype is one that cannot silently match zero rows and take zero
 * locks, which is a failure the database does not report — the statement
 * succeeds and returns `[]`.
 */
export const CLASS_TO_ENTRY_JOIN = Prisma.sql`JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"`;

/**
 * `Class` to the waitlist entries on it, for a `ClassLockSource.join`. Same
 * reasoning as `CLASS_TO_ENTRY_JOIN` above.
 *
 * `FOR UPDATE OF c` is what keeps this join from also locking the
 * `WaitlistEntry` rows it reaches — pinned by 'locks the Class rows and NOT
 * the WaitlistEntry rows the join reaches' in `db-locks.test.ts`.
 */
export const CLASS_TO_WAITLIST_JOIN = Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`;

/**
 * What `lockClassRowsOrdered` locks.
 *
 * Composed `Prisma.Sql` fragments rather than a union of typed selectors, and
 * that was the decision #237 existed to make. A selector union cannot go
 * stale — the compiler forces a member per site — but it IS this helper's
 * caller list re-expressed as a type, and it would make this module know
 * every one of its callers by name and carry their domain types. The
 * predicate was never what went stale; the site list was.
 */
export interface ClassLockSource {
  /**
   * Extra tables the `where` may name, spliced between `FROM "Class" c` and
   * the `WHERE`. Prefer `CLASS_TO_ENTRY_JOIN` / `CLASS_TO_WAITLIST_JOIN`
   * above; compose both with `Prisma.sql`.
   *
   * AN INNER JOIN IS A FILTER, and the dependency runs the opposite way from
   * how this reads. Supplying one does not merely widen the namespace the
   * `where` may reference — it NARROWS THE LOCK SET to classes having at
   * least one matching row. `{ join: CLASS_TO_WAITLIST_JOIN, where: c."teacherId" = … }`
   * locks that teacher's classes THAT HAVE A WAITLIST ENTRY, not that
   * teacher's classes. A `LEFT JOIN` would not narrow, and would widen the
   * `ON` clause's reach past what any caller here needs; no caller uses one.
   */
  join?: Prisma.Sql;
  /**
   * The predicate, over `c` plus whatever `join` brings into scope.
   *
   * Parenthesised before splicing, so `OR`/`AND` precedence inside it is
   * yours and cannot combine with anything this helper adds. Screened for the
   * clauses this helper owns — see `ILLEGAL_IN_FRAGMENT` below.
   *
   * Values are BOUND: `Prisma.sql` tagged templates merge their values into
   * this statement in source order, verified against Postgres, so nothing
   * here is interpolated unless a caller reaches for `Prisma.raw`. In `src/`
   * that is `statusInList` above, whose parameter type is what makes it safe.
   */
  where: Prisma.Sql;
  /**
   * Also lock each matched class's `CalendarEntry` row, in a second statement
   * after every `Class` lock — the same order and for the same reason
   * `lockClassRow` takes its two.
   *
   * OPT-IN rather than automatic, because widening every call site by reflex
   * adds wait edges nothing needs, and because the answer is per-caller. Ask
   * it of the whole TRANSACTION, not of this statement: does anything in it
   * read or write the entry's `date`, `startTime`, `durationMinutes` or
   * `cancelledAt`? Each call site records its answer as a `VERDICT (#327)`
   * comment beside the transaction the question is about.
   */
  entries?: boolean;
}
```

Change the signature to `source: ClassLockSource`.

- [ ] **Step 4: Delete the paragraphs the type now carries**

From `lockClassRowsOrdered`'s docblock, remove: the "The predicate is a composed `Prisma.Sql`…" paragraph (moved onto `ClassLockSource`), and the "`entries: true` ADDS the `CalendarEntry` rows…" paragraph (moved onto `entries`). Keep everything about the *statement*: the four things it owns, the per-acquisition timeout measurement, the returned-ids argument, the `NO ROSTER HERE` paragraph and its `grep -rn 'VERDICT (#327)' src` re-derivation, the second-statement scoping note, the NOT-for-single-row note, and the brand note.

Leave the "A fragment is also not a loophole…" sentence in place for now — Task 4 rewrites it, and splitting the edit keeps each task's diff reviewable on its own.

- [ ] **Step 5: Rewrite the four call sites**

`src/services/gdpr.ts:434` — `join: CLASS_TO_WAITLIST_JOIN,`
`src/services/gdpr.ts:1121` — `join: CLASS_TO_ENTRY_JOIN,`
`src/services/class-template-lifecycle.ts:745` — `join: CLASS_TO_ENTRY_JOIN,`
`src/services/waitlist.ts:1087-1088` — `join: Prisma.sql`${CLASS_TO_WAITLIST_JOIN} ${CLASS_TO_ENTRY_JOIN}`,`

Extend each file's `@/lib/db-locks` import (`gdpr.ts:20`, `class-template-lifecycle.ts:39`, `waitlist.ts:16`) with the constants it now uses. Change no `where` fragment and no `entries` flag.

`gdpr.test.ts` spies on this function twice (around lines 1838 and in the `#367` snapshot block) with a `mockImplementation(async (tx, source) => …)` that reads `source.entries`. Naming the parameter object does not change its shape, so those keep compiling — but check them rather than assuming, since a spy whose types drift fails as a confusing `mockImplementation` overload error rather than as a signature mismatch.

- [ ] **Step 6: Run the suites**

```bash
npx vitest run --project unit src/lib/db-locks.test.ts src/services/gdpr.test.ts src/services/waitlist.test.ts src/services/class-template-lifecycle.test.ts
npx vitest run --project unit-sweeps src/lib/db-locks-lock-order.test.ts src/services/gdpr-lock-order.test.ts src/services/template-lock-order.test.ts
npm run typecheck && npm run lint
```

Expected: PASS. The lock-order files are in the serial `unit-sweeps` tier — run them there, not under `--project unit`, or they are silently not run.

- [ ] **Step 7: Sweep for what this task invalidated**

```bash
grep -rn 'JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"\|JOIN "WaitlistEntry" w ON w."classId" = c.id' src/ | grep -v '\.test\.ts'
grep -rn 'db-locks.ts:3[0-9][0-9]' src/ docs/
```

The first must return **zero** hits — five production copies replaced by two constants. Test files legitimately keep their own literals: several stage races against a hand-written statement deliberately not routed through the helper. The second finds line-number citations into the docblock this task shortened; re-point each at a name.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db-locks.ts src/lib/db-locks.test.ts src/services/gdpr.ts src/services/waitlist.ts src/services/class-template-lifecycle.ts
git commit -m "refactor(db-locks): the lock source is a named type, and its joins are constants (#245)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Make the "fails loudly" guarantees structural, and test them

Two of the docblock's loudness guarantees hold only because `ORDER BY c.id` sits between the `WHERE` splice point and the locking clause. A third failure — a locking clause inside a subquery — is not caught at all, and is reachable today.

**Files:**
- Modify: `src/lib/db-locks.ts` — parenthesise the spliced `where`; add `ILLEGAL_IN_FRAGMENT` and its check; rewrite the loudness sentence
- Test: `src/lib/db-locks.test.ts`

**Interfaces:**
- Consumes: `ClassLockSource`, `CLASS_TO_ENTRY_JOIN`, `CLASS_TO_WAITLIST_JOIN`, `lockClassRowsOrdered` (Task 3).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('lockClassRowsOrdered', …)` block in `src/lib/db-locks.test.ts`. Add `type TransactionClientOnly` to that file's existing `./db-locks` import list — the capture helper below annotates with it, and nothing in the file imports it today.

```ts
// A client that records the statement text instead of running it. The
// fragments arrive as VALUES of the outer template, so `strings` is exactly
// this helper's own static SQL — which is what these assertions are about.
const captureStatements = (): { tx: TransactionClientOnly; statements: string[] } => {
  const statements: string[] = [];
  const tx = {
    $executeRawUnsafe: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray) => {
      statements.push(strings.join(' ? '));
      return [];
    },
  } as unknown as TransactionClientOnly;
  return { tx, statements };
};

it('parenthesises the caller predicate before splicing it', async () => {
  const { tx, statements } = captureStatements();
  await lockClassRowsOrdered(tx, { where: Prisma.sql`c."id" = ${'x'}` });
  // The parens are what make a stray clause a syntax error AT THE CLAUSE
  // rather than at the `ORDER BY` that happens to follow it — the guarantee
  // stops depending on where `ORDER BY c.id` sits. They also keep a caller's
  // `OR` from combining with anything this helper appends later.
  expect(statements[0]).toMatch(/WHERE \( \? \)\s*ORDER BY c\.id/);
});

it.each([
  ['a locking clause', Prisma.sql`c."id" = ${'x'} FOR UPDATE`],
  ['its own ordering', Prisma.sql`c."id" = ${'x'} ORDER BY c."createdAt"`],
  ['a row limit', Prisma.sql`c."id" = ${'x'} LIMIT 1`],
  ['a statement separator', Prisma.sql`c."id" = ${'x'};`],
  [
    'a locking clause inside a subquery',
    Prisma.sql`c.id IN (SELECT "classId" FROM "WaitlistEntry" FOR UPDATE)`,
  ],
])('refuses a where fragment carrying %s', async (_label, where) => {
  const { tx, statements } = captureStatements();
  await expect(lockClassRowsOrdered(tx, { where })).rejects.toThrow(
    /clause this helper owns/,
  );
  // Refused BEFORE the statement is issued, not after it errors: the point is
  // that a fragment which would parse cannot reach Postgres.
  expect(statements).toEqual([]);
});

it('refuses a join fragment carrying one too', async () => {
  const { tx } = captureStatements();
  await expect(
    lockClassRowsOrdered(tx, {
      join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id FOR UPDATE`,
      where: Prisma.sql`w."studentId" = ${'x'}`,
    }),
  ).rejects.toThrow(/clause this helper owns/);
});

// The screen reads STATIC TEMPLATE TEXT. A bound value that happens to spell
// a keyword is data, and refusing it would be a false positive a caller
// could not work around.
it('does not refuse a bound value that spells one', async () => {
  const { tx, statements } = captureStatements();
  await lockClassRowsOrdered(tx, { where: Prisma.sql`c."id" = ${'for update'}` });
  expect(statements).toHaveLength(1);
});

// The third loudness guarantee, and the one that was already structural:
// name resolution, not clause order. Kept as a test because nothing else
// asserts it and the docblock claims it.
it('lets Postgres refuse a where that names a table no join brought in', async () => {
  await expect(
    prisma.$transaction((tx) =>
      lockClassRowsOrdered(tx, { where: Prisma.sql`w."studentId" = ${'x'}` }),
    ),
  ).rejects.toThrow(/missing FROM-clause entry for table "w"/);
});

// Why the subquery case above is guarded at all — the widening is real, and
// this measures it on a raw statement the helper would now refuse. The
// control is what stops it passing vacuously: without the locking clause the
// same query leaves `WaitlistEntry` at `AccessShareLock`.
it('would otherwise let a subquery lock the WaitlistEntry rows FOR UPDATE OF c excludes', async () => {
  const modeOf = (subqueryLock: Prisma.Sql) =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT c.id FROM "Class" c
        WHERE (c.id IN (SELECT "classId" FROM "WaitlistEntry" ${subqueryLock}))
        ORDER BY c.id FOR UPDATE OF c`;
      const held = await tx.$queryRaw<Array<{ mode: string }>>`
        SELECT mode FROM pg_locks
        WHERE pid = pg_backend_pid() AND relation = '"WaitlistEntry"'::regclass`;
      return held.map((row) => row.mode);
    });

  expect(await modeOf(Prisma.sql`FOR UPDATE`)).toContain('RowShareLock');
  expect(await modeOf(Prisma.empty)).toEqual(['AccessShareLock']);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npx vitest run --project unit src/lib/db-locks.test.ts -t 'lockClassRowsOrdered'
```

Expected: the parens test FAILS (no `WHERE (`), the six refusal tests FAIL (no error thrown — several reach Postgres and return `[]`), the bound-value and missing-FROM tests PASS, and the `pg_locks` test PASSES. Record which failed; a refusal test that passes here is asserting the wrong thing.

- [ ] **Step 3: Add the screen and the parens**

In `src/lib/db-locks.ts`, above `lockClassRowsOrdered`:

```ts
/**
 * Clauses `lockClassRowsOrdered` owns and a caller's fragment may not carry.
 *
 * Not stylistic. A stray bare `FOR UPDATE` is the exact widening
 * `FOR UPDATE OF c` exists to prevent: Postgres unions locking clauses, so it
 * would also lock every joined table and add wait edges `docs/lock-order.md`
 * does not model. A stray `ORDER BY` would replace the ascending-by-id
 * acquisition order that is this helper's whole reason to exist.
 *
 * Parenthesising the fragment (below) already makes a TOP-LEVEL stray clause
 * a syntax error at the clause itself. This screen exists for the one shape
 * parens cannot reach: a locking clause inside a subquery, which is
 * legitimately parenthesised already, parses cleanly, and takes
 * `RowShareLock` on the subquery's table — measured, and pinned by
 * 'would otherwise let a subquery lock the WaitlistEntry rows…' in
 * `db-locks.test.ts`.
 *
 * No `g` flag: `RegExp.test` on a global regex carries `lastIndex` between
 * calls and would skip every other fragment.
 */
const ILLEGAL_IN_FRAGMENT =
  /\b(order\s+by|for\s+(update|share|no\s+key|key\s+share)|limit|offset)\b|;/i;

/**
 * Screens one caller fragment, reading its STATIC TEMPLATE TEXT only.
 *
 * `.strings` is the tagged template's literal parts — bound values are not in
 * it, so a fragment whose *parameter* is the string `'for update'` passes,
 * which it must: that is data, and refusing it would be a false positive with
 * no workaround. A nested `Prisma.sql` or `Prisma.raw` fragment IS flattened
 * into the outer `.strings`, so composition cannot smuggle a clause past this.
 */
function assertNoIllegalClauses(member: 'join' | 'where', fragment: Prisma.Sql): void {
  const match = ILLEGAL_IN_FRAGMENT.exec(fragment.strings.join(' ? '));
  if (match !== null) {
    throw new Error(
      `lockClassRowsOrdered: the \`${member}\` fragment contains ${JSON.stringify(match[0])}, a clause this helper owns. See ClassLockSource.`,
    );
  }
}
```

Then in the function body, before `setLockTimeout`:

```ts
  if (source.join !== undefined) assertNoIllegalClauses('join', source.join);
  assertNoIllegalClauses('where', source.where);
```

and change the splice to:

```ts
    WHERE (${source.where})
```

- [ ] **Step 4: Rewrite the loudness sentence in the docblock**

Replace the "A fragment is also not a loophole: a caller that references `w.` without supplying a `join`, or writes its own `ORDER BY` or `FOR UPDATE`, gets a SQL error, not a silently wrong lock." sentence — and the "Parameters are bound…" sentence that follows it, which `ClassLockSource.where` now carries — with:

```
 * A fragment is not a loophole, and since #245 that is checked rather than
 * adjacent. A caller that references `w.` without supplying a `join` is
 * refused by name resolution; one that writes a clause this helper owns is
 * refused by `ILLEGAL_IN_FRAGMENT` above, and by the parentheses around the
 * splice if it somehow reaches Postgres. Each of those is pinned by its own
 * test in `db-locks.test.ts`. Before #245 the first two rested on `ORDER BY
 * c.id` happening to sit between the splice point and the locking clause,
 * and a locking clause inside a subquery was not refused at all.
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
npx vitest run --project unit src/lib/db-locks.test.ts
npx vitest run --project unit-sweeps src/lib/db-locks-lock-order.test.ts
npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 6: Warm the routes, then prove each guard bites (mutation)**

Four mutations, each applied alone, exact error text recorded in the ledger, then reverted:

1. **Remove the parens** (`WHERE ${source.where}`). Expected: the parens test fails on its regex. Confirms it asserts the splice, not the fragment.
2. **Remove the `where` screen call.** Expected: the five `it.each` refusal cases fail. Note in the ledger *how* each fails — the subquery case returns `[]` rather than erroring, which is the silent failure this whole task is about.
3. **Remove the `join` screen call.** Expected: only the join refusal test fails. Confirms the two calls are independently load-bearing rather than one covering the other.
4. **Change `ILLEGAL_IN_FRAGMENT` to read the fragment's `.sql` instead of `.strings`.** Expected: the bound-value test fails — `.sql` contains placeholders, but a caller could still bind a value the screen then mis-reads. This is the mutation that proves the `.strings` choice is deliberate, not incidental.

Restore all four, re-run Step 5, confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db-locks.ts src/lib/db-locks.test.ts
git commit -m "fix(db-locks): the fragment guarantees are checked, not positional (#245)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The two prose rosters become pointers

`gdpr.ts` holds two censuses that `docs/lock-order.md` already owns. Both are accurate today; both are the shape CLAUDE.md forbids and that `db-locks.ts` explicitly declines to keep.

**Files:**
- Modify: `src/services/gdpr.ts:479-489`, `src/services/gdpr.ts:1042-1053`

**Interfaces:** Consumes and produces nothing. Comment-only; no test changes.

- [ ] **Step 1: Replace the first roster**

`gdpr.ts:479-489` currently names all four `lockClassRowsOrdered` call sites, repeats "Five until #194", and repeats the `grep -rn 'lockClassRowsOrdered(' src/` command — all of which `docs/lock-order.md`'s *Ordering WITHIN `Class`* section holds. Replace those lines with:

```ts
    // Ascending by id is this project's intended order for taking more than
    // one `Class` row, and every site that does goes through the shared
    // helper `lockClassRowsOrdered` (`db-locks.ts`). Which sites those are,
    // and how to re-derive the set, is `docs/lock-order.md`'s
    // "Ordering WITHIN `Class`" — it owns that census; a second copy here
    // would go stale against it silently.
```

Keep everything around it. The "Takes an order, deliberately, not agree" paragraph that follows is about a real exception involving *this* function and `updateClass`, has no other owner, and stays verbatim.

- [ ] **Step 2: Replace the second roster**

`gdpr.ts:1042-1053` names the five `ClassTemplate`-before-`Class` sites and repeats the #229 history that `docs/lock-order.md`'s *Resolved: `{Class, ClassTemplate}` order standardised (#229)* section holds. Replace the roster sentences with:

```ts
      // Template child rows locked first, ordered by id (#229) — this
      // transaction's FIRST lock acquisition. `ClassTemplate` before `Class`
      // is the canonical direction, and this function was the sole site
      // taking the opposite one until #229 moved these locks ahead of
      // `lockClassRowsOrdered` below. Which sites take that order is
      // `docs/lock-order.md`'s "Resolved: `{Class, ClassTemplate}` order
      // standardised (#229)".
```

Keep the "Mirrors `lockClassRowsOrdered`'s discipline…" paragraph that follows — it argues the AB-BA case for *this* transaction and names a gap Task 3 of #298 left `known-open`, neither of which the doc carries.

- [ ] **Step 3: Confirm the doc still says what the pointers claim**

```bash
grep -n 'Ordering WITHIN `Class`' docs/lock-order.md
grep -n 'order standardised (#229)' docs/lock-order.md
```

Both must hit. A pointer at a heading that has been renamed is worse than the roster it replaced — it points at nothing and no test can tell.

- [ ] **Step 4: Run the suites**

```bash
npx vitest run --project unit src/services/gdpr.test.ts
npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts
npm run typecheck && npm run lint
```

Expected: PASS — comment-only, so a failure here means something else was touched.

- [ ] **Step 5: Commit**

```bash
git add src/services/gdpr.ts
git commit -m "docs(gdpr): two censuses point at their owner instead of copying it (#245)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Before the PR

- [ ] `npm run verify` — typecheck, lint, and every vitest project, with the app live on `:3000`. Do not start or restart a dev server that is already running; it is the user's.
- [ ] Re-derive the two censuses this branch touched and put the arithmetic in the PR body:

```bash
grep -rn 'lockClassRowsOrdered(' src/ | grep -v '\.test\.ts'
grep -rn 'JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"\|JOIN "WaitlistEntry" w ON w."classId" = c.id' src/ | grep -v '\.test\.ts'
```

- [ ] The PR body carries: the four premise corrections from the spec's *What was measured*; what each replaced comment used to say (Tasks 1, 4 and 5 all delete prose); the mutation records from Tasks 2 and 4 with exact error text; and the statement that `integration` was covered by a green `npm run verify` rather than run separately.
