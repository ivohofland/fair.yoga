# The studio family, driven end to end

**Issue:** #283 (parent #274). Folds in #281 entirely.
**Date:** 2026-08-22
**Status:** design agreed, awaiting review

---

## 1. What the issue said, and what is actually true

#283 was filed 2026-08-20. Two of its claims are wrong, one of them was already
wrong on the day it was written, and the third became wrong two days later. The
conclusion survives all three — an e2e spec is still the right build — but the
*reason* does not, and the reason is what decides how much else to build.

### Holds, re-measured against `f9c9e69`

| Claim | Verified |
|---|---|
| `grep -ril studio tests/e2e/` matches nine spec files | ✅ exactly 9 |
| Every match is a room venue name | ✅ eight are `venueName:` fixture fields; the ninth (`teacher-journey.spec.ts:186`) types `'Main Studio'` into a `Room name` field |
| No spec visits any studio route | ✅ `grep -rn "studio-class" tests/e2e/` returns nothing |
| `visual.spec.ts` has six screens, none of them studio | ✅ login, public-page, schedule, class-detail-open, inbox, settings |
| The class family has `recurring.spec.ts` and `class-edit.spec.ts` | ✅ |

### Correction 1 — `vitest.config.ts` reaches `src/app/**`, and did before the issue was filed

The issue states:

> That gating logic lives in server components, which `vitest.config.ts` cannot
> reach — its projects are scoped to `src/**/*.test.ts` and
> `src/components/**/*.test.tsx`, so nothing matches `src/app/**`.

The `components` project's glob is
`['src/components/**/*.test.tsx', 'src/app/**/*.test.tsx']`. The second entry
was added by commit `8f7f8f9` (#136) — before #283 existed. Three page tests
live under `src/app/` today, and one of them,
`src/app/(teacher)/settings/rooms/[id]/page.test.tsx`, renders an **async server
component** in jsdom via `render(await Page({ params }))` with `prisma`,
`requireTeacherSession` and `next/navigation` mocked, for the express purpose of
asserting which control is drawn.

The issue is also internally inconsistent: it lists `studio-class/new/page`
among the existing component tests, and that file is `src/app/(teacher)/studio-class/new/page.test.tsx`.

### Correction 2 — one of the six screens acquired wiring coverage after the issue was filed

The issue states that what has nothing at any level is the wiring — "whether the
buttons appear in the states the pages gate them on … whether the confirmation
sentences the two resolvers produce actually reach the screen."

`tests/integration/studio-class-page.test.ts` (added by commit `bccfb1d`, #279,
two days after this issue) does both for `/(teacher)/studio-class/[id]`: it
fetches the page as a signed-in teacher, asserts `200`, and reads the returned
HTML for which button is drawn in each state and whether the cost claim reaches
the screen.

### The measured baseline

Studio coverage at the merge base (`f9c9e69`) — **174 tests across 12
files, none of them e2e**:

```
unit          3 files   79 tests   lifecycle 41, generator 27, deletion 11
components    7 files   39 tests   form 10, delete-btn 6, toggle 6, archive 6,
                                   student-count 4, new/page 4, cancel 3
integration   2 files   56 tests   studio-api 50, studio-class-page 6
e2e           0 files    0 tests
              ────────────────────
             12 files  174 tests   79 + 39 + 56 = 174
```

Re-derive with:

```bash
for f in $(find src tests \( -name '*.test.ts' -o -name '*.test.tsx' \) | grep -i studio); do
  n=$(npx vitest run "$f" 2>&1 | grep -E "Tests\s+[0-9]+ passed" | tail -1)
  printf '%-70s %s\n' "$f" "$n"
done
```

Path-based, directories included, and counted by vitest rather than by
`grep -cE '^\s*(it|test)\('` — a line-count grep is blind to loop-generated
tests, undercounting `studio-template-list.test.tsx` (7 tests, added later on
this branch by issue 281's fix) as 3. The old `find -iname '*studio*test*'`
matched basenames only, so it silently dropped
`src/app/(teacher)/studio-class/new/page.test.tsx` and
`src/components/studio-class/student-count-editor.test.tsx` — both counted in
the table above — and reproduced neither 12 (10 at this merge base, 11 once
`studio-template-list.test.tsx` existed).

Verified against the table: `git diff --stat f9c9e69..HEAD -- src tests`
touches none of these 12 files (its only studio-related additions are
`studio-template-list.test.tsx` and `tests/e2e/studio.spec.ts`), so counting
them at the branch tip stands in for counting at the merge base. Per-file
vitest counts reconcile exactly: unit 41 + 27 + 11 = 79; components
10 + 6 + 6 + 6 + 4 + 4 + 3 = 39; integration 50 + 6 = 56; 79 + 39 + 56 = 174.
The 12/174 figures were already correct — the defect was only in the command
offered to reproduce them.

So the uncovered surface is **four screens, not six**:
`/settings/studio-classes`, `/settings/studio-classes/[id]`,
`/settings/studio-classes/archived`, `/settings/studio-classes/new`.

---

## 2. Why e2e anyway, given two cheaper techniques exist

Three techniques can reach a page in this repo:

| | Browser | Server | Database | In `npm run verify` | Can drive a flow |
|---|---|---|---|---|---|
| jsdom page test (`src/app/**/*.test.tsx`) | no | no | mocked | yes | no |
| HTTP page test (`tests/integration/**`) | no | yes | yes | yes | no |
| Playwright (`tests/e2e/**`) | yes | yes | yes | **no** (`verify` is `typecheck && lint && vitest`) | yes |

`/settings/studio-classes/[id]` gates its two controls on server-rendered props:

```tsx
{!template.isArchived && <ToggleStudioTemplateButton … />}
{!template.isActive   && <ArchiveStudioTemplateButton … />}
```

Both buttons call `router.refresh()` after a successful `PATCH`, which is what
makes the server re-render and hand down new props. A jsdom test mocks the
database, so it can assert either state but never the **transition**; an HTTP
page test does one fetch and stops. Only a browser observes that the refresh
actually re-gated the controls — and a stale-server-snapshot defect there is
invisible to every other level in this repo.

**The four settings screens are reached by necessity, not by addition.**
`/settings/studio-classes` queries `isArchived: false`, so once a template is
archived its detail page has exactly one door: `/settings/studio-classes/archived`.
An arc that ends in un-archive must walk through the archived list to get there.
No separate jsdom tests for those screens are therefore proposed — the flow
visits all four.

---

## 3. Two composition facts the arc exists to pin

Both were discovered while designing this spec and neither is asserted anywhere
today.

**Archiving requires a paused template.** `ArchiveStudioTemplateButton` renders
only when `!isActive`, so an active template offers Pause and nothing else. The
arc must therefore pause **twice**: once to observe the Archive control appear,
and again after the resume step, to reach the archive. That is the composition,
and the spec states it rather than working around it.

**Un-archiving forces `isActive: false`.**
`studio-class-template-lifecycle.ts:1226` writes `isActive: false` on both
archive directions. So an archived template always satisfies `!isActive` and
always offers Unarchive — there is no dead-end state where both controls are
hidden. After un-archiving, the template is *paused*, not active, which is
precisely what `UNARCHIVE_STUDIO_MESSAGE` exists to tell the teacher. Nothing
currently proves the screen agrees with the sentence.

---

## 4. What gets built

### 4.1 `tests/e2e/studio.spec.ts` — new

One file, two `describe` blocks, `mode: 'serial'`, **two teacher fixtures** —
one per `describe`, since Playwright runs `beforeAll`/`afterAll` per describe
and sharing a teacher would tie the second block's setup to the first
block's teardown having already run — modelled on `recurring.spec.ts`.

**Fixture.** Each describe seeds its own `Teacher` + `Account` + `Session`
through Prisma (`seedSession`, `sessionCookie`, `accountIdOfTeacher` from the
existing helpers), with a `uniqueSuffix()`. **No `Room` or `TeacherRoom`** —
the studio family is disconnected from `Room` by design (`CLAUDE.md`, Data
Model), which is the one structural way this fixture is *simpler* than
`recurring.spec.ts`'s. The template describe's teacher also owns a second
template ("Yin Retreat", seeded directly through Prisma rather than the form,
`isActive: false`) so the archived-list arc has a live template to prove the
archived filter excludes, and a never-archived one to prove the live filter
excludes it back.

**Day-of-week choice.** Three days from the run day, exactly as
`recurring.spec.ts` does and for the same reason: `generateStudioInstancesForTemplate`
filters candidates on `classStartInstant(date, startTime, tz) > startDate`
(`studio-class-generator.ts:138-143`), so today's occurrence is skipped once its
start time has passed. A fixed weekday makes the counts time-of-day-dependent on
one day in seven.

#### `describe('Studio class templates')`

| # | Step | Asserted |
|---|---|---|
| 1 | Create through `/settings/studio-classes/new` | redirect to `/settings/studio-classes`; the list shows the **class type**; `prisma.studioClass.count({ where: { templateId } })` is 4 (creation itself fills the window — the POST calls `generateStudioInstancesForTemplate`, `api/studio-class-templates/route.ts:111`) |
| 2 | The generated classes are on the schedule | `/` shows studio cards carrying the class type and the `· Studio class` suffix `StudioClassCard` appends (`class-list.tsx:140`) |
| 3 | A generated class refuses removal | opening one of them from the schedule offers **no** Remove control (`deletable` is false for a generated class dated today or later). Placed here deliberately — see §6, task order |
| 4 | Pause | control reads `Pause studio class`; the confirmation is `pauseMessage`'s sentence; after `router.refresh()` the control reads `Resume studio class` **and** `Archive studio class` has appeared |
| 5 | The list still names it | back on `/settings/studio-classes`, the row still shows the class type and still shows the location in its caption — **#281's assertion; red against today's code** |
| 6 | Resume | confirmation is `4 classes on your schedule. Nothing needed adding.` (`buildResumeSentence` with `added: 0, scheduled: 4`, all `SkipCounts` zero — pause deletes nothing, so the window is already full); `Archive studio class` is gone again |
| 7 | Pause again, then archive | confirmation is `archiveStudioMessage(4, 0)`; `prisma.studioClass.count` for the template is 0 |
| 8 | The archived template moved lists | absent from `/settings/studio-classes`, present on `/settings/studio-classes/archived`; its detail page offers **only** `Unarchive studio class` |
| 9 | Unarchive | confirmation is `UNARCHIVE_STUDIO_MESSAGE`; the template is back on the live list marked `paused`, and its page offers **both** `Resume studio class` and `Archive studio class` — the screen agreeing with the sentence |

#### `describe('One-off studio classes')`

`createStudioClassSchema.date` is `isoDate` with **no lower bound**
(`schemas.ts:467-474`), so a past-dated one-off is creatable through the form —
no Prisma seeding needed for this arc.

| # | Step | Asserted |
|---|---|---|
| 1 | `/` → `Log a studio class` → fill six fields with a **past** date → `Log class` | the browser lands on `/studio-class/{id}` and the row exists. The submit handler pushes there itself; the `Created` notice is the fallback for a push that does not commit, so asserting the notice and clicking its button races the navigation |
| 2 | Set a student count | `Saved` appears beside the field |
| 3 | Cancel | the page reads `This class was cancelled.` |
| 4 | Remove | the Remove control is offered (past + manual ⇒ `deletable`), and after confirming, `/studio-class/{id}` no longer resolves and the class is gone from Prisma |

**Load-bearing order:** `StudentCountEditor` renders only in the
`cancelledAt === null` branch (`studio-class/[id]/page.tsx:102`'s ternary, editor at `:120`). Cancel
before setting the count and the editor is not on the page. Set count → cancel →
remove, in that order.

### 4.2 `visual.spec.ts` — a seventh screen

`studio template detail (paused)` — `/settings/studio-classes/[id]` on a paused
template, the only state showing both controls at once, and the first settings
*detail* page in the baseline set.

Fixture: a `StudioClassTemplate` seeded directly through Prisma with
`isActive: false`. Paused means the sweep generates nothing, so **no `StudioClass`
row appears and `schedule.png` is unaffected** — an important property, because
a regenerated baseline that a reviewer cannot read is a cost this screen should
not impose. The existing fixture's `Class` sits at Tuesday 09:00; a
`StudioClassTemplate` cannot collide with a `Class` under #296's guards (those
pair template-with-template and class-with-class), but the fixture should pick a
different `(dayOfWeek, startTime)` regardless. `afterAll` must delete it.

Two new baselines: `studio-template-chromium-darwin.png` and
`studio-template-Mobile-Chrome-darwin.png`. Note that `visual.spec.ts`
`test.skip`s itself in CI where no `-linux` baselines exist, so this — like the
existing six — is local-only coverage.

### 4.3 #281, folded whole

`src/components/settings/studio-template-list.tsx` renders three sections from
one array with two different spellings:

| section | title | caption line 2 |
|---|---|---|
| active (title `:30`, caption `:35`) | `{t.classType \|\| t.location}` | `{t.location} · €{rate}/hr` |
| paused (title `:52`, caption `:57`) | `{t.location}` | `€{rate}/hr` |
| archived (title `:76`, caption `:81`) | `{t.location}` | `€{rate}/hr` |

Both divergences are fixed — all three sections to one title expression and one
caption expression — and the component gains
`studio-template-list.test.tsx`, rendering a template with a `classType` in each
of the three states and asserting the same title and the same caption fields in
each. That is the whole of #281's acceptance, so #281 is finished by this
branch.

**Why the fix cannot be title-only.** The e2e assertion in §4.1 step 5 catches
the title. Nothing in a browser distinguishes "the location is missing from
caption line 2" from a deliberate layout choice, so the caption divergence needs
the component test, not the spec. Fixing one and not the other would leave the
issue half-done in a file this branch had just edited.

---

## 5. What this does not do

- **#284 is unaffected.** Studio generation is still not week-keyed; a template
  moved Tuesday→Thursday still generates four Thursdays beside four standing
  Tuesdays. The arc never moves a template's day, so it neither exercises nor
  masks that.
- **#275, #276, #277, #278, #280, #282 are unaffected.** Each is a behavioural
  defect with its own acceptance; none is a coverage gap this spec fills.
  #282's raw-Zod-string message in particular is a *failure* path, and this arc
  drives only success paths.
- **No jsdom page tests are added** for the four settings screens, for the
  reason in §2 — the arc walks all four, and a mocked snapshot of a screen the
  arc already drives is duplication, not depth.
- **The `describe` blocks do not exercise the cross-family slot guard (#296).**
  The fixture teacher owns no `Class` and no `ClassTemplate`, so
  `blocked_by_other_family` is unreachable here. `tests/integration/studio-api.test.ts`
  covers the route side.
- **Nothing is added to `npm run verify`'s e2e reach.** `verify` remains
  `typecheck && lint && vitest`; `tests/e2e/studio.spec.ts` runs only under
  `npm run test:e2e` and in CI. The one part of this branch that *does* run in
  `verify` is `studio-template-list.test.tsx`.

---

## 6. Task order, and which parts of it are load-bearing

1. **#281's source fix and component test first.** The e2e step 5 assertion is
   red until the fix lands, and a branch whose new spec is red at its own first
   commit cannot tell a real failure from an expected one.
2. **The generated-class removal assertion (§4.1 step 3) must precede the
   archive (step 7).** Archiving deletes all four generated classes, so after
   step 7 there is no generated class left to assert about. This is ordering,
   not preference.
3. **Set count → cancel → remove** in the one-off arc, per §4.1.
4. **The visual screen last.** Baselines are generated artifacts; regenerating
   them before the fixture is settled wastes a round.

---

## 7. Acceptance

- `npx playwright test studio` green, both projects.
- `npm run verify` green, with `studio-template-list.test.tsx` in the count.
- Each of the four previously-uncovered settings screens is visited by at least
  one assertion in `studio.spec.ts`.
- Each of the four resolver sentences — pause, resume, archive, un-archive —
  is asserted as it appears on screen, not as the resolver returns it.
- Every guard added is proved by mutation: the mutation, the exact error text it
  produces, and the restore, recorded per guard in the plan.
- The PR body carries the measured before/after test counts with arithmetic that
  reconciles, names the corrections in §1, and states which suites ran.
