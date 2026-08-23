# Mutations — studio family e2e (issue 283)

Each guard below was broken, the exact failure text was captured from a real
run, the mutation was restored, and green was re-verified before moving on.
Sources: `.superpowers/sdd/2026-08-22-studio-family-e2e/task-{1,2,3,4}-report.md`,
each read in full including its appended fix-round sections — several
mutations were scored during review rounds and live only there.

Fourteen mutations are documented below: 3 in Task 1, 6 in Task 2, 2 in Task 3,
1 in Task 4, 2 in the review fix wave (3+6+2+1+2, one heading per entry —
re-derive the entry count with `grep -c '^### ' docs/superpowers/plans/2026-08-22-studio-family-e2e-mutations.md`).
Mutation labels are copied as each report scored them, not renumbered into one
global sequence — Task 1's fix round and Task 2's original pass each
independently number their first new mutation `M3`, so that label appears
twice below (flagged where Task 2's section starts). Every one of the
fourteen came back RED as predicted, or RED on a different case than
predicted with the discrepancy explained (M6); none came back an unexplained
GREEN.

## Task 1 — the paused/archived title and caption fix (issue 281, commit `32b276c`)

Scored against
`npx vitest run --project components src/components/settings/studio-template-list.test.tsx`.

### M1 — the failing test, before the fix (brief step 2)

Mutation: none — the new 7-case spec run against the unmodified component,
before the paused/archived sections' title and caption spans were changed to
match the active section.

Result: **RED**, 4 of 7 failing.

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |components| src/components/settings/studio-template-list.test.tsx (7 tests | 4 failed) 46ms
     × titles a paused template with its class type 6ms
     × keeps the location in a paused template's caption 3ms
     × titles a archived template with its class type 4ms
     × keeps the location in a archived template's caption 3ms

...
 Test Files  1 failed (1)
      Tests  4 failed | 3 passed (7)
```

Each failure's DOM dump confirmed the exact defect: paused/archived titles
rendered the location instead of the class type, captions rendered the rate
with no location. Fix applied → 7/7 passed before M2 was scored.

### M2 — re-diverge one section only (brief step 5)

Mutation: reverted only the archived section's title back to `{t.location}`,
leaving the paused section and both captions as fixed.

Result: **RED**, exactly one of 7 failing.

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |components| src/components/settings/studio-template-list.test.tsx (7 tests | 1 failed) 51ms
     × titles a archived template with its class type 8ms

...
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

Restored the archived title to `{t.classType || t.location}` and re-ran:
7/7 passed.

### M3 — the caption half (F3, added during the fix round)

M1 and M2 both targeted the title half of the fix; nothing had yet mutated
the caption half by execution rather than by reading. Mutation: reverted the
*paused* section's caption only (line 57) from
`{t.location} &middot; &euro;{Number(t.hourlyRate).toFixed(2)}/hr` back to
the bare `&euro;{Number(t.hourlyRate).toFixed(2)}/hr`, leaving the archived
section's identical caption line untouched.

Result: **RED**, exactly one of 7 failing.

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |components| src/components/settings/studio-template-list.test.tsx (7 tests | 1 failed) 44ms
     × keeps the location in a paused template's caption 6ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |components| src/components/settings/studio-template-list.test.tsx > StudioTemplateList — the three sections agree > keeps the location in a paused template's caption
TestingLibraryElementError: Unable to find an element with the text: /Yoga Studio Centrum · €45\.00\/hr/. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.

Ignored nodes: comments, script, style
<body>
  <div>
    <div>
      <a
        class="flex items-start justify-between gap-3 min-h-14 py-2 border-b border-border no-underline opacity-60"
        href="/settings/studio-classes/t1"
      >
        <div
          class="flex flex-col gap-1"
        >
          <span
            class="text-base text-ink"
          >
            Vinyasa
          </span>
          <span
            class="type-caption"
          >
            Tuesday
             
            09:00
             · 
            60
             min
          </span>
          <span
            class="type-caption"
          >
            €
            45.00
            /hr
          </span>
        </div>
        <span
          class="type-caption pt-1"
        >
          paused
        </span>
      </a>
    </div>
  </div>
</body>
 ❯ Object.getElementError node_modules/@testing-library/dom/dist/config.js:37:19
 ❯ node_modules/@testing-library/dom/dist/query-helpers.js:76:38
 ❯ node_modules/@testing-library/dom/dist/query-helpers.js:52:17
 ❯ node_modules/@testing-library/dom/dist/query-helpers.js:95:19
 ❯ src/components/settings/studio-template-list.test.tsx:50:21

 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

Restored the paused caption to
`{t.location} &middot; &euro;{Number(t.hourlyRate).toFixed(2)}/hr`;
`git diff src/components/settings/studio-template-list.tsx` against HEAD came
back empty. Re-verified: 7/7 passed on the file, then `npm run verify` —
144 test files / 1814 tests passed.

## Task 2 — the template arc (issue 283)

Scored against `npx playwright test studio --project=chromium` (8 e2e cases),
each mutation warmed first via a throwaway request per the lazy-recompile
hazard. This section's first mutation is independently labeled `M3` — Task 1's
fix round above used the same label for an unrelated mutation; the two were
scored by different task reports without a shared counter.

### M3 — the deletability predicate forced permissive

Mutation: `studioClassDeletability` forced to return `{ deletable: true }`
unconditionally.

Result: **RED**, exactly as predicted.

```
Error: expect(locator).toHaveCount(expected) failed
Locator:  getByRole('button', { name: 'Remove this class' })
Expected: 0
Received: 1
```

Restored, re-warmed, re-ran: 2/2 passed.

### M4 — the archive gate short-circuited

Mutation: in `src/app/(teacher)/settings/studio-classes/[id]/page.tsx`, at the `{!template.isActive && (` gate,
changed `{!template.isActive && (` to `{false && (`.

Result: **RED**, exactly as predicted (test 3 fails; test 4 "did not run" —
serial mode stops on first failure).

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('button', { name: 'Archive studio class' })
Error: element(s) not found
```

Restored, re-warmed, re-ran: 4/4 passed.

### M5 — Task 1's fix reverted at the e2e layer

Mutation: `src/components/settings/studio-template-list.tsx`'s paused-section
title reverted to `{t.location}`.

Result: **RED**, exactly as predicted — this is the assertion that proves
Task 1's fix (`32b276c`) is load-bearing at the e2e layer, not only at the
component-test layer.

```
Error: expect(locator).toBeVisible() failed
Locator: getByText('Studio Flow')
Error: element(s) not found
```

Restored, re-warmed, re-ran: 4/4 passed.

### M6 — the archive/un-archive CAS forced to leave `isActive` true

Mutation: `src/services/studio-class-template-lifecycle.ts:1226`, changed
`isActive: false` to `isActive: true` in the archive/un-archive CAS `data:`
block.

Result: **RED**, one test earlier than predicted.

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('button', { name: 'Unarchive studio class' })
Error: element(s) not found
```

**M6 was RED, but not on the case it was chosen to prove — and that gap is
the reason M7 exists.** The mutation was picked to falsify test 8's
post-un-archive assertions (`isActive` back to `false`, the Resume control
present). Instead it reddened test 7, one step earlier: the same CAS
statement writes `isActive` for *both* directions of the toggle, so archiving
in test 6 already leaves the mutated `isActive: true` in place, and the
archived detail page's Unarchive button is itself gated on
`!template.isActive` — with the mutation that gate is false, so test 7 never
finds the button, and the serial suite stops there without ever reaching
test 8. The mutation is real and the underlying claim ("the sentence and the
screen are pinned together") still holds, but a red that stops early proves
the wrong thing: in a serial spec, choosing a mutation means asking not only
what it would break, but what it would break *first*. M7 below was chosen to
isolate to test 8 specifically, and did.

Restored, re-warmed, re-ran: 8/8 passed, `git diff --stat` showed only the
spec file after the restore.

### M7 — isolating the un-archive-only assertion (added in the review fix pass)

Mutation: `src/services/studio-class-template-lifecycle.ts:1230`, dropped
`archivedAt: null` from the un-archive-only spread, leaving
`...(archiving ? {} : { withdrawnCount: null })`.

Result: **RED on test 8 and nothing earlier — exactly as predicted**, unlike
M6.

```
Running 8 tests using 1 worker

[1/8] … creates a template through settings and fills the window
[2/8] … the four generated classes are on the schedule, and refuse removal
[3/8] … pausing says what stays scheduled, and reveals Archive
[4/8] … the paused row keeps its name on the list
[5/8] … resuming reports the window it already has
[6/8] … archiving withdraws the window and says how much
[7/8] … an archived template leaves the live list for the archived one
[8/8] … un-archiving returns the template paused, not active
  1) [chromium] › tests/e2e/studio.spec.ts:209:7 › Studio class templates › un-archiving returns the template paused, not active

    Error: expect(received).toBeNull()

    Received: 2026-08-22T22:00:10.283Z

      224 |     expect(t.isArchived).toBe(false);
      225 |     expect(t.isActive).toBe(false);
    > 226 |     expect(t.archivedAt).toBeNull();
          |                          ^

  1 failed
    [chromium] › tests/e2e/studio.spec.ts:209:7 › … un-archiving returns the template paused, not active
  7 passed (6.5s)
```

Tests 1–7 pass; test 8 fails on exactly the one assertion the mutation
touches — the proof M6 could not give, that test 8's `archivedAt` check is
load-bearing on its own rather than riding along behind an earlier, coarser
failure.

Restored `archivedAt: null` to the spread, re-warmed, re-ran: 8/8 passed,
`git diff --stat` on the source file empty.

### M8 — the archived list's own filter (added in the review fix pass, round 2)

Mutation: `src/app/(teacher)/settings/studio-classes/archived/page.tsx`,
dropped the `isArchived: true` clause entirely, leaving the `findMany` scoped
only by `teacherId`. Scored against a fixture extended with a second,
never-archived template (`otherTemplateId`, "Yin Retreat") so the archived
list's own filter — not just the live list's — becomes falsifiable.

Result: **RED**, exactly on the new assertion the second-template fixture
exists to prove.

```
Running 8 tests using 1 worker
[1/8] … creates a template through settings and fills the window
[2/8] … the four generated classes are on the schedule, and refuse removal
[3/8] … pausing says what stays scheduled, and reveals Archive
[4/8] … the paused row keeps its name on the list
[5/8] … resuming reports the window it already has
[6/8] … archiving withdraws the window and says how much
[7/8] … an archived template leaves the live list for the archived one
  1) [chromium] › tests/e2e/studio.spec.ts:229:7 › Studio class templates › an archived template leaves the live list for the archived one

    Error: expect(locator).toHaveCount(expected) failed

    Locator:  getByText('Yin Retreat')
    Expected: 0
    Received: 1
    Timeout:  5000ms

      239 |     // ...and the reverse: the second template, never archived, does not
      240 |     // appear here either.
    > 241 |     await expect(page.getByText('Yin Retreat')).toHaveCount(0);
          |                                                 ^

  1 failed
    [chromium] › … an archived template leaves the live list for the archived one
  1 did not run
  6 passed (10.6s)
```

Restored the `isArchived: true` clause, re-warmed, re-ran: 8/8 passed, source
diff clean. Full task re-run after all six mutations: `npx playwright test
studio` — 16 passed (chromium + Mobile Chrome); `npm run typecheck` and
`npm run lint` both exit 0.

## Task 3 — the one-off class arc (issue 283)

### M9 — count moved past cancel

Mutation: moved the COUNT block after the CANCEL block (the count editor is
gated on `cancelledAt === null`, so once cancelled it should no longer
exist). Warmed `/studio-class/new` first.

Result: **RED**, exactly as predicted.

```
Test timeout of 30000ms exceeded.

Error: locator.fill: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByLabel('Student count')

  365 |     // COUNT — before cancelling: the editor lives in the `cancelledAt === null`
  366 |     // branch and is gone from the cancelled page entirely.
> 367 |     await page.getByLabel('Student count').fill('11');
      |                                            ^
  368 |     await page.getByRole('button', { name: 'Save', exact: true }).click();
  369 |     await expect(page.getByText('Saved')).toBeVisible();
  370 |     await expect
    at /Users/ivohofland/Projects/fair.yoga/tests/e2e/studio.spec.ts:367:44
```

Restored, re-ran full spec: 9/9 passed.

### M10 — the DELETE handler emptied of its own delete

Mutation: `src/app/api/studio-classes/[id]/route.ts`, removed the body of
the `DELETE` handler's `prisma.studioClass.delete({ where: { id } })` call,
leaving the `try`/`catch` scaffolding so the handler still returns
`respondOk({ deleted: true })`. Warmed `GET /api/studio-classes/warmup-id`
first to force a recompile.

Result: **RED**, exactly as predicted — the UI navigated (button click,
confirm, hard navigation to `/` all succeeded) but the row survived.

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 0
Received: 1

  383 |     // `delete-studio-class-button.tsx:76-90`.
  384 |     await page.waitForURL('http://localhost:3000/', { timeout: 10_000 });
> 385 |     expect(await prisma.studioClass.count({ where: { id: created.id } })).toBe(0);
      |                                                                           ^
  386 |   });
  387 | });
```

Restored the route file (`git diff` on it empty afterward); confirmed no
orphaned row was left behind (`afterAll` ran and cleaned it up even though
the test failed). Re-ran full spec: 9/9 passed.

Full task re-run after both mutations: `npx playwright test studio
--project=chromium` — 9/9 passed (also re-run 25× back-to-back for a
separate flake check, 0 failures); both projects — 18/18 passed;
`npm run typecheck` and `npm run lint` clean.

## Task 4 — a seventh visual screen (issue 283)

### M11 — the `DATE_SMELL` fix, mutation-tested (added in the follow-up review fix)

**M11 exists because a fix introduced its own risk, not because the feature
code changed.** The new visual test's baseline page has a native
`dayOfWeek` `<select>` whose seven `<option>` labels tripped
`freezeDates`'s own `DATE_SMELL` check — Chromium's `Element.innerText`
includes every `<option>`'s text regardless of CSS `display`, even though a
closed `<select>` only ever rasterizes its one selected option into a
screenshot. The first fix stripped weekday/month words out of the checked
text by string content. That approach was rejected before it shipped: it
would also have deleted matching words anywhere else on the page, silently
hiding one specific class of real leak — a bare weekday like
"Today is Wednesday", which `DATE_PATTERN` is too strict to freeze but
`DATE_SMELL` is loose enough to catch on its own. The replacement instead
scopes by DOM position: hide every `<select>` element (not its `<option>`s)
before reading `innerText`, then restore it. M11 is the mutation test that
proves the replacement actually closes the hole the string-based approach
would have left open, rather than merely arguing it does: inject a bare
weekday *outside* the `<select>`, and confirm `DATE_SMELL` still fails on
it. Worth recording alongside it, because it is what killed an intermediate
proposal (reading a detached `body.cloneNode(true)` instead of the live DOM):
measured on `/login`, a detached clone's `innerText` came back **12283**
characters against **194** live — the clone has no layout box, so `innerText`
degrades toward `textContent` and surfaces the unrendered Next.js RSC script
payload (`self.__next_f.push(...)`) sitting in `<script>` tags on the page.

Mutation, added immediately after `await hydrated;` and before
`freezeDates(page)`:

```ts
await page.evaluate(() => {
  const p = document.createElement('p');
  p.textContent = 'Wednesday';
  document.body.appendChild(p);
});
```

Ran `npx playwright test visual --grep "studio template" --project=chromium`
(existing baseline, no `--update-snapshots`).

Result: **RED** — the guard caught the injected leak, which is the pass
condition for a mutation test on a guard.

```
Error: expect(received).not.toMatch(expected)

Expected pattern: not /\b(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|January|February|March|April|June|July|August|September|October|November|December)\b|.../
Received string:      "Studio classes
Visual Community Studio
Class type
Location
Day
Start time
Duration (minutes)
Hourly rate
Save
Resume studio class
Archive studio class

Wednesday"
    at freezeDates (tests/e2e/visual.spec.ts:178:58)
```

**On the fidelity of this capture:** the `Expected pattern:` line above is
copied exactly as Task 4's own report recorded it, elision included — the
regex is cut mid-alternation with a literal `|...` rather than reproduced to
its closing `/`. That line is *not* byte-verbatim console text; it is
presented here as recorded, not as a claim that it is complete. The match
location (`freezeDates (tests/e2e/visual.spec.ts:178:58)`) and the
`Received string:` block above it are exact. The full `DATE_SMELL` pattern
lives in `tests/e2e/visual.spec.ts` itself and is not reproduced in this
ledger.

"Day" is immediately followed by "Start time" in the received string — the
`<select>`'s own weekday options contribute nothing to the check — and the
only "Wednesday" present is the injected, unscoped one, which is exactly
what the fix is supposed to catch.

Removed the mutation; re-ran the same command: 2 passed, green, against the
unchanged existing baseline (also confirms the hydration/readiness additions
made alongside this fix did not alter the captured screenshot). Full task
re-run: `npx playwright test visual` — 14 passed (7 screens × 2 projects);
`npm run typecheck` clean; `npx eslint tests/e2e/visual.spec.ts` clean;
`git status --short tests/e2e/visual.spec.ts-snapshots/` empty — no baseline
moved.

## Review fix wave — whole-branch review findings I3/I4 (issue 283, 2026-08-23)

Two more mutations, added while addressing the whole-branch review's
Important findings I3 and I4. Scored the same way as Tasks 1-4: mutate, warm,
run, capture the verbatim failure, restore, re-verify green.

### M12 — `resolveStudioConfirmation`'s `active` arm, proving the resolver routes real counts to the screen

`template-action-messages.test.ts` already pins the sentence strings
`resolveStudioConfirmation` produces, but nothing had proved the resolver's
`active` arm carries the PATCH response's own `added`/`scheduled` values
through to the screen, rather than merely being reachable. Mutation: in
`resolveStudioConfirmation`'s `active` case
(`src/components/settings/template-action-messages.ts`), changed
`resumeStudioMessage(data.added, data.scheduled, data.counts)` to
`resumeStudioMessage(data.scheduled, data.scheduled, data.counts)`. Warmed
`GET /settings/studio-classes/warm-id` (307), then ran
`npx playwright test studio --project=chromium` (9 e2e cases).

Result: **RED on test 5 and nothing earlier — exactly as predicted.**

```
Running 9 tests using 1 worker

[1/9] … creates a template through settings and fills the window
[2/9] … the four generated classes are on the schedule, and refuse removal
[3/9] … pausing says what stays scheduled, and reveals Archive
[4/9] … the paused row keeps its name on the list
[5/9] … resuming reports the window it already has
  1) [chromium] › tests/e2e/studio.spec.ts:194:7 › Studio class templates › resuming reports the window it already has

    Error: expect(locator).toBeVisible() failed

    Locator: getByText('4 classes on your schedule. Nothing needed adding.')
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found

      200 |     // what `template-action-messages.ts` asks a test to drive, because equal
      201 |     // arguments cannot detect a transposition.
    > 202 |     await expect(page.getByText('4 classes on your schedule. Nothing needed adding.')).toBeVisible();
          |                                                                                        ^
      203 |
      204 |     // Active again, so Archive is gated off again.
      205 |     await expect(page.getByRole('button', { name: 'Pause studio class' })).toBeVisible();
        at /Users/ivohofland/Projects/fair.yoga/tests/e2e/studio.spec.ts:202:88

[6/9] … archiving withdraws the window and says how much
[7/9] … an archived template leaves the live list for the archived one
[8/9] … un-archiving returns the template paused, not active
[9/9] … log, count, cancel, remove
  1 failed
    [chromium] › tests/e2e/studio.spec.ts:194:7 › Studio class templates › resuming reports the window it already has
  3 did not run
  5 passed (12.3s)
```

Restored `resumeStudioMessage(data.added, data.scheduled, data.counts)`;
`git diff --stat` on the source file empty. Re-warmed, re-ran: 9/9 passed.

The capture above is verbatim and was taken at `0329cab`. `354c131` later
added comment lines above this test, so the `studio.spec.ts:194` in the
capture is `:201` at branch head — re-derive with
`grep -n "resuming reports the window it already has" tests/e2e/studio.spec.ts`.
The mutation was re-run against branch head during review and reddened the
same test and no other.

### M13 — the studio template detail header, reverted to the location-only expression it used to have

Issue #281 fixed the three list sections; the detail page's own
`<PageHeader>` still titled itself with `template.location` alone
(`settings/studio-classes/[id]/page.tsx`), so a teacher who tapped a row
titled by class type could land on a header naming something else entirely.
The fix titles the header with the same expression the list uses
(`template.classType || template.location`), and `studio.spec.ts` gained an
assertion at the archived-list-to-detail hop (`getByRole('heading', { name:
'Studio Flow' })`) to pin it. Mutation: reverted the header back to
`title={template.location}`. Warmed `GET /settings/studio-classes/warm-id`
(307), then ran `npx playwright test studio --project=chromium`.

Result: **RED on test 7 and nothing earlier — exactly as predicted**, the one
test that makes the archived-list-to-detail hop.

```
Running 9 tests using 1 worker

[1/9] … creates a template through settings and fills the window
[2/9] … the four generated classes are on the schedule, and refuse removal
[3/9] … pausing says what stays scheduled, and reveals Archive
[4/9] … the paused row keeps its name on the list
[5/9] … resuming reports the window it already has
[6/9] … archiving withdraws the window and says how much
[7/9] … an archived template leaves the live list for the archived one
  1) [chromium] › tests/e2e/studio.spec.ts:231:7 › Studio class templates › an archived template leaves the live list for the archived one

    Error: expect(locator).toBeVisible() failed

    Locator: getByRole('heading', { name: 'Studio Flow' })
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found

      249 |     // (`studio-template-list.tsx:30,52,76`), so the two screens can't
      250 |     // disagree.
    > 251 |     await expect(page.getByRole('heading', { name: 'Studio Flow' })).toBeVisible();
          |                                                                      ^
      252 |
      253 |     // Archived: Toggle is gated off by `!isArchived`, and Archive renders in
      254 |     // its un-archive direction. Exactly one control, and no dead end.
        at /Users/ivohofland/Projects/fair.yoga/tests/e2e/studio.spec.ts:251:70

[8/9] … un-archiving returns the template paused, not active
[9/9] … log, count, cancel, remove
  1 failed
    [chromium] › tests/e2e/studio.spec.ts:231:7 › Studio class templates › an archived template leaves the live list for the archived one
  1 did not run
  7 passed (13.4s)
```

Restored `title={template.classType || template.location}`; `git diff --stat`
on the source file empty. Re-warmed, re-ran: 9/9 passed.

Same provenance as M12: captured at `0329cab`, so the capture's
`studio.spec.ts:231` is `:238` at branch head — re-derive with
`grep -n "an archived template leaves the live list" tests/e2e/studio.spec.ts`.
Re-run against branch head during review, same locus.

**Collateral this fix has on `visual.spec.ts`, recorded rather than acted
on.** The `studio template detail (paused)` baseline's fixture uses distinct
`classType` ('Visual Studio Flow') and `location` ('Visual Community Studio')
values, so the corrected header renders different text than the frozen
baseline expects — `npx playwright test visual --grep "studio template"`
fails on a 654-pixel screenshot diff, not on `DATE_SMELL`.

That diff was the mutation's collateral, not a defect: the header fix it
targets is the intended rendering, so the baseline captured before it was the
stale one. Both `studio-template-*.png` baselines were regenerated in
`d436dd8` once the mutation was reverted, which is why the diff no longer
reproduces.
