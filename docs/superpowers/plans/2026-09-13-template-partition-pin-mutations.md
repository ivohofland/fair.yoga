# Mutation Record — ClassTemplate Partition Pin & Lifecycle Pins (Issue #270)

This document records the mutation testing protocol for Issue #270 in accordance with `AGENTS.md` and `docs/solve-issue-lessons.md`:
> *"A pin that compiles but cannot fail certifies nothing. Break it, record the exact error text, restore, re-verify — put this in the plan as an explicit step, per guard."*

Every mutation was executed in-place, verified via `pnpm exec tsc --noEmit`, recorded verbatim with exit code and compiler error text, reverted immediately, and re-verified to a clean green state.

---

## Part 1: Partition Pin Both-Halves Proof

Proves both halves of `_templateListsPartitionTheModel`:
1. It catches unclassified columns added to the live Prisma model (which the old duplicate-union form silently ignored — issue #111).
2. It catches deletions and typos in the classified lists (`PlainUpdateForbiddenTemplateField`).

### Mutation 1A: Simulated Added Column (Partition Form Catches Schema Addition)

- **Target:** `_templateListsPartitionTheModel` in `src/services/class-template-lifecycle.ts:240-245`
- **Change:** Add simulated unclassified column to `Prisma.ClassTemplateUncheckedUpdateManyInput`:
  ```ts
  const _templateListsPartitionTheModel: NoneOf<
    Exclude<
      keyof (Prisma.ClassTemplateUncheckedUpdateManyInput & { simulatedUnclassifiedColumn?: string }),
      TeacherEditableClassTemplateField | PlainUpdateForbiddenTemplateField
    >
  > = true;
  ```
- **Must fire:** `_templateListsPartitionTheModel` naming `'simulatedUnclassifiedColumn'`.
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.ts(240,7): error TS2322: Type 'true' is not assignable to type '"simulatedUnclassifiedColumn"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 1B: Contrast with Old Duplicate-Union Form (Old Pin Stays Blind)

- **Target:** `_templateListsPartitionTheModel` in `src/services/class-template-lifecycle.ts:240-245`
- **Change:** With the simulated column present on the model type, evaluate the old duplicate-union pin form:
  ```ts
  // Simulated column on model type:
  type _SimulatedModelWithAddedColumn = Prisma.ClassTemplateUncheckedUpdateManyInput & { simulatedUnclassifiedColumn?: string };
  // Old duplicate-union completeness check:
  const _templateListsPartitionTheModel: NoneOf<
    Exclude<
      | 'id'
      | 'scheduleRuleId'
      | 'kind'
      | 'roomArchived'
      | 'ruleLive'
      | 'createdAt'
      | 'updatedAt',
      PlainUpdateForbiddenTemplateField
    >
  > = true;
  ```
- **Must fire / pass:** Old form does not reference the live Prisma type; must stay GREEN despite the unclassified column.
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 0
- **Typecheck (verbatim):**
  *(clean exit 0, no output)*
- **Analysis:** Demonstrates why the duplicate-union form was defective in incident #111 (when `archivedAt` and `withdrawnCount` were added to the schema without the pin firing). The partition form in Mutation 1A immediately caught the new column.
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 2: Deleted Forbidden Entry

- **Target:** `PlainUpdateForbiddenTemplateField` in `src/services/class-template-lifecycle.ts:219-226`
- **Change:** Remove `'roomArchived'` from `PlainUpdateForbiddenTemplateField`.
  ```diff
  --- a/src/services/class-template-lifecycle.ts
  +++ b/src/services/class-template-lifecycle.ts
  @@ -220,7 +220,6 @@ type PlainUpdateForbiddenTemplateField =
     | 'id'
     | 'scheduleRuleId'
     | 'kind'
  -  | 'roomArchived'
     | 'ruleLive'
     | 'createdAt'
     | 'updatedAt';
  ```
- **Must fire:** `_templateListsPartitionTheModel` (names `'roomArchived'`) and call-site parameter guard test in `class-template-lifecycle.test.ts:53`.
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.test.ts(53,3): error TS2578: Unused '@ts-expect-error' directive.
  src/services/class-template-lifecycle.ts(239,7): error TS2322: Type 'true' is not assignable to type '"roomArchived"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 3: Typo'd Forbidden Column

- **Target:** `PlainUpdateForbiddenTemplateField` in `src/services/class-template-lifecycle.ts:223`
- **Change:** Typo `'roomArchived'` to `'roomArchive'`.
  ```diff
  --- a/src/services/class-template-lifecycle.ts
  +++ b/src/services/class-template-lifecycle.ts
  @@ -220,7 +220,7 @@ type PlainUpdateForbiddenTemplateField =
     | 'id'
     | 'scheduleRuleId'
     | 'kind'
  -  | 'roomArchived'
  +  | 'roomArchive'
     | 'ruleLive'
     | 'createdAt'
     | 'updatedAt';
  ```
- **Must fire:** `_templateForbiddenColumnsExist` (names `'roomArchive'`), `_templateListsPartitionTheModel` (names `'roomArchived'`), and test call-site guard.
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.test.ts(53,3): error TS2578: Unused '@ts-expect-error' directive.
  src/services/class-template-lifecycle.ts(240,7): error TS2322: Type 'true' is not assignable to type '"roomArchived"'.
  src/services/class-template-lifecycle.ts(253,7): error TS2322: Type 'true' is not assignable to type '"roomArchive"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

## Part 2: Re-proving All Other Lifecycle Pins

### Mutation 4: `_templateUpdateColumnsExist` (Invalid Column in Wire Update Slice)

- **Target:** `ClassTemplateOwnUpdateData` in `src/services/class-template-lifecycle.ts:102-105`
- **Change:** Add non-existent column `notAColumn` to `ClassTemplateOwnUpdateData`:
  ```ts
  type ClassTemplateOwnUpdateData = Omit<
    ClassTemplateUpdateData,
    'classType' | 'dayOfWeek' | 'startTime' | 'durationMinutes'
  > & { notAColumn?: string };
  ```
- **Must fire:** `_templateUpdateColumnsExist` (names `'notAColumn'`).
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.ts(118,7): error TS2322: Type 'true' is not assignable to type '"notAColumn"'.
  src/services/class-template-lifecycle.ts(167,7): error TS2322: Type 'true' is not assignable to type '"notAColumn"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 5: `_templateFieldsArePermitted` (Unpermitted Field in Wire Update Slice)

- **Target:** `ClassTemplateOwnUpdateData` in `src/services/class-template-lifecycle.ts:102-105`
- **Change:** Add valid column that is forbidden/unpermitted (`roomArchived`) to `ClassTemplateOwnUpdateData`:
  ```ts
  type ClassTemplateOwnUpdateData = Omit<
    ClassTemplateUpdateData,
    'classType' | 'dayOfWeek' | 'startTime' | 'durationMinutes'
  > & { roomArchived?: boolean };
  ```
- **Must fire:** `_templateFieldsArePermitted` (names `'roomArchived'`).
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.ts(167,7): error TS2322: Type 'true' is not assignable to type '"roomArchived"'.
  src/services/class-template-lifecycle.ts(874,11): error TS2322: Type 'ClassTemplateOwnUpdateData' is not assignable to type 'ClassTemplateUncheckedUpdateManyInput & Partial<Record<PlainUpdateForbiddenTemplateField, never>>'.
    Type 'ClassTemplateOwnUpdateData' is not assignable to type 'Partial<Record<PlainUpdateForbiddenTemplateField, never>>'.
      Types of property 'roomArchived' are incompatible.
        Type 'boolean | undefined' is not assignable to type 'undefined'.
          Type 'false' is not assignable to type 'undefined'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 6: `_templateAllowlistHasNoStaleFields` (Extra Stale Field on Allowlist)

- **Target:** `TeacherEditableClassTemplateField` in `src/services/class-template-lifecycle.ts:145-154`
- **Change:** Add `'staleField'` to `TeacherEditableClassTemplateField`.
  ```diff
  --- a/src/services/class-template-lifecycle.ts
  +++ b/src/services/class-template-lifecycle.ts
  @@ -151,7 +151,8 @@ type TeacherEditableClassTemplateField =
     | 'minStudents'
     | 'maxStudents'
     | 'cancelDeadline'
  -  | 'autoCancelCheck';
  +  | 'autoCancelCheck'
  +  | 'staleField';
  ```
- **Must fire:** `_templateAllowlistHasNoStaleFields` (names `'staleField'`).
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.ts(181,7): error TS2322: Type 'true' is not assignable to type '"staleField"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 7: `_templateAllowlistHasNoForbiddenFields` (Forbidden Field on Allowlist)

- **Target:** `TeacherEditableClassTemplateField` in `src/services/class-template-lifecycle.ts:145-154`
- **Change:** Add `'roomArchived'` to `TeacherEditableClassTemplateField`.
  ```diff
  --- a/src/services/class-template-lifecycle.ts
  +++ b/src/services/class-template-lifecycle.ts
  @@ -151,7 +151,8 @@ type TeacherEditableClassTemplateField =
     | 'minStudents'
     | 'maxStudents'
     | 'cancelDeadline'
  -  | 'autoCancelCheck';
  +  | 'autoCancelCheck'
  +  | 'roomArchived';
  ```
- **Must fire:** `_templateAllowlistHasNoForbiddenFields` (names `'roomArchived'`) and `_templateAllowlistHasNoStaleFields`.
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.ts(181,7): error TS2322: Type 'true' is not assignable to type '"roomArchived"'.
  src/services/class-template-lifecycle.ts(264,7): error TS2322: Type 'true' is not assignable to type '"roomArchived"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 8: `_scheduleRuleUpdateColumnsExist` (Invalid Column in Rule Update Slice)

- **Target:** `ScheduleRuleUpdateData` in `src/services/class-template-lifecycle.ts:93-97`
- **Change:** Add `& { notARuleColumn?: string }` to `ScheduleRuleUpdateData`:
  ```ts
  type ScheduleRuleUpdateData = Pick<
    ClassTemplateUpdateData,
    'classType' | 'dayOfWeek' | 'startTime' | 'durationMinutes'
  > & { notARuleColumn?: string };
  ```
- **Must fire:** `_scheduleRuleUpdateColumnsExist` (names `'notARuleColumn'`).
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.ts(288,7): error TS2322: Type 'true' is not assignable to type '"notARuleColumn"'.
  src/services/class-template-lifecycle.ts(310,7): error TS2322: Type 'true' is not assignable to type '"notARuleColumn"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 9: `_scheduleRuleFieldsArePermitted` (Unpermitted Field in Rule Update Slice)

- **Target:** `ScheduleRuleUpdateData` in `src/services/class-template-lifecycle.ts:93-97`
- **Change:** Add valid column that is forbidden/unpermitted (`isActive`) to `ScheduleRuleUpdateData`:
  ```ts
  type ScheduleRuleUpdateData = Pick<
    ClassTemplateUpdateData,
    'classType' | 'dayOfWeek' | 'startTime' | 'durationMinutes'
  > & { isActive?: boolean };
  ```
- **Must fire:** `_scheduleRuleFieldsArePermitted` (names `'isActive'`).
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.ts(310,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 10: `_scheduleRuleAllowlistHasNoStaleFields` (Extra Field on Rule Allowlist)

- **Target:** `TeacherEditableScheduleRuleField` in `src/services/class-template-lifecycle.ts:303-307`
- **Change:** Add `'staleRuleField'` to `TeacherEditableScheduleRuleField`:
  ```diff
  --- a/src/services/class-template-lifecycle.ts
  +++ b/src/services/class-template-lifecycle.ts
  @@ -304,7 +304,8 @@ export type TeacherEditableScheduleRuleField =
     | 'classType'
     | 'dayOfWeek'
     | 'startTime'
  -  | 'durationMinutes';
  +  | 'durationMinutes'
  +  | 'staleRuleField';
  ```
- **Must fire:** `_scheduleRuleAllowlistHasNoStaleFields` (names `'staleRuleField'`).
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.ts(317,7): error TS2322: Type 'true' is not assignable to type '"staleRuleField"'.
  src/services/rule-lifecycle.ts(1634,83): error TS2344: Type 'TeacherEditableScheduleRuleField' does not satisfy the constraint 'keyof ScheduleRuleUncheckedUpdateManyInput'.
    Type '"staleRuleField"' is not assignable to type 'keyof ScheduleRuleUncheckedUpdateManyInput'.
  src/services/studio-class-template-lifecycle.ts(358,7): error TS2322: Type 'true' is not assignable to type '"staleRuleField"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 11: `_scheduleRuleListsPartitionTheModel` (Deleted Forbidden Rule Entry)

- **Target:** `PlainUpdateForbiddenScheduleRuleField` in `src/services/class-template-lifecycle.ts:354-365`
- **Change:** Remove `'isActive'` from `PlainUpdateForbiddenScheduleRuleField`.
  ```diff
  --- a/src/services/class-template-lifecycle.ts
  +++ b/src/services/class-template-lifecycle.ts
  @@ -355,7 +355,6 @@ export type PlainUpdateForbiddenScheduleRuleField =
     | 'id'
     | 'teacherId'
     | 'kind'
  -  | 'isActive'
     | 'isArchived'
     | 'archivedAt'
     | 'withdrawnCount'
  ```
- **Must fire:** `_scheduleRuleListsPartitionTheModel` (names `'isActive'`), test call-site guard, and downstream studio pin.
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.test.ts(57,3): error TS2578: Unused '@ts-expect-error' directive.
  src/services/class-template-lifecycle.ts(372,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
  src/services/studio-class-template-lifecycle.test.ts(22,3): error TS2578: Unused '@ts-expect-error' directive.
  src/services/studio-class-template-lifecycle.ts(410,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 12: `_scheduleRuleForbiddenColumnsExist` (Typo in Forbidden Rule Column)

- **Target:** `PlainUpdateForbiddenScheduleRuleField` in `src/services/class-template-lifecycle.ts:358`
- **Change:** Typo `'isActive'` to `'isActiv'`.
  ```diff
  --- a/src/services/class-template-lifecycle.ts
  +++ b/src/services/class-template-lifecycle.ts
  @@ -355,7 +355,7 @@ export type PlainUpdateForbiddenScheduleRuleField =
     | 'id'
     | 'teacherId'
     | 'kind'
  -  | 'isActive'
  +  | 'isActiv'
     | 'isArchived'
     | 'archivedAt'
     | 'withdrawnCount'
  ```
- **Must fire:** `_scheduleRuleForbiddenColumnsExist` (names `'isActiv'`), `_scheduleRuleListsPartitionTheModel` (names `'isActive'`), test call-site guard, and downstream studio pin.
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.test.ts(57,3): error TS2578: Unused '@ts-expect-error' directive.
  src/services/class-template-lifecycle.ts(373,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
  src/services/class-template-lifecycle.ts(386,7): error TS2322: Type 'true' is not assignable to type '"isActiv"'.
  src/services/studio-class-template-lifecycle.test.ts(22,3): error TS2578: Unused '@ts-expect-error' directive.
  src/services/studio-class-template-lifecycle.ts(410,7): error TS2322: Type 'true' is not assignable to type '"isActive" | "isActiv"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 13: `_scheduleRuleAllowlistHasNoForbiddenFields` (Forbidden Field on Rule Allowlist)

- **Target:** `TeacherEditableScheduleRuleField` in `src/services/class-template-lifecycle.ts:303-307`
- **Change:** Add `'isActive'` to `TeacherEditableScheduleRuleField`.
  ```diff
  --- a/src/services/class-template-lifecycle.ts
  +++ b/src/services/class-template-lifecycle.ts
  @@ -304,7 +304,8 @@ export type TeacherEditableScheduleRuleField =
     | 'classType'
     | 'dayOfWeek'
     | 'startTime'
  -  | 'durationMinutes';
  +  | 'durationMinutes'
  +  | 'isActive';
  ```
- **Must fire:** `_scheduleRuleAllowlistHasNoForbiddenFields` (names `'isActive'`) and `_scheduleRuleAllowlistHasNoStaleFields`.
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.ts(317,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
  src/services/class-template-lifecycle.ts(396,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
  src/services/studio-class-template-lifecycle.ts(358,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

### Mutation 14: Call-Site Parameter Guard (`src/services/class-template-lifecycle.test.ts:43-61`)

- **Target:** `updateClassTemplate` data parameter in `src/services/class-template-lifecycle.ts:457-460`
- **Change:** Remove `& Partial<Record<PlainUpdateForbiddenTemplateField, never>>` from `updateClassTemplate` parameter definition:
  ```diff
  --- a/src/services/class-template-lifecycle.ts
  +++ b/src/services/class-template-lifecycle.ts
  @@ -455,7 +455,6 @@ export function updateClassTemplate(
     templateId: string,
     teacherId: string,
     data: ClassTemplateUpdateData &
  -    Partial<Record<PlainUpdateForbiddenTemplateField, never>> &
       Partial<Record<PlainUpdateForbiddenScheduleRuleField, never>>,
   ): Promise<UpdateClassTemplateResult> {
  ```
- **Must fire:** `@ts-expect-error` directives in `src/services/class-template-lifecycle.test.ts` for template-forbidden fields (`scheduleRuleId`, `roomArchived`, `ruleLive`) go unused (`TS2578`).
- **Command:** `pnpm exec tsc --noEmit`
- **Exit Code:** 2
- **Typecheck (verbatim):**
  ```
  src/services/class-template-lifecycle.test.ts(51,3): error TS2578: Unused '@ts-expect-error' directive.
  src/services/class-template-lifecycle.test.ts(53,3): error TS2578: Unused '@ts-expect-error' directive.
  src/services/class-template-lifecycle.test.ts(55,3): error TS2578: Unused '@ts-expect-error' directive.
  ```
- **Status:** Reverted, re-run clean (exit code 0). ✅

---

## Summary & Verification Status

- All 14 mutations were executed and verified against TypeScript compiler behavior.
- Every pin was proven to bite (failing RED with TS error code 2322 or 2578, naming the offending identifier).
- The partition form both-halves proof (Mutations 1A & 1B) conclusively proves why partition pins are superior to duplicate-union pins when new model columns are introduced (#111).
- All files are restored to clean baseline; `pnpm exec tsc --noEmit` exits 0 with zero errors.
