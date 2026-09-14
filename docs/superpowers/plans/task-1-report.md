# Task 1 Implementation Report: Upgrade Toggle Payload Pins in api-types.ts & Clean Up template-action-messages.test.ts (#207)

**Issue:** #207  
**Plan:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md`  
**Status:** Completed  

---

## 1. Summary of Changes

1. **`src/lib/api-types.ts`**:
   - Replaced `import type { Assert, Equals } from '@/lib/type-pins'` with `import type { NoneOf } from '@/lib/type-pins'`.
   - Replaced the `Assert<Equals<..., false>>` type aliases with `NoneOf` compile-time pins (`_classIsNotStudio` and `_studioIsNotClass`).
   - If an invariant is violated, the pin evaluates to a descriptive string naming the offending direction (`'TemplateToggleResponse extends StudioTemplateToggleResponse'` or `'StudioTemplateToggleResponse extends TemplateToggleResponse'`), causing `Type 'true' is not assignable to type '<OffenderDescription>'`.

2. **`src/components/settings/template-action-messages.test.ts`**:
   - Removed the `describe('the two toggle payloads are not interchangeable')` block (formerly lines 741–764).
   - The `@ts-expect-error` directives with dummy `expect(true).toBe(true)` assertions are now redundant because the mutual non-assignability invariant is certified directly beside the type definitions in `src/lib/api-types.ts`.

---

## 2. Git Diff

```diff
diff --git a/src/components/settings/template-action-messages.test.ts b/src/components/settings/template-action-messages.test.ts
index 28cf91da..1761969f 100644
--- a/src/components/settings/template-action-messages.test.ts
+++ b/src/components/settings/template-action-messages.test.ts
@@ -737,28 +737,3 @@ describe('templateUpdatedMessage', () => {
     );
   });
 });
-
-describe('the two toggle payloads are not interchangeable', () => {
-  it('rejects a studio payload at the class resolver', () => {
-    const studio: StudioTemplateToggleResponse = {
-      action: 'active',
-      templateKind: 'studio',
-      scheduled: 4,
-      added: 0,
-      counts: { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 },
-    };
-    // @ts-expect-error studio payloads must never satisfy the class resolver
-    resolveTemplateConfirmation(studio);
-    // and the reverse
-    const cls: TemplateToggleResponse = {
-      action: 'active',
-      templateKind: 'class',
-      scheduled: 4,
-      added: 0,
-      counts: { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 },
-    };
-    // @ts-expect-error class payloads must never satisfy the studio resolver
-    resolveStudioConfirmation(cls);
-    expect(true).toBe(true);
-  });
-});
diff --git a/src/lib/api-types.ts b/src/lib/api-types.ts
index 9694e97f..9e608535 100644
--- a/src/lib/api-types.ts
+++ b/src/lib/api-types.ts
@@ -14,7 +14,7 @@
 
 import type { SkipCounts } from '@/lib/generation';
 import type { TemplateGenerationState } from '@/lib/template-selection';
-import type { Assert, Equals } from '@/lib/type-pins';
+import type { NoneOf } from '@/lib/type-pins';
 
 /**
  * The `data` payload of a successful PATCH on a class template (#206).
@@ -109,7 +109,18 @@ export interface TemplateEditResponse {
 }
 
 // Compile-time pins asserting that the class and studio toggle response types
-// remain non-interchangeable via `templateKind` (#93, #119, #206).
-type _classIsNotStudio = Assert<Equals<TemplateToggleResponse extends StudioTemplateToggleResponse ? true : false, false>>;
-type _studioIsNotClass = Assert<Equals<StudioTemplateToggleResponse extends TemplateToggleResponse ? true : false, false>>;
-void 0 as unknown as [_classIsNotStudio, _studioIsNotClass];
+// remain mutually non-interchangeable via `templateKind` (#93, #119, #206, #207).
+// Expressed with NoneOf so a broken invariant names the offending direction.
+const _classIsNotStudio: NoneOf<
+  TemplateToggleResponse extends StudioTemplateToggleResponse
+    ? 'TemplateToggleResponse extends StudioTemplateToggleResponse'
+    : never
+> = true;
+void _classIsNotStudio;
+
+const _studioIsNotClass: NoneOf<
+  StudioTemplateToggleResponse extends TemplateToggleResponse
+    ? 'StudioTemplateToggleResponse extends TemplateToggleResponse'
+    : never
+> = true;
+void _studioIsNotClass;
```

---

## 3. Verification

1. **`pnpm run typecheck`**:
   - Result: Exit code 0 (`tsc --noEmit`).
2. **`pnpm exec vitest run --project unit src/components/settings/template-action-messages.test.ts`**:
   - Result: Exit code 0 (1 test file, 68 passed).
3. **`pnpm exec eslint src/lib/api-types.ts src/components/settings/template-action-messages.test.ts`**:
   - Result: Exit code 0 (clean, no warnings or errors).
