# Task 2 Review: Migrate Lifecycle Result Pins in rule-lifecycle.ts & rule-lifecycle.test.ts (#207)

**Issue:** #207  
**Plan Reference:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md` (Task 2 section)  
**Implementer Report:** `docs/superpowers/plans/task-2-report.md`  
**Reviewer:** Antigravity Code Reviewer  
**Date:** 2026-09-14  

---

## Verdict: APPROVED

The Task 2 implementation adheres completely to the plan specification and project rules (`AGENTS.md`, `CLAUDE.md`). All compile-time `NoneOf` pins for `ArchiveRuleResult`, `PauseRuleResult`, and `UpdateRuleResult` are properly instantiated with `const ...: NoneOf<...> = true; void ...`, accurately enforce mutual non-interchangeability between class and studio template families, and provably report the offender name upon type violation. The test file docblocks accurately clarify the `npm run typecheck` only enforcement model, and all tests, typechecks, and linters pass cleanly.

No defects or regressions were identified. The changes are ready to commit.

---

## Detailed Findings

### 1. Spec & Plan Compliance: FULLY COMPLIANT

- **`src/services/rule-lifecycle.ts`**:
  - Imported `type { NoneOf }` from `@/lib/type-pins`.
  - Imported `ClassTemplate` and `StudioClassTemplate` from `@prisma/client`.
  - Updated docblock on `ArchiveRuleResult` (lines 320–326): removed reference to `@ts-expect-error` in test files; cited `NoneOf` compile-time pins declared directly below (#207).
  - Added compile-time pins `_classArchiveIsNotStudio` and `_studioArchiveIsNotClass` immediately below `ArchiveRuleResult`.
  - Updated docblock on `PauseRuleResult` (lines 916–921): removed reference to `@ts-expect-error` in test files; cited `NoneOf` compile-time pins declared below (#207).
  - Added compile-time pins `_classPauseIsNotStudio` and `_studioPauseIsNotClass` immediately below `PauseRuleResult`.
  - Added compile-time pins `_classUpdateIsNotStudio` and `_studioUpdateIsNotClass` immediately below `UpdateRuleResult`.

- **`src/services/rule-lifecycle.test.ts`**:
  - In `describe('rule-lifecycle family descriptors') -> it('refuses a childTable, logNoun, or editNoun that belongs to the other family')`:
    - Updated docblock to explicitly state that the 7 `@ts-expect-error` property assignment checks are verified by `npm run typecheck` only (`tsc --noEmit`) and are invisible to test runners.
  - In `describe("the two families' lifecycle results are not interchangeable")`:
    - Updated docblock to explain that non-interchangeability is pinned at compile time via `NoneOf` in `src/services/rule-lifecycle.ts` (#207), and tests below retain positive assertions.
    - Removed the 6 `@ts-expect-error` test calls (`takesStudio(classResult)` / `takesClass(studioResult)` for archive, pause, and update).
    - Preserved positive assertions:
      - `expect(takesStudio(studioResult)).toBe(true);`
      - `expect(takesClass(classResult)).toBe(true);`
  - Checked all imports in `src/services/rule-lifecycle.test.ts`: all imported symbols (`UpdateRuleResult`, `ArchiveRuleResult`, `PauseRuleResult`, `WithSlot`, etc.) remain actively referenced. No dead imports introduced or retained.

### 2. Quality & Correctness: HIGH

- **Instantiation Pattern**:
  All 6 pins follow the required canonical instantiation pattern:
  ```ts
  const _classArchiveIsNotStudio: NoneOf<
    ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>
      ? 'ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>'
      : never
  > = true;
  void _classArchiveIsNotStudio;
  ```
  - Declared using `const ...: NoneOf<...> = true; void ...;` to ensure evaluation by the TypeScript compiler under both server and client conditions, and suppressed from unused variable warnings via `void`.
  - Resolves to `NoneOf<never>` (`true`) when the types are mutually disjoint.

- **Mutual Non-Interchangeability**:
  - Covered all 3 lifecycle result types across both directions:
    - `ArchiveRuleResult<ClassTemplate>` ⇎ `ArchiveRuleResult<StudioClassTemplate>`
    - `PauseRuleResult<ClassTemplate>` ⇎ `PauseRuleResult<StudioClassTemplate>`
    - `UpdateRuleResult<ClassTemplate>` ⇎ `UpdateRuleResult<StudioClassTemplate>`
  - Non-interchangeability holds on `template: WithSlot<TChild>` (the field carrying the child difference between regular and studio families).

- **Offender Naming & Mutation Verification**:
  - Verified via a live mutation probe in `src/services/rule-lifecycle.ts`:
    - Mutated `ArchiveRuleResult<TChild>` by replacing `template: WithSlot<TChild>` with `template: { id: string }` (erasing the child type distinction).
    - Ran `pnpm run typecheck`. The compiler rejected the assignment with error `TS2322`:
      ```
      src/services/rule-lifecycle.ts(370,7): error TS2322: Type 'true' is not assignable to type '"ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>"'.
      src/services/rule-lifecycle.ts(377,7): error TS2322: Type 'true' is not assignable to type '"ArchiveRuleResult<StudioClassTemplate> extends ArchiveRuleResult<ClassTemplate>"'.
      ```
    - Both directions named the offending type relation explicitly instead of emitting generic boolean failure messages.
    - Code was restored and verified clean.

### 3. Comment Discipline: COMPLIANT

- Removed all outdated references to test-level `@ts-expect-error` directives in `ArchiveRuleResult` and `PauseRuleResult` docblocks.
- Accurately cited `#207` in all pin comments and docblock updates.
- Added unambiguous clarification in `rule-lifecycle.test.ts` docblock for property assignment guards:
  > *"The 7 `@ts-expect-error` property assignment checks below are verified by `npm run typecheck` only (`tsc --noEmit`) and are invisible to test runners."*

### 4. Verification: PASSED

- **`git diff`**:
  - Confirmed changes are strictly limited to `src/services/rule-lifecycle.ts` and `src/services/rule-lifecycle.test.ts`.
  - No extraneous formatting churn or unintended changes.
- **`pnpm run typecheck`**: Exit code 0 (`tsc --noEmit` passed with 0 errors).
- **`pnpm exec vitest run --project unit src/services/rule-lifecycle.test.ts`**: Exit code 0 (1 test file, 13 passed).
- **`pnpm exec eslint src/services/rule-lifecycle.ts src/services/rule-lifecycle.test.ts`**: Exit code 0 (clean, no errors or warnings).

---

## Conclusion & Next Step

Task 2 meets all criteria and is approved for commit:

```bash
git add src/services/rule-lifecycle.ts src/services/rule-lifecycle.test.ts
git commit -m "fix(rule-lifecycle): express result type non-interchangeability with NoneOf pins (#207)"
```
