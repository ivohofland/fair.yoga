# Task 3 Implementation Report: Migrate Verdict Pin in studio-class-editability.ts & studio-class-editability.test.ts (#207)

**Issue:** #207  
**Plan:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md`  
**Status:** Completed  

---

## 1. Summary of Changes

1. **`src/services/studio-class-editability.ts`**:
   - Imported `type { NoneOf }` from `@/lib/type-pins`.
   - Added compile-time `NoneOf` pin `_illegalVerdictCannotStand` immediately beside `StudioClassEditVerdict`:
     ```ts
     // Compile-time pin asserting dateEditable cannot stand without scheduleEditable (#207).
     const _illegalVerdictCannotStand: NoneOf<
       { scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict
         ? '{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict'
         : never
     > = true;
     void _illegalVerdictCannotStand;
     ```
   - Invariant violation reports `Type 'true' is not assignable to type '"{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict"'`.

2. **`src/services/studio-class-editability.test.ts`**:
   - Removed trailing `@ts-expect-error _illegalVerdict` declaration and its comment block (lines 195-204).
   - In `it('refuses a widened row at the type level')`, updated the docblock to explicitly state:
     - The `@ts-expect-error` parameter check is verified by `npm run typecheck` only (`tsc --noEmit`) and is invisible to test runners.
     - The union invariant (`dateEditable ⇒ scheduleEditable`) is pinned separately beside `StudioClassEditVerdict` in `studio-class-editability.ts` via `NoneOf`.

---

## 2. Git Diff

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

## 3. Verification

1. **`pnpm run typecheck`**:
   - Result: Exit code 0 (`tsc --noEmit` passed cleanly).

2. **`pnpm exec vitest run --project unit src/services/studio-class-editability.test.ts`**:
   - Result: Exit code 0 (1 test file, 17 passed).

3. **`pnpm exec eslint src/services/studio-class-editability.ts src/services/studio-class-editability.test.ts`**:
   - Result: Exit code 0 (clean, no errors or warnings).

4. **Mutation Probe (Verification that `_illegalVerdictCannotStand` pin bites)**:
   - Temporarily widened `StudioClassEditVerdict` to `| { scheduleEditable: boolean; dateEditable: boolean }`.
   - Ran `pnpm run typecheck`. Compiler failed with error `TS2322`:
     ```
     src/services/studio-class-editability.ts(69,7): error TS2322: Type 'true' is not assignable to type '"{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict"'.
     ```
   - Confirmed error specifically names the offending invalid state.
   - Restored `StudioClassEditVerdict` to exact original union and confirmed `pnpm run typecheck` returned to exit 0.
