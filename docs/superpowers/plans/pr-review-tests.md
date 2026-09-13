# Test & Mutation Coverage Analysis: PR #592 (`solve_issue_270`)

- **PR:** #592 (branch `solve_issue_270` against `origin/main`)
- **Issue:** #270 (ClassTemplate Partition Pin & Completeness Alignment)
- **Review Date:** 2026-09-13
- **Review Scope:**
  - `src/services/class-template-lifecycle.test.ts`
  - `docs/superpowers/plans/2026-09-13-template-partition-pin-mutations.md`
  - `docs/superpowers/plans/2026-09-13-template-partition-pin.md`
  - Related implementations: `src/services/class-template-lifecycle.ts`, `src/services/class-lifecycle.ts`
- **Verdict:** **APPROVED** ✅

---

## 1. Executive Summary

This report provides an in-depth evaluation of the test suite and mutation testing protocol implemented in PR #592. The PR addresses Issue #270 by:
1. Renaming `_templateForbiddenListIsComplete` to `_templateListsPartitionTheModel` in `src/services/class-template-lifecycle.ts` to reflect partition semantics across `ClassTemplate` update inputs.
2. Documenting the mechanism difference between partition pins and legacy duplicate-union pins, specifically citing incident #111 (unclassified columns added during schema migrations without failing the pin).
3. Preserving the historical census measurement of the `Class` model in `src/services/class-lifecycle.ts` and explaining why `Class` remains unpartitioned after Issue #327.
4. Implementing a complete 14-mutation verification protocol proving that all compile-time pins and call-site parameter guards bite when violated.

Automated verification confirmed that `pnpm run typecheck` passes with exit code 0, all linter rules pass, and the entire test suite passes without regressions.

---

## 2. Behavioral Coverage Analysis (`src/services/class-template-lifecycle.test.ts`)

`src/services/class-template-lifecycle.test.ts` spans 3,063 lines and provides rigorous unit and lifecycle integration testing across the three primary service operations: `updateClassTemplate`, `archiveOrUnarchiveTemplate`, and `pauseOrResumeTemplate`.

### A. Evaluated Behavioral Vectors

1. **Input Validation & Ownership Boundary (`updateClassTemplate`):**
   - Non-existent template UUID -> returns `{ ok: false, reason: 'not_found' }`.
   - Cross-teacher access attempts -> returns `{ ok: false, reason: 'forbidden' }` and verifies zero DB writes.
   - Empty input payload `{}` -> returns `{ ok: false, reason: 'no_fields' }`.
   - Undefined-only payload `{ description: undefined }` -> returns `{ ok: false, reason: 'no_fields' }`, ensuring no redundant row locks are taken.
   - Non-existent room and other-teacher room assignments -> return `{ ok: false, reason: 'invalid_room' }` with write preservation verified.

2. **Concurrency & Exclusion Constraint Handling:**
   - Same-family slot collision with a live sibling recurring class -> returns `{ ok: false, reason: 'slot_conflict', heldBy: 'regular' }` and verifies audit warning logging.
   - Cross-family slot collision with a studio recurring class (`StudioClassTemplate`) -> returns `{ ok: false, reason: 'slot_conflict', heldBy: 'studio' }` and verifies warning logging.
   - Foreign key violation on room archiving (`CLASS_TEMPLATE_ROOM_FK`) tested against concurrency races.

3. **Horizon Prediction & Generation State:**
   - Active update -> computes `firstEffective` week (aligned to UTC Monday) and reports `generationState: 'active'`.
   - Paused template update -> successfully applies update, sets `generationState: 'paused'`, and ensures `firstEffective: null`.
   - Archived template update -> successfully applies update, distinguishes from paused state (`isArchived: true, isActive: false`), sets `generationState: 'archived'`, and sets `firstEffective: null`.
   - Past-start filter -> verifies candidate start instants in the past are excluded from prediction horizon.
   - Cross-family overlap & cancellation -> live studio class blocks occurrence and advances prediction by one week; cancelled studio class (`cancelledAt != null`) does not block occurrence.
   - Spanning interval overlap -> overlapping classes with non-identical start times properly trip the overlap detector.

4. **Lifecycle Transitions (`archiveOrUnarchiveTemplate` & `pauseOrResumeTemplate`):**
   - Archiving cascade -> unbooked instances window withdrawn, booked instances preserved.
   - Idempotent state toggles -> verified against repeated calls.

### B. Behavioral Gaps & Observations

- **Observation 1 (`createClassTemplate` Unit Tests):** `createClassTemplate` is exported from `src/services/class-template-lifecycle.ts`, but its behavioral test coverage resides in `tests/integration/class-templates-api.test.ts` and `src/services/template-room-constraint.test.ts` rather than `class-template-lifecycle.test.ts`. This was introduced in PR #331 (deadlock-free slot insert) and is orthogonal to PR #592, but is noted for completeness.
- **Observation 2 (Runtime Enforcement of Forbidden Fields):** `updateClassTemplate` does not perform runtime stripping or error throwing for forbidden keys; protection is enforced entirely at compile-time via TypeScript intersection types and at the boundary via Zod parsing. This architecture is intentional and explicitly documented in `class-template-lifecycle.test.ts:20-41`.

---

## 3. Compiler Pin Coverage Analysis

`src/services/class-template-lifecycle.ts` implements a two-model partition discipline separating `ClassTemplate` economics from `ScheduleRule` scheduling data.

### A. Inventory of Compile-Time Pins

| # | Pin Identifier | Model / Scope | Invariant Enforced |
|---|---|---|---|
| 1 | `_templateUpdateColumnsExist` | `ClassTemplate` | Every wire update slice key exists on Prisma input |
| 2 | `_templateFieldsArePermitted` | `ClassTemplate` | Forward pin: wire keys ⊆ `TeacherEditableClassTemplateField` |
| 3 | `_templateAllowlistHasNoStaleFields` | `ClassTemplate` | Reverse pin: `TeacherEditableClassTemplateField` ⊆ wire keys |
| 4 | `_templateListsPartitionTheModel` | `ClassTemplate` | Completeness: Allowlist ∪ Forbidden = `keyof Prisma.ClassTemplateUncheckedUpdateManyInput` |
| 5 | `_templateForbiddenColumnsExist` | `ClassTemplate` | Every forbidden name exists on Prisma model |
| 6 | `_templateAllowlistHasNoForbiddenFields` | `ClassTemplate` | Disjointness: Allowlist ∩ Forbidden = ∅ |
| 7 | `_scheduleRuleUpdateColumnsExist` | `ScheduleRule` | Every wire rule slice key exists on Prisma input |
| 8 | `_scheduleRuleFieldsArePermitted` | `ScheduleRule` | Forward pin: wire rule keys ⊆ `TeacherEditableScheduleRuleField` |
| 9 | `_scheduleRuleAllowlistHasNoStaleFields` | `ScheduleRule` | Reverse pin: `TeacherEditableScheduleRuleField` ⊆ wire rule keys |
| 10 | `_scheduleRuleListsPartitionTheModel` | `ScheduleRule` | Completeness: Rule Allowlist ∪ Forbidden = `keyof Prisma.ScheduleRuleUncheckedUpdateManyInput` |
| 11 | `_scheduleRuleForbiddenColumnsExist` | `ScheduleRule` | Every forbidden rule name exists on Prisma model |
| 12 | `_scheduleRuleAllowlistHasNoForbiddenFields` | `ScheduleRule` | Disjointness: Rule Allowlist ∩ Forbidden = ∅ |

### B. Call-Site Parameter Guard (`class-template-lifecycle.test.ts:43-61`)

The function `_templateForbiddenFieldsAreRejected` verifies that the parameter type of `updateClassTemplate`:
```ts
data: ClassTemplateUpdateData &
  Partial<Record<PlainUpdateForbiddenTemplateField, never>> &
  Partial<Record<PlainUpdateForbiddenScheduleRuleField, never>>
```
is enforced on callers.
- **Instrument Design:** Variables (rather than object literals) are used to bypass TypeScript's excess-property checking, ensuring only the intersection type enforces rejection.
- **Directives:** Uses `@ts-expect-error` so that weakening the signature causes `tsc --noEmit` to fail with `error TS2578: Unused '@ts-expect-error' directive`.

### C. Pin Coverage Gaps & Observations

- **Observation 3 (Representative vs. Exhaustive Call-Site Assertions):**
  - `_templateForbiddenFieldsAreRejected` tests 3 of 7 template forbidden fields (`scheduleRuleId`, `roomArchived`, `ruleLive`) and 2 of 10 schedule rule forbidden fields (`isActive`, `isArchived`).
  - Untested at the call-site guard: `id`, `kind`, `createdAt`, `updatedAt`, `teacherId`, `archivedAt`, `withdrawnCount`, `live`.
  - **Assessment:** Because TypeScript's `Record<Union, never>` constructs a homogenous mapped type over the union, asserting multiple representative members proves that both intersection records are applied to the signature. While testing all 17 fields would provide exhaustive proof, testing 5 key representatives across both unions is mathematically and practically sound.

---

## 4. Mutation Testing Protocol Completeness (`2026-09-13-template-partition-pin-mutations.md`)

The mutation protocol recorded in `docs/superpowers/plans/2026-09-13-template-partition-pin-mutations.md` was analyzed against the protocol defined in `AGENTS.md` and `docs/mutation-testing.md`.

### A. Protocol Audit by Component

1. **Both-Halves Verification (Mutations 1A & 1B):**
   - **Mutation 1A (Simulated Added Column - Partition Form):**
     - Target: `_templateListsPartitionTheModel` in `src/services/class-template-lifecycle.ts:240-245`.
     - Injection: `& { simulatedUnclassifiedColumn?: string }` onto `Prisma.ClassTemplateUncheckedUpdateManyInput`.
     - Result: Failed RED with `error TS2322: Type 'true' is not assignable to type '"simulatedUnclassifiedColumn"'` (Exit code 2).
   - **Mutation 1B (Contrast with Legacy Duplicate-Union Form):**
     - Target: Old `_templateForbiddenListIsComplete` duplicate-union form.
     - Injection: Evaluated against the same simulated column.
     - Result: Remained GREEN (Exit code 0, no errors).
   - **Conclusion:** Conclusively demonstrates the vulnerability of the legacy duplicate-union pin and proves why the partition pin prevents incident #111 from recurring.

2. **Deleted Forbidden Entry (Mutation 2):**
   - Target: `PlainUpdateForbiddenTemplateField`.
   - Mutation: Removed `'roomArchived'`.
   - Result: Failed RED. Caught by both `_templateListsPartitionTheModel` (`error TS2322`) and the test call-site guard (`error TS2578: Unused '@ts-expect-error' directive`).

3. **Typo'd Forbidden Column (Mutation 3):**
   - Target: `PlainUpdateForbiddenTemplateField`.
   - Mutation: Renamed `'roomArchived'` to `'roomArchive'`.
   - Result: Failed RED. Caught by `_templateForbiddenColumnsExist` (TS2322 naming `'roomArchive'`), `_templateListsPartitionTheModel` (TS2322 naming `'roomArchived'`), and the test call-site guard (TS2578).

4. **Re-proving of All Remaining Pins (Mutations 4–13):**
   - All remaining 10 pins in `src/services/class-template-lifecycle.ts` were systematically broken and proven to fail RED with exact TS error codes, target names, and exit code 2:
     - Mutation 4 (`_templateUpdateColumnsExist`): Invalid column `notAColumn` -> TS2322.
     - Mutation 5 (`_templateFieldsArePermitted`): Unpermitted column `roomArchived` -> TS2322.
     - Mutation 6 (`_templateAllowlistHasNoStaleFields`): Stale field `staleField` -> TS2322.
     - Mutation 7 (`_templateAllowlistHasNoForbiddenFields`): Overlapping forbidden field `roomArchived` -> TS2322.
     - Mutation 8 (`_scheduleRuleUpdateColumnsExist`): Invalid rule column `notARuleColumn` -> TS2322.
     - Mutation 9 (`_scheduleRuleFieldsArePermitted`): Unpermitted field `isActive` -> TS2322.
     - Mutation 10 (`_scheduleRuleAllowlistHasNoStaleFields`): Stale field `staleRuleField` -> TS2322.
     - Mutation 11 (`_scheduleRuleListsPartitionTheModel`): Deleted rule forbidden entry `isActive` -> TS2322 & TS2578.
     - Mutation 12 (`_scheduleRuleForbiddenColumnsExist`): Typo `isActiv` -> TS2322 & TS2578.
     - Mutation 13 (`_scheduleRuleAllowlistHasNoForbiddenFields`): Overlapping forbidden field `isActive` -> TS2322.

5. **Call-Site Parameter Guard Mutation (Mutation 14):**
   - Target: `updateClassTemplate` parameter signature in `src/services/class-template-lifecycle.ts:457-460`.
   - Mutation: Removed `& Partial<Record<PlainUpdateForbiddenTemplateField, never>>`.
   - Result: Failed RED with TS2578 on test lines 51, 53, 55 (`scheduleRuleId`, `roomArchived`, `ruleLive`).

### B. Mutation Protocol Gaps & Observations

- **Observation 4 (Independent Mutation of Schedule Rule Parameter Guard):**
  - In Mutation 14, only the `ClassTemplate` forbidden parameter guard was stripped.
  - The second parameter guard, `& Partial<Record<PlainUpdateForbiddenScheduleRuleField, never>>`, was not independently removed in an explicit "Mutation 14B" to observe test lines 57 and 59 failing with TS2578 in isolation.
  - **Assessment:** While Mutation 11 demonstrated that deleting an entry from `PlainUpdateForbiddenScheduleRuleField` triggers TS2578 on line 57, an isolated deletion of the schedule rule parameter guard would complete total symmetry.

---

## 5. Gap Severity & Quality Rating (1–10 Scale)

To avoid ambiguity between "gap severity" (where higher means worse) and "quality score" (where higher means better), both metrics are explicitly stated:

### A. Gap Severity Score: **1.5 / 10** (Negligible Gaps)
*Scale: 1 = Zero/negligible gaps; 10 = Critical architectural/safety flaws.*
- **Identified Gaps:**
  1. Call-site parameter guard tests 5 of 17 forbidden fields (representative rather than exhaustive).
  2. Call-site parameter guard mutation tested removal of the template record slice, omitting an independent single-line removal of the rule record slice.
  3. `createClassTemplate` unit tests are in integration/constraint suites rather than the primary lifecycle test file.
- **Impact:** None of these gaps compromise type safety, build integrity, or runtime behavior.

### B. Coverage & Rigor Quality Score: **9.5 / 10** (Outstanding)
*Scale: 1 = Completely untested; 10 = Flawless, textbook-grade execution.*
- **Breakdown:**
  - Behavioral Test Coverage: **9.5 / 10** (Comprehensive coverage of errors, concurrency, horizon prediction, and lifecycle transitions).
  - Compile-Time Pin Coverage: **9.8 / 10** (Total partition coverage across two Prisma models; bi-directional forward/reverse/disjointness pins).
  - Mutation Protocol Completeness: **9.6 / 10** (All 14 mutations verified with verbatim compiler output, both-halves proof executed, clean revert state confirmed).
  - Documentation & Historical Preservation: **10 / 10** (Exact citation of #111, preservation of #270 census and #327 architectural evolution in `class-lifecycle.ts`).

---

## 6. Verification Audit

- **Typecheck:** `pnpm run typecheck` (`tsc --noEmit`) -> **Exit code 0** (Clean pass).
- **Linter:** `pnpm run lint` -> **Exit code 0** (No lint errors introduced).
- **Test Suites:** `pnpm test` -> **71 test files, 927 tests passed** (Clean pass).
- **Working Tree State:** Clean, isolated, no leftover test artifacts or uncommitted changes.

---

## 7. Final Verdict

**APPROVED** ✅

PR #592 completely satisfies all acceptance criteria for Issue #270. The compile-time partition pin `_templateListsPartitionTheModel` provides robust, regression-proof defense against unclassified schema additions, and the mutation testing record stands as a benchmark for rigorous both-halves verification.
