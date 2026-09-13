# ClassTemplate Partition Pin & Completeness Alignment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the acceptance criteria of Issue #270: align `_templateListsPartitionTheModel` naming and docblock in `class-template-lifecycle.ts` (citing #111), preserve the `Class` measurement comment in `class-lifecycle.ts`, and prove every pin bites through reverted mutation testing (recording both halves).

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma, vitest (`unit`, `unit-sweeps`, `integration`, `components`).

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. `pnpm run typecheck` must be exit 0 at every commit.
- **Never start or restart the dev server on :3000.** The user runs it.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Commit per task.** The PR is rebase-merged, never squashed.
- **`pnpm run verify` before pushing.**

---

### Task 1: Rename Pin, Update Docblocks, and Preserve Class Measurement

**Files:**
- `src/services/class-template-lifecycle.ts` (modify)
- `src/services/class-template-lifecycle.test.ts` (modify)
- `src/services/class-lifecycle.ts` (modify)

**Behavior:**
1. In `src/services/class-template-lifecycle.ts:235-241`:
   - Rename `_templateForbiddenListIsComplete` to `_templateListsPartitionTheModel`:
     ```ts
     const _templateListsPartitionTheModel: NoneOf<
       Exclude<
         keyof Prisma.ClassTemplateUncheckedUpdateManyInput,
         TeacherEditableClassTemplateField | PlainUpdateForbiddenTemplateField
       >
     > = true;
     void _templateListsPartitionTheModel;
     ```
   - Update its docblock to record:
     - The pin checks completeness against live Prisma `ClassTemplateUncheckedUpdateManyInput`.
     - Unlike the old duplicate-union form (which only caught deletions from the union), the partition form catches newly added columns from migrations that nobody classified.
     - Cite issue #111 as the motivating incident where `archivedAt` and `withdrawnCount` were added to `ClassTemplate` without the old pin firing.
2. In `src/services/class-template-lifecycle.test.ts:23`:
   - Update the comment referencing `_templateForbiddenListIsComplete` to `_templateListsPartitionTheModel`.
3. In `src/services/class-lifecycle.ts:1065`:
   - In the docblock above `_classForbiddenListIsComplete`, preserve the measurement and explanation from Issue #270:
     - Note why the partition substitution is unavailable for `Class` without per-column design decisions.
     - State the measured census: `Class: 10 allowlist + 7 forbidden = 17, plus 7 unclassified = 24 columns`.
     - Record the verbatim seven unclassified names: `"teacherRoomId" | "templateId" | "cancelDeadline" | "autoCancelCheck" | "createdAt" | "updatedAt" | "spotBroadcastAt"`.
     - Note that issue #327 split `Class` and `CalendarEntry` (adding `calendarEntryId`, `kind`, `entryLive`, `roomArchived`), leaving `Class` unpartitioned today as well.

- [ ] **Step 1: Apply the code and docblock updates across the three files**
- [ ] **Step 2: Run `pnpm run typecheck` and `pnpm test` to verify clean pass**
- [ ] **Step 3: Commit Task 1 changes**

---

### Task 2: Mutation Testing Protocol — Prove Every Guard Bites

**Files:**
- `src/services/class-template-lifecycle.ts`
- `src/services/class-template-lifecycle.test.ts`
- `docs/superpowers/plans/2026-09-13-template-partition-pin-mutations.md` (create to record mutation results)

**Behavior:**
Execute and record each mutation using `tsc --noEmit` and/or test runner, logging exact compiler errors and verifying both halves.

1. **Partition Pin Both-Halves Proof:**
   - **Mutation A (Simulated added column):**
     - Add simulated column `& { simulatedUnclassifiedColumn?: string }` to `Prisma.ClassTemplateUncheckedUpdateManyInput`.
     - Observe: `_templateListsPartitionTheModel` fails RED with `Type 'true' is not assignable to type '"simulatedUnclassifiedColumn"'`.
     - Contrast: Under the old duplicate-union form (`Exclude<'id' | ... , PlainUpdateForbiddenTemplateField>`), verify that the pin stays GREEN.
   - **Mutation B (Deleted forbidden entry):**
     - Remove `'roomArchived'` from `PlainUpdateForbiddenTemplateField`.
     - Observe: `_templateListsPartitionTheModel` fails RED naming `'roomArchived'`.
   - **Mutation C (Typo'd forbidden column):**
     - Change `'roomArchived'` to `'roomArchive'` in `PlainUpdateForbiddenTemplateField`.
     - Observe: `_templateForbiddenColumnsExist` fails RED with `Type 'true' is not assignable to type '"roomArchive"'` and `_templateListsPartitionTheModel` fails RED.

2. **Re-prove All Other Pins in `class-template-lifecycle.ts`:**
   - `_templateUpdateColumnsExist`: Add a non-column field to `ClassTemplateOwnUpdateData` -> fails RED.
   - `_templateFieldsArePermitted`: Add an unpermitted field to `ClassTemplateOwnUpdateData` -> fails RED.
   - `_templateAllowlistHasNoStaleFields`: Add an extra field to `TeacherEditableClassTemplateField` -> fails RED.
   - `_templateAllowlistHasNoForbiddenFields`: Add a forbidden field (`'roomArchived'`) to `TeacherEditableClassTemplateField` -> fails RED.
   - `_scheduleRuleUpdateColumnsExist`: Add non-column field to `ScheduleRuleUpdateData` -> fails RED.
   - `_scheduleRuleFieldsArePermitted`: Add unpermitted field to `ScheduleRuleUpdateData` -> fails RED.
   - `_scheduleRuleAllowlistHasNoStaleFields`: Add extra field to `TeacherEditableScheduleRuleField` -> fails RED.
   - `_scheduleRuleListsPartitionTheModel`: Delete a field from `PlainUpdateForbiddenScheduleRuleField` -> fails RED.
   - `_scheduleRuleForbiddenColumnsExist`: Typo in `PlainUpdateForbiddenScheduleRuleField` -> fails RED.
   - `_scheduleRuleAllowlistHasNoForbiddenFields`: Add forbidden field to `TeacherEditableScheduleRuleField` -> fails RED.
   - Call-site parameter guard (`class-template-lifecycle.test.ts`): Remove `& Partial<Record<PlainUpdateForbiddenTemplateField, never>>` from `updateClassTemplate` -> `@ts-expect-error` in test goes unused, `tsc` fails RED.

- [ ] **Step 1: Run and log each mutation in the mutation record document**
- [ ] **Step 2: Ensure all mutations are fully reverted and `pnpm run typecheck` is clean (exit 0)**
- [ ] **Step 3: Commit Task 2 mutation record**

---

### Task 3: Full Verification & PR Ready

**Behavior:**
1. Run full verification sequence:
   - `pnpm run typecheck`
   - `pnpm run lint`
   - `pnpm test`
2. Verify git status has no uncommitted leftovers.

- [ ] **Step 1: Execute `pnpm run verify`**
- [ ] **Step 2: Confirm all tests green**
