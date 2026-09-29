# Template-form exact copy pins Implementation Plan (#320)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every positive copy pin in the two template-form test files compares the rendered text exactly, so a punctuation, case or surrounding-text drift in that copy turns a test red.

**Architecture:** Test-only change. `findByText`/`getByText` given a *string* compare the whole normalized `textContent` of an element (`exact: true` is the default); given an unanchored regex they run `regex.test(text)`, which accepts any string containing a match. Replace each unanchored positive regex pin with the exact rendered string. No production code changes.

**Tech Stack:** Vitest (`components` project, jsdom), @testing-library/react.

**Spec:** none — single-subsystem, one approach. The direction is recorded here and in the PR body.

## Premise, as measured (not as the issue states it)

The issue (filed 2026-08-24) names `template-form.test.tsx:210,326,327,344,353`. The file has since grown from ~360 to 1870 lines. The same five pins now sit at **726, 925, 926, 943, 952** (identified by content at `671c3b63`, the revision the issue's numbers match). Three more unanchored positive pins were added after the issue: **843** (`/^Created/`, prefix-anchored only), **1015**, **1094**. The studio twin file carries the same shape twice: **`studio-template-form.test.tsx:318`** (`/^Created/`) and **`:764`**. Each studio pin guards copy shared with the class-family pin beside it (the SettledNotice `label` on both forms; the one `buildResumeSentence` both families call).

Re-derive: `grep -nE "(get|find)(All)?ByText\(/" src/components/settings/template-form.test.tsx src/components/settings/studio-template-form.test.tsx`. That grep also lists the negative pins below, which this plan leaves alone.

**Deliberately unchanged:**
- **Negative pins** — `queryByText(/no rooms configured/i)` (927, 944, 953) and `queryByText(/undefined/)` (1305). An unanchored negative regex refuses *every* string containing the phrase. Anchoring it would shrink what it refuses, which weakens it.
- **Locators, not copy pins** — `findByRole('button', { name: /create/i })`, `findByLabelText(/cancellation deadline/i)`, `findByRole('option', { name: /Studio B/ })`. These find an element; the copy under test is asserted elsewhere.
- **`toHaveTextContent(/^…$/)` pins** (382, 425, 470, 578, 692, …) — already anchored at both ends. They have to be regexes: `toHaveTextContent` with a *string* is a substring match.
- **The other regex `*ByText` pins across the repo** — `grep -rhE "(get|find)(All)?ByText\(/" src --include='*.test.tsx' | wc -l` → 102 lines in 33 files (2026-09-29, before this change). That is out of this issue's scope, and the PR body says so.

## Global Constraints

- Tests assert copy, never `error.message` literals from services (project rule; not touched here).
- Exact strings are copied from the source file, character for character — including `'` (the JSX `&apos;` renders as `'`).
- Comment Discipline (CLAUDE.md): no counts or rosters in test comments; no "this previously read X".
- Stage exact paths; never `git add -A`.

## Review Focus

1. **A pin converted to a string that does not match** would fail *today*, and would read as a failing test rather than a wrong plan. Each task runs its file green after converting.
2. **A conversion that cannot fail.** Each converted pin gets a mutation that the OLD regex accepts and the NEW string rejects (below). The mutation proves the conversion added bite, not just that the test runs.
3. **Mutation left in the tree.** Each mutation is applied and restored as exact text. The task ends with `git status --porcelain` showing only the intended test-file change, or nothing once committed.
4. **Multiple matches.** `getByText('Created')` must still find exactly one element. The button reads "Go to recurring classes", so it cannot collide, but the run proves it.
5. **The overlap sentence's head.** `resumeMessage(result.added, result.added, …)` (`template-form.tsx:446`) with `added: 0` renders the `Nothing is scheduled from this template.` head, so the exact string carries that head too.

---

### Task 1: `template-form.test.tsx` — exact copy pins

**Files:**
- Modify: `src/components/settings/template-form.test.tsx` (lines 726, 843, 925, 926, 943, 952, 1015–1016, 1094–1095 as of `0f451444`)

**Interfaces:** none produced; Task 2 is independent.

- [ ] **Step 1: Demonstrate the gap (mutation against the OLD pins).** Apply each source mutation below, one at a time. Run `pnpm exec vitest run --project components src/components/settings/template-form.test.tsx`. Record that the named test stays **green** (that green is the defect the issue describes), then restore the exact original text.

| # | Source file:line | Original | Mutated to | Old pin line(s) that stay green |
|---|---|---|---|---|
| M1 | `src/components/settings/template-form.tsx:131` | `'Min rate cannot exceed target rate'` | `'Min rate cannot exceed target rate.'` | 726 |
| M2 | `src/components/settings/template-form.tsx:567` | `All your rooms are archived.` | `All your rooms are archived` | 925 |
| M3 | `src/components/settings/template-form.tsx:568` | `Unarchive one in Settings to schedule here.` | `Unarchive one in Settings to schedule here` | 926 |
| M4 | `src/components/settings/template-form.tsx:553` | `Couldn&apos;t load your rooms.` | `Couldn&apos;t load your rooms` | 943, 952 |
| M5 | `src/components/settings/template-form.tsx:723` | `label="Created"` | `label="Created."` | 843 |
| M6 | `src/components/settings/template-action-messages.ts:284` | `if (causes.length > 0) return [head, ...causes].join(' ');` | `if (causes.length > 0) return [head, ...causes, 'Nothing needed adding.'].join(' ');` | 1015 |
| M7 | `src/components/settings/template-action-messages.ts:281` | `'Nothing is scheduled from this template.'` | `'Nothing is scheduled from this template'` | 1094 |

M6 and M7 also turn `template-action-messages.test.ts` red — that file's own exact pins. It's expected and not part of this record; the point is the *form* test's blindness.

If any old pin goes **red** under its mutation, stop: the premise for that line is wrong, and the pin stays as it is. Report it.

- [ ] **Step 2: Convert the pins.** Replace exactly:

```ts
// 726
expect(await screen.findByText('Min rate cannot exceed target rate')).toBeInTheDocument();
// 843
expect(screen.getByText('Created')).toBeInTheDocument();
// 925, 926
expect(await screen.findByText('All your rooms are archived.')).toBeInTheDocument();
expect(screen.getByText('Unarchive one in Settings to schedule here.')).toBeInTheDocument();
// 943 and 952 (both tests)
expect(await screen.findByText("Couldn't load your rooms.")).toBeInTheDocument();
// 1015–1016
expect(
  await screen.findByText('3 classes on your schedule. 1 date already had a class.'),
).toBeInTheDocument();
// 1094–1095
expect(
  await screen.findByText(
    'Nothing is scheduled from this template. 4 dates overlap other classes on your schedule.',
  ),
).toBeInTheDocument();
```

Match the file's quote style (single quotes; a string containing `'` uses double quotes, as elsewhere in the file). Leave the neighbouring `queryByText(/no rooms configured/i)` lines untouched.

- [ ] **Step 3: Run green.** `pnpm exec vitest run --project components src/components/settings/template-form.test.tsx` → all pass.

- [ ] **Step 4: Commit** (before mutating — a restore must never be able to discard the conversion).

```bash
git add src/components/settings/template-form.test.tsx
git commit -m "test(template-form): pin copy by exact string, not substring regex (#320)"
```

- [ ] **Step 5: Prove each converted pin bites.** Re-apply M1–M7 one at a time. Under each, the listed line must now go **red**. Record the failing test name and the first line of the `Unable to find an element with the text: …` error. Restore the exact text after each one.

- [ ] **Step 6: End clean.** `git status --porcelain` prints nothing; `git diff HEAD --stat` is empty; the file run is green again.

### Task 2: `studio-template-form.test.tsx` — the twin pins

**Files:**
- Modify: `src/components/settings/studio-template-form.test.tsx` (lines 318, 764–765 as of `0f451444`)

**Interfaces:** none.

- [ ] **Step 1: Demonstrate the gap.** Apply each mutation and run `pnpm exec vitest run --project components src/components/settings/studio-template-form.test.tsx`. The named test stays **green**. Restore the exact text.

| # | Source file:line | Original | Mutated to | Old pin line that stays green |
|---|---|---|---|---|
| S1 | `src/components/settings/studio-template-form.tsx:425` | `label="Created"` | `label="Created."` | 318 |
| S2 | `src/components/settings/template-action-messages.ts:281` | `'Nothing is scheduled from this template.'` | `'Nothing is scheduled from this template'` | 764 |

- [ ] **Step 2: Convert.**

```ts
// 318
expect(screen.getByText('Created')).toBeInTheDocument();
// 764–765
expect(
  await screen.findByText(
    'Nothing is scheduled from this template. 2 dates overlap other classes on your schedule.',
  ),
).toBeInTheDocument();
```

Before relying on 764's head, confirm the studio create path passes `added` as the scheduled count (grep `resumeStudioMessage(` in `studio-template-form.tsx`). If the head differs, use the string the run reports and note it in the task report.

- [ ] **Step 3: Run green**, then **Step 4: Commit.**

```bash
git add src/components/settings/studio-template-form.test.tsx
git commit -m "test(studio-template-form): pin the shared copy by exact string (#320)"
```

- [ ] **Step 5: Prove each converted pin bites.** S1 → 318 red, S2 → 764 red; record the error lines; restore.

- [ ] **Step 6: End clean.** `git status --porcelain` empty; file green.
