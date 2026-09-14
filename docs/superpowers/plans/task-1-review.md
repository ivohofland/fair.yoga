# Task 1 Review: Upgrade Toggle Payload Pins in api-types.ts & Clean Up template-action-messages.test.ts (#207)

**Issue:** #207  
**Plan Reference:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md` (Task 1 section)  
**Implementer Report:** `docs/superpowers/plans/task-1-report.md`  
**Reviewer:** Antigravity Code Reviewer  
**Date:** 2026-09-14  

---

## Verdict: CHANGES REQUESTED (Minor cleanup required before commit)

The core `NoneOf` pin implementation in `src/lib/api-types.ts` is exemplary: it follows the repo's pin conventions, compiles cleanly under strict mode, and provably names the offending relation when mutated. The removal of the redundant test block in `src/components/settings/template-action-messages.test.ts` matches the plan.

However, **4 unused imports were left behind** in `src/components/settings/template-action-messages.test.ts` when removing lines 741–764. These must be cleaned up before committing Task 1.

---

## Detailed Findings

### 1. Spec & Plan Compliance: PARTIALLY COMPLIANT (Unused imports left behind)
- **`src/lib/api-types.ts`**:
  - Replaced `import type { Assert, Equals }` with `import type { NoneOf }` from `@/lib/type-pins`.
  - Replaced lines 111–116 (`Assert<Equals<..., false>>`) with the `NoneOf` pins `_classIsNotStudio` and `_studioIsNotClass` verbatim per plan.
- **`src/components/settings/template-action-messages.test.ts`**:
  - Removed lines 741–764 (`describe('the two toggle payloads are not interchangeable', ...)`) with the redundant `@ts-expect-error` calls and dummy `expect(true).toBe(true)` assertions.
  - **Defect**: The plan specified:
    > Task 1: Upgrade Toggle Payload Pins in `src/lib/api-types.ts` & Clean Up `template-action-messages.test.ts`
  - The import statement in `src/components/settings/template-action-messages.test.ts` still imports 4 symbols that were only used in the deleted test block:
    - Line 6: `resolveTemplateConfirmation`
    - Line 7: `resolveStudioConfirmation`
    - Line 12: `type StudioTemplateToggleResponse`
    - Line 13: `type TemplateToggleResponse`

### 2. Quality & Correctness: HIGH (with 1 hygiene defect)
- **Instantiation Pattern**:
  - The pins use the canonical instantiation pattern:
    ```ts
    const _classIsNotStudio: NoneOf<
      TemplateToggleResponse extends StudioTemplateToggleResponse
        ? 'TemplateToggleResponse extends StudioTemplateToggleResponse'
        : never
    > = true;
    void _classIsNotStudio;

    const _studioIsNotClass: NoneOf<
      StudioTemplateToggleResponse extends TemplateToggleResponse
        ? 'StudioTemplateToggleResponse extends TemplateToggleResponse'
        : never
    > = true;
    void _studioIsNotClass;
    ```
  - Follows `const ...: NoneOf<...> = true; void ...;` exactly as specified in `src/lib/type-pins.ts`.
  - Conditional branch evaluates to `never` when the types are mutually disjoint, resolving to `NoneOf<never>` which is `true`.
- **Offender Naming**:
  - Verified via live mutation tests:
    - **Mutation 1** (setting `TemplateToggleResponse.templateKind` to `'studio'`):
      TypeScript compiler rejects assignment with:
      ```
      src/lib/api-types.ts(114,7): error TS2322: Type 'true' is not assignable to type '"TemplateToggleResponse extends StudioTemplateToggleResponse"'.
      ```
    - **Mutation 2** (setting `StudioTemplateToggleResponse.templateKind` to `'class'`):
      TypeScript compiler rejects assignment with:
      ```
      src/lib/api-types.ts(121,7): error TS2322: Type 'true' is not assignable to type '"StudioTemplateToggleResponse extends TemplateToggleResponse"'.
      ```
  - Both directions clearly name the offending direction and condition.
- **Import Hygiene**:
  - `src/lib/api-types.ts`: Clean. Old `Assert` and `Equals` imports were removed.
  - `src/components/settings/template-action-messages.test.ts`: **NOT Clean**. Dead imports must be removed.

### 3. Comment Discipline: COMPLIANT
- `src/lib/api-types.ts`:
  - Pin comment:
    ```ts
    // Compile-time pins asserting that the class and studio toggle response types
    // remain mutually non-interchangeable via `templateKind` (#93, #119, #206, #207).
    // Expressed with NoneOf so a broken invariant names the offending direction.
    ```
    Accurately cites all lineage issues: #93, #119, #206, #207.
  - The docblock on `TemplateToggleResponse` (lines 20–37) accurately explains the role of `templateKind` as the discriminator and references the compile-time pin below.
  - No stale claims or orphaned assertions.

### 4. Verification: PASSED
- `git diff`: Confirmed modifications are restricted strictly to `src/lib/api-types.ts` and `src/components/settings/template-action-messages.test.ts`.
- `pnpm run typecheck`: Exit code 0 (`tsc --noEmit` passed with 0 errors).
- `pnpm exec vitest run --project unit src/components/settings/template-action-messages.test.ts`: Exit code 0 (1 test file, 68 tests passed).

---

## Action Required

Before committing Task 1:
In `src/components/settings/template-action-messages.test.ts`, remove the 4 unused imports from lines 6–7 and lines 12–13:

```diff
diff --git a/src/components/settings/template-action-messages.test.ts b/src/components/settings/template-action-messages.test.ts
index 1761969f..d1ac0856 100644
--- a/src/components/settings/template-action-messages.test.ts
+++ b/src/components/settings/template-action-messages.test.ts
@@ -3,14 +3,10 @@ import {
   pauseMessage,
   archiveMessage,
   archiveStudioMessage,
-  resolveTemplateConfirmation,
-  resolveStudioConfirmation,
   resumeMessage,
   resumeStudioMessage,
   templateUpdatedMessage,
   UNARCHIVE_MESSAGE,
-  type StudioTemplateToggleResponse,
-  type TemplateToggleResponse,
 } from './template-action-messages';
```

Once this cleanup is applied and verified, Task 1 is approved for commit:
```bash
git add src/lib/api-types.ts src/components/settings/template-action-messages.test.ts
git commit -m "fix(api-types): express toggle payload non-interchangeability with NoneOf pins (#207)"
```
