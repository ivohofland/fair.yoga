# Template late-first-class warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A class template's create, resume and edit answers tell the teacher when the template's first class starts inside its cancellation deadline (and past its auto-cancel check), as #840 and #847 already do for a published or moved class.

**Architecture:** One server function (`lateFirstClass`) judges a class start with the existing `latePublishInstants`/`latePublishState` chain. The generator reports the earliest class it inserted and the instant it stamped with; the probe reports its candidate date. A nullable `TemplateFamily.lateFirstClass` hook — present for the class family, `null` for studio — is called from the three lifecycle paths, and the result travels on the three class-template responses to a new `LateFirstClassNotice`.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (`unit`, `components`, `integration` projects), React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-13-template-late-first-class-design.md` — read it before any task; it carries the reasoning this plan does not repeat.

## Global Constraints

- No second spelling of any instant: starts come from `classStartInstant` (server) and deadlines/checks from `latePublishInstants` (`src/lib/late-publish.ts`); the state from `latePublishState`.
- `src/lib/late-publish.ts` and `src/lib/generation.ts` stay client-safe; `src/lib/generation.ts` stays import-free (value imports).
- The generator's rules do not change: an inside-deadline candidate is still generated.
- Studio templates never carry or show the warning.
- Comment Discipline (CLAUDE.md): comments annotate their own code; no counts or rosters in prose; state what is true now. Correction history goes in the PR body.
- Copy strings are exactly the spec's (§Copy); `publish`/`move` copy of `LatePublishNotice` stays byte for byte.
- Edit-path instant: `min(now + CLASS_GENERATION_INTERVAL_MS, start)`; create/resume: the instant the generator passed to `createChildren`.
- Fast loop: `pnpm exec vitest run --project unit <path>`, `--project components <path>`; integration needs `pnpm run worktree:up` first, then `pnpm exec vitest run --project integration <path>`.
- Node 24: prefix shell with the nvm v24 bin (`export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`).
- Stage exact paths; never `git add -A`/`.`. Quote paths with parentheses.

## Review Focus

1. Deadline boundary — a start exactly `DEADLINE_HOURS` after `at` is in time (`null`); 1 ms closer is `past_deadline` (Task 1).
2. Check boundary — `at` exactly at the check instant is `past_check` (`>=`, matching `isPastCancelCheck`) (Task 1).
3. The create/resume warning must agree with the stored `autoCancelDecidedAt` stamp of the class it names — a `past_check` answer with a `null` stamp is the bug the shared instant prevents (Task 2).
4. A resume that inserts nothing answers `null`, even when an existing class is inside its deadline (Task 2).
5. A malformed `lateFirstClass` on the wire shows no notice and does not break the success sentence (Task 4).

---

### Task 1: `lateFirstClass`, its client-safe type and guard, and the shared sweep interval

**Files:**
- Modify: `src/lib/late-publish.ts` (add `LateFirstClassState`, `LateFirstClass`, `isLateFirstClass`)
- Modify: `src/lib/late-publish.test.ts` (guard tests)
- Create: `src/services/late-first-class.ts`
- Create: `src/services/late-first-class.test.ts`
- Modify: `src/lib/generation.ts` (add `CLASS_GENERATION_INTERVAL_MS = 60 * 60 * 1000`)
- Modify: `src/lib/scheduler.ts` (`class-generation` entry's `intervalMs` uses the constant)

**Interfaces:**
- Produces:
  - `src/lib/late-publish.ts`: `export type LateFirstClassState = Exclude<LatePublishState, 'none'>;` `export interface LateFirstClass { date: string; state: LateFirstClassState; minStudents: number }` `export function isLateFirstClass(value: unknown): value is LateFirstClass` — true only for an object whose `date` matches `/^\d{4}-\d{2}-\d{2}$/`, `state` is `'past_deadline' | 'past_check'`, `minStudents` is a positive integer.
  - `src/services/late-first-class.ts`: `export function lateFirstClass(args: { template: { cancelDeadline: CancelDeadline; autoCancelCheck: AutoCancelCheck; minStudents: number }; entry: { date: Date; startTime: Date }; timeZone: string; at: Date }): LateFirstClass | null` — `start = classStartInstant(entry, timeZone)`; `state = latePublishState({ now: at, ...latePublishInstants({ start, cancelDeadline, autoCancelCheck }) })`; `'none'` → `null`; else `{ date: entry.date.toISOString().slice(0, 10), state, minStudents }`.
  - `src/lib/generation.ts`: `export const CLASS_GENERATION_INTERVAL_MS: number`.

- [ ] **Step 1: Write the failing tests.** In `src/services/late-first-class.test.ts`, fix a teacher zone (`'Europe/Amsterdam'`), an entry (`date: new Date('2026-11-10T00:00:00Z')`, `startTime: hhmmToTime('18:00')`), and compute `start = classStartInstant(entry, zone)` in the test (the function under test uses the same one; assert relative to it). Cases, `cancelDeadline: 'HOURS_24'`, `autoCancelCheck: 'HOURS_2'`, `minStudents: 3`:
  - `at = start − 24h` exactly → `null` (deadline instant is still in time).
  - `at = start − 24h + 1ms` → `{ date: '2026-11-10', state: 'past_deadline', minStudents: 3 }`.
  - `at = start − 2h − 1ms` → `past_deadline`; `at = start − 2h` exactly → `past_check`.
  - `at = start` → `past_check`; `at = start + 1ms` → `null` (a started class reads `none`).
  - `at` 30 days before → `null`.
  In `src/lib/late-publish.test.ts`, `isLateFirstClass`: accepts a well-formed value; rejects `null`, a string, `state: 'none'`, `date: '10-11-2026'`, `minStudents: 0`, `minStudents: 1.5`, a missing field.
- [ ] **Step 2: Run, expect FAIL** (`pnpm exec vitest run --project unit src/services/late-first-class.test.ts src/lib/late-publish.test.ts`) with "not exported"/module-not-found.
- [ ] **Step 3: Implement** the three exports above and the constant. In `scheduler.ts` replace the `class-generation` entry's `60 * MINUTE` with `CLASS_GENERATION_INTERVAL_MS` (imported from `@/lib/generation`). The constant's one-line comment says it is the generation sweep's interval and that the scheduler reads it from here.
- [ ] **Step 4: Run, expect PASS**, plus `pnpm exec vitest run --project unit src/lib/scheduler.test.ts` (its `['class-generation', 60 * MINUTE]` pin must still pass).
- [ ] **Step 5: Prove the boundary pin bites.** Temporarily change `isPastCancelDeadline`'s `>` to `>=` in `src/lib/cancel-deadline.ts`; the exact-deadline case must fail. Record the failure line; restore; re-run green.
- [ ] **Step 6: Commit** `feat: lateFirstClass judges a template's first class against its deadline (#849)`.

---

### Task 2: Generator, probe and lifecycle plumbing

Depends on Task 1.

**Files:**
- Modify: `src/lib/generation.ts` (`GenerationResult.firstCreated`)
- Modify: `src/services/entry-generation.ts` (`GeneratorFamily.createChildren` fourth parameter; `generateEntriesForRule` reads one instant, passes it, returns `firstCreated`; `probeFirstEffectiveWeek` returns `{ week, candidate } | null` and its docblock/comments say so)
- Modify: `src/services/class-generator.ts` (`createChildren` stamps with the passed instant)
- Modify: `src/services/studio-class-generator.ts` (accepts and ignores the parameter, if its signature needs it)
- Modify: `src/services/rule-lifecycle.ts` (`TemplateFamily.lateFirstClass`; `PauseRuleOutcome`/`PauseRuleResult` active arms + the `switch`; `UpdateRuleResult` ok arm gains `lateFirstClass`; `updateRule` destructures the probe; its `firstEffective` note names the sibling field)
- Modify: `src/services/class-template-lifecycle.ts` (`CLASS_FAMILY.lateFirstClass`; `CreateTemplateResult` ok arm gains `lateFirstClass`, computed inside the transaction)
- Modify: `src/services/studio-class-template-lifecycle.ts` (`STUDIO_FAMILY.lateFirstClass: null`)
- Modify tests: `src/services/class-generator.test.ts` (the `toEqual({ created: 0, skipped: [] })` assertion), `src/services/entry-generation.test.ts` (probe return shape), `src/services/class-template-lifecycle.test.ts`, `src/services/studio-class-template-lifecycle.test.ts`, `src/services/rule-lifecycle.test.ts` as the compiler requires.

**Interfaces:**
- Consumes: `lateFirstClass`, `LateFirstClass` (Task 1).
- Produces:
  - `GenerationResult = { created: number; skipped: SkippedSlot[]; firstCreated: { date: Date; startTime: Date; at: Date } | null }`.
  - `GeneratorFamily.createChildren(db, template, entries, at: Date)`.
  - `probeFirstEffectiveWeek(...) : Promise<{ week: Date; candidate: Date } | null>`.
  - `TemplateFamily.lateFirstClass: ((child: TChild, entry: { date: Date; startTime: Date }, timeZone: string, at: Date) => LateFirstClass | null) | null`.
  - `CreateTemplateResult` ok: `{ ok: true; template; generation; lateFirstClass: LateFirstClass | null }`.
  - `pauseOrResumeRule` active result: `{ ok: true; action: 'active'; template; scheduled; added; counts; lateFirstClass: LateFirstClass | null }` (and `PauseRuleOutcome`'s active arm the same field).
  - `UpdateRuleResult` ok: `{ ok: true; template; firstEffective: Date | null; generationState; lateFirstClass: LateFirstClass | null }`.

Rules for the implementer:
- `generateEntriesForRule`: `const at = new Date()` immediately before `createChildren`; pass it; `firstCreated` = the row with the minimum `date.getTime()` among `inserted` (explicit reduce — never `inserted[0]`), with `startTime` from that row, plus `at`; `null` when nothing was inserted (both return sites).
- `CLASS_GENERATOR.createChildren` uses the parameter in place of its own `new Date()`, for `isPastCancelCheck(..., at)` and the `? at : null` stamp.
- `updateRule`: after the probe, `firstEffective = probe?.week ?? null`; `lateFirstClass = family.lateFirstClass && probe ? family.lateFirstClass(updated, { date: probe.candidate, startTime: updatedRule.startTime }, template.scheduleRule.teacher.defaultTimezone, new Date(Math.min(now.getTime() + CLASS_GENERATION_INTERVAL_MS, classStartInstant({ date: probe.candidate, startTime: updatedRule.startTime }, sameZone).getTime()))) : null`. `updated` is a `WithSlot<TChild>`, i.e. a `TChild`, carrying `cancelDeadline`/`autoCancelCheck`/`minStudents` as written (`written` is out of scope after the `try`). Non-`active` `generationState` → `null`.
- `pauseOrResumeRule` active arm: `lateFirstClass = family.lateFirstClass && generation.firstCreated ? family.lateFirstClass(claimed, generation.firstCreated, claimed.scheduleRule.teacher.defaultTimezone, generation.firstCreated.at) : null`.
- `GeneratorFamily.createChildren`'s docblock states the new `at` parameter (the instant the stamp is judged at). `STUDIO_GENERATOR.createChildren` may stay three-parameter.
- `createClassTemplate`: inside the `$transaction` callback, after generation, narrowed without `!` (`CLASS_FAMILY.lateFirstClass && generation.firstCreated ? … : null`): `CLASS_FAMILY.lateFirstClass` with `created` (the joined row), `generation.firstCreated`, `created.scheduleRule.teacher.defaultTimezone`, `generation.firstCreated.at`. Return it through `outcome`.

- [ ] **Step 1: Write the failing DB tests** in `src/services/class-template-lifecycle.test.ts` (unit project, real test DB; reuse the file's `seedTeacher` pattern and teardown, one fresh teacher per case so slots never collide). Build schedules from the real clock: pick `target = now + 30h` for a past-deadline case (`cancelDeadline: 'HOURS_48'`, `autoCancelCheck: 'HOURS_2'`) and `target = now + 90min` for a past-check case (`autoCancelCheck: 'HOURS_4'`); derive `dayOfWeek` (schema convention `(getUTCDay()+6)%7` of the target's local calendar date in the teacher's zone) and `startTime` (`HH:MM` of the target in that zone, minutes floored) — use `Intl.DateTimeFormat` with the teacher's `defaultTimezone`. Cases:
  - **create, past_deadline:** `createClassTemplate` → `lateFirstClass.state === 'past_deadline'`, `date` equals the inserted earliest `CalendarEntry.date` (read it back), and that class's `autoCancelDecidedAt` is `null`.
  - **create, past_check:** `state === 'past_check'` and the stored class's `autoCancelDecidedAt` is not `null` and equals `generation.firstCreated.at` (Review Focus 3).
  - **create, in time:** target `now + 6 days`, `HOURS_24` → `lateFirstClass === null`.
  - **resume:** a template seeded paused with no classes (see Fixtures below), then `pauseOrResumeTemplate(..., 'active')` with a past-deadline target → `lateFirstClass.state === 'past_deadline'`.
  - **resume inserting nothing:** a paused template whose window is already fully generated (create active, then pause, then resume) → `lateFirstClass === null` although its first class is inside its deadline (Review Focus 4).
  - **edit:** a template seeded active with no entries, scheduled at `now + 30h`, `HOURS_48` (see Fixtures below); `updateClassTemplate` with a `classType` rename only → `lateFirstClass.state === 'past_deadline'`, `date` = candidate, `firstEffective` = Monday of that candidate.
  - **edit, paused template:** → `lateFirstClass === null`.
  In `src/services/studio-class-template-lifecycle.test.ts`: the studio edit and resume results share the generic `UpdateRuleResult`/`PauseRuleResult` types, so they carry `lateFirstClass` too — assert it is `null` for a studio edit and a studio resume whose first class is inside 30 h (`STUDIO_FAMILY.lateFirstClass` is `null`). `CreateStudioTemplateResult` is separate and does not gain the field. The studio WIRE does not change (both studio routes pick fields by name).
  Update the two runtime key-set pins — `class-template-lifecycle.test.ts` (~line 316) and `studio-class-template-lifecycle.test.ts` (~line 1514), each an `Object.keys(result).sort()` equality on the edit result — to include `'lateFirstClass'`, re-derived from the arm as their comments ask.
  In `src/services/entry-generation.test.ts`: the probe has only failure-case (`null`) tests today; add one success case on the existing stub (`clientOf(() => Promise.resolve([]))` with the file's Thursday horizon) asserting `{ week: <Monday>, candidate: <the Thursday itself> }`.

  **Fixtures (all DB cases):** one fresh `seedTeacher(label)` per case (its zone is `'UTC'`; use it). The unit project runs under `TZ=America/New_York`, so derive the target's day and time with `Intl.DateTimeFormat(..., { timeZone })` and `Date.UTC(...)` only — never local getters or `new Date(y, m, d)`. Edit and resume fixtures: seed the template with Prisma nested create exactly as the file's `makeTemplate` helper does (target `dayOfWeek`/`startTime`, `cancelDeadline: 'HOURS_48'`, no entries; `isActive: false` on the rule for the resume and paused-edit cases), then call `updateClassTemplate(prisma, id, teacherId, { classType: 'Renamed' })` only, or `pauseOrResumeTemplate(prisma, id, teacherId, 'active')`.
- [ ] **Step 2: Run, expect FAIL** (`pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts src/services/entry-generation.test.ts`), then `pnpm exec tsc --noEmit` lists the construction sites to update.
- [ ] **Step 3: Implement** per the rules above. Rewrite the comments the spec's §"Comments and docs this falsifies" names for this task: `probeFirstEffectiveWeek`'s docblock and its "Converted to the WEEK's Monday" comment, `updateRule`'s `firstEffective` note (`rule-lifecycle.ts`, near the `UpdateRuleResult` type), `class-generator.ts`'s stamp comment (the instant now arrives as a parameter). Fix `class-generator.test.ts`'s `toEqual` with `firstCreated: null`.
- [ ] **Step 4: Run, expect PASS** — the files above plus `pnpm exec vitest run --project unit src/services/class-generator.test.ts src/services/studio-class-generator.test.ts src/services/rule-lifecycle.test.ts src/services/studio-class-template-lifecycle.test.ts`, and `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Prove the shared-instant pin bites.** Temporarily make `generateEntriesForRule` return `at: new Date(at.getTime() + 60_000)` in `firstCreated` (an instant the stamp did not use); the create past_check case must fail on the stamp-equals-`at` assertion. Restore; re-run green. Record the failure text.
- [ ] **Step 6: Commit** `feat: template create, resume and edit answer whether the first class is late (#849)`.

---

### Task 3: The three class-template responses carry `lateFirstClass`

Depends on Task 2.

**Files:**
- Modify: `src/lib/api-types.ts` (`TemplateCreateResponse` gains the field; `StudioTemplateCreateResponse` becomes its own interface `{ added: number; counts: SkipCounts }` with its docblock rewritten; `TemplateToggleResponse` active arm gains the field; new `ClassTemplateEditResponse = TemplateEditResponse & { lateFirstClass: LateFirstClass | null }`; the existing `NoneOf` toggle pins keep compiling)
- Modify: `src/app/api/class-templates/route.ts` (POST 201 body adds `lateFirstClass: result.lateFirstClass`)
- Modify: `src/app/api/class-templates/[id]/route.ts` (PUT body adds it; PATCH active arm adds it; `PutResponse` uses `ClassTemplateEditResponse`)
- Modify: `src/components/settings/template-action-messages.ts` only if its re-exported toggle types need it to compile
- Test: `tests/integration/class-templates-api.test.ts`

**Interfaces:**
- Consumes: Task 2's result fields.
- Produces: wire `lateFirstClass: { date: 'YYYY-MM-DD'; state; minStudents } | null` on the class POST 201, the class PUT 200, and the class PATCH `action: 'active'` 200. Studio endpoints unchanged.

- [ ] **Step 1: Write failing integration tests** in `tests/integration/class-templates-api.test.ts`. One fresh `seedTeacher('late-first-<case>')` per case (zone `'UTC'`), never the file-level shared teacher (its many templates make a clock-derived slot collide depending on the hour); body built with that owner's `teacherRoomId` and explicit `cancelDeadline: 'HOURS_48'`, `autoCancelCheck: 'HOURS_2'`; clean up per case. Cases: POST a template whose first candidate is `now + 30h` → `data.lateFirstClass.state === 'past_deadline'` and `data.lateFirstClass.date` is the target date; POST one 6 days out → `data.lateFirstClass === null`; for the PUT, delete the first template's entries (`prisma.calendarEntry.deleteMany({ where: { scheduleRuleId } })`, as the file does elsewhere), then PUT a `classType` rename → `state === 'past_deadline'`, `date` = target date. Derive day/time with `Intl.DateTimeFormat`/`Date.UTC` as in Task 2.
- [ ] **Step 2: Run, expect FAIL** (`pnpm run worktree:up` once, then `pnpm exec vitest run --project integration tests/integration/class-templates-api.test.ts`).
- [ ] **Step 3: Implement** the type and route changes.
- [ ] **Step 4: Run, expect PASS**, and `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit** `feat: class-template responses carry lateFirstClass (#849)`.

---

### Task 4: `LateFirstClassNotice` on the create form, edit form and resume button; docs

Depends on Task 3.

**Files:**
- Modify: `src/components/class/late-publish-notice.tsx` (extract `export function shortfallSentence(minStudents: number): string` returning `If ${shortfall}, you cover what ${missing} would have paid.` and use it; publish/move output byte-identical)
- Modify: `src/components/class/late-publish-notice.test.tsx` (pin `shortfallSentence` for 1 and 3)
- Create: `src/components/settings/late-first-class-notice.tsx`
- Create: `src/components/settings/late-first-class-notice.test.tsx`
- Modify: `src/components/settings/template-form.tsx` (create gate; edit success; comments)
- Modify: `src/components/settings/template-form.test.tsx`
- Modify: `src/components/settings/toggle-template-button.tsx` + `.test.tsx`
- Modify: `src/components/settings/template-action-messages.ts` (`resolveStudioConfirmation` docblock: the class create form now also stays for a late first class)
- Modify: `docs/technical-architecture.md` (the PUT's probe paragraph: the PUT also answers whether the first class is late; one sentence + link to the spec)
- Modify: `CLAUDE.md` (Class Lifecycle, "template is a stamp" bullet: the edit answer also warns when that first class would start inside its cancellation deadline)
- Modify: `docs/superpowers/specs/2026-10-12-late-move-notice-design.md` (one line under "Template path: decided (c)": changed to (b) on 2026-10-13, see the #849 spec)

**Interfaces:**
- Consumes: `LateFirstClass`, `isLateFirstClass` (Task 1); wire fields (Task 3); `formatDayHeader` (`@/lib/format`).
- Produces: `LateFirstClassNotice({ late: LateFirstClass; when: 'added' | 'expected' })`.

Copy — exactly, `{date}` = `formatDayHeader(new Date(late.date))`, `{shortfall}` = `shortfallSentence(late.minStudents)`:
- added/past_deadline: `Your first class, on {date}, starts inside its cancellation deadline. Students who book it can't cancel for free. You can cancel it from your schedule.`
- added/past_check: `Your first class, on {date}, starts inside its cancellation deadline and past its auto-cancel check. Students who book it can't cancel for free, and the class goes ahead however few book. {shortfall} You can cancel it from your schedule.`
- expected/past_deadline: `Your first class on the new schedule, on {date}, may be added after its cancellation deadline has passed. Students who book it then can't cancel for free.`
- expected/past_check: `Your first class on the new schedule, on {date}, may be added after its cancellation deadline and auto-cancel check have passed. Students who book it then can't cancel for free, and it may go ahead however few book. {shortfall}`
Markup: the same `<p className="type-caption text-gold-deep bg-gold-tint rounded-card px-4 py-3 mb-4">` as `LatePublishNotice`, exhaustive `switch` with a `never` default on `state`.

Wire reading (each of the three sites): `const late = isLateFirstClass(data.lateFirstClass) ? data.lateFirstClass : null;` and when `data.lateFirstClass` is neither `null`/`undefined` nor valid, `console.warn('<site>: unreadable lateFirstClass, no notice shown', data.lateFirstClass)`.

- [ ] **Step 1: Write failing component tests.**
  - `late-first-class-notice.test.tsx`: all four copy strings exactly, for `minStudents` 1 and 3 on the past_check ones; date `'2026-11-10'` renders `Tuesday, 10 Nov` (check `formatDayHeader`'s month spelling in `src/lib/format.ts` and use what it produces).
  - `template-form.test.tsx` (follow its existing fetch-mock pattern): create with a clean window and `lateFirstClass` present → stays on the page (no `router.push`), shows the success sentence and the notice; clean window and `lateFirstClass: null` → navigates as today; edit success with `lateFirstClass` → `templateUpdatedMessage` sentence plus the expected-copy notice; a malformed `lateFirstClass` (`{ state: 'soon' }`) on create with a clean window → navigates, no notice, `console.warn` called (Review Focus 5).
  - `template-form.test.tsx`, stale notice: edit save answering a `lateFirstClass`, then a second save answering `null` → the notice is gone.
  - `toggle-template-button.test.tsx`: resume answer with `lateFirstClass` → resume sentence and the added-copy notice; with `null` → no notice.
- [ ] **Step 2: Run, expect FAIL** (`pnpm exec vitest run --project components src/components/settings src/components/class/late-publish-notice.test.tsx`).
- [ ] **Step 3: Implement.** Create form: the success branch stays on the page when `anyBlocked(result.counts) || late !== null`, sets `success` to `resumeMessage(result.added, result.added, result.counts)` and a `late` state; render `{late && <LateFirstClassNotice late={late} when={mode === 'create' ? 'added' : 'expected'} />}` directly under the success line. Edit branch sets the same `late` state (expected). Clear `late` at every site that clears `success` (`setSuccess('')`: field edits and submit start). Rewrite the create-gate comments so they state the two conditions. Toggle button: a second `late` state, cleared on each click, read null-safely inside the existing `try` after `setMessage(...)` (`(data as { lateFirstClass?: unknown } | undefined)?.lateFirstClass` — a body with no `data` must not change which message shows), rendered under the message with `when="added"`. `resolveStudioConfirmation`'s docblock: cut its narration of `template-form.tsx`'s behaviour to a pointer to the #849 spec rather than extending it (Comment Discipline). Add `src/components/settings/late-first-class-notice.tsx` to `CLIENT_IMPORTED` in `src/lib/client-safe-instants.test.ts`. Then the docs edits listed under Files.
- [ ] **Step 4: Run, expect PASS**, then `pnpm exec tsc --noEmit` and `pnpm lint`.
- [ ] **Step 5: Prove the stay-on-page pin bites.** Temporarily drop `|| late !== null` from the gate; the "stays on the page" test must fail. Restore; re-run green.
- [ ] **Step 6: Commit** `feat: template form and resume button show the late-first-class notice (#849)`.
