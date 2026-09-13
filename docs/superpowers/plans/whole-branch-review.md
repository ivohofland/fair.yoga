# Whole-Branch Review: `solve_issue_270`

- **Branch:** `solve_issue_270`
- **Base Commit:** `7a272263` (`update .gitignore`)
- **Head Commit:** `aaf2a0f8` (`test(templates): prove partition pin and re-prove lifecycle pins by mutation (#270)`)
- **Review Date:** 2026-09-13
- **Reviewer:** Whole-Branch Review Agent
- **Verdict:** **APPROVED** ✅

---

## 1. Executive Summary

This whole-branch review evaluates all commits on branch `solve_issue_270` against base `7a272263` (`git diff 7a272263 HEAD`), assessing compliance with Issue #270 acceptance criteria, codebase architectural invariants, and verification standards established in `AGENTS.md`.

The branch accomplishes three core goals:
1. Renames `_templateForbiddenListIsComplete` to `_templateListsPartitionTheModel` in [src/services/class-template-lifecycle.ts](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts), harmonizing naming with `_scheduleRuleListsPartitionTheModel` and the studio-family partition pins.
2. Updates docblocks in [src/services/class-template-lifecycle.ts](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts) (citing motivating incident #111) and [src/services/class-lifecycle.ts](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-lifecycle.ts) (preserving the historical census measurement of Issue #270 and explaining why `Class` remains unpartitioned following Issue #327).
3. Executes and documents a comprehensive 14-mutation testing protocol in [docs/superpowers/plans/2026-09-13-template-partition-pin-mutations.md](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/docs/superpowers/plans/2026-09-13-template-partition-pin-mutations.md), proving both halves of the partition pin and re-proving all remaining compile-time pins and call-site guards.

All automated verification checks passed cleanly (`pnpm run typecheck`, `pnpm run lint`, and `pnpm test`).

---

## 2. Cross-Task Consistency Analysis

### A. Identifier & Reference Consistency (`_templateListsPartitionTheModel`)
- **Declaration:** In [src/services/class-template-lifecycle.ts:240-246](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts#L240-L246), the compile-time pin is declared and consumed via `void`:
  ```ts
  const _templateListsPartitionTheModel: NoneOf<
    Exclude<
      keyof Prisma.ClassTemplateUncheckedUpdateManyInput,
      TeacherEditableClassTemplateField | PlainUpdateForbiddenTemplateField
    >
  > = true;
  void _templateListsPartitionTheModel;
  ```
- **Test References:** In [src/services/class-template-lifecycle.test.ts:23](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.test.ts#L23), the comment block explaining the content pins vs. call-site guard was updated from `_templateForbiddenListIsComplete` to `_templateListsPartitionTheModel`.
- **Peer References:** In [src/services/class-lifecycle.ts:1065](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-lifecycle.ts#L1065), the docblock directly references `_templateListsPartitionTheModel` by its new name.
- **Codebase Grep Audit:** A global search across all source files in `src/` confirmed zero remaining occurrences of `_templateForbiddenListIsComplete`. All references in source code and active test suites use `_templateListsPartitionTheModel`.
- **Naming Symmetry:** The name now aligns directly with sibling partition pins:
  - `_templateListsPartitionTheModel` ([class-template-lifecycle.ts](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts#L240))
  - `_scheduleRuleListsPartitionTheModel` ([class-template-lifecycle.ts](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts#L373))
  - `_studioTemplateListsPartitionTheModel` ([studio-class-template-lifecycle.ts](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/studio-class-template-lifecycle.ts#L247))
  - `_scheduleRuleListsPartitionTheModel` ([studio-class-template-lifecycle.ts](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/studio-class-template-lifecycle.ts#L422))

### B. Accuracy of Mutation Testing Documentation
[docs/superpowers/plans/2026-09-13-template-partition-pin-mutations.md](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/docs/superpowers/plans/2026-09-13-template-partition-pin-mutations.md) was reviewed against the active pin code:
- **Both-Halves Proof (Mutations 1A & 1B):**
  - **Mutation 1A:** Adds `simulatedUnclassifiedColumn?: string` to `Prisma.ClassTemplateUncheckedUpdateManyInput`. `_templateListsPartitionTheModel` fails RED with `TS2322: Type 'true' is not assignable to type '"simulatedUnclassifiedColumn"'` (exit code 2).
  - **Mutation 1B:** Contrasts with the legacy duplicate-union form (`Exclude<'id' | ... , PlainUpdateForbiddenTemplateField>`), proving it remained GREEN (exit code 0) under the exact same schema change. This precisely explains how incident #111 occurred.
- **Deleted & Typo Mutations (Mutations 2 & 3):**
  - **Mutation 2:** Deleting `'roomArchived'` from `PlainUpdateForbiddenTemplateField` caused `_templateListsPartitionTheModel` to fail RED (naming `'roomArchived'`), and the call-site guard in `class-template-lifecycle.test.ts:53` failed with unused `@ts-expect-error` (`TS2578`).
  - **Mutation 3:** Typo'ing `'roomArchived'` to `'roomArchive'` caused `_templateForbiddenColumnsExist` to fail RED (naming `'roomArchive'`), `_templateListsPartitionTheModel` to fail RED (naming `'roomArchived'`), and the test guard to fail (`TS2578`).
- **Re-proved Pins & Call-Site Guard (Mutations 4–14):**
  - Every other compile-time pin (`_templateUpdateColumnsExist`, `_templateFieldsArePermitted`, `_templateAllowlistHasNoStaleFields`, `_templateAllowlistHasNoForbiddenFields`, `_scheduleRuleUpdateColumnsExist`, `_scheduleRuleFieldsArePermitted`, `_scheduleRuleAllowlistHasNoStaleFields`, `_scheduleRuleListsPartitionTheModel`, `_scheduleRuleForbiddenColumnsExist`, `_scheduleRuleAllowlistHasNoForbiddenFields`, and `_templateForbiddenFieldsAreRejected` call-site parameter guard) was individually mutated and recorded with exact compiler output.
- **Finding:** The mutation document accurately tests current code targets and accurately reflects compiler diagnostics and exit codes.

### C. Precision and Truthfulness of Docblocks
- **[class-template-lifecycle.ts:228-239](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts#L228-L239):**
  - Explicitly states completeness is checked against `Prisma.ClassTemplateUncheckedUpdateManyInput`.
  - Explains why the partition pin catches new columns while the duplicate-union form only caught deletions from the union.
  - Accurately cites issue #111 (`archivedAt` and `withdrawnCount` added to `ClassTemplate`).
  - Contains no untethered or stale claims.
- **[class-lifecycle.ts:1065-1075](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-lifecycle.ts#L1065-L1075):**
  - Explains why `_templateListsPartitionTheModel`'s approach cannot be naively copy-pasted to `Class`.
  - Accurately preserves the census measured during Issue #270: `Class: 10 allowlist + 7 forbidden = 17, plus 7 unclassified = 24 columns`.
  - Records the verbatim seven unclassified names: `"teacherRoomId" | "templateId" | "cancelDeadline" | "autoCancelCheck" | "createdAt" | "updatedAt" | "spotBroadcastAt"`.
  - Correctly cites issue #327 (the `Class` vs `CalendarEntry` split) which added foreign keys and mirrors (`calendarEntryId`, `kind`, `entryLive`, `roomArchived`), clarifying why `Class` remains unpartitioned today and why partitioning it requires intentional per-column design decisions rather than mechanical replacement.
  - Contains no stale claims: the census is clearly framed as the historical measurement made in #270 rather than an assertion of the post-#327 schema.

---

## 3. Quality & Architecture Verification

### A. TypeScript Strictness (`pnpm run typecheck`)
- Command: `pnpm run typecheck` (`tsc --noEmit`)
- Result: **Clean pass, exit code 0**. Zero TypeScript errors.
- Strictness: Conforms to `strict: true`, no implicit `any`, no unused directives.

### B. Linter Cleanliness (`pnpm run lint`)
- Command: `pnpm run lint` (`eslint`)
- Result: **Clean pass, exit code 0** (0 errors, 6 pre-existing warnings in unrelated components).
- Zero lint issues introduced in touched files.

### C. Test Suite Pass (`pnpm test`)
- Command: `pnpm test` (`vitest run --project unit --project components && vitest run --project unit-sweeps --project integration`)
- Result: **Clean pass, exit code 0**.
  - **Pass 1 (unit & components):** Passed.
  - **Pass 2 (unit-sweeps & integration):** Passed.
  - **Total:** 71 test files passed, 927 tests passed.
  - Zero test regressions.

### D. Git Cleanliness
- Working tree state: Clean before this report was written (`nothing to commit, working tree clean`).
- Commit structure: Two focused, well-formed commits:
  1. `2d0edc9b feat(templates): align partition pin naming, cite #111, preserve Class measurement (#270)`
  2. `aaf2a0f8 test(templates): prove partition pin and re-prove lifecycle pins by mutation (#270)`
- Diff scope: Only touches files designated in the plan and issue requirements.

---

## 4. Findings Categorization

### Critical
*None.*

### Important
*None.*

### Suggestions
1. **Plan Checkbox Hygiene (Minor):** In [docs/superpowers/plans/2026-09-13-template-partition-pin.md](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/docs/superpowers/plans/2026-09-13-template-partition-pin.md), the step checkboxes remain `- [ ]` even though all tasks are complete and verified by their respective task reports and reviews (`task-1-report.md`, `task-2-report.md`, etc.). Updating them to `- [x]` when convenient maintains plan-document tracking hygiene.

---

## 5. Final Verdict

**APPROVED** ✅

The branch `solve_issue_270` satisfies all acceptance criteria of Issue #270. All pins, docblocks, cross-references, mutation records, and automated test gates are consistent, accurate, and passing. Ready for merge.
