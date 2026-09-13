# Type Design Review: PR #592 (`solve_issue_270` against `origin/main`)

- **Branch:** `solve_issue_270`
- **Reviewed Files:**
  - [`src/services/class-template-lifecycle.ts`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts)
  - [`src/services/class-template-lifecycle.test.ts`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.test.ts)
  - [`src/services/class-lifecycle.ts`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-lifecycle.ts)
- **Review Date:** 2026-09-13
- **Review Verdict:** **APPROVED** ✅ (Overall Compiler & Invariant Guarantee Score: **8.5 / 10**)

---

## Executive Summary

PR #592 addresses Issue #270 by formalizing compile-time partition pins and documentation invariants across the template and class lifecycle services. The core contributions evaluated in this type design review are:

1. Renaming and docblock alignment of `_templateListsPartitionTheModel` in [`class-template-lifecycle.ts`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts#L240), replacing the former `_templateForbiddenListIsComplete` identifier to match peer partition pins (`_scheduleRuleListsPartitionTheModel` and studio-family counterparts).
2. Grounding the pin construction against `keyof Prisma.ClassTemplateUncheckedUpdateManyInput` and citing motivating incident #111, where unclassified schema columns bypassed the legacy duplicate-union pin form.
3. Preserving the precise census measurement of Issue #270 in [`class-lifecycle.ts`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-lifecycle.ts#L1065) and articulating why `Class` cannot undergo mechanical partition pin substitution without per-column domain design decisions (further complicated by the Issue #327 `Class`/`CalendarEntry` model split).
4. Demonstrating that all compile-time pins and call-site parameter guards actively bite through a 14-mutation verification protocol documented in [`docs/superpowers/plans/2026-09-13-template-partition-pin-mutations.md`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/docs/superpowers/plans/2026-09-13-template-partition-pin-mutations.md).

---

## Section 1: `_templateListsPartitionTheModel` Pin Construction Evaluation

### 1.1 Mathematical Model and Pin Mechanics

In [`src/services/class-template-lifecycle.ts:240-246`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts#L240-L246), the compile-time pin is constructed as:

```ts
const _templateListsPartitionTheModel: NoneOf<
  Exclude<
    keyof Prisma.ClassTemplateUncheckedUpdateManyInput,
    TeacherEditableClassTemplateField | PlainUpdateForbiddenTemplateField
  >
> = true;
void _templateListsPartitionTheModel;
```

A mathematical partition of a set $U$ into subsets $\{A, F\}$ requires three properties:
1. **Coverage (Completeness):** $A \cup F = U$
2. **Disjointness (Mutual Exclusivity):** $A \cap F = \emptyset$
3. **Soundness (Non-stale membership):** $A \subseteq U$ and $F \subseteq U$

The type design in [`class-template-lifecycle.ts`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts) enforces this full set of partition properties via cooperating compile-time pins:

| Property | Implementation Expression | Target Enforced |
|---|---|---|
| **Coverage ($U \setminus (A \cup F) = \emptyset$)** | `_templateListsPartitionTheModel` | `Exclude<keyof Prisma.ClassTemplateUncheckedUpdateManyInput, TeacherEditableClassTemplateField \| PlainUpdateForbiddenTemplateField>` |
| **Disjointness ($A \cap F = \emptyset$)** | `_templateAllowlistHasNoForbiddenFields` | `Extract<TeacherEditableClassTemplateField, PlainUpdateForbiddenTemplateField>` |
| **Soundness of $F$ ($F \subseteq U$)** | `_templateForbiddenColumnsExist` | `Exclude<PlainUpdateForbiddenTemplateField, keyof Prisma.ClassTemplateUncheckedUpdateManyInput>` |
| **Soundness of $A$ ($A \subseteq U$)** | `_templateUpdateColumnsExist` + `_templateFieldsArePermitted` + `_templateAllowlistHasNoStaleFields` | Slices wire schema `ClassTemplateOwnUpdateData` to columns, proving $A = \text{keyof ClassTemplateOwnUpdateData} \subseteq U$ |

### 1.2 Census of the `ClassTemplate` Scalar Space

The live Prisma schema defines 16 scalar attributes on `model ClassTemplate`:

- **Universe $U$ (`keyof Prisma.ClassTemplateUncheckedUpdateManyInput`):**
  `'id' | 'scheduleRuleId' | 'kind' | 'teacherRoomId' | 'ruleLive' | 'roomArchived' | 'description' | 'roomCost' | 'minRate' | 'targetRate' | 'minStudents' | 'maxStudents' | 'cancelDeadline' | 'autoCancelCheck' | 'createdAt' | 'updatedAt'` (16 keys).
- **Subset $A$ (`TeacherEditableClassTemplateField`):**
  `'description' | 'teacherRoomId' | 'roomCost' | 'minRate' | 'targetRate' | 'minStudents' | 'maxStudents' | 'cancelDeadline' | 'autoCancelCheck'` (9 keys).
- **Subset $F$ (`PlainUpdateForbiddenTemplateField`):**
  `'id' | 'scheduleRuleId' | 'kind' | 'roomArchived' | 'ruleLive' | 'createdAt' | 'updatedAt'` (7 keys).

$9 + 7 = 16$. The union $(A \cup F)$ exactly equals $U$, and their intersection is `never`.

### 1.3 Selection of `ClassTemplateUncheckedUpdateManyInput`

The choice of `Prisma.ClassTemplateUncheckedUpdateManyInput` rather than `ClassTemplateUpdateInput` or `ClassTemplateUncheckedUpdateInput` is deliberate and correct:
1. **Filtering Out Relational Writes:** `ClassTemplateUpdateInput` (the checked update type) includes relations (`classes`, `scheduleRule`, `teacherRoom`). Pinning against checked update inputs would allow relational keys to masquerade as scalar attributes.
2. **Filtering Out Nested Relation Connectors:** `ClassTemplateUncheckedUpdateInput` (single-record update) includes nested write structures that `updateMany` refuses.
3. **Scalar Column Fidelity:** `UncheckedUpdateManyInput` strictly represents the set of scalar columns directly writable to the underlying PostgreSQL table.

### 1.4 Contrast with the Legacy Duplicate-Union Form and Incident #111

The legacy pin form (`_classForbiddenListIsComplete` in `class-lifecycle.ts`) checked completeness via literal duplication:

```ts
// Legacy duplicate-union pattern:
const _templateForbiddenListIsComplete: NoneOf<
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

**The Vulnerability:** The duplicate-union form verifies only that the hardcoded string union is covered by `PlainUpdateForbiddenTemplateField`. It establishes **zero linkage** to the live Prisma model type.
- During incident #111, when migrations added `archivedAt` and `withdrawnCount` to `ClassTemplate`, the duplicate-union pin remained completely green (exit code 0).
- Neither the allowlist nor the forbidden list claimed those columns, leaving their update permissions unassigned and unverified.
- As demonstrated in Mutation 1A & 1B of the PR test protocol, `_templateListsPartitionTheModel` immediately produces a compile-time failure (`TS2322: Type 'true' is not assignable to type '"simulatedUnclassifiedColumn"'`), while the duplicate-union form remains silent.

---

## Section 2: Explanation of Why `Class` is Not Partitioned

### 2.1 Audit of the `Class` Docblock in `src/services/class-lifecycle.ts`

Lines 1065–1075 of [`src/services/class-lifecycle.ts`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-lifecycle.ts#L1065-L1075) state:

```ts
/**
 * Why the partition pin form (`_templateListsPartitionTheModel`) is unavailable
 * for `Class`: Issue #270 measured the census across the `Class` model:
 *   Class: 10 allowlist + 7 forbidden = 17, plus 7 unclassified = 24 columns.
 * The verbatim seven unclassified names were:
 *   "teacherRoomId" | "templateId" | "cancelDeadline" | "autoCancelCheck" |
 *   "createdAt" | "updatedAt" | "spotBroadcastAt".
 * Later, issue #327 split `Class` and `CalendarEntry`, adding foreign keys and
 * mirrors (`calendarEntryId`, `kind`, `entryLive`, `roomArchived`), so `Class`
 * remains unpartitioned today. Applying a partition pin here would require
 * per-column design decisions rather than a mechanical substitution.
 */
```

### 2.2 Technical Validity of the Non-Partition Decision

The decision to retain the duplicate-union form (`_classForbiddenListIsComplete`) for `Class` rather than executing a mechanical refactor to a partition pin is sound:

1. **Unclassified Surface Area:** In `class-lifecycle.ts`, `PlainUpdateForbiddenClassField` was originally constructed as a targeted guard for known attack vectors (`id`, `teacherId`, `status`, `settingsLocked`, `effectiveTeacherRate`, `totalStudents`, `totalRevenue`). Unlike `ClassTemplate`, it was never conceived as a total partition of `Class`.
2. **Substantive Domain Policy Required:** Mechanically dumping the unclassified columns into `PlainUpdateForbiddenClassField` would bypass necessary architectural decisions:
   - `cancelDeadline` and `autoCancelCheck`: Editable on `ClassTemplate`, but omitted from `TeacherEditableClassField`. Is this an intentional immutability rule for scheduled instances or an API gap?
   - `teacherRoomId`: Should `updateClass` allow changing a class's room? (Currently disallowed; requires room validation and capacity check).
   - `spotBroadcastAt`: Internal waitlist timestamp managed by background workers; should be forbidden from teacher edits, but needs explicit documentation.
3. **Model Decomposition under Issue #327:**
   - In Issue #327, `Class` was decomposed into `Class` and `CalendarEntry`.
   - Core scheduling fields (`classType`, `date`, `startTime`, `durationMinutes`, `teacherId`) moved to `CalendarEntry`.
   - New relational and mirror fields were added to `Class`: `calendarEntryId`, `kind`, `entryLive`, `roomArchived`.
   - As a consequence, `TeacherEditableClassField` currently spans columns across **both tables** (`CalendarEntry` + `Class`).
   - A valid partition pin for `Class` cannot be a single `NoneOf<Exclude<keyof Prisma.ClassUncheckedUpdateManyInput, ...>>`. It would require two distinct partitions:
     a) `_classOwnListsPartitionTheModel` against `keyof Prisma.ClassUncheckedUpdateManyInput`.
     b) `_calendarEntryListsPartitionTheModel` against `keyof Prisma.CalendarEntryUncheckedUpdateManyInput`.

**Conclusion on Section 2:** The docblock in `class-lifecycle.ts` accurately represents the historical facts, documents the exact 7 unclassified column names, and correctly warns future maintainers against performing a syntactic find-and-replace that would hide unexamined domain decisions.

---

## Section 3: Invariant Expression and Compiler Guarantees Evaluation

### Rating: **8.5 / 10**

### 3.1 What Works Exceptionally Well (Score Contribution: +8.5)

1. **Mathematical Partition Enforcement:**
   - In `class-template-lifecycle.ts`, the model update keys are fully partitioned. Any schema migration introducing an unclassified column halts `tsc --noEmit` immediately.
2. **Call-Site Parameter Hardening with `never` Records:**
   - The public service signature for `updateClassTemplate` uses:
     ```ts
     data: ClassTemplateUpdateData &
       Partial<Record<PlainUpdateForbiddenTemplateField, never>> &
       Partial<Record<PlainUpdateForbiddenScheduleRuleField, never>>
     ```
   - This ensures that callers cannot pass forbidden keys even if excess property checks are bypassed by intermediate object variables.
3. **Proving Negative Types via Variables and `@ts-expect-error`:**
   - In [`class-template-lifecycle.test.ts:43-61`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.test.ts#L43-L61), `_templateForbiddenFieldsAreRejected` explicitly uses typed variables rather than object literals.
   - It proves that excess property checking isn't the sole protector; the parameter type itself rejects the forbidden keys.
   - If the `never` record intersection is removed from the service signature, the compiler throws `TS2578: Unused '@ts-expect-error' directive`.
4. **Multi-Layered Invariant Defense (Database Backstops):**
   - TypeScript compile-time guarantees are backed by database-level constraints:
     - GiST slot exclusion: `ScheduleRule_teacher_slot_excl`
     - Composite FK mirrors with `ON UPDATE CASCADE`: `ClassTemplate` to `TeacherRoom` and `ScheduleRule`
     - Single-row CHECK constraints: `ClassTemplate_live_needs_open_room` (`CHECK (NOT ("ruleLive" AND "roomArchived"))`)
     - Database triggers: `class_reject_terminal_status_change` and `entry_frozen_schedule_guard`

### 3.2 Where Compiler Guarantees Fall Short of 10/10 (Deduction: -1.5)

1. **Type Assertion Escape Hatches in Generic Rule Dispatch (`as` casting) (-0.6):**
   - In [`src/services/rule-lifecycle.ts:1574`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/rule-lifecycle.ts#L1574), `updateRule` takes `data: Record<string, unknown>`.
   - In [`src/services/class-template-lifecycle.ts:876`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_270/src/services/class-template-lifecycle.ts#L876), `CLASS_FAMILY.updateChild` performs:
     ```ts
     const writeData: Prisma.ClassTemplateUncheckedUpdateManyInput &
       Partial<Record<PlainUpdateForbiddenTemplateField, never>> =
       childData as ClassTemplateOwnUpdateData;
     ```
   - The `as ClassTemplateOwnUpdateData` assertion destroys the compiler's ability to verify that `childData` does not contain unexpected or forbidden keys at that internal junction. The safety relies on `updateClassTemplate` being the gatekeeper.
2. **Asymmetry in `updateClass` Signature (-0.5):**
   - While `updateClassTemplate` incorporates `Partial<Record<ForbiddenField, never>>` into its parameter type, `updateClass` in `class-lifecycle.ts:1340` accepts bare `ClassUpdateData`.
   - If a caller passes a wider variable containing `status: 'completed'` to `updateClass`, TypeScript will not flag it on the variable parameter unless excess property checking applies to an inlined literal.
3. **Dual-Table Model Bleed in `Class` (-0.4):**
   - `TeacherEditableClassField` mixes columns from `Class` and `CalendarEntry` without table-level partition pins, leaving `Class` without the full partition guarantees that `ClassTemplate` and `ScheduleRule` enjoy.

---

## Findings & Recommendations

### Findings
1. **`_templateListsPartitionTheModel` Construction:** **Exemplary**. Accurately partitions `ClassTemplateUncheckedUpdateManyInput` against `TeacherEditableClassTemplateField` and `PlainUpdateForbiddenTemplateField`. The 14-mutation suite proves all failure modes trigger expected compiler errors.
2. **`Class` Non-Partition Explanation:** **Accurate and Honest**. Accurately documents the historical census (10 allowlist + 7 forbidden = 17, plus 7 unclassified = 24), names all 7 unclassified fields verbatim, and details the architectural impact of the Issue #327 `CalendarEntry` split.
3. **Docblock Cross-References:** All references across `class-template-lifecycle.ts`, `class-template-lifecycle.test.ts`, and `class-lifecycle.ts` match `_templateListsPartitionTheModel`.

### Recommendations for Future Sprints
1. **`updateClass` Parameter Hardening:** Add `Partial<Record<PlainUpdateForbiddenClassField, never>>` to `updateClass`'s `data` parameter in `class-lifecycle.ts`, accompanied by `@ts-expect-error` test pins matching `_templateForbiddenFieldsAreRejected`.
2. **Issue #327 Partitioning of `Class`:** In a dedicated follow-up issue, classify the remaining columns of `Class` and `CalendarEntry` into dual partition pins (`_classListsPartitionTheModel` and `_calendarEntryListsPartitionTheModel`).

---

## Verdict

**APPROVED** ✅

The type design implemented in PR #592 (`solve_issue_270`) is robust, mathematically sound, verified by mutation testing, and adheres to the strict type architecture standards of `fair.yoga`.
