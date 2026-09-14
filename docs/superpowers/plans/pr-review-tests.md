# PR Test Analysis: PR #597 (Issue #207)

- **PR:** #597 (`fix/207-toggle-payload-type-pins` against `main`)
- **Issue:** #207 (Toggle-Payload & Result Type Pins: Replace `@ts-expect-error` with `NoneOf` Pins)
- **Review Skill:** `.agents/skills/pr-test-analyzer/SKILL.md`
- **Plan Reference:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md`
- **Mutation Ledger:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md`
- **Reviewer:** PR Test Analyzer
- **Date:** 2026-09-14
- **Verification Fact:** `pnpm run verify` passes cleanly (249 test files, 3,227 passed tests, exit code 0).

---

## 1. Test Coverage Summary

This pull request completes Issue #207 by modernizing how type invariants and negative type contracts are tested across the codebase:

1. **Compile-Time `NoneOf` Pins at Definition Sites**:
   - Replaces opaque `Assert<Equals<..., false>>` in `src/lib/api-types.ts` with self-naming `NoneOf` pins (`_classIsNotStudio`, `_studioIsNotClass`).
   - Introduces bidirectional compile-time `NoneOf` pins in `src/services/rule-lifecycle.ts` for all three generic rule lifecycle results:
     - `ArchiveRuleResult<TChild>` (`_classArchiveIsNotStudio`, `_studioArchiveIsNotClass`)
     - `PauseRuleResult<TChild>` (`_classPauseIsNotStudio`, `_studioPauseIsNotClass`)
     - `UpdateRuleResult<TChild>` (`_classUpdateIsNotStudio`, `_studioUpdateIsNotClass`)
   - Elevates the verdict state invariant in `src/services/studio-class-editability.ts` into a compile-time `NoneOf` pin (`_illegalVerdictCannotStand`), asserting that `{ scheduleEditable: false; dateEditable: true }` cannot satisfy `StudioClassEditVerdict`.

2. **Elimination of Tautological Test-Level Type Checks**:
   - In `src/components/settings/template-action-messages.test.ts`, removes lines 741–764 which wrapped `@ts-expect-error` calls inside a runtime test that concluded with `expect(true).toBe(true)`. The underlying type non-assignability contract is now pinned at the declaration site in `src/lib/api-types.ts`.
   - In `src/services/rule-lifecycle.test.ts`, removes redundant call-site `@ts-expect-error` invocations (`takesStudio(classResult)` and `takesClass(studioResult)`) while retaining the positive runtime assertions.
   - In `src/services/studio-class-editability.test.ts`, removes the uncalled `@ts-expect-error const _illegalVerdict: StudioClassEditVerdict` assignment.

3. **Exhaustive Documentation of Call-Site Parameter Guards**:
   - Systematically documents 15 test files containing call-site `@ts-expect-error` directives, explaining that these parameter-narrowing guards are enforced exclusively by `npm run typecheck` (`tsc --noEmit` exit code) and are invisible to Vitest runtime test execution.

### Suite Verification Status

| Check | Tool / Runner | Result | Details |
|---|---|---|---|
| **Typecheck** | `tsc --noEmit` | **PASS (Exit 0)** | 0 errors |
| **Linter** | `eslint` | **PASS (Exit 0)** | 0 errors |
| **Test Pass 1** | Vitest (`unit`, `components`) | **PASS (Exit 0)** | 178 test files, 2,299 passed tests |
| **Test Pass 2** | Vitest (`unit-sweeps`, `integration`) | **PASS (Exit 0)** | 71 test files, 928 passed tests |
| **Total Test Suite** | `pnpm test` | **PASS (Exit 0)** | **249 test files, 3,227 passed tests** |

Coverage adequacy for the modified functionality is **exceptional**. Behavioral runtime coverage remains 100% intact, and compile-time negative guarantees are now certified by deterministic, self-describing compiler pins backed by an empirical mutation testing ledger.

---

## 2. 🚨 Critical Gaps (Rating 8–10)

**None.**

There are zero critical test gaps:
- No runtime execution paths are left untested.
- No financial, payment, scheduling, or authorization logic was loosened.
- All negative invariant boundaries are strictly defended at compile time and verified via mutation testing.

---

## 3. ⚠️ Important Improvements (Rating 5–7)

### Gap 1 (Rating 5/10 — Test Title Alignment): Align `it(...)` titles in `src/services/rule-lifecycle.test.ts` with remaining runtime assertions

- **Location:** `src/services/rule-lifecycle.test.ts:184-248`
- **Scenario:** In `describe("the two families' lifecycle results are not interchangeable")`, the three tests are titled:
  - `it('rejects each family archive result where the other family is required', ...)`
  - `it('rejects each family pause result where the other family is required', ...)`
  - `it('rejects each family update result where the other family is required', ...)`
- **Why it matters:** Previously, these tests contained negative `@ts-expect-error` invocations (`takesStudio(classResult)` / `takesClass(studioResult)`). Those negative calls were correctly removed because the rejection is now proven by the `NoneOf` compile-time pins in `src/services/rule-lifecycle.ts:370, 999, 1613`. The test bodies now exclusively execute positive assertions (`expect(takesStudio(studioResult)).toBe(true)` and `expect(takesClass(classResult)).toBe(true)`). Although the block's JSDoc header accurately explains this migration, the individual `it(...)` titles still claim to "reject" the foreign family, describing the compile-time invariant rather than the runtime test execution.
- **Suggested Improvement:**
  In a future cleanup pass, adjust the test titles to reflect their active runtime verification, for example:
  ```ts
  it('accepts family-specific archive results at their respective family consumers', () => {
    // ...
    expect(takesStudio(studioResult)).toBe(true);
    expect(takesClass(classResult)).toBe(true);
  });
  ```

---

## 4. 🔧 Test Quality Issues

### 4.1 Behavioral Coverage over Line Coverage
The changes rigorously prioritize behavioral and contract coverage over superficial metrics:
- In `src/components/settings/template-action-messages.test.ts`, removing `expect(true).toBe(true)` eliminates a tautological line without diminishing behavioral coverage. The module still retains comprehensive tests for all message resolvers (`resolveTemplateConfirmation`, `resolveStudioConfirmation`, `templateUpdatedMessage`, `resumeStudioMessage`) across every action discriminator (`'paused'`, `'archived'`, `'active'`, `'unchanged'`, `'unarchived'`) and input permutation.
- In `src/services/studio-class-editability.test.ts`, the full behavioral matrix evaluating past vs. future dates and generated vs. manual studio classes remains untouched and active.

### 4.2 Test Resilience & DAMP over DRY
- **DAMP Setup**: In `src/services/rule-lifecycle.test.ts:189-198`, the test fixtures use explicit, descriptive inline setup (`{} as WithSlot<ClassTemplate>`, `{} as WithSlot<StudioClassTemplate>`) rather than complex shared factories. This keeps the tests independent, isolated, and readable.
- **Decoupling from Private Implementation**: The compile-time pins check public exported types (`TemplateToggleResponse`, `ArchiveRuleResult`, `StudioClassEditVerdict`). If internal implementation helpers change, the pins will not experience false failures as long as the public contract holds.

### 4.3 Appropriate Mocking Strategy
- No new mocks were introduced.
- Tests in `src/services/` run against clean domain types without mock leakage.
- Component tests in `src/components/settings/` run in `jsdom` without artificial network interceptors since `template-action-messages` is a pure function layer.

### 4.4 Tier Placement Accuracy
- All modified and audited tests are located in their appropriate tiers:
  - `src/services/*.test.ts`: `unit` tier (parallel, fast Node execution).
  - `src/components/**/*.test.ts`: `components` tier (`jsdom` environment).
  - None of the modified tests perform wide DB sweeps or row lock contention, so none belong in `unit-sweeps`.

---

## 5. ✨ Positive Observations

### 5.1 Thorough Mutation Testing Protocol (`docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md`)
The mutation testing ledger demonstrates exemplary discipline complying with `AGENTS.md` ("A guard that cannot fail certifies nothing"):
- **6 distinct mutation scenarios** covering **9 compile-time pins** were executed in-place:
  1. `_classIsNotStudio`: Mutated `TemplateToggleResponse` `templateKind` to `'studio'`.
     - *Result:* Failed `tsc --noEmit` (exit 2) naming `"TemplateToggleResponse extends StudioTemplateToggleResponse"`.
  2. `_studioIsNotClass`: Mutated `StudioTemplateToggleResponse` `templateKind` to `'class'`.
     - *Result:* Failed `tsc --noEmit` (exit 2) naming `"StudioTemplateToggleResponse extends TemplateToggleResponse"`.
  3. `_classArchiveIsNotStudio` & `_studioArchiveIsNotClass`: Collapsed `template: WithSlot<TChild>` to `{ id: string }`.
     - *Result:* Failed `tsc --noEmit` (exit 2) naming both offending conditions verbatim.
  4. `_classPauseIsNotStudio` & `_studioPauseIsNotClass`: Collapsed `template` in `PauseRuleResult`.
     - *Result:* Failed `tsc --noEmit` (exit 2) naming both offending conditions verbatim.
  5. `_classUpdateIsNotStudio` & `_studioUpdateIsNotClass`: Collapsed `template` in `UpdateRuleResult`.
     - *Result:* Failed `tsc --noEmit` (exit 2) naming both offending conditions verbatim.
  6. `_illegalVerdictCannotStand`: Widened `StudioClassEditVerdict` to `{ scheduleEditable: boolean; dateEditable: boolean }`.
     - *Result:* Failed `tsc --noEmit` (exit 2) naming `"{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict"`.
- Every mutation produced the expected compiler diagnostic naming the offender, and all files were restored cleanly.

### 5.2 Crisp Distinction Between Type Pins and Parameter Guards
The PR establishes an important architectural boundary:
- **Type Invariants** (e.g. non-interchangeability of response types or invalid union states) belong beside the type declarations in `src/` using `NoneOf`. They fail `tsc` immediately upon definition and name the exact offending condition.
- **Function Parameter Guards** (e.g. ensuring a service function refuses excess properties or unpermitted fields passed via variables) must remain at call sites in `src/**/*.test.ts` using `@ts-expect-error`, because they test the assignability constraint imposed by the function signature.
- Adding explicit docblocks across all 15 test files with `@ts-expect-error` call-site guards protects these tests from being deleted as "dead code" and clarifies that their verification happens during `tsc --noEmit`, not Vitest runtime execution.

### 5.3 Zero Test Regressions Across Full Suite
All 249 test files and 3,227 tests in the repo pass cleanly without flakes or regressions.
