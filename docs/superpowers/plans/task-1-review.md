# Task 1 Review: Rename Pin, Update Docblocks, and Preserve Class Measurement

**Verdict:** APPROVED  
**Review Date:** 2026-09-13  
**Implementation Plan:** `docs/superpowers/plans/2026-09-13-template-partition-pin.md`  
**Task Report:** `docs/superpowers/plans/task-1-report.md`  

---

## 1. Spec Compliance & Acceptance Criteria

### A. `src/services/class-template-lifecycle.ts`
- **Pin Renaming and Construction:**
  - Renamed `_templateForbiddenListIsComplete` to `_templateListsPartitionTheModel`.
  - Type implementation correctly partitions against `keyof Prisma.ClassTemplateUncheckedUpdateManyInput`:
    ```ts
    const _templateListsPartitionTheModel: NoneOf<
      Exclude<
        keyof Prisma.ClassTemplateUncheckedUpdateManyInput,
        TeacherEditableClassTemplateField | PlainUpdateForbiddenTemplateField
      >
    > = true;
    void _templateListsPartitionTheModel;
    ```
- **Docblock Content & Citations:**
  - Accurately documents that completeness is verified against live Prisma `ClassTemplateUncheckedUpdateManyInput`.
  - Explains the critical mechanism difference: the old duplicate-union form only caught deletions from the union, whereas the partition form catches newly added columns from migrations that nobody classified.
  - Correctly cites issue #111 as the motivating incident where `archivedAt` and `withdrawnCount` were added to `ClassTemplate` without the old pin firing.

### B. `src/services/class-template-lifecycle.test.ts`
- Line 23 comment updated from `_templateForbiddenListIsComplete` to `_templateListsPartitionTheModel` alongside `_templateForbiddenColumnsExist`.
- Accurately describes what the partition pin and column existence pins prove vs. what the call-site guard in `updateClassTemplate` enforces.

### C. `src/services/class-lifecycle.ts`
- Docblock above `_classForbiddenListIsComplete` (lines 1065–1075) preserves the census measurement and context from Issue #270:
  - Explains why the partition pin form (`_templateListsPartitionTheModel`) is unavailable for `Class` without per-column design decisions.
  - States the measured census: `Class: 10 allowlist + 7 forbidden = 17, plus 7 unclassified = 24 columns`.
  - Records the verbatim seven unclassified names: `"teacherRoomId" | "templateId" | "cancelDeadline" | "autoCancelCheck" | "createdAt" | "updatedAt" | "spotBroadcastAt"`.
  - Notes the subsequent #327 split of `Class` and `CalendarEntry` (adding `calendarEntryId`, `kind`, `entryLive`, `roomArchived`), explaining why `Class` remains unpartitioned today.

---

## 2. Code and Comment Quality (CLAUDE.md Discipline)

- **No stale claims:** Historical census numbers and column lists are framed explicitly as measurements made during Issue #270, and subsequent structural changes (#327) are accounted for so no false claim is made about current column structure.
- **No untethered prose claims:** The partition pin in `class-template-lifecycle.ts` is tethered directly to the live compiler type `keyof Prisma.ClassTemplateUncheckedUpdateManyInput`.
- **Accurate references:** Issue citations (#111, #270, #327) are exact and match the codebase history and design decisions.

---

## 3. Verification

- **Typecheck:**
  - `pnpm run typecheck` (`tsc --noEmit`) completed with exit code 0 (clean pass).
- **Lint:**
  - `pnpm run lint` (`eslint`) completed with exit code 0 (0 errors, 6 pre-existing warnings in component UI code).
- **Test Suites:**
  - `pnpm exec vitest run src/services/class-template-lifecycle.test.ts` passed: 1 test file, 65 tests passed.
  - `pnpm exec vitest run src/services/class-lifecycle.test.ts` passed: 1 test file, 79 tests passed.
  - Full suite `pnpm test` passed: 71 test files, 927 tests passed.

---

## 4. Conclusion

Task 1 meets all requirements specified in the implementation plan and issue #270 acceptance criteria. Ready to proceed to Task 2 (Mutation Testing Protocol).
