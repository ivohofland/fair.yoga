# Comment & Documentation Review: PR #597 (Issue #207)

- **PR:** #597
- **Branch:** `fix/207-toggle-payload-type-pins` against `main`
- **Issue:** #207 (Express toggle payload and lifecycle result non-interchangeability with `NoneOf` pins)
- **Plan Reference:** [`docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md)
- **Mutation Ledger:** [`docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md)
- **Review Date:** 2026-09-14
- **Reviewer:** Antigravity Comment Analyzer (following [`.agents/skills/comment-analyzer/SKILL.md`](file:///Users/ivohofland/Projects/fair.yoga/.agents/skills/comment-analyzer/SKILL.md))
- **Overall Status:** **APPROVED WITH MINOR ADVISORY FIX** (1 comment discipline rule violation: hardcoded count in prose)

---

## 1. Executive Summary

This review audits all code comments, JSDoc docblocks, and test annotations introduced or modified across the entire branch `fix/207-toggle-payload-type-pins` (PR #597) against `main`.

The changes in PR #597 touch comments in 18 source and test files:
1. **Source type-pin definitions (3 files):**
   - [`src/lib/api-types.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/api-types.ts#L111-L126)
   - [`src/services/rule-lifecycle.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.ts#L323-L325)
   - [`src/services/studio-class-editability.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-editability.ts#L71-L77)
2. **Test cleanups & migrated invariants (3 files):**
   - [`src/components/settings/template-action-messages.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/components/settings/template-action-messages.test.ts) (removed redundant `@ts-expect-error` assertions)
   - [`src/services/rule-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts#L95-L98)
   - [`src/services/studio-class-editability.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-editability.test.ts#L185-L189)
3. **Typecheck-only enforcement notices (13 additional test files):**
   - Explicitly documenting that call-site `@ts-expect-error` parameter assertions are verified by `npm run typecheck` only (`tsc --noEmit`) and invisible to Vitest runtime test execution.

Overall, the documentation updates are clear, precise, and accurately describe the compilation-level behavior. Only **one rule violation** of the Fair.Yoga Comment Discipline was identified: a hardcoded prose count (`7`) in [`src/services/rule-lifecycle.test.ts:95`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts#L95).

---

## 2. Findings Grouped by Category

### 🚨 Critical Inaccuracies
*Factually wrong claims that will mislead future developers.*

None found in docblocks or inline code comments. The compile-time mechanisms (`NoneOf` conditional types, parameter type bounds, and `@ts-expect-error` unused-directive failure modes) are accurately explained across all modified comments.

> [!NOTE]
> **Advisory Observation — Test Title Discrepancy (Low Risk):**
> In [`src/services/rule-lifecycle.test.ts:185, 206, 228`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts#L185), the test cases retain names from before the negative `@ts-expect-error` assertions were migrated:
> - `it('rejects each family archive result where the other family is required', ...)`
> - `it('rejects each family pause result where the other family is required', ...)`
> - `it('rejects each family update result where the other family is required', ...)`
>
> The docblock directly above at lines 177–178 accurately states what is true NOW:
> > *"The tests below retain the positive assertions exercising the type shapes for each family."*
>
> The test bodies now strictly exercise positive acceptance (`expect(takesStudio(studioResult)).toBe(true)`). The string titles in `it('rejects...')` are technically misnomers now that the negative rejection occurs in `rule-lifecycle.ts` compile-time pins, though this is test metadata rather than code comments.

---

### ⚠️ Rule Violations (Comment Discipline)
*Prose rosters, counts, cross-file claims, or historical narratives.*

#### Issue 1: Hardcoded Prose Count
- **Location:** [`src/services/rule-lifecycle.test.ts:95-97`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts#L95-L97)
- **Violation:** Violation of [CLAUDE.md](file:///Users/ivohofland/Projects/fair.yoga/CLAUDE.md) Comment Discipline Rule 2:
  > *"Never write a count or a member list in prose — name the type. 'Every `SkipCounts` member' survives a fifth member; a prose roster does not... In a comment, never."*
- **Current Text:**
  ```ts
   * The 7 `@ts-expect-error` property assignment checks below are verified by
   * `npm run typecheck` only (`tsc --noEmit`) and are invisible to Vitest runtime test
   * execution (tests do not typecheck or transpile types).
  ```
- **Analysis:**
  Specifying the literal count `7` in prose creates immediate comment rot risk if an 8th check is added (e.g. for an additional template property or descriptor noun) or if checks are refactored. None of the other 14 updated test files use hardcoded numbers (e.g., [`src/lib/api-utils.test.ts:109`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/api-utils.test.ts#L109) uses *"The `@ts-expect-error` compile-time type assertions below..."* and [`src/lib/db-locks.test.ts:54`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/db-locks.test.ts#L54) uses *"These checks are verified by..."*).
- **Recommended Resolution:**
  Remove `"7 "` to make the sentence durable:
  ```diff
  --- a/src/services/rule-lifecycle.test.ts
  +++ b/src/services/rule-lifecycle.test.ts
  @@ -95,3 +95,3 @@ describe('rule-lifecycle family descriptors', () => {
  -   * The 7 `@ts-expect-error` property assignment checks below are verified by
  +   * The `@ts-expect-error` property assignment checks below are verified by
      * `npm run typecheck` only (`tsc --noEmit`) and are invisible to Vitest runtime test
      * execution (tests do not typecheck or transpile types).
  ```

---

### 🗑️ Redundant Comments
*Comments that merely re-state obvious code.*

None found. Every comment added or revised across the 18 files explains **why** an invariant is enforced at compile-time, **why** a specific failure mechanism (`NoneOf` vs `@ts-expect-error`) was selected, or alerts future maintainers that Vitest does not run type checks.

---

### ✨ Positive Examples
*Exemplary docblocks that clearly explain non-obvious rationale.*

1. **Directional Error Diagnostics in `api-types.ts`:**
   [`src/lib/api-types.ts:111-126`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/api-types.ts#L111-L126):
   ```ts
   // Compile-time pins asserting that the class and studio toggle response types
   // remain mutually non-interchangeable via `templateKind` (#93, #119, #206, #207).
   // Expressed with NoneOf so a broken invariant names the offending direction.
   const _classIsNotStudio: NoneOf<
     TemplateToggleResponse extends StudioTemplateToggleResponse
       ? 'TemplateToggleResponse extends StudioTemplateToggleResponse'
       : never
   > = true;
   void _classIsNotStudio;
   ```
   *Why exemplary:* Concise, explains the non-obvious design decision behind using string literal labels in conditional types with `NoneOf`, and links directly to issue lineage (#93, #119, #206, #207).

2. **Clean Replacement of Historical Narration in `rule-lifecycle.ts`:**
   [`src/services/rule-lifecycle.ts:323-325`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.ts#L323-L325):
   ```ts
    * Held by the compile-time `NoneOf` pins declared below (#207): a claim about
    * what the compiler refuses is worth only the pin that makes the compiler
    * refuse it.
   ```
   *Why exemplary:* Directly states what is true NOW. Replaced an outdated sentence that referenced `@ts-expect-error` in `rule-lifecycle.test.ts` and `template-action-messages.test.ts` without introducing any historical "previously this was..." narration.

3. **Clarifying Scope Separation Between Parameter and Union Invariants:**
   [`src/services/studio-class-editability.test.ts:185-189`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-editability.test.ts#L185-L189):
   ```ts
    * This `@ts-expect-error` parameter check is verified by `npm run typecheck`
    * only (`tsc --noEmit`) and is invisible to Vitest runtime test execution
    * (tests do not typecheck or transpile types). The union invariant
    * (`dateEditable ⇒ scheduleEditable`) is pinned separately beside
    * `StudioClassEditVerdict` in `studio-class-editability.ts` via `NoneOf`.
   ```
   *Why exemplary:* Prevents confusion by explaining why this test only checks input row parameter widening, while pointing the reader to the type definition file where the verdict shape itself is pinned.

4. **Standardized Typecheck-Only Enforcement Notices:**
   Applied across 15 test files with consistent phrasing:
   `"This check is verified by npm run typecheck only (tsc --noEmit) and is invisible to Vitest runtime test execution (tests do not typecheck or transpile types)."`
   *Why exemplary:* Solves a systemic cognitive pitfall where engineers assume passing unit tests imply `@ts-expect-error` lines were checked during test execution.

---

## 3. Comprehensive File-by-File Audit Table

| File | Lines / Element | Comment Content & Intent | Discipline & Factual Accuracy | Status |
|---|---|---|---|---|
| [`src/lib/api-types.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/api-types.ts#L111-L126) | Lines 111–126 (`_classIsNotStudio`, `_studioIsNotClass`) | Annotates compile-time pins asserting mutual non-interchangeability via `templateKind`. Explains `NoneOf` error message purpose. | **Accurate & compliant.** Annotates immediate code, states current truth, no rosters or counts. | **PASS** ✅ |
| [`src/services/rule-lifecycle.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.ts#L323-L325) | Lines 323–325 (`ArchiveRuleResult`) | Docblock updated to reference `NoneOf` pins declared below (#207). | **Accurate & compliant.** Replaced obsolete reference to test-level assertions. States what is true NOW. | **PASS** ✅ |
| [`src/services/rule-lifecycle.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.ts#L368-L382) | Lines 368–382 (`_classArchiveIsNotStudio`, `_studioArchiveIsNotClass`) | Annotates archive result mutual non-interchangeability pins via `template: WithSlot<TChild>`. | **Accurate & compliant.** Accurately identifies `template: WithSlot<TChild>` as the discriminating carrier. | **PASS** ✅ |
| [`src/services/rule-lifecycle.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.ts#L919-L920) | Lines 919–920 (`PauseRuleResult`) | Docblock updated to reference `NoneOf` pins declared below (#207). | **Accurate & compliant.** Cleanly updated without historical narrative. | **PASS** ✅ |
| [`src/services/rule-lifecycle.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.ts#L997-L1011) | Lines 997–1011 (`_classPauseIsNotStudio`, `_studioPauseIsNotClass`) | Annotates pause result mutual non-interchangeability pins via `template: WithSlot<TChild>`. | **Accurate & compliant.** Accurately documents pin mechanism. | **PASS** ✅ |
| [`src/services/rule-lifecycle.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.ts#L1611-L1625) | Lines 1611–1625 (`_classUpdateIsNotStudio`, `_studioUpdateIsNotClass`) | Annotates update result mutual non-interchangeability pins via `template: WithSlot<TChild>`. | **Accurate & compliant.** Accurately documents pin mechanism. | **PASS** ✅ |
| [`src/services/studio-class-editability.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-editability.ts#L71-L77) | Lines 71–77 (`_illegalVerdictCannotStand`) | Annotates `NoneOf` pin asserting that `dateEditable` cannot stand without `scheduleEditable` (#207). | **Accurate & compliant.** Directly states the invariant and sits immediately above the pin. | **PASS** ✅ |
| [`src/components/settings/template-action-messages.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/components/settings/template-action-messages.test.ts) | Lines 730–739 | End of file after removing redundant test block lines 741–764. | **Accurate & compliant.** Clean removal, zero leftover comments or dangling references. | **PASS** ✅ |
| [`src/services/rule-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts#L95-L98) | Lines 95–98 | Explains that property assignment checks are verified by `npm run typecheck` only. | **Rule Violation:** Contains literal count `"7"`. Needs `"7 "` removed. | **WARN** ⚠️ |
| [`src/services/rule-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts#L172-L183) | Lines 172–183 | Docblock explaining that lifecycle result non-interchangeability is pinned via `NoneOf` in `rule-lifecycle.ts`, while tests retain positive shape assertions. | **Accurate & compliant.** States what is true NOW; prevents future maintainers from re-adding redundant negative assertions. | **PASS** ✅ |
| [`src/services/studio-class-editability.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-editability.test.ts#L185-L189) | Lines 185–189 | Docblock on `refuses a widened row at the type level` clarifying parameter check vs verdict pin. | **Accurate & compliant.** Clearly articulates the distinct roles of the parameter test and the `NoneOf` type pin. | **PASS** ✅ |
| [`src/services/studio-class-deletion.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-deletion.test.ts#L167-L169) | Lines 167–169 | Documents typecheck-only enforcement for `refuses template state at the type level`. | **Accurate & compliant.** Precise description of compiler vs Vitest behavior. | **PASS** ✅ |
| [`src/lib/api-utils.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/api-utils.test.ts#L109-L113) | Lines 109–113, 456–459, 578–580 | Documents typecheck-only enforcement across 3 `@ts-expect-error` test blocks. | **Accurate & compliant.** Follows non-numeric phrasing ("assertions below", "check below"). | **PASS** ✅ |
| [`src/lib/db-locks.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/db-locks.test.ts#L54-L55) | Lines 54–55 | Documents typecheck-only enforcement on `_theBrandRejectsABareClient`. | **Accurate & compliant.** Accurately uses plural ("These checks"). | **PASS** ✅ |
| [`src/lib/entry-conflict.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/entry-conflict.test.ts#L274-L275) | Lines 274–275 | Documents typecheck-only enforcement on `_theProbeRejectsATransactionClient`. | **Accurate & compliant.** Singular check accurately described. | **PASS** ✅ |
| [`src/lib/registration-status.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/registration-status.test.ts#L32-L33) | Lines 32–33 | Documents typecheck-only enforcement on `_theListRejectsAForeignEnum`. | **Accurate & compliant.** Preserves prior test reasoning while clarifying enforcement scope. | **PASS** ✅ |
| [`src/lib/rule-slot-holder.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/rule-slot-holder.test.ts#L176-L177) | Lines 176–177 | Documents typecheck-only enforcement on `_theProbeRejectsATransactionClient`. | **Accurate & compliant.** Concise and accurate. | **PASS** ✅ |
| [`src/lib/timezone.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/timezone.test.ts#L471-L472) | Lines 471–472 | Documents typecheck-only enforcement on `_theBrandRejectsPlainNumber`. | **Accurate & compliant.** Concise and accurate. | **PASS** ✅ |
| [`src/lib/worktree/identity.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/worktree/identity.test.ts#L107-L108) | Lines 107–108 | Documents typecheck-only enforcement on `RawName` and `DbSlug` brand tests. | **Accurate & compliant.** Plural matches the group of helper functions. | **PASS** ✅ |
| [`src/lib/worktree/registry.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/worktree/registry.test.ts#L709-L710) | Lines 709–710 | Documents typecheck-only enforcement on `_allocatePortArgsCannotBeSwapped`. | **Accurate & compliant.** Concise and accurate. | **PASS** ✅ |
| [`src/services/class-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/class-lifecycle.test.ts#L37-L38) | Lines 37–38, 110–111, 2106–2107 | Documents typecheck-only enforcement on `_completionTimingIsRequired`, `_transitionRangesAreNarrow`, and `noUncheckedIndexedAccess`. | **Accurate & compliant.** Accurately annotates each separate compile-time assertion. | **PASS** ✅ |
| [`src/services/class-template-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/class-template-lifecycle.test.ts#L37-L38) | Lines 37–38 | Documents typecheck-only enforcement on `_templateForbiddenFieldsAreRejected`. | **Accurate & compliant.** Distinguishes function-level parameter checking from model content pins. | **PASS** ✅ |
| [`src/services/entry-generation.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/entry-generation.test.ts#L15-L16) | Lines 15–16 | Documents typecheck-only enforcement on `_theBrandRejectsUnbrandedEpochMs`. | **Accurate & compliant.** Accurately uses plural ("These checks"). | **PASS** ✅ |
| [`src/services/studio-class-template-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-template-lifecycle.test.ts#L13-L14) | Lines 13–14 | Documents typecheck-only enforcement on `_studioTemplateForbiddenFieldsAreRejected`. | **Accurate & compliant.** Concise and accurate. | **PASS** ✅ |

---

## 4. Summary & Next Steps

1. **Overall Quality:** The PR's comments and docblocks are remarkably high quality, demonstrate thorough adherence to TypeScript compile-time principles, and remove historical clutter and misleading claims.
2. **Action Item:**
   - Apply the one-word deletion in [`src/services/rule-lifecycle.test.ts:95`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts#L95) to change `"The 7 \`@ts-expect-error\` property assignment checks..."` to `"The \`@ts-expect-error\` property assignment checks..."`.
   - (Optional) Consider updating the test titles in [`src/services/rule-lifecycle.test.ts:185, 206, 228`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts#L185) from `"rejects each family ..."` to `"exercises type shapes for each family ..."` for completeness.
