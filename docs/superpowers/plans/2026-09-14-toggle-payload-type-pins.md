# Toggle-Payload & Result Type Pins: Replace @ts-expect-error with NoneOf Pins (#207) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development (`invoke_subagent`) to implement this plan task-by-task.

**Goal:** Complete Issue #207 acceptance criteria: express toggle-payload and lifecycle-result non-interchangeability pins using `NoneOf` from `@/lib/type-pins` beside the type definitions in source files so compiler failures name the offending type/condition; eliminate the redundant test-level `@ts-expect-error` directives; migrate the verdict union pin in `studio-class-editability`; and audit/clarify that remaining call-site `@ts-expect-error` directives are checked by `npm run typecheck` only.

**Tech Stack:** TypeScript strict, Next.js 16, Vitest (`unit`, `components`, `integration`).

## Global Constraints

- **TypeScript `strict: true`**. No `any`, no implicit types, no suppressing directives where pins belong.
- **Failures must name the offender**: Invariant violations must report `Type 'true' is not assignable to type '"<OffenderDescription>"'`, not a bare `Type 'false' does not satisfy the constraint 'true'`.
- **Never start or restart the dev server on :3000.** The user runs it.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Commit per task.** The PR is rebase-merged, never squashed.
- **`pnpm run verify` before pushing.**

---

### Task 1: Upgrade Toggle Payload Pins in `src/lib/api-types.ts` & Clean Up `template-action-messages.test.ts`

**Files:**
- Modify: `src/lib/api-types.ts:17, 111-116`
- Modify: `src/components/settings/template-action-messages.test.ts:741-764`

**Behavior:**
1. In `src/lib/api-types.ts`:
   - Import `type { NoneOf }` from `@/lib/type-pins`.
   - Replace lines 111-115 (`Assert<Equals<..., false>>`) with:
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

     const _studioIsNotClass: NoneOf<
       StudioTemplateToggleResponse extends TemplateToggleResponse
         ? 'StudioTemplateToggleResponse extends TemplateToggleResponse'
         : never
     > = true;
     void _studioIsNotClass;
     ```
2. In `src/components/settings/template-action-messages.test.ts`:
   - Remove lines 741-764 (`describe('the two toggle payloads are not interchangeable', ...)`) which used `@ts-expect-error` with dummy `expect(true).toBe(true)` assertions.
   - Note: The mutual non-assignability invariant is now certified directly in `src/lib/api-types.ts` beside `TemplateToggleResponse` and `StudioTemplateToggleResponse`.
3. Verify:
   - `pnpm run typecheck` passes cleanly (exit 0).
   - `pnpm exec vitest run --project unit src/components/settings/template-action-messages.test.ts` passes cleanly.
4. Commit:
   ```bash
   git add src/lib/api-types.ts src/components/settings/template-action-messages.test.ts
   git commit -m "fix(api-types): express toggle payload non-interchangeability with NoneOf pins (#207)"
   ```

---

### Task 2: Migrate Lifecycle Result Pins in `src/services/rule-lifecycle.ts` & `rule-lifecycle.test.ts`

**Files:**
- Modify: `src/services/rule-lifecycle.ts`
- Modify: `src/services/rule-lifecycle.test.ts`

**Behavior:**
1. In `src/services/rule-lifecycle.ts`:
   - Import `type { NoneOf }` from `@/lib/type-pins`.
   - In `ArchiveRuleResult` docblock (lines 322-325): replace the outdated sentence citing `@ts-expect-error` in `rule-lifecycle.test.ts` and `template-action-messages.test.ts` with an explanation that non-interchangeability is asserted by the `NoneOf` compile-time pins below.
   - Immediately following `ArchiveRuleResult` definition, add:
     ```ts
     // Compile-time pins asserting that class and studio archive results are
     // mutually non-interchangeable via `template: WithSlot<TChild>` (#207).
     const _classArchiveIsNotStudio: NoneOf<
       ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>
         ? 'ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>'
         : never
     > = true;
     void _classArchiveIsNotStudio;

     const _studioArchiveIsNotClass: NoneOf<
       ArchiveRuleResult<StudioClassTemplate> extends ArchiveRuleResult<ClassTemplate>
         ? 'ArchiveRuleResult<StudioClassTemplate> extends ArchiveRuleResult<ClassTemplate>'
         : never
     > = true;
     void _studioArchiveIsNotClass;
     ```
   - In `PauseRuleResult` docblock (lines 903-905): update docblock to cite `NoneOf` pins beside the type definition.
   - Immediately following `PauseRuleResult` definition, add:
     ```ts
     // Compile-time pins asserting that class and studio pause results are
     // mutually non-interchangeable via `template: WithSlot<TChild>` (#207).
     const _classPauseIsNotStudio: NoneOf<
       PauseRuleResult<ClassTemplate> extends PauseRuleResult<StudioClassTemplate>
         ? 'PauseRuleResult<ClassTemplate> extends PauseRuleResult<StudioClassTemplate>'
         : never
     > = true;
     void _classPauseIsNotStudio;

     const _studioPauseIsNotClass: NoneOf<
       PauseRuleResult<StudioClassTemplate> extends PauseRuleResult<ClassTemplate>
         ? 'PauseRuleResult<StudioClassTemplate> extends PauseRuleResult<ClassTemplate>'
         : never
     > = true;
     void _studioPauseIsNotClass;
     ```
   - Following `UpdateRuleResult` definition, add:
     ```ts
     // Compile-time pins asserting that class and studio update results are
     // mutually non-interchangeable via `template: WithSlot<TChild>` (#207).
     const _classUpdateIsNotStudio: NoneOf<
       UpdateRuleResult<ClassTemplate> extends UpdateRuleResult<StudioClassTemplate>
         ? 'UpdateRuleResult<ClassTemplate> extends UpdateRuleResult<StudioClassTemplate>'
         : never
     > = true;
     void _classUpdateIsNotStudio;

     const _studioUpdateIsNotClass: NoneOf<
       UpdateRuleResult<StudioClassTemplate> extends UpdateRuleResult<ClassTemplate>
         ? 'UpdateRuleResult<StudioClassTemplate> extends UpdateRuleResult<ClassTemplate>'
         : never
     > = true;
     void _studioUpdateIsNotClass;
     ```
2. In `src/services/rule-lifecycle.test.ts`:
   - In `describe('the two template families are not interchangeable')`:
     - Remove the `@ts-expect-error` calls `takesStudio(classResult)` and `takesClass(studioResult)` for archive (lines 200-203), pause (lines 229-232), and update (lines 255-258), since these invariants are now pinned in `rule-lifecycle.ts`.
     - Keep the positive assertions `expect(takesStudio(studioResult)).toBe(true)` / `expect(takesClass(classResult)).toBe(true)`.
   - In `it('refuses a childTable, logNoun, or editNoun that belongs to the other family')` (lines 96-124):
     - Update test docblock to explicitly state that the 7 `@ts-expect-error` directives testing property assignments are checked by `npm run typecheck` only.
3. Verify:
   - `pnpm run typecheck` passes cleanly (exit 0).
   - `pnpm exec vitest run --project unit src/services/rule-lifecycle.test.ts` passes cleanly.
4. Commit:
   ```bash
   git add src/services/rule-lifecycle.ts src/services/rule-lifecycle.test.ts
   git commit -m "fix(rule-lifecycle): express result type non-interchangeability with NoneOf pins (#207)"
   ```

---

### Task 3: Migrate Verdict Pin in `src/services/studio-class-editability.ts` & `studio-class-editability.test.ts`

**Files:**
- Modify: `src/services/studio-class-editability.ts`
- Modify: `src/services/studio-class-editability.test.ts`

**Behavior:**
1. In `src/services/studio-class-editability.ts`:
   - Import `type { NoneOf }` from `@/lib/type-pins`.
   - Immediately following `StudioClassEditVerdict`:
     ```ts
     // Compile-time pin asserting dateEditable cannot stand without scheduleEditable (#207).
     const _illegalVerdictCannotStand: NoneOf<
       { scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict
         ? '{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict'
         : never
     > = true;
     void _illegalVerdictCannotStand;
     ```
2. In `src/services/studio-class-editability.test.ts`:
   - Remove lines 195-204 (the `@ts-expect-error` `_illegalVerdict` pin).
   - Update docblock to reference the pin residing beside `StudioClassEditVerdict` in `studio-class-editability.ts`.
3. Verify:
   - `pnpm run typecheck` passes cleanly (exit 0).
   - `pnpm exec vitest run --project unit src/services/studio-class-editability.test.ts` passes cleanly.
4. Commit:
   ```bash
   git add src/services/studio-class-editability.ts src/services/studio-class-editability.test.ts
   git commit -m "fix(studio-class-editability): express verdict illegal state pin with NoneOf (#207)"
   ```

---

### Task 4: Audit & Document Remaining Call-Site `@ts-expect-error` Directives

**Files:**
- Modify: test files with call-site `@ts-expect-error` directives lacking explicit `npm run typecheck` only notice

**Behavior:**
1. Audit all remaining call-site `@ts-expect-error` files (`db-locks.test.ts`, `class-template-lifecycle.test.ts`, `studio-class-template-lifecycle.test.ts`, `class-lifecycle.test.ts`, `entry-generation.test.ts`, `timezone.test.ts`, `worktree/identity.test.ts`, `worktree/registry.test.ts`, `rule-slot-holder.test.ts`, `entry-conflict.test.ts`, `registration-status.test.ts`, `api-utils.test.ts`, `studio-class-deletion.test.ts`, `studio-class-editability.test.ts`).
2. Ensure each test / helper docblock explicitly states:
   - Checked by `npm run typecheck` only (`tsc --noEmit`).
   - Invisible to Vitest runtime test execution (tests do not execute or transpile types).
3. Verify:
   - `pnpm run typecheck` passes cleanly.
   - `pnpm test` passes cleanly.
4. Commit:
   ```bash
   git add -u
   git commit -m "docs(tests): clarify typecheck-only enforcement on remaining call-site @ts-expect-error guards (#207)"
   ```

---

### Task 5: Mutation Testing Protocol — Prove Every Guard Bites

**Files:**
- Create: `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md`

**Behavior:**
Execute each mutation, record exact compiler error message, restore, and verify green.

1. **Mutation 1 (Toggle payload: `_classIsNotStudio`):**
   - In `src/lib/api-types.ts`: on `TemplateToggleResponse`, change `templateKind: 'class'` to `templateKind: 'studio'`.
   - Run `pnpm run typecheck`.
   - Expect RED: `Type 'true' is not assignable to type '"TemplateToggleResponse extends StudioTemplateToggleResponse"'`.
   - Restore and re-verify GREEN.

2. **Mutation 2 (Toggle payload: `_studioIsNotClass`):**
   - In `src/lib/api-types.ts`: on `StudioTemplateToggleResponse`, change `templateKind: 'studio'` to `templateKind: 'class'`.
   - Run `pnpm run typecheck`.
   - Expect RED: `Type 'true' is not assignable to type '"StudioTemplateToggleResponse extends TemplateToggleResponse"'`.
   - Restore and re-verify GREEN.

3. **Mutation 3 (Archive rule result: `_classArchiveIsNotStudio` & `_studioArchiveIsNotClass`):**
   - In `src/services/rule-lifecycle.ts`: replace `template: WithSlot<TChild>` in `ArchiveRuleResult` with `template: { id: string }`.
   - Run `pnpm run typecheck`.
   - Expect RED: `Type 'true' is not assignable to type '"ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>"'` and twin.
   - Restore and re-verify GREEN.

4. **Mutation 4 (Pause rule result: `_classPauseIsNotStudio` & `_studioPauseIsNotClass`):**
   - In `src/services/rule-lifecycle.ts`: replace `template: WithSlot<TChild>` in `PauseRuleResult` with `template: { id: string }`.
   - Run `pnpm run typecheck`.
   - Expect RED: `Type 'true' is not assignable to type '"PauseRuleResult<ClassTemplate> extends PauseRuleResult<StudioClassTemplate>"'` and twin.
   - Restore and re-verify GREEN.

5. **Mutation 5 (Update rule result: `_classUpdateIsNotStudio` & `_studioUpdateIsNotClass`):**
   - In `src/services/rule-lifecycle.ts`: replace `template: WithSlot<TChild>` in `UpdateRuleResult` with `template: { id: string }`.
   - Run `pnpm run typecheck`.
   - Expect RED: `Type 'true' is not assignable to type '"UpdateRuleResult<ClassTemplate> extends UpdateRuleResult<StudioClassTemplate>"'` and twin.
   - Restore and re-verify GREEN.

6. **Mutation 6 (Verdict pin: `_illegalVerdictCannotStand`):**
   - In `src/services/studio-class-editability.ts`: change `StudioClassEditVerdict` to `| { scheduleEditable: boolean; dateEditable: boolean }`.
   - Run `pnpm run typecheck`.
   - Expect RED: `Type 'true' is not assignable to type '"{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict"'`.
   - Restore and re-verify GREEN.

7. **Verify Entire Suite:**
   - Run `pnpm run verify` (typecheck → lint → test).
8. Commit:
   ```bash
   git add docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md
   git commit -m "docs(types): record mutation testing ledger for toggle payload and result type pins (#207)"
   ```
