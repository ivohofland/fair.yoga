# #309 — one refusal voice across the studio class family: punctuated sentences

**Date:** 2026-08-24 · **Issue:** #309 · **Bundle:** 7 (the studio class family) ·
**Prior art:** `2026-08-23-studio-class-type-validation-design.md` (#282, which added two of
the banner sites); `studio-class-edit-form.tsx`'s `validate()` docblock (#197/#276,
the per-field prose standard)

**Revised 2026-08-24 after PR #316 review.** The first draft of this spec chose a
different option on a premise the review falsified; §1.3 and §2 record what was
measured the second time. The superseded reasoning is in the PR #316 thread.

## 1. What was measured

Census re-taken 2026-08-24 against `0a33e71`, by the §6 commands plus a mechanism read
of each hit's file. No e2e or integration file references any of this copy — they assert
the field *label* `'Class type'`, which every candidate string satisfies.

### The studio family, and the class-family form that is not in it

| Site | Field refusals | Mechanism | Family |
|---|---|---|---|
| `src/app/(teacher)/studio-class/new/page.tsx:93,97,101` | 3 | banner, sequential first-missing | studio |
| `src/components/settings/studio-template-form.tsx:102,106` | 2 | banner, sequential first-missing | studio |
| `src/components/studio-class/studio-class-edit-form.tsx:104-118` | 6 | per-field errors map, all-at-once | studio |
| `src/components/settings/template-form.tsx:244-272` | 5 | banner, sequential first-missing | class |

Before this branch every one of the four was internally uniform: the three studio banner
forms and `template-form.tsx` entirely bare, the edit form entirely punctuated. The only
divergence was *between* the studio banner forms and the studio edit form.

### Corrections the census adds to the issue

1. **A fifth writing surface exists outside the issue's boundary:**
   `(teacher)/class/new/page.tsx:245` writes `'Enter a class type'` per-field,
   unpunctuated, untested. Class family; stays out of scope.
2. **The issue's prose says "three forms"; its table lists four.** The three *studio*
   surfaces are new-page, studio-template-form, edit form. The fourth,
   `template-form.tsx`, is the recurring-template twin from the **class** family. The
   first draft judged it un-leavable because the two settings template forms share a
   directory; that is a code-reading adjacency, not a user-visible one — the two render
   on different screens and never co-appear. It is out of scope, and left untouched.
3. **There is no single "the simultaneous surface".** The first draft chose its direction
   on the claim that the edit form is the only place a teacher sees two messages side by
   side. Three forms render an all-at-once errors map (§6 command 3), and the other two
   are entirely bare:

   | All-at-once surface | Field messages | Punctuated |
   |---|---|---|
   | `studio-class/studio-class-edit-form.tsx` | 6 | all |
   | `students/create-student-form.tsx:57-61` | 3 | none |
   | `(teacher)/class/new/page.tsx:244-248` | 10 (5 per step) | none |

   So the app-wide simultaneous-render vote runs **against** punctuation, not for it. The
   direction below is therefore argued per family, which is the only scope #309 asks about.
4. **Sequential is not invisible.** The first draft held that mixed punctuation inside a
   banner form is "code-level only" because one message shows at a time. A teacher
   submitting an empty `/studio-class/new` reads all three refusals in the same element,
   seconds apart. Intra-form consistency is user-visible on this axis; only
   *simultaneity* is not.

## 2. Decision — punctuate the studio family entire, leave the class family alone

Every field refusal in the three studio forms is a punctuated sentence; every field
refusal in `template-form.tsx` stays bare. Both families end internally uniform, and the
studio family additionally ends uniform across its three forms — the divergence #309 was
filed about.

Chosen over:

- **Punctuate only the `classType` line in each form** (the first draft's option B): buys
  cross-form agreement on one string by making three previously-uniform forms mixed.
  Given correction 4 that cost is user-visible, and it is the same defect class the issue
  complains about, relocated.
- **Drop the period from the edit form** (2 line-edits): cheapest, and matches the
  app-wide majority — but it moves the studio family away from the one form whose copy is
  pinned and whose voice #197/#276 set deliberately, and it would put a bare fragment
  beside five punctuated siblings inside a genuinely simultaneous render.
- **Re-punctuate every validation string in all five forms:** correct app-wide, but it
  rewrites the class-creation wizard and the CRM form on the back of a one-character
  issue. Recorded as a house-copy question, not answered here (§5).
- **Let it go:** the words already match — but the issue was filed deliberately, and the
  cost here is five source lines.

## 3. Changes

Copy-only, studio family only. Five source literals, two of which already read as
sentences and are untouched:

1. `src/app/(teacher)/studio-class/new/page.tsx:93,97,101` → `'Class type is required.'`,
   `'Location is required.'`, `'Date is required.'`
2. `src/components/settings/studio-template-form.tsx:102,106` →
   `'Class type is required.'`, `'Location is required.'`
3. `src/components/studio-class/studio-class-edit-form.tsx` — untouched, already the
   reference voice.
4. `src/components/settings/template-form.tsx` — untouched. Byte-identical to `main`.

Test changes: the four `classType` assertions take the period; two new tests pin the
`location` and `date` refusals that had no pin in either form; two non-falsifiable
assertions are removed (§4.3). No schema, service, API route, or migration change;
nothing server-side reads these strings. The #282 docblocks in both test files describe
mechanism and rationale without quoting the literal, so they stand as written.

## 4. Coverage

No new guard is introduced — this branch renames pinned copy, and the guards themselves
were mutation-proven in their own rounds (#282: guard-deleted and return-dropped mutants;
#276/#282: trim-dropped mutant). What must hold after the edit:

1. Every copy pin returned by §6 command 2 goes green together.
2. **Bite-proof, run per new string.** The `location` and `date` refusals were previously
   unpinned, so their tests were written first and observed red against the bare literals
   (`Unable to find … "Location is required."` / `"Date is required."`) before the sources
   were punctuated. The `classType` pins were re-proven the same way in
   `studio-template-form.tsx`. Every red named copy drift with `fetchMock` still uncalled,
   i.e. the guard was intact and only the string had moved.
3. **Two assertions were removed because they could not fail.** The second `classType`
   copy assertion in each banner test sat after a second submit, and `handleSubmit` clears
   `error` only *after* its guards pass — so the banner from the first submit was still
   mounted and satisfied it on stale state. Deleting the intervening click left both files
   green. The request-count assertion on that second submit is the real pin for the
   whitespace boundary and stays. Making the banner clear on edit (as the edit form does,
   `studio-class-edit-form.test.tsx:177`) would make a copy assertion there meaningful;
   that is a behaviour change, and is filed rather than done here.
4. Component tests hit no dev server, so warm-route discipline does not apply to them;
   `npm run verify` afterwards runs the integration project and needs the app on :3000.

## 5. What this does not do

- **`(teacher)/class/new/page.tsx` and `students/create-student-form.tsx` are unaffected**
  — class family and CRM respectively. Whether the app should punctuate validation copy
  everywhere is a house-copy question #309 does not ask; §1 correction 3 is the census a
  future round would start from.
- **`template-form.tsx` is unaffected** — class family, and its five refusals stay
  uniformly bare.
- **Mechanism unification stays off the table** — sequential banners and the all-at-once
  map are each deliberate (#282 §2, #197/#276).
- **Server-side Zod copy is unaffected** — `min(1)` + `parseBody` developer strings were
  settled by #282 for non-UI clients.
- **Pin gaps recorded, not filled here.** `template-form.tsx:248`'s banner is not merely
  copy-unpinned: deleting the whole guard leaves that file green, so nothing observes it.
  The wizard's ten `validateStep` messages have no pin at all. Both are outside this
  diff — this branch touches neither file — and are filed at fold time.
- **The edit form's empty-`''` case stays unpinned, deliberately.** `''.trim()` and
  `'   '.trim()` take the identical branch, so an empty-string test catches no mutant the
  existing whitespace one misses, while the whitespace one catches the trim-dropped mutant
  that empty-string cannot. Closing as WONTFIX beats filing it.

## 6. Re-derivables

1. Family tether — no bare field refusal left in the three studio forms:
   `rg -n "setError\('[A-Z][^']*[^.]'\)|errors\.[a-zA-Z]+ = '[A-Z][^']*[^.]'" src/app/\(teacher\)/studio-class/new/page.tsx src/components/settings/studio-template-form.tsx src/components/studio-class/studio-class-edit-form.tsx`
   → no hits.
2. Copy pins for the studio `classType` string:
   `rg -n 'Class type is required' src/` → 7 lines (3 sources, 4 assertions), every one
   ending in a period. The narrower pattern is canonical; adding `|Enter a class type`
   returns 8 by pulling in the out-of-scope wizard (§5).
3. All-at-once surfaces, the census behind §1 correction 3:
   `rg -ln "error=\{(errors|fieldErrors|errs)\." src/` → 3 files.
4. `template-form.tsx` unchanged: `git diff main -- src/components/settings/template-form.tsx`
   → empty.
5. #282's spec §6 census of bare client refusals moves 18 → 13 under this branch, not to
   zero: `git grep -c "is required'" main -- src/app src/components | grep -v test` versus
   the same grep on this branch.
