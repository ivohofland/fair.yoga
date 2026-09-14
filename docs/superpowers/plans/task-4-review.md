# Task 4 Review: Audit & Document Remaining Call-Site @ts-expect-error Directives (#207)

**Issue:** #207  
**Plan Reference:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md` (Task 4 section)  
**Implementer Report:** `docs/superpowers/plans/task-4-report.md`  
**Reviewer:** Antigravity Code Reviewer  
**Date:** 2026-09-14  

---

## Verdict: APPROVED (WITH MINOR COMMENT EDIT RECOMMENDED)

The Task 4 implementation achieves full compliance with the plan specification and repository standards (`AGENTS.md`, `CLAUDE.md`). All test files carrying remaining call-site `@ts-expect-error` directives across the entire codebase were systematically audited and documented to make their enforcement model explicit: verified by `npm run typecheck` only (`tsc --noEmit`) and invisible to Vitest runtime test execution.

One minor comment duplication was discovered in `src/services/studio-class-deletion.test.ts:162-164` that should be cleaned up prior to staging and committing.

---

## Detailed Findings

### 1. Spec & Plan Compliance: FULLY COMPLIANT

A complete codebase sweep was performed searching for all `@ts-expect-error` occurrences across `src/` and `tests/`.

- **Audit Completeness**:
  Every call-site `@ts-expect-error` directive in the repository is located in one of 15 test files (the 14 files enumerated in the Task 4 plan plus `rule-lifecycle.test.ts` identified during implementation). All other occurrences in `src/` are non-directive comment citations.
- **Enforcement Clarity**:
  In all 15 test files, every `@ts-expect-error` site or helper has an explicit docblock or commentary stating:
  1. It is verified by `npm run typecheck` only (`tsc --noEmit`).
  2. It is invisible to Vitest runtime test execution (tests do not typecheck or transpile types).

#### Breakdown of Audited Files (15 files)

1. **`src/services/studio-class-template-lifecycle.test.ts`** (`_studioTemplateForbiddenFieldsAreRejected`): Explicit notice added.
2. **`src/services/class-template-lifecycle.test.ts`** (`_templateForbiddenFieldsAreRejected`): Explicit notice added.
3. **`src/services/class-lifecycle.test.ts`**:
   - `_completionTimingIsRequired`: Explicit notice added.
   - `_transitionRangesAreNarrow`: Explicit notice added.
   - `updateClass's non-empty tuple guarantee` (`noUncheckedIndexedAccess` test): Explicit docblock added.
4. **`src/services/studio-class-deletion.test.ts`** (`it('refuses template state at the type level')`): Explicit notice added.
5. **`src/services/studio-class-editability.test.ts`** (`it('refuses a widened row at the type level')`): Parameter guard docblock aligned with typecheck-only notice and `NoneOf` union pin pointer.
6. **`src/services/rule-lifecycle.test.ts`** (`it('refuses a childTable, logNoun, or editNoun that belongs to the other family')`): Docblock aligned to cite Vitest runtime invisibility.
7. **`src/services/entry-generation.test.ts`** (`_theBrandRejectsUnbrandedEpochMs`): Explicit notice added.
8. **`src/lib/db-locks.test.ts`** (`_theBrandRejectsABareClient`): Explicit notice added.
9. **`src/lib/rule-slot-holder.test.ts`** (`_theProbeRejectsATransactionClient`): Explicit notice added.
10. **`src/lib/entry-conflict.test.ts`** (`_theProbeRejectsATransactionClient`): Explicit notice added.
11. **`src/lib/registration-status.test.ts`** (`_theListRejectsAForeignEnum`): Explicit notice added.
12. **`src/lib/timezone.test.ts`** (`_theBrandRejectsPlainNumber`): Explicit notice added.
13. **`src/lib/worktree/identity.test.ts`** (`_rawNameBrandRejectsPlainString`, `_dbSlugBrandRejectsPlainString`, `_dbNamesForSlugRejectsRawName`): Explicit notice added.
14. **`src/lib/worktree/registry.test.ts`** (`_allocatePortArgsCannotBeSwapped`): Explicit notice added.
15. **`src/lib/api-utils.test.ts`**:
    - `respondTyped` compile-time contract test: Explicit docblock added.
    - `ApiLogDetail` clobber test: Explicit docblock notice added.
    - `paramsFirstHandler` signature guard: Explicit docblock notice added.

---

### 2. Comment Discipline: COMPLIANT WITH ONE MINOR EDIT

- **Accuracy and Scope**:
  - The comments adhere to the repo rule: "A comment annotates the code it sits on."
  - They clearly explain *why* the construct exists (compiler failure via `TS2578` on unused `@ts-expect-error`) and *how* it is tested (`tsc --noEmit`), dispelling any false expectation that Vitest test runners execute these type checks.
  - No stale references or dead links were introduced.

- **Minor Stutter / Duplication Finding**:
  - **Location**: `src/services/studio-class-deletion.test.ts:162-164`
  - **Current Text**:
    ```ts
    * Not because of excess-property checking: an OPTIONAL widening
    * (`template?: …`) is legal to supply and legal to omit, so every production
    * call site compiles either way, literal or variable. What catches it is this
    * What catches it is this directive. Under a widening the line below stops being an error,
    * and an unused `@ts-expect-error` is itself `TS2578` — so `tsc` fails here, and measurably
    * nowhere else.
    ```
  - **Issue**: The phrase `"What catches it is this"` was accidentally duplicated across lines 162 and 163.
  - **Recommended Patch**:
    ```diff
    --- a/src/services/studio-class-deletion.test.ts
    +++ b/src/services/studio-class-deletion.test.ts
    @@ -160,8 +160,7 @@ describe('studioClassDeletability', () => {
        * Not because of excess-property checking: an OPTIONAL widening
        * (`template?: …`) is legal to supply and legal to omit, so every production
        * call site compiles either way, literal or variable. What catches it is this
    -   * What catches it is this directive. Under a widening the line below stops being an error,
    +   * directive. Under a widening the line below stops being an error,
        * and an unused `@ts-expect-error` is itself `TS2578` — so `tsc` fails here, and measurably
        * nowhere else.
    ```

---

### 3. Verification: PASSED

1. **`pnpm run typecheck`**:
   - Exit code: 0 (`tsc --noEmit` passed with 0 errors).
2. **`pnpm run lint`**:
   - Exit code: 0 (0 errors, 6 pre-existing warnings in unrelated files).
3. **`git diff`**:
   - Strictly scoped to documentation and JSDoc blocks across the 15 test files. No runtime logic or test assertions altered.

---

## Conclusion & Next Step

Task 4 is approved. After applying the minor docblock edit in `src/services/studio-class-deletion.test.ts`, the implementer may proceed to stage and commit:

```bash
git add -u
git commit -m "docs(tests): clarify typecheck-only enforcement on remaining call-site @ts-expect-error guards (#207)"
```
