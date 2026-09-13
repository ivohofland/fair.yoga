# Task 1 Implementation Report

**Task:** Rename Pin, Update Docblocks, and Preserve Class Measurement  
**Implementation Plan:** `docs/superpowers/plans/2026-09-13-template-partition-pin.md`  
**Status:** Completed

---

## 1. Summary of Changes

### A. `src/services/class-template-lifecycle.ts`
- Renamed compile-time pin const `_templateForbiddenListIsComplete` to `_templateListsPartitionTheModel`.
- Renamed the corresponding `void _templateListsPartitionTheModel;` expression.
- Updated docblock above `_templateListsPartitionTheModel`:
  - Documents that completeness is verified against live Prisma `ClassTemplateUncheckedUpdateManyInput`.
  - Explains what the partition form catches that the duplicate-union form could not (additions to the model vs deletions).
  - Cites issue #111 as the motivating incident where `archivedAt` and `withdrawnCount` were added to `ClassTemplate` without the old pin firing.

### B. `src/services/class-template-lifecycle.test.ts`
- Updated the comment at lines 20-30 to refer to `_templateListsPartitionTheModel` alongside `_templateForbiddenColumnsExist`.

### C. `src/services/class-lifecycle.ts`
- Updated the docblock above `_classForbiddenListIsComplete` (around line 1065):
  - Preserved the issue #270 census measurement across the `Class` model: `Class: 10 allowlist + 7 forbidden = 17, plus 7 unclassified = 24 columns`.
  - Recorded the verbatim seven unclassified names: `"teacherRoomId" | "templateId" | "cancelDeadline" | "autoCancelCheck" | "createdAt" | "updatedAt" | "spotBroadcastAt"`.
  - Noted that issue #327 split `Class` and `CalendarEntry`, adding foreign keys and mirrors (`calendarEntryId`, `kind`, `entryLive`, `roomArchived`), leaving `Class` unpartitioned today.
  - Explained that applying a partition pin to `Class` cannot be a mechanical substitution and would require per-column design decisions.

---

## 2. Git Diff

```diff
diff --git a/src/services/class-lifecycle.ts b/src/services/class-lifecycle.ts
index e4f9b07a..ed391566 100644
--- a/src/services/class-lifecycle.ts
+++ b/src/services/class-lifecycle.ts
@@ -1061,6 +1061,17 @@ type PlainUpdateForbiddenClassField =
  * component's form-coverage pin, which a contributor clears by adding the
  * field to the form. Duplication is the price; it turns a silent deletion into
  * a two-place edit, which is the visibility the docblock above says it wants.
+ *
+ * Why the partition pin form (`_templateListsPartitionTheModel`) is unavailable
+ * for `Class`: Issue #270 measured the census across the `Class` model:
+ *   Class: 10 allowlist + 7 forbidden = 17, plus 7 unclassified = 24 columns.
+ * The verbatim seven unclassified names were:
+ *   "teacherRoomId" | "templateId" | "cancelDeadline" | "autoCancelCheck" |
+ *   "createdAt" | "updatedAt" | "spotBroadcastAt".
+ * Later, issue #327 split `Class` and `CalendarEntry`, adding foreign keys and
+ * mirrors (`calendarEntryId`, `kind`, `entryLive`, `roomArchived`), so `Class`
+ * remains unpartitioned today. Applying a partition pin here would require
+ * per-column design decisions rather than a mechanical substitution.
  */
 const _classForbiddenListIsComplete: NoneOf<
   Exclude<
diff --git a/src/services/class-template-lifecycle.test.ts b/src/services/class-template-lifecycle.test.ts
index 8897bd2e..fc0987be 100644
--- a/src/services/class-template-lifecycle.test.ts
+++ b/src/services/class-template-lifecycle.test.ts
@@ -20,7 +20,7 @@ import { log } from '@/lib/log';
  * The forbidden-field GUARD is required on `updateClassTemplate`'s `data`
  * parameter, and this is what enforces it.
  *
- * `_templateForbiddenListIsComplete` and `_templateForbiddenColumnsExist`
+ * `_templateListsPartitionTheModel` and `_templateForbiddenColumnsExist`
  * prove the list's CONTENT — every column is classified, and no name on it is
  * absent from the model. Neither proves the list is APPLIED. Dropping
  * `& Partial<Record<PlainUpdateForbiddenTemplateField, never>>` from the
diff --git a/src/services/class-template-lifecycle.ts b/src/services/class-template-lifecycle.ts
index 228e1c65..a2ba2903 100644
--- a/src/services/class-template-lifecycle.ts
+++ b/src/services/class-template-lifecycle.ts
@@ -228,17 +228,22 @@ type PlainUpdateForbiddenTemplateField =
 /**
  * Compile-time pin (completeness): every `ClassTemplate` column must be
  * claimed by the allowlist or the forbidden list above — checked against the
- * live Prisma type, so a migration that adds an unclassified column reddens
- * this rather than passing silently, matching the rule-level and
- * studio-family pins beside this one.
+ * live Prisma `ClassTemplateUncheckedUpdateManyInput`.
+ *
+ * Unlike the old duplicate-union form (which only caught deletions from the
+ * union), the partition form catches newly added columns from migrations that
+ * nobody classified. The motivating incident was issue #111, where
+ * `archivedAt` and `withdrawnCount` were added to `ClassTemplate` without the
+ * old pin firing. Matching the rule-level and studio-family pins beside this
+ * one, this reddens immediately when an unclassified column is introduced.
  */
-const _templateForbiddenListIsComplete: NoneOf<
+const _templateListsPartitionTheModel: NoneOf<
   Exclude<
     keyof Prisma.ClassTemplateUncheckedUpdateManyInput,
     TeacherEditableClassTemplateField | PlainUpdateForbiddenTemplateField
   >
 > = true;
-void _templateForbiddenListIsComplete;
+void _templateListsPartitionTheModel;
 
 /**
  * Compile-time pin: every name above must be a real `ClassTemplate` column.
```

---

## 3. Typecheck Output

```bash
$ pnpm run typecheck
> tsc --noEmit
# Exit code 0 (clean pass)
```
