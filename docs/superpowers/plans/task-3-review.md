# Task 3 Review: Migrate Verdict Pin in studio-class-editability.ts & studio-class-editability.test.ts (#207)

**Issue:** #207  
**Plan Reference:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md` (Task 3 section)  
**Implementer Report:** `docs/superpowers/plans/task-3-report.md`  
**Reviewer:** Antigravity Code Reviewer  
**Date:** 2026-09-14  

---

## Verdict: APPROVED

The Task 3 implementation satisfies all requirements from the plan and repository standards (`AGENTS.md`, `CLAUDE.md`). The verdict union pin (`_illegalVerdictCannotStand`) is properly instantiated with `const ...: NoneOf<...> = true; void ...` beside `StudioClassEditVerdict` in `src/services/studio-class-editability.ts`, accurately prevents the illegal state `{ scheduleEditable: false; dateEditable: true }`, and names the offending type relation upon compiler failure. The redundant trailing `@ts-expect-error` pin was cleanly removed from `src/services/studio-class-editability.test.ts`, and the test docblock accurately explains the distinction between the parameter guard and the union pin. All typechecks, unit tests, and lint checks pass cleanly.

---

## Detailed Findings

### 1. Spec & Plan Compliance: FULLY COMPLIANT

- **`src/services/studio-class-editability.ts`**:
  - Imported `type { NoneOf }` from `@/lib/type-pins`.
  - Added compile-time pin `_illegalVerdictCannotStand` immediately following `StudioClassEditVerdict`:
    ```ts
    // Compile-time pin asserting dateEditable cannot stand without scheduleEditable (#207).
    const _illegalVerdictCannotStand: NoneOf<
      { scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict
        ? '{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict'
        : never
    > = true;
    void _illegalVerdictCannotStand;
    ```
  - Exactly conforms to the plan specification.
- **`src/services/studio-class-editability.test.ts`**:
  - Removed lines 195–204 containing the redundant `@ts-expect-error _illegalVerdict` constant and comment.
  - Updated the docblock on `it('refuses a widened row at the type level')` to document that the call-site parameter check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to test runners, and that the union invariant (`dateEditable ⇒ scheduleEditable`) is pinned separately beside `StudioClassEditVerdict` in `studio-class-editability.ts` via `NoneOf`.
  - Confirmed all remaining imports in the test file remain referenced (e.g. `StudioClassEditVerdict` is actively used in fixtures `EDITABLE` and `INCOME_RECORD`). No dead imports.

### 2. Quality & Correctness: HIGH

- **Instantiation Pattern**:
  - Follows canonical `const ...: NoneOf<...> = true; void ...;` instantiation required by `@/lib/type-pins`.
  - Suppressed from unused-variable lint via `void _illegalVerdictCannotStand;`.
- **Accurate Invariant Enforcement**:
  - When `StudioClassEditVerdict` only permits `{ scheduleEditable: false; dateEditable: false }` and `{ scheduleEditable: true; dateEditable: boolean }`, the condition `{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict` evaluates to `false`, resolving to `never`.
  - `NoneOf<never>` resolves to `true`, and `true = true` compiles cleanly.
- **Offender Naming & Mutation Verification**:
  - Conducted an independent live mutation test:
    - Mutated `StudioClassEditVerdict` in `src/services/studio-class-editability.ts` to include `| { scheduleEditable: boolean; dateEditable: boolean }`.
    - Executed `pnpm run typecheck`. The compiler rejected the assignment with error `TS2322`:
      ```
      src/services/studio-class-editability.ts(72,7): error TS2322: Type 'true' is not assignable to type '"{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict"'.
      ```
    - The compiler output unambiguously identifies the exact invalid state (`{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict`) rather than a bare boolean failure.
    - Code was restored cleanly and verified green.

### 3. Comment Discipline: COMPLIANT

- **Citation of #207**:
  - `src/services/studio-class-editability.ts:71` explicitly cites Issue #207:
    ```ts
    // Compile-time pin asserting dateEditable cannot stand without scheduleEditable (#207).
    ```
- **Separation of Parameter Guard and Union Pin**:
  - In `src/services/studio-class-editability.test.ts`, the docblock on `it('refuses a widened row at the type level')` clearly explains:
    1. The parameter `@ts-expect-error` guard protects against widening the input parameter to accept undeclared fields (e.g., `cancelledAt`), verified only by `npm run typecheck` (`tsc --noEmit`).
    2. The union invariant (`dateEditable ⇒ scheduleEditable`) is pinned separately on the return type beside `StudioClassEditVerdict` in `studio-class-editability.ts` via `NoneOf`.
  - *(Minor note)*: Appending `(#207)` to the test docblock reference (`... via NoneOf (#207).`) would provide dual-file issue tracking, but the citation in the source pin fully satisfies repository traceability requirements.

### 4. Verification: PASSED

- **`pnpm run typecheck`**: Exit code 0 (`tsc --noEmit` passed with 0 errors).
- **`pnpm exec vitest run --project unit src/services/studio-class-editability.test.ts`**: Exit code 0 (1 test file, 17 tests passed).
- **`pnpm exec eslint src/services/studio-class-editability.ts src/services/studio-class-editability.test.ts`**: Exit code 0 (clean, 0 errors, 0 warnings).
- **`git diff`**:
  ```diff
  diff --git a/src/services/studio-class-editability.test.ts b/src/services/studio-class-editability.test.ts
  index 7333aba7..b68e2054 100644
  --- a/src/services/studio-class-editability.test.ts
  +++ b/src/services/studio-class-editability.test.ts
  @@ -181,6 +181,11 @@ describe('studioClassEditability', () => {
      * verdict read cancellation or template state would ship silently. This
      * directive is what fails `tsc` when the signature widens, as TS2578
      * (unused '@ts-expect-error') pointing here.
  +   *
  +   * This `@ts-expect-error` parameter check is verified by `npm run typecheck`
  +   * only (`tsc --noEmit`) and is invisible to test runners. The union invariant
  +   * (`dateEditable ⇒ scheduleEditable`) is pinned separately beside
  +   * `StudioClassEditVerdict` in `studio-class-editability.ts` via `NoneOf`.
      */
     it('refuses a widened row at the type level', () => {
       studioClassEditability(
  @@ -191,13 +196,3 @@ describe('studioClassEditability', () => {
       );
     });
   });
  -
  -/**
  - * The union's own pin. `dateEditable ⇒ scheduleEditable` is held by the TYPE,
  - * not merely by the one producer — the matrix sweep above still runs because
  - * it also pins zone behaviour, but it is no longer the only thing standing
  - * between a second producer and an illegal verdict.
  - */
  -// @ts-expect-error dateEditable cannot stand without scheduleEditable
  -const _illegalVerdict: StudioClassEditVerdict = { scheduleEditable: false, dateEditable: true };
  -void _illegalVerdict;
  diff --git a/src/services/studio-class-editability.ts b/src/services/studio-class-editability.ts
  index 0bc21bb5..8fc3306e 100644
  --- a/src/services/studio-class-editability.ts
  +++ b/src/services/studio-class-editability.ts
  @@ -1,4 +1,5 @@
   import { startOfLocalDay } from '@/lib/timezone';
  +import type { NoneOf } from '@/lib/type-pins';
   
   // Re-exported so SERVER consumers need only this module. Client surfaces must
   // import `@/services/studio-class-edit-refusals` directly — reaching them
  @@ -67,6 +68,14 @@ export type StudioClassEditVerdict =
     /** Not past: the whole schedule may change; `date` only on a manual row. */
     | { scheduleEditable: true; dateEditable: boolean };
   
  +// Compile-time pin asserting dateEditable cannot stand without scheduleEditable (#207).
  +const _illegalVerdictCannotStand: NoneOf<
  +  { scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict
  +    ? '{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict'
  +    : never
  +> = true;
  +void _illegalVerdictCannotStand;
  +
   /**
    * Is this calendar date strictly before the teacher's local today?
    *
  ```

---

## Conclusion & Next Step

Task 3 is approved. The implementer may proceed to stage and commit:

```bash
git add src/services/studio-class-editability.ts src/services/studio-class-editability.test.ts
git commit -m "fix(studio-class-editability): express verdict illegal state pin with NoneOf (#207)"
```
