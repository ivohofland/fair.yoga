# #309 — one classType refusal string across the studio class family: `Class type is required.`

**Date:** 2026-08-24 · **Issue:** #309 · **Bundle:** 7 (the studio class family) ·
**Prior art:** `2026-08-23-studio-class-type-validation-design.md` (#282, which added two of
the three banner sites); `studio-class-edit-form.tsx`'s `validate()` docblock (#197/#276,
the per-field prose standard)

## 1. What was measured (and where the issue needed correction)

Census taken 2026-08-24 against `0a33e71`, by
`rg -n "Class type is required|Enter a class type" src/ tests/` plus a mechanism read of
each hit's file. Every occurrence of the copy lives in these nine lines; no e2e or
integration file references any of it.

### The four in-scope sites

| Site | Copy today | Mechanism | Pinned by |
|---|---|---|---|
| `src/components/settings/template-form.tsx:248` | `Class type is required` | banner, sequential first-missing | fetch-count only (`template-form.test.tsx:220`) — **no copy pin** |
| `src/app/(teacher)/studio-class/new/page.tsx:93` | `Class type is required` | banner, sequential first-missing | copy at `page.test.tsx:149,155` (empty + whitespace) |
| `src/components/settings/studio-template-form.tsx:102` | `Class type is required` | banner, sequential first-missing | copy at `studio-template-form.test.tsx:147,153` (empty + whitespace) |
| `src/components/studio-class/studio-class-edit-form.tsx:104` | `Class type is required.` | per-field errors map, all-at-once | copy at `studio-class-edit-form.test.tsx:173` (whitespace only) |

### Corrections the census adds to the issue

1. **A fifth writing surface exists outside the issue's boundary:**
   `(teacher)/class/new/page.tsx:245` writes `'Enter a class type'` per-field,
   unpunctuated, untested. It belongs to the regular class family, never co-renders with
   any studio surface, and stays out of scope — recorded because "unify the family"
   decisions keep getting re-litigated against surfaces nobody counted.
2. **The issue's prose says "three forms"; its table lists four.** The three *studio*
   surfaces are new-page, studio-template-form, edit form. `template-form.tsx` is the
   recurring-template twin from the class family — and it cannot be left out regardless:
   the two settings template forms sit in the same directory serving parallel screens, so
   whichever string wins must apply to both twins or the divergence this issue exists to
   remove survives between them.
3. **The visibility asymmetry, which decides the punctuation direction.** The banner
   forms validate sequentially — `setError(x); return;` — so exactly one validation
   message is ever on screen; mixed punctuation *inside* those forms is code-level only,
   invisible to users. The edit form collects all field errors up front and renders them
   simultaneously — it is the only place a teacher can see two messages side by side, and
   today all six of its messages are punctuated sentences.

## 2. Decision — option B: the period wins, everywhere

All four sites read **`Class type is required.`** Chosen at the direction gate over:

- **A, dropping the period in the edit form** (2 line-edits): cheapest, majority style
  app-wide — but it puts an unpunctuated message beside five punctuated siblings in the
  one form where teachers can actually see them together. The defect class the issue
  complains about would be relocated into the only user-visible instance of it.
- **C, re-punctuating every validation string in all five forms** (~15 strings): kills
  the wizard's bare fragments too, but balloons a one-character decision into a
  two-family sweep with no user-visible gain over B.
- **D, let it go:** the words already match and the mechanisms differ deliberately — but
  the issue was filed deliberately too, and B's cost is six extra lines.

B's residual inconsistency — each banner form carrying one punctuated string among bare
siblings (`Location is required`, …) — is never rendered next to those siblings, and it
points in the direction the app's newer product prose already drifts (#197-era sentence
copy). Mechanism unification stays rejected, per the issue's own note and both prior
designs.

## 3. Changes

Copy-only. One string literal in three sources, four test assertions:

1. `src/app/(teacher)/studio-class/new/page.tsx:93` → `'Class type is required.'`
2. `src/components/settings/studio-template-form.tsx:102` → `'Class type is required.'`
3. `src/components/settings/template-form.tsx:248` → `'Class type is required.'`
4. `src/app/(teacher)/studio-class/new/page.test.tsx:149,155` → assert the period
5. `src/components/settings/studio-template-form.test.tsx:147,153` → assert the period

`studio-class-edit-form.tsx` and its test are untouched. No schema, service, API route,
or migration change; nothing server-side reads these strings. The surrounding comments
(#282 blocks in both test files) describe mechanism and rationale without quoting the
literal, so they stand as written.

## 4. Coverage

No new guard is introduced — this branch renames pinned copy, and the guards themselves
were mutation-proven in their own rounds (#282: guard-deleted and return-dropped mutants;
#276/#282: trim-dropped mutant). What must hold after the edit:

1. The six updated/untouched copy pins go green together.
2. **One bite-proof for the branch's own claim** (that the pins track the new string):
   in `studio-template-form.tsx`, revert `:102` to the old literal, run that file alone.
   Expected red: both assertions at `:147`/`:153` fail on the missing period while
   `fetchMock` stays uncalled — i.e. the red names copy drift, not a broken guard.
   Restore, re-run green. (The other two sources share the assertion shape; one
   demonstration covers the class.)
3. Component tests hit no dev server, so warm-route discipline does not apply to them;
   `npm run verify` afterwards runs the integration project and needs the app on :3000.

## 5. What this does not do

- **`(teacher)/class/new/page.tsx`'s `'Enter a class type'` is unaffected** — different
  family, imperative voice, never co-rendered; converging it is a house-copy question
  #309 does not ask.
- **Mechanism unification stays off the table** — sequential banners and the all-at-once
  map are each deliberate (#282 §2, #197/#276).
- **Server-side Zod copy is unaffected** — `min(1)` + `parseBody` developer strings were
  settled by #282 for non-UI clients.
- **Three pre-existing pin gaps are recorded, not filled here**: `template-form`'s banner
  has no copy pin (fetch-count only), the wizard's message has none at all, and the edit
  form pins whitespace-only but not empty `''`. None were made worse by this branch;
  filing or attaching them happens at fold/file time, outside the diff.

## 6. Re-derivables

- Full census (should return exactly the nine lines of §1):
  `rg -n "Class type is required|Enter a class type" src/`
- Post-change tether — zero unpunctuated occurrences left in the family:
  `rg -n "Class type is required[^.]" src/` → no hits.
  (This supersedes #282's spec §6 count of `"is required'"` lines, which measured that
  round's merge base and drops to zero under this branch.)
- Boundary-pin structure unchanged: empty + whitespace pairs at
  `(teacher)/studio-class/new/page.test.tsx:149,155` and
  `studio-template-form.test.tsx:147,153`; whitespace-only at
  `studio-class-edit-form.test.tsx:173`.
