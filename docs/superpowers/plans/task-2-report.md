# Task 2 Implementation Report: Migrate Lifecycle Result Pins in rule-lifecycle.ts & rule-lifecycle.test.ts (#207)

**Issue:** #207  
**Plan:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md`  
**Status:** Completed  

---

## 1. Summary of Changes

1. **`src/services/rule-lifecycle.ts`**:
   - Added imports for `ClassTemplate` and `StudioClassTemplate` from `@prisma/client`.
   - Added import `type { NoneOf }` from `@/lib/type-pins`.
   - Updated docblocks for `ArchiveRuleResult` and `PauseRuleResult` to reference the compile-time `NoneOf` pins declared directly beside the types instead of outdated `@ts-expect-error` directives in test files (#207).
   - Added compile-time `NoneOf` pins beside:
     - `ArchiveRuleResult`: `_classArchiveIsNotStudio` and `_studioArchiveIsNotClass`
     - `PauseRuleResult`: `_classPauseIsNotStudio` and `_studioPauseIsNotClass`
     - `UpdateRuleResult`: `_classUpdateIsNotStudio` and `_studioUpdateIsNotClass`
   - Violations name the offending direction (`'ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>'`, etc.).

2. **`src/services/rule-lifecycle.test.ts`**:
   - In `describe("the two families' lifecycle results are not interchangeable")`:
     - Removed redundant `@ts-expect-error` calls (`takesStudio(classResult)`, `takesClass(studioResult)`) for archive, pause, and update results.
     - Kept positive assertions exercising the type shapes for each family (`expect(takesStudio(studioResult)).toBe(true)`, `expect(takesClass(classResult)).toBe(true)`).
     - Updated docblock to cite that non-interchangeability is pinned at compile time via `NoneOf` in `src/services/rule-lifecycle.ts`.
   - In `it('refuses a childTable, logNoun, or editNoun that belongs to the other family')`:
     - Updated docblock to explicitly state that the 7 `@ts-expect-error` property assignment checks are verified by `npm run typecheck` only (`tsc --noEmit`) and are invisible to test runners.

---

## 2. Git Diff

```diff
diff --git a/src/services/rule-lifecycle.test.ts b/src/services/rule-lifecycle.test.ts
index c6b6df50..92a1496c 100644
--- a/src/services/rule-lifecycle.test.ts
+++ b/src/services/rule-lifecycle.test.ts
@@ -91,7 +91,9 @@ describe('rule-lifecycle family descriptors', () => {
    * than a silent widening.
    *
    * A claim about what the compiler refuses is worth only the pin that makes
-   * the compiler refuse it, which is the rule `ArchiveRuleResult`'s docblock
-   * states and the non-interchangeability pin below already follows.
+   * the compiler refuse it.
+   *
+   * The 7 `@ts-expect-error` property assignment checks below are verified by
+   * `npm run typecheck` only (`tsc --noEmit`) and are invisible to test runners.
    */
   it('refuses a childTable, logNoun, or editNoun that belongs to the other family', () => {
@@ -167,15 +169,12 @@ describe('rule-lifecycle family descriptors', () => {
 });
 
 /**
- * `ArchiveRuleResult`'s and `PauseRuleResult`'s docblocks (`rule-lifecycle.ts`)
- * both claim that being generic in the child leaves the two families' results
- * non-interchangeable, because `template` differs. A claim about what the
- * compiler refuses is worth only the pin that makes the compiler refuse it —
- * the shape `template-action-messages.test.ts` uses for the `templateKind`
- * discriminator this is modelled on ("the two toggle payloads are not
- * interchangeable"). One test per union, because the claim is made twice and
- * either declaration could lose the field that carries the difference without
- * the other noticing.
+ * Non-interchangeability of the two families' lifecycle results is pinned
+ * at compile time via `NoneOf` beside `ArchiveRuleResult`, `PauseRuleResult`,
+ * and `UpdateRuleResult` in `src/services/rule-lifecycle.ts` (#207).
+ *
+ * The tests below retain the positive assertions exercising the type shapes
+ * for each family.
  *
  * `{} as WithSlot<…>` because `template` is the only field carrying the
  * difference and nothing here reads the row; building two real ones would put
@@ -197,11 +196,6 @@ describe("the two families' lifecycle results are not interchangeable", () => {
       template: {} as WithSlot<StudioClassTemplate>,
     };
 
-    // @ts-expect-error a class archive result must never satisfy the studio one
-    takesStudio(classResult);
-    // @ts-expect-error a studio archive result must never satisfy the class one
-    takesClass(studioResult);
-
     // Each at its own family, so the two functions above are exercised rather
     // than merely declared.
     expect(takesStudio(studioResult)).toBe(true);
@@ -226,11 +220,6 @@ describe("the two families' lifecycle results are not interchangeable", () => {
       template: {} as WithSlot<StudioClassTemplate>,
     };
 
-    // @ts-expect-error a class pause result must never satisfy the studio one
-    takesStudio(classResult);
-    // @ts-expect-error a studio pause result must never satisfy the class one
-    takesClass(studioResult);
-
     expect(takesStudio(studioResult)).toBe(true);
     expect(takesClass(classResult)).toBe(true);
   });
@@ -252,11 +241,6 @@ describe("the two families' lifecycle results are not interchangeable", () => {
       generationState: 'active',
     };
 
-    // @ts-expect-error a class update result must never satisfy the studio one
-    takesStudio(classResult);
-    // @ts-expect-error a studio update result must never satisfy the class one
-    takesClass(studioResult);
-
     expect(takesStudio(studioResult)).toBe(true);
     expect(takesClass(classResult)).toBe(true);
   });
diff --git a/src/services/rule-lifecycle.ts b/src/services/rule-lifecycle.ts
index cb8a9e07..82cd8e8a 100644
--- a/src/services/rule-lifecycle.ts
+++ b/src/services/rule-lifecycle.ts
@@ -6,7 +6,7 @@
  */
 
 import { Prisma } from '@prisma/client';
-import type { PrismaClient, ClassFamily } from '@prisma/client';
+import type { PrismaClient, ClassFamily, ClassTemplate, StudioClassTemplate } from '@prisma/client';
 import type { TransactionClientOnly } from '@/lib/db-locks';
 import { setLockTimeout } from '@/lib/db-locks';
 import { startOfLocalDay, classStartInstant } from '@/lib/timezone';
@@ -16,6 +16,7 @@ import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
 import { ruleSlotHolder, minutesSinceMidnight, type RuleSlotHolder } from '@/lib/rule-slot-holder';
 import { isRecordNotFound, isTransientDbError, isRestrictViolationOn } from '@/lib/api-errors';
 import { log } from '@/lib/log';
+import type { NoneOf } from '@/lib/type-pins';
 import {
   type JoinedRule,
   type ChildWithRule,
@@ -319,10 +320,9 @@ export type TemplateFamily<TChild, TKind extends ClassFamily = ClassFamily> = Ge
  * non-interchangeable anyway, because `ArchiveRuleResult<ClassTemplate>` and
  * `ArchiveRuleResult<StudioClassTemplate>` differ in `template` — the same job
  * `templateKind` does for the wire types in `template-action-messages.ts`.
- * Held by `@ts-expect-error` call arguments in `rule-lifecycle.test.ts`, the
- * way `template-action-messages.test.ts` holds the discriminator this is
- * modelled on: a claim about what the compiler refuses is worth only the pin
- * that makes the compiler refuse it.
+ * Held by the compile-time `NoneOf` pins declared below (#207): a claim about
+ * what the compiler refuses is worth only the pin that makes the compiler
+ * refuse it.
  */
 export type ArchiveRuleResult<TChild> =
   | { ok: true; action: 'archived'; template: WithSlot<TChild>; deleted: number; remaining: number }
@@ -365,6 +365,22 @@ export type ArchiveRuleResult<TChild> =
    */
   | { ok: false; reason: 'busy' };
 
+// Compile-time pins asserting that class and studio archive results are
+// mutually non-interchangeable via `template: WithSlot<TChild>` (#207).
+const _classArchiveIsNotStudio: NoneOf<
+  ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>
+    ? 'ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>'
+    : never
+> = true;
+void _classArchiveIsNotStudio;
+
+const _studioArchiveIsNotClass: NoneOf<
+  ArchiveRuleResult<StudioClassTemplate> extends ArchiveRuleResult<ClassTemplate>
+    ? 'ArchiveRuleResult<StudioClassTemplate> extends ArchiveRuleResult<ClassTemplate>'
+    : never
+> = true;
+void _studioArchiveIsNotClass;
+
 /**
  * Archive or un-archive one `ScheduleRule` child, for whichever family
  * `family` describes. Archiving withdraws that rule's future calendar entries
@@ -901,8 +917,7 @@ export async function archiveOrUnarchiveRule<TChild>(
  * `ArchiveRuleResult` above sets out: the two families' pause unions were
  * measured arm-for-arm identical, and the two instantiations stay
  * non-interchangeable anyway because they differ in `template`. Held the same
- * way the archive's claim is, by `@ts-expect-error` call arguments in
- * `rule-lifecycle.test.ts`.
+ * way the archive's claim is, by the compile-time `NoneOf` pins declared below (#207).
  */
 export type PauseRuleResult<TChild> =
   | {
@@ -979,6 +994,22 @@ export type PauseRuleResult<TChild> =
    */
   | { ok: false; reason: 'busy' };
 
+// Compile-time pins asserting that class and studio pause results are
+// mutually non-interchangeable via `template: WithSlot<TChild>` (#207).
+const _classPauseIsNotStudio: NoneOf<
+  PauseRuleResult<ClassTemplate> extends PauseRuleResult<StudioClassTemplate>
+    ? 'PauseRuleResult<ClassTemplate> extends PauseRuleResult<StudioClassTemplate>'
+    : never
+> = true;
+void _classPauseIsNotStudio;
+
+const _studioPauseIsNotClass: NoneOf<
+  PauseRuleResult<StudioClassTemplate> extends PauseRuleResult<ClassTemplate>
+    ? 'PauseRuleResult<StudioClassTemplate> extends PauseRuleResult<ClassTemplate>'
+    : never
+> = true;
+void _studioPauseIsNotClass;
+
 /**
  * One arm per way `pauseOrResumeRule`'s transaction can resolve, mapped to the
  * public `PauseRuleResult` above once it has committed. None of these ever
@@ -1577,6 +1608,22 @@ export type UpdateRuleResult<TChild> =
    */
   | { ok: false; reason: 'busy' };
 
+// Compile-time pins asserting that class and studio update results are
+// mutually non-interchangeable via `template: WithSlot<TChild>` (#207).
+const _classUpdateIsNotStudio: NoneOf<
+  UpdateRuleResult<ClassTemplate> extends UpdateRuleResult<StudioClassTemplate>
+    ? 'UpdateRuleResult<ClassTemplate> extends UpdateRuleResult<StudioClassTemplate>'
+    : never
+> = true;
+void _classUpdateIsNotStudio;
+
+const _studioUpdateIsNotClass: NoneOf<
+  UpdateRuleResult<StudioClassTemplate> extends UpdateRuleResult<ClassTemplate>
+    ? 'UpdateRuleResult<StudioClassTemplate> extends UpdateRuleResult<ClassTemplate>'
+    : never
+> = true;
+void _studioUpdateIsNotClass;
+
 /**
  * Apply a partial update to a template child and its schedule rule.
  *
```

---

## 3. Verification

1. **`pnpm run typecheck`**:
   - Result: Exit code 0 (`tsc --noEmit` passed cleanly).

2. **`pnpm exec vitest run --project unit src/services/rule-lifecycle.test.ts`**:
   - Result: Exit code 0 (1 test file, 13 passed).

3. **`pnpm exec eslint src/services/rule-lifecycle.ts src/services/rule-lifecycle.test.ts`**:
   - Result: Exit code 0 (clean, no errors or warnings).

4. **Mutation Probe (Verification that pins bite)**:
   - Temporarily broke `ArchiveRuleResult<TChild>` by replacing `template: WithSlot<TChild>` with `template: { id: string }`.
   - `pnpm run typecheck` produced compiler error `TS2322`:
     `Type 'true' is not assignable to type '"ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>"'`
     and its studio-to-class twin.
   - Restored and confirmed clean typecheck (exit code 0).
