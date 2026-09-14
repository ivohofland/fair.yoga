# Task 4 Implementation Report: Audit & Document Remaining Call-Site @ts-expect-error Directives (#207)

**Issue:** #207  
**Plan:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md`  
**Status:** Completed  

---

## 1. Summary of Changes

Audited all test files with remaining call-site `@ts-expect-error` directives. For each directive / test helper, updated the docblock or comment directly beside the function/test to explicitly state that:
1. It is checked by `npm run typecheck` only (`tsc --noEmit`).
2. It is invisible to Vitest runtime test execution (tests do not typecheck or transpile types).

### Files Updated (15 files)

1. **`src/services/studio-class-template-lifecycle.test.ts`**:
   - `_studioTemplateForbiddenFieldsAreRejected`: Updated docblock to state that the check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.

2. **`src/services/class-template-lifecycle.test.ts`**:
   - `_templateForbiddenFieldsAreRejected`: Updated docblock to state that the check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.

3. **`src/services/class-lifecycle.test.ts`**:
   - `_completionTimingIsRequired`: Added explicit typecheck-only and Vitest runtime invisibility notice.
   - `_transitionRangesAreNarrow`: Added explicit typecheck-only and Vitest runtime invisibility notice.
   - `updateClass's non-empty tuple guarantee` (`noUncheckedIndexedAccess` test): Added docblock stating check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.

4. **`src/services/studio-class-deletion.test.ts`**:
   - `refuses template state at the type level`: Updated docblock to state the parameter check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.

5. **`src/services/entry-generation.test.ts`**:
   - `_theBrandRejectsUnbrandedEpochMs`: Updated docblock to state checks are verified by `npm run typecheck` only (`tsc --noEmit`) and are invisible to Vitest runtime test execution.

6. **`src/lib/db-locks.test.ts`**:
   - `_theBrandRejectsABareClient`: Updated docblock to state checks are verified by `npm run typecheck` only (`tsc --noEmit`) and are invisible to Vitest runtime test execution.

7. **`src/lib/rule-slot-holder.test.ts`**:
   - `_theProbeRejectsATransactionClient`: Updated docblock to state check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.

8. **`src/lib/entry-conflict.test.ts`**:
   - `_theProbeRejectsATransactionClient`: Updated docblock to state check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.

9. **`src/lib/registration-status.test.ts`**:
   - `_theListRejectsAForeignEnum`: Updated docblock to state check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.

10. **`src/lib/timezone.test.ts`**:
    - `_theBrandRejectsPlainNumber`: Updated docblock to state check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.

11. **`src/lib/worktree/identity.test.ts`**:
    - `_rawNameBrandRejectsPlainString`, `_dbSlugBrandRejectsPlainString`, `_dbNamesForSlugRejectsRawName`: Updated docblock to state checks are verified by `npm run typecheck` only (`tsc --noEmit`) and are invisible to Vitest runtime test execution.

12. **`src/lib/worktree/registry.test.ts`**:
    - `_allocatePortArgsCannotBeSwapped`: Updated docblock to state check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.

13. **`src/lib/api-utils.test.ts`**:
    - `respondTyped` contract test (`enforces compile-time type requirements`): Added docblock stating compile-time assertions are verified by `npm run typecheck` only (`tsc --noEmit`) and are invisible to Vitest runtime test execution.
    - `ApiLogDetail` clobber test (`keeps the real request context even when classifyApiError returns a clobbering detail`): Added docblock stating parameter check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.
    - `paramsFirstHandler` test: Updated docblock to state check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution.

14. **`src/services/rule-lifecycle.test.ts`**:
    - Aligned docblock on family descriptors test (`refuses a childTable, logNoun, or editNoun that belongs to the other family`) to state property assignment checks are verified by `npm run typecheck` only (`tsc --noEmit`) and are invisible to Vitest runtime test execution (tests do not typecheck or transpile types).

15. **`src/services/studio-class-editability.test.ts`**:
    - Aligned docblock on `refuses a widened row at the type level` to state parameter check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to Vitest runtime test execution (tests do not typecheck or transpile types).

---

## 2. Verification

1. **`pnpm run typecheck`**:
   - Exit code: 0 (`tsc --noEmit` passed with 0 errors).

2. **`pnpm test`**:
   - Exit code: 0.
   - Pass 1 (`unit`, `components`): 178 test files passed (2299 tests).
   - Pass 2 (`unit-sweeps`, `integration`): 71 test files passed (928 tests).
   - Total: 249 test files passed, 3227 passed tests.

3. **`pnpm exec eslint <touched files>`**:
   - Exit code: 0 (clean, no errors or warnings).

4. **`pnpm run lint`**:
   - Exit code: 0 (0 errors, 6 pre-existing warnings in unrelated files).
